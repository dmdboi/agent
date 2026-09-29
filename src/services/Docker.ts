import Docker, { AuthConfigObject } from "dockerode";
import { createReadStream } from "fs";
import { PassThrough, Readable, Writable } from "stream";
import { pipeline } from "stream/promises";
import { normalizeContainer } from "../utils/transformers";
import { error, info } from "../utils/console";
import config from "../config";

export interface ExecCommandStream {
  stdout: Readable;
  stderr: Readable;
  // Resolves to the process exit code. Only meaningful once stdout/stderr have ended —
  // callers that need the code should drain both streams first.
  exitCode: () => Promise<number>;
}

export interface ExecCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EphemeralContainer {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  wait: () => Promise<number>;
  remove: () => Promise<void>;
}

interface PullImageAuth {
  username: string;
  password: string;
  registry: string;
}

const PUSH_TIMEOUT_MS = 15 * 60 * 1000;

interface PushProgressEvent {
  status?: string;
  error?: string;
  errorDetail?: { message?: string };
}

interface PullProgressEvent {
  status?: string;
  progress?: string;
  id?: string;
}

interface BuildProgressEvent {
  stream?: string;
  error?: string;
  errorDetail?: { message?: string; code?: number };
}

export class DockerService {
  public readonly name = "Docker";
  public readonly docker: Docker;

  constructor(socketPath: string = config.DOCKER_SOCKET) {
    this.docker = new Docker({ socketPath });
    info(this.name, "Initialized Docker client", { socketPath });
  }

  // CONTAINERS

  async listContainers(): Promise<any[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      return containers.map(container => normalizeContainer(container));
    } catch (err) {
      error(this.name, "Failed to list containers", { error: (err as Error).message });
      throw err;
    }
  }

  async getContainer(id: string): Promise<Docker.ContainerInspectInfo> {
    try {
      const container = this.docker.getContainer(id);
      return await container.inspect();
    } catch (err) {
      error(this.name, "Failed to get container", { id, error: (err as Error).message });
      throw err;
    }
  }

  async listContainersByLabel(label: string, value: string): Promise<Docker.ContainerInfo[]> {
    try {
      return await this.docker.listContainers({ all: true, filters: { label: [`${label}=${value}`] } });
    } catch (err) {
      error(this.name, "Failed to list containers by label", { label, value, error: (err as Error).message });
      throw err;
    }
  }

  async renameContainer(id: string, name: string): Promise<void> {
    try {
      const container = this.docker.getContainer(id);
      await container.rename({ name });
    } catch (err) {
      error(this.name, "Failed to rename container", { id, name, error: (err as Error).message });
      throw err;
    }
  }

  async createContainer(options: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    try {
      return await this.docker.createContainer(options);
    } catch (err) {
      error(this.name, "Failed to create container", {
        name: options.name,
        image: options.Image,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async removeContainer(id: string, force: boolean = false): Promise<void> {
    try {
      const container = this.docker.getContainer(id);
      await container.remove({ force });
    } catch (err) {
      error(this.name, "Failed to remove container", { id, error: (err as Error).message });
      throw err;
    }
  }

  async restartContainer(id: string): Promise<void> {
    try {
      const container = this.docker.getContainer(id);
      await container.restart();
    } catch (err) {
      error(this.name, "Failed to restart container", { id, error: (err as Error).message });
      throw err;
    }
  }

  async startContainer(id: string): Promise<void> {
    try {
      const container = this.docker.getContainer(id);
      await container.start();
    } catch (err) {
      error(this.name, "Failed to start container", { id, error: (err as Error).message });
      throw err;
    }
  }

  async stopContainer(id: string, timeout: number = 10): Promise<void> {
    try {
      const container = this.docker.getContainer(id);
      await container.stop({ t: timeout });
    } catch (err) {
      error(this.name, "Failed to stop container", { id, error: (err as Error).message });
      throw err;
    }
  }

  async getContainerLogs(
    id: string,
    options: { tail?: number; since?: number; timestamps?: boolean; stdout?: boolean; stderr?: boolean } = {},
  ): Promise<Buffer> {
    try {
      const container = this.docker.getContainer(id);
      // `follow: false` here is a literal, not `boolean` — that's what selects dockerode's
      // `Promise<Buffer>` overload instead of `Promise<NodeJS.ReadableStream>`, so no cast needed.
      return await container.logs({
        follow: false,
        stdout: options.stdout ?? true,
        stderr: options.stderr ?? true,
        tail: options.tail ?? 200,
        since: options.since ?? 0,
        timestamps: options.timestamps ?? false,
      });
    } catch (err) {
      error(this.name, "Failed to get container logs", { id, error: (err as Error).message });
      throw err;
    }
  }

  async streamContainerLogs(
    id: string,
    options: { tail?: number; since?: number; timestamps?: boolean; stdout?: boolean; stderr?: boolean; abortSignal?: AbortSignal } = {},
  ): Promise<NodeJS.ReadableStream> {
    try {
      const container = this.docker.getContainer(id);
      return await container.logs({
        follow: true,
        stdout: options.stdout ?? true,
        stderr: options.stderr ?? true,
        tail: options.tail ?? 100,
        since: options.since ?? 0,
        timestamps: options.timestamps ?? false,
        abortSignal: options.abortSignal,
      });
    } catch (err) {
      error(this.name, "Failed to stream container logs", { id, error: (err as Error).message });
      throw err;
    }
  }

  // Runs `cmd` inside a running container and returns its stdout/stderr as live streams —
  // nothing is buffered here, which is what lets callers pipe a multi-GB pg_dump/tar
  // straight through to an upload without holding it in memory.
  async execCommandStream(containerId: string, cmd: string[], opts: { env?: string[] } = {}): Promise<ExecCommandStream> {
    const container = this.docker.getContainer(containerId);

    const exec = await container.exec({
      Cmd: cmd,
      Env: opts.env,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const rawStream = await exec.start({ hijack: true, stdin: false });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // stderr is drained by hand for diagnostics, so a late error on it must not
    // crash the process. stdout errors, though, must reach the consumer's
    // pipeline so a truncated dump fails the backup instead of completing with a
    // short archive — hence a socket-level error is forwarded onto both streams.
    stderr.on("error", () => { });
    rawStream.on("error", err => {
      stdout.destroy(err as Error);
      stderr.destroy(err as Error);
    });

    this.docker.modem.demuxStream(rawStream, stdout, stderr);

    // demuxStream forwards frames but not EOF: once the hijacked socket ends the
    // PassThroughs must be ended too, or a consumer piping `stdout` to a file
    // (stageToFile) never sees the readable end and hangs forever.
    const finished = new Promise<void>(resolve => {
      const done = (): void => {
        stdout.end();
        stderr.end();
        resolve();
      };
      rawStream.once("end", done);
      rawStream.once("close", done);
    });

    return {
      stdout,
      stderr,
      exitCode: async () => {
        await finished;
        const inspectResult = await exec.inspect();
        return inspectResult.ExitCode ?? -1;
      },
    };
  }

  // Runs `cmd` inside a running container and buffers stdout/stderr — for short
  // control-plane commands (createdb, psql probes, pg_restore) where the output
  // is small but an optional file (inputFile) is streamed in on stdin.
  async execCommandBuffered(containerId: string, cmd: string[], opts: { env?: string[]; inputFile?: string } = {}): Promise<ExecCommandResult> {
    const container = this.docker.getContainer(containerId);
    const hasInput = Boolean(opts.inputFile);

    const exec = await container.exec({
      Cmd: cmd,
      Env: opts.env,
      AttachStdin: hasInput,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const rawStream = await exec.start({ hijack: true, stdin: hasInput });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    stdout.on("data", chunk => outChunks.push(chunk as Buffer));
    stderr.on("data", chunk => errChunks.push(chunk as Buffer));
    stdout.on("error", () => { });
    stderr.on("error", () => { });

    this.docker.modem.demuxStream(rawStream, stdout, stderr);

    const finished = new Promise<void>((resolve, reject) => {
      const done = (): void => {
        stdout.end();
        stderr.end();
        resolve();
      };
      rawStream.once("end", done);
      rawStream.once("close", done);
      rawStream.once("error", reject);
    });
    finished.catch(() => { });

    if (opts.inputFile) {
      // Writes the payload then closes stdin, which pg_restore reads as EOF.
      await pipeline(createReadStream(opts.inputFile), rawStream);
    }

    await finished;

    const inspectResult = await exec.inspect();

    return {
      stdout: Buffer.concat(outChunks).toString("utf-8"),
      stderr: Buffer.concat(errChunks).toString("utf-8"),
      exitCode: inspectResult.ExitCode ?? -1,
    };
  }

  // Creates a throwaway container (pulling the image if missing), attaches to its
  // stdio, and starts it. The caller streams data through stdin/stdout, waits for
  // the exit code, and must call remove() — on both success and failure.
  async runEphemeralContainer(opts: { image: string; cmd: string[]; binds: string[]; attachStdin?: boolean }): Promise<EphemeralContainer> {
    const attachStdin = Boolean(opts.attachStdin);

    if (!(await this.checkImageExists(opts.image))) {
      await this.pullImage(opts.image);
    }

    const container = await this.docker.createContainer({
      Image: opts.image,
      Cmd: opts.cmd,
      OpenStdin: attachStdin,
      StdinOnce: attachStdin,
      AttachStdin: attachStdin,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        Binds: opts.binds,
        NetworkMode: "none",
        AutoRemove: false,
      },
    });

    const rawStream = await container.attach({
      stream: true,
      hijack: true,
      stdin: attachStdin,
      stdout: true,
      stderr: true,
    });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.on("error", () => { });
    rawStream.on("error", err => {
      stdout.destroy(err as Error);
      stderr.destroy(err as Error);
    });

    this.docker.modem.demuxStream(rawStream, stdout, stderr);

    // demuxStream does not forward EOF; end the PassThroughs when the attach
    // socket closes so a consumer piping `stdout` to a file terminates.
    const endOutputs = (): void => {
      stdout.end();
      stderr.end();
    };
    rawStream.once("end", endOutputs);
    rawStream.once("close", endOutputs);

    await container.start();

    return {
      stdin: rawStream as unknown as Writable,
      stdout,
      stderr,
      wait: async () => {
        const result = await container.wait();
        return result.StatusCode ?? -1;
      },
      remove: async () => {
        try {
          await container.remove({ force: true });
        } catch (err) {
          error(this.name, "Failed to remove ephemeral container", { image: opts.image, error: (err as Error).message });
        }
      },
    };
  }

  // VOLUMES

  async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (err) {
      const dockerErr = err as { statusCode?: number };
      if (dockerErr.statusCode === 404) {
        return false;
      }
      error(this.name, "Error checking volume existence", { name, error: (err as Error).message });
      throw err;
    }
  }

  async createVolume(name: string): Promise<void> {
    await this.docker.createVolume({ Name: name });
  }

  async removeVolume(name: string): Promise<void> {
    await this.docker.getVolume(name).remove({ force: true });
  }

  // IMAGES

  async listImages(): Promise<Docker.ImageInfo[]> {
    try {
      return await this.docker.listImages();
    } catch (err) {
      error(this.name, "Failed to list images", { error: (err as Error).message });
      throw err;
    }
  }

  async getImage(id: string): Promise<Docker.ImageInspectInfo> {
    try {
      return await this.docker.getImage(id).inspect();
    } catch (err) {
      error(this.name, "Failed to get image", { id, error: (err as Error).message });
      throw err;
    }
  }

  async pullImage(name: string, auth?: Partial<PullImageAuth>): Promise<void> {
    info(this.name, "Pulling image", { name });

    const authconfig = this.buildAuthConfig(auth);

    // Validate auth if provided
    if (authconfig) {
      await this.validateAuth(authconfig, name);
    }

    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      this.docker.pull(name, { authconfig }, (err, stream) => {
        if (err) {
          error(this.name, "Failed to pull image", { name, error: err.message });
          return reject(err);
        }
        if (!stream) {
          error(this.name, "No stream returned from pull", { name });
          return reject(new Error("No stream returned from Docker pull"));
        }
        resolve(stream);
      });
    });

    try {
      await this.followProgress<PullProgressEvent>(stream, event => {
        // Only log significant progress events to reduce noise
        if (event?.status && this.isSignificantProgressEvent(event.status)) {
          info(this.name, "Image pull progress", { name, status: event.status, progress: event.progress });
        }
      });
    } catch (err) {
      error(this.name, "Image pull failed", { name, error: (err as Error).message });
      throw err;
    }

    info(this.name, "Successfully pulled image", { name });
  }

  // Tags `localTag` as `remoteRef` (host[:port]/path:tag) and pushes it. Like a failed build, a
  // failed push still resolves the stream with HTTP 200 and only reports an `error` event.
  async pushImage(localTag: string, remoteRef: string, auth?: Partial<PullImageAuth>, timeoutMs: number = PUSH_TIMEOUT_MS): Promise<void> {
    info(this.name, "Pushing image", { localTag, remoteRef });

    const authconfig = this.buildAuthConfig(auth);

    if (authconfig) {
      await this.validateAuth(authconfig, remoteRef);
    }

    const lastColon = remoteRef.lastIndexOf(":");
    const repo = remoteRef.slice(0, lastColon);
    const tag = remoteRef.slice(lastColon + 1);

    await this.docker.getImage(localTag).tag({ repo, tag });

    const stream = await this.docker.getImage(remoteRef).push({ authconfig });

    const progress = this.followProgress<PushProgressEvent>(stream, event => {
      if (event?.status && this.isSignificantProgressEvent(event.status)) {
        info(this.name, "Image push progress", { remoteRef, status: event.status });
      }
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        (stream as Partial<NodeJS.ReadableStream & { destroy: () => void }>).destroy?.();
        reject(new Error(`Image push timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });

    let output: PushProgressEvent[];
    try {
      output = await Promise.race([progress, timeout]);
    } catch (err) {
      error(this.name, "Image push failed", { remoteRef, error: (err as Error).message });
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const failure = output.find(event => event.error || event.errorDetail);
    if (failure) {
      const message = failure.errorDetail?.message || failure.error || "Docker push failed";
      error(this.name, "Image push failed", { remoteRef, error: message });
      throw new Error(message);
    }

    info(this.name, "Successfully pushed image", { remoteRef });
  }

  async buildImage(contextPath: string, tag: string, buildArgs?: Record<string, string>): Promise<void> {
    info(this.name, "Building image", { contextPath, tag, buildArgs: buildArgs ? Object.keys(buildArgs) : undefined });

    const stream = await this.docker.buildImage({ context: contextPath, src: ["."] }, { t: tag, buildargs: buildArgs });

    let output: BuildProgressEvent[];
    try {
      output = await this.followProgress<BuildProgressEvent>(stream, event => {
        const line = event?.stream?.trim();
        if (line) info(this.name, "Image build progress", { tag, line });
      });
    } catch (err) {
      error(this.name, "Image build failed", { tag, error: (err as Error).message });
      throw err;
    }

    // A failed `docker build` still resolves the stream with HTTP 200 — the failure only
    // shows up as an `error`/`errorDetail` event buried in the output, not a rejected promise.
    const failure = output.find(event => event.error || event.errorDetail);
    if (failure) {
      const message = failure.errorDetail?.message || failure.error || "Docker build failed";
      error(this.name, "Image build failed", { tag, error: message });
      throw new Error(message);
    }

    info(this.name, "Successfully built image", { tag });
  }

  // Wraps dockerode's callback-based followProgress in a promise, resolving with the full
  // array of progress events once the stream ends. Shared by pullImage and buildImage, whose
  // completion semantics differ (a failed pull rejects; a failed build resolves with an error
  // event) — so error interpretation stays with the caller.
  private followProgress<T>(stream: NodeJS.ReadableStream, onProgress: (event: T) => void): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err, output) => (err ? reject(err) : resolve(output as T[])),
        onProgress,
      );
    });
  }

  async removeImage(id: string, force: boolean = false): Promise<void> {
    try {
      await this.docker.getImage(id).remove({ force });
    } catch (err) {
      error(this.name, "Failed to remove image", { id, error: (err as Error).message });
      throw err;
    }
  }

  // `all` mirrors `docker image prune -a`: without it only dangling images go,
  // with it every image not referenced by a container is fair game.
  async pruneImages(all: boolean = false): Promise<Docker.PruneImagesInfo> {
    try {
      const options = all ? { filters: { dangling: ["false"] } } : {};
      const result = await this.docker.pruneImages(options);
      info(this.name, "Pruned images", {
        all,
        spaceReclaimed: result.SpaceReclaimed,
        imagesDeleted: result.ImagesDeleted?.length || 0,
      });
      return result;
    } catch (err) {
      error(this.name, "Failed to prune images", { error: (err as Error).message });
      throw err;
    }
  }

  async checkImageExists(id: string): Promise<boolean> {
    try {
      await this.docker.getImage(id).inspect();
      return true;
    } catch (err) {
      const dockerErr = err as { statusCode?: number };
      if (dockerErr.statusCode === 404) {
        return false;
      }
      error(this.name, "Error checking image existence", { id, error: (err as Error).message });
      throw err;
    }
  }

  // PRIVATE HELPERS

  private buildAuthConfig(auth?: Partial<PullImageAuth>): AuthConfigObject | undefined {
    if (!auth?.username || !auth?.password || !auth?.registry) {
      return undefined;
    }

    return {
      username: auth.username,
      password: auth.password,
      serveraddress: auth.registry,
      auth: "", // Required by Docker API
    };
  }

  private async validateAuth(authconfig: AuthConfigObject, imageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.checkAuth(authconfig, err => {
        if (err) {
          error(this.name, "Authentication failed", {
            image: imageName,
            registry: authconfig.serveraddress,
            error: err.message,
          });
          return reject(new Error(`Authentication failed for ${authconfig.serveraddress}`));
        }
        info(this.name, "Authentication successful", {
          image: imageName,
          registry: authconfig.serveraddress,
        });
        resolve();
      });
    });
  }

  private isSignificantProgressEvent(status: string): boolean {
    // Only log meaningful status changes, not every progress tick
    const significantStatuses = ["Pulling fs layer", "Downloading", "Download complete", "Extracting", "Pull complete", "Already exists", "Digest:", "Status:"];

    return significantStatuses.some(s => status.includes(s));
  }
}
