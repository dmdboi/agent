import { Context } from "hono";
import { join } from "path";
import { ShellService } from "../services/Shell";
import { DockerService } from "../services/Docker";
import { hostCommand, runHost, writeHostFile } from "../services/HostShell";
import { demultiplexDockerStream, stripAnsiCodes } from "../utils/transformers";
import { handleError } from "../utils/error";

const COMPOSE_BASE = "/srv/compose";

// Matches Docker's own container/project naming rules — no shell metacharacters, no path separators.
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function createShellHandlers(shellService: ShellService, dockerService: DockerService) {
  if (!shellService) throw new Error("Shell service is required");
  if (!dockerService) throw new Error("Docker service is required");

  async function runShell(ctx: Context) {
    const { command } = await ctx.req.json<{ command: string }>();
    const result = await shellService.exec(hostCommand(command), { timeout: 120_000 });
    return ctx.json({
      output: result.output,
      error: result.error,
      exit_code: result.exitCode,
    });
  }

  async function runCompose(ctx: Context) {
    const { project, compose, env } = await ctx.req.json<{
      project: string;
      compose: string;
      env?: Record<string, string>;
    }>();

    if (!SAFE_NAME.test(project)) {
      return ctx.json({ error: "Invalid project name" }, 400);
    }

    const dir = join(COMPOSE_BASE, project);
    runHost(`mkdir -p '${dir}'`);

    writeHostFile(join(dir, "docker-compose.yml"), compose);

    if (env && Object.keys(env).length > 0) {
      const envContent = Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      writeHostFile(join(dir, ".env"), envContent);
    }

    const result = await shellService.exec(
      hostCommand(`sh -c "cd '${dir}' && docker compose -p '${project}' up -d"`),
      { timeout: 300_000 },
    );

    return ctx.json({
      output: result.output,
      error: result.error,
      exit_code: result.exitCode,
    });
  }

  async function execContainer(ctx: Context) {
    const { container, command } = await ctx.req.json<{
      container: string;
      command: string;
    }>();

    if (!SAFE_NAME.test(container)) {
      return ctx.json({ error: "Invalid container name" }, 400);
    }

    try {
      // Goes through dockerode's exec API directly rather than shelling out
      // to `docker exec` — the agent image doesn't (and shouldn't need to)
      // carry the docker CLI, only the socket.
      const dockerContainer = dockerService.docker.getContainer(container);

      const exec = await dockerContainer.exec({
        Cmd: ["sh", "-c", command],
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }

      const { stdout, stderr } = demultiplexDockerStream(Buffer.concat(chunks));
      const { ExitCode } = await exec.inspect();

      return ctx.json({
        output: stripAnsiCodes(stdout).trim(),
        error: stripAnsiCodes(stderr).trim(),
        exit_code: ExitCode,
      });
    } catch (err) {
      return handleError(ctx, err, "Shell", "exec container", { container });
    }
  }

  return { runShell, runCompose, execContainer };
}
