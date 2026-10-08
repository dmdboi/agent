import { Context } from "hono";

import { DeployService, DeployOptions } from "../services/Deploy";
import { info, error as logError } from "../utils/console";
import { handleError } from "../utils/error";

interface DeploymentRequestBody {
  deployment_id: string;
  strategy?: "rolling" | "recreate";
  container: {
    name: string;
    image: string;
    networks?: string[];
    [key: string]: unknown;
  };
  health?: {
    path?: string;
    port: number;
    timeout_s?: number;
    interval_s?: number;
  };
  retire?: string[];
  stop_grace_seconds?: number;
  prestep?: {
    run?: boolean;
    command?: string[];
    labels?: Record<string, string>;
  };
}

const DEFAULT_PRESTEP_COMMAND = ["php", "artisan", "migrate", "--pretend"];

function normalise(body: DeploymentRequestBody): DeployOptions {
  const container = body.container;

  return {
    deploymentId: body.deployment_id,
    strategy: body.strategy === "recreate" ? "recreate" : "rolling",
    container: {
      name: container.name,
      image: container.image,
      environment: container.environment as string[] | undefined,
      labels: container.labels as Record<string, string> | undefined,
      exposedPorts: container.exposedPorts as Record<string, object> | undefined,
      hostConfig: container.hostConfig as { Binds?: string[] } | undefined,
      command: container.command as string[] | undefined,
      entrypoint: container.entrypoint as string[] | string | undefined,
      workingdir: container.workingdir as string | undefined,
      networks: container.networks ?? [],
      pullImage: container.pullImage as boolean | undefined,
      auth: container.auth as { username?: string; password?: string; registry?: string } | undefined,
    },
    health: body.health
      ? {
          path: body.health.path ?? "/up",
          port: body.health.port,
          timeoutSeconds: body.health.timeout_s ?? 120,
          intervalSeconds: body.health.interval_s ?? 3,
        }
      : undefined,
    retire: body.retire ?? [],
    stopGraceSeconds: body.stop_grace_seconds,
    prestep: body.prestep
      ? {
          run: Boolean(body.prestep.run),
          command: body.prestep.command && body.prestep.command.length > 0 ? body.prestep.command : DEFAULT_PRESTEP_COMMAND,
          labels: body.prestep.labels,
        }
      : undefined,
  };
}

export function createDeploymentHandlers(deployService: DeployService) {
  if (!deployService) {
    throw new Error("Deploy service is required");
  }

  async function deploy(ctx: Context) {
    try {
      const options = normalise(await ctx.req.json<DeploymentRequestBody>());

      info("Deploy", "Deployment requested", {
        deploymentId: options.deploymentId,
        strategy: options.strategy,
        retire: options.retire.length,
        prestep: options.prestep?.run ?? false,
      });

      deployService.deploy(options).catch(err => {
        logError("Deploy", "Unhandled deployment error", {
          deploymentId: options.deploymentId,
          error: (err as Error).message,
        });
      });

      return ctx.json({ success: true, message: "deployment started", deploymentId: options.deploymentId }, 202);
    } catch (err) {
      return handleError(ctx, err, "Deploy", "start deployment");
    }
  }

  return { deploy };
}
