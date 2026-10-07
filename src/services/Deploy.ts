import { httpService } from "./Http";
import { DockerService } from "./Docker";
import { demultiplexDockerStream, stripAnsiCodes } from "../utils/transformers";
import { info, warn, error as logError } from "../utils/console";
import {
  MANAGED_LABEL_KEYS,
  WORKLOAD_ROLES,
  WorkloadRole,
  buildManagedLabels,
  parseContainerEnv,
} from "../utils/containerIdentity";

const DEFAULT_STOP_GRACE_SECONDS = 140;
const RUNNING_GRACE_MS = 3000;
const REPORT_BACKOFF_MS = [1000, 2000, 4000, 8000];

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface DeployContainerOptions {
  name: string;
  image: string;
  environment?: string[];
  labels?: Record<string, string>;
  exposedPorts?: Record<string, object>;
  hostConfig?: { Binds?: string[]; [key: string]: unknown };
  command?: string[];
  entrypoint?: string[] | string;
  workingdir?: string;
  networks?: string[];
  pullImage?: boolean;
  auth?: { username?: string; password?: string; registry?: string };
}

export interface DeployHealthCheck {
  path: string;
  port: number;
  timeoutSeconds: number;
  intervalSeconds: number;
}

export interface DeployOptions {
  deploymentId: string;
  strategy: "rolling" | "recreate";
  container: DeployContainerOptions;
  health?: DeployHealthCheck;
  retire: string[];
  stopGraceSeconds?: number;
  prestep?: { run: boolean; command: string[] };
}

type DeployStatus = "completed" | "failed" | "rolled_back";

export class DeployService {
  public readonly name = "Deploy";

  constructor(private readonly docker: DockerService) {
    if (!docker) {
      throw new Error("Docker service is required");
    }
  }

  async deploy(options: DeployOptions): Promise<void> {
    const logs: string[] = [];
    const log = (line: string): void => {
      logs.push(line);
      info(this.name, line, { deploymentId: options.deploymentId });
    };

    // Containers this run actually removed (a failed stop/remove is skipped), so
    // Core can drop their rows even when the deploy fails: `retired` old
    // containers a `recreate`/`rolling` swap kills, `discarded` the new
    // container rolled back after a failed health check.
    let retired: string[] = [];
    const discarded: string[] = [];

    // `recreate` stops the retire set up front to free its ports/volumes, then
    // removes it only once the new container is healthy. Until then the old
    // containers are a stopped standby we can start again if the deploy fails.
    let oldStopped = false;

    try {
      if (options.prestep?.run) {
        log("Running pre-deploy step");
        const prestep = await this.runPrestep(options);
        if (!prestep.ok) {
          log("Pre-deploy step failed");

          return await this.report(options, "failed", logs, prestep.output || "pre-deploy step exited non-zero", null, retired, discarded);
        }
        log("Pre-deploy step passed");
      }

      if (options.strategy === "recreate") {
        await this.stopRetired(options, log);
        oldStopped = true;
      }

      log("Creating new container");
      const newContainerId = await this.createContainer(options, log);

      const healthy = options.health
        ? await this.waitForHealthy(newContainerId, options.health, log)
        : await this.waitForRunning(newContainerId, log);

      if (!healthy) {
        log("New container did not become healthy — rolling back");
        if (await this.discard(newContainerId, log)) {
          discarded.push(newContainerId);
        }

        if (options.strategy === "recreate") {
          const restored = await this.restoreRetired(options, log);
          const status: DeployStatus = restored ? "rolled_back" : "failed";
          const reason = restored
            ? "new container failed its health check; previous container restored"
            : "new container failed its health check; previous container could not be restored";

          return await this.report(options, status, logs, reason, null, retired, discarded);
        }

        return await this.report(options, "rolled_back", logs, "new container failed its health check", null, retired, discarded);
      }

      if (options.strategy === "recreate") {
        retired = await this.removeRetired(options, log);
        oldStopped = false;
      }

      if (options.strategy === "rolling") {
        retired = await this.retire(options, log);
      }

      log("Deployment completed");
      const container = await this.docker.getContainer(newContainerId);

      return await this.report(options, "completed", logs, null, container, retired, discarded);
    } catch (err) {
      const message = (err as Error).message;
      logError(this.name, "Deployment failed", { deploymentId: options.deploymentId, error: message });
      logs.push(`Deployment failed: ${message}`);

      // A `recreate` that threw after stopping the old containers but before
      // removing them: start them again so the app isn't left with nothing.
      if (oldStopped) {
        await this.restoreRetired(options, log);
      }

      // Only `retired` (containers we definitely removed) is reported here.
      // A new container created before the throw may still be running — its
      // fate is left to Core's periodic container reconciliation.
      return await this.report(options, "failed", logs, message, null, retired, discarded);
    }
  }

  private async ensureImage(container: DeployContainerOptions): Promise<void> {
    const exists = await this.docker.checkImageExists(container.image);

    if (!exists || container.pullImage) {
      info(this.name, "Pulling image", { image: container.image });
      await this.docker.pullImage(container.image, {
        username: container.auth?.username,
        password: container.auth?.password,
        registry: container.auth?.registry,
      });
    }
  }

  private async createContainer(options: DeployOptions, log: (line: string) => void): Promise<string> {
    const container = options.container;

    await this.ensureImage(container);

    const networks = container.networks ?? [];
    const EndpointsConfig = networks.reduce((acc: Record<string, { Aliases: string[] }>, net: string) => {
      if (!["host", "bridge", "none"].includes(net)) {
        acc[net] = { Aliases: [container.name] };
      }

      return acc;
    }, {});

    const created = await this.docker.createContainer({
      name: container.name,
      Image: container.image,
      Env: container.environment,
      Labels: { ...container.labels, ...this.identityLabels(options, WORKLOAD_ROLES.runtime) },
      ExposedPorts: container.exposedPorts,
      HostConfig: container.hostConfig,
      Cmd: container.command,
      NetworkingConfig: { EndpointsConfig },
      Entrypoint: container.entrypoint,
      WorkingDir: container.workingdir,
    });

    await this.docker.startContainer(created.id);
    log(`New container ${created.id.slice(0, 12)} started`);

    return created.id;
  }

  private async waitForHealthy(id: string, health: DeployHealthCheck, log: (line: string) => void): Promise<boolean> {
    const deadline = Date.now() + health.timeoutSeconds * 1000;
    const attemptTimeout = Math.min(5000, health.intervalSeconds * 1000);
    log(`Waiting for ${health.path} on port ${health.port} to respond`);

    while (Date.now() < deadline) {
      if (await this.hasExited(id)) {
        log("New container exited before it became healthy");

        return false;
      }

      try {
        const host = await this.containerHost(id);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), attemptTimeout);

        try {
          const response = await fetch(`http://${host}:${health.port}${health.path}`, { signal: controller.signal });

          if (response.status >= 200 && response.status < 400) {
            log("New container is healthy");

            return true;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {}

      await sleep(health.intervalSeconds * 1000);
    }

    return false;
  }

  private async waitForRunning(id: string, log: (line: string) => void): Promise<boolean> {
    log("No health check configured — verifying the container stays running");
    await sleep(RUNNING_GRACE_MS);

    try {
      const inspect = await this.docker.getContainer(id);

      return inspect.State?.Running === true && inspect.State?.Restarting !== true;
    } catch {
      return false;
    }
  }

  private async containerHost(id: string): Promise<string> {
    const inspect = await this.docker.getContainer(id);
    const networks = (inspect.NetworkSettings?.Networks ?? {}) as Record<string, { IPAddress?: string } | null>;

    const traefikIp = networks["traefik"]?.IPAddress;
    if (traefikIp) {
      return traefikIp;
    }

    for (const net of Object.values(networks)) {
      if (net?.IPAddress) {
        return net.IPAddress;
      }
    }

    throw new Error("new container has no network IP yet");
  }

  private async hasExited(id: string): Promise<boolean> {
    try {
      const inspect = await this.docker.getContainer(id);
      const status = inspect.State?.Status;

      return status === "exited" || status === "dead";
    } catch {
      return true;
    }
  }

  private async retire(options: DeployOptions, log: (line: string) => void): Promise<string[]> {
    await this.stopRetired(options, log);

    return this.removeRetired(options, log);
  }

  private async stopRetired(options: DeployOptions, log: (line: string) => void): Promise<void> {
    const grace = options.stopGraceSeconds ?? DEFAULT_STOP_GRACE_SECONDS;

    for (const id of options.retire) {
      log(`Stopping old container ${id.slice(0, 12)}`);

      try {
        await this.docker.stopContainer(id, grace);
      } catch (err) {
        warn(this.name, "Failed to stop old container", { id, error: (err as Error).message });
      }
    }
  }

  private async removeRetired(options: DeployOptions, log: (line: string) => void): Promise<string[]> {
    const removed: string[] = [];

    for (const id of options.retire) {
      log(`Removing old container ${id.slice(0, 12)}`);

      try {
        await this.docker.removeContainer(id, true);
        removed.push(id);
      } catch (err) {
        warn(this.name, "Failed to remove old container", { id, error: (err as Error).message });
      }
    }

    return removed;
  }

  // Bring the retire set back after a failed `recreate` — they were only
  // stopped, never removed. Returns true if every one is running again.
  private async restoreRetired(options: DeployOptions, log: (line: string) => void): Promise<boolean> {
    let allRunning = true;

    for (const id of options.retire) {
      log(`Restoring old container ${id.slice(0, 12)}`);

      try {
        await this.docker.startContainer(id);
      } catch (err) {
        allRunning = false;
        warn(this.name, "Failed to restore old container during rollback", { id, error: (err as Error).message });
      }
    }

    return allRunning;
  }

  private async discard(id: string, log: (line: string) => void): Promise<boolean> {
    log(`Discarding new container ${id.slice(0, 12)}`);

    try {
      await this.docker.stopContainer(id, 10);
    } catch (err) {
      warn(this.name, "Failed to stop new container during rollback", { id, error: (err as Error).message });
    }

    try {
      await this.docker.removeContainer(id, true);

      return true;
    } catch (err) {
      // Returning false here: the new container may still be holding the fixed
      // host port, so a recreate's restoreRetired() can fail to rebind it.
      warn(this.name, "Failed to remove new container during rollback", { id, error: (err as Error).message });

      return false;
    }
  }

  private identityLabels(options: DeployOptions, workloadRole: WorkloadRole): Record<string, string> {
    const env = parseContainerEnv(options.container.environment);
    const labels = options.container.labels ?? {};

    return buildManagedLabels({
      applicationId: env.get("CORE_APP_ID") ?? labels[MANAGED_LABEL_KEYS.applicationId] ?? null,
      environmentId: env.get("CORE_ENV_ID") ?? labels[MANAGED_LABEL_KEYS.environmentId] ?? null,
      deploymentId: options.deploymentId || labels[MANAGED_LABEL_KEYS.deploymentId] || null,
      workloadRole,
    });
  }

  private async runPrestep(options: DeployOptions): Promise<{ ok: boolean; output: string }> {
    const container = options.container;
    await this.ensureImage(container);

    const primaryNetwork = (container.networks ?? []).find(net => !["host", "bridge", "none"].includes(net));

    const oneShot = await this.docker.docker.createContainer({
      Image: container.image,
      Cmd: options.prestep!.command,
      Env: container.environment,
      Labels: this.identityLabels(options, WORKLOAD_ROLES.prestep),
      Tty: false,
      HostConfig: {
        Binds: container.hostConfig?.Binds ?? [],
        NetworkMode: primaryNetwork ?? "none",
        AutoRemove: false,
      },
    });

    try {
      const stream = await oneShot.attach({ stream: true, hijack: true, stdout: true, stderr: true });
      const chunks: Buffer[] = [];
      const drained = new Promise<void>(resolve => {
        stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        stream.once("end", resolve);
        stream.once("close", resolve);
        stream.once("error", () => resolve());
      });

      await oneShot.start();
      const result = await oneShot.wait();
      await Promise.race([drained, sleep(1000)]);

      const { stdout, stderr } = demultiplexDockerStream(Buffer.concat(chunks));
      const output = stripAnsiCodes(`${stdout}${stderr}`).trim();

      return { ok: (result.StatusCode ?? -1) === 0, output };
    } catch (err) {
      return { ok: false, output: (err as Error).message };
    } finally {
      try {
        await oneShot.remove({ force: true });
      } catch {}
    }
  }

  private async report(
    options: DeployOptions,
    status: DeployStatus,
    logs: string[],
    error: string | null,
    container: unknown = null,
    retired: string[] = [],
    discarded: string[] = [],
  ): Promise<void> {
    const payload = {
      type: "deployment_status",
      deploymentId: options.deploymentId,
      status,
      logs,
      error,
      container,
      retired,
      discarded,
    };

    for (let attempt = 0; attempt <= REPORT_BACKOFF_MS.length; attempt++) {
      try {
        await httpService.post(payload);

        return;
      } catch (err) {
        if (attempt === REPORT_BACKOFF_MS.length) {
          logError(this.name, "Failed to report deployment status after retries", {
            deploymentId: options.deploymentId,
            status,
            error: (err as Error).message,
          });

          return;
        }

        await sleep(REPORT_BACKOFF_MS[attempt]);
      }
    }
  }
}
