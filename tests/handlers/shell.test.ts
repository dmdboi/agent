import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createShellHandlers } from "../../src/controllers/shell";
import { makeApp } from "../helpers/makeApp";
import { createDockerMock } from "../helpers/dockerMockFactory";
import { makeDockerMuxedBuffer } from "../helpers/streams";
import { ShellService } from "../../src/services/Shell";

vi.mock("../../src/services/Docker");
vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));
vi.mock("../../src/services/HostShell", () => ({
  hostCommand: vi.fn((cmd: string) => `nsenter -t 1 -m -u -i -n -p -- ${cmd}`),
  runHost: vi.fn(),
  writeHostFile: vi.fn(),
}));

describe("Shell Handlers — runShell / runCompose", () => {
  let server: import("http").Server;
  let mockDockerService: any;
  let mockShellService: ShellService;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDockerService = createDockerMock();
    mockShellService = new ShellService();
    vi.spyOn(mockShellService, "exec").mockResolvedValue({ output: "ok", error: "", exitCode: 0 });
    const handlers = createShellHandlers(mockShellService, mockDockerService);
    const s = await makeApp(
      app => {
        app.post("/run-shell", handlers.runShell);
        app.post("/run-compose", handlers.runCompose);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  it("routes runShell through the host's PID namespace, not the container's own", async () => {
    const { hostCommand } = await import("../../src/services/HostShell");

    const response = await request(server).post("/run-shell").send({ command: "docker image prune -af" });

    expect(response.status).toBe(200);
    expect(hostCommand).toHaveBeenCalledWith("docker image prune -af");
    expect(mockShellService.exec).toHaveBeenCalledWith(
      "nsenter -t 1 -m -u -i -n -p -- docker image prune -af",
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("writes the compose project to the host filesystem and runs docker compose in the host namespace", async () => {
    const { runHost, writeHostFile, hostCommand } = await import("../../src/services/HostShell");

    const response = await request(server)
      .post("/run-compose")
      .send({ project: "my-app", compose: "services:\n  web:\n    image: nginx\n" });

    expect(response.status).toBe(200);
    expect(runHost).toHaveBeenCalledWith(expect.stringContaining("mkdir -p"));
    expect(writeHostFile).toHaveBeenCalledWith(
      expect.stringContaining("my-app/docker-compose.yml"),
      "services:\n  web:\n    image: nginx\n",
    );
    expect(hostCommand).toHaveBeenCalledWith(expect.stringContaining("docker compose -p 'my-app' up -d"));
  });

  it("rejects unsafe compose project names", async () => {
    const response = await request(server)
      .post("/run-compose")
      .send({ project: "../etc", compose: "services: {}" });

    expect(response.status).toBe(400);
  });
});

describe("Shell Handlers — execContainer", () => {
  let server: import("http").Server;
  let mockDockerService: any;
  let mockShellService: ShellService;
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockDockerService = createDockerMock();
    mockShellService = new ShellService();
    const handlers = createShellHandlers(mockShellService, mockDockerService);
    const s = await makeApp(
      app => {
        app.post("/exec-container", handlers.execContainer);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
  });

  it("runs the command via dockerode exec, not a shelled-out docker CLI", async () => {
    const buf = makeDockerMuxedBuffer("accepting connections\n", "");
    const mockExec = {
      start: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          yield buf;
        },
      }),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    };
    const mockContainer = { exec: vi.fn().mockResolvedValue(mockExec) };
    mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

    const response = await request(server)
      .post("/exec-container")
      .send({ container: "postgres-16", command: "pg_isready -U postgres" });

    expect(response.status).toBe(200);
    expect(response.body.output).toBe("accepting connections");
    expect(response.body.exit_code).toBe(0);
    expect(mockDockerService.docker.getContainer).toHaveBeenCalledWith("postgres-16");
    expect(mockContainer.exec).toHaveBeenCalledWith({
      Cmd: ["sh", "-c", "pg_isready -U postgres"],
      AttachStdout: true,
      AttachStderr: true,
    });
  });

  it("returns a non-zero exit code without treating it as a request error", async () => {
    const buf = makeDockerMuxedBuffer("", "not ready\n");
    const mockExec = {
      start: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          yield buf;
        },
      }),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 1 }),
    };
    const mockContainer = { exec: vi.fn().mockResolvedValue(mockExec) };
    mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

    const response = await request(server)
      .post("/exec-container")
      .send({ container: "postgres-16", command: "pg_isready -U postgres" });

    expect(response.status).toBe(200);
    expect(response.body.exit_code).toBe(1);
    expect(response.body.error).toBe("not ready");
  });

  it("rejects unsafe container names", async () => {
    const response = await request(server)
      .post("/exec-container")
      .send({ container: "../etc/passwd", command: "ls" });

    expect(response.status).toBe(400);
  });

  it("handles exec errors", async () => {
    const mockContainer = { exec: vi.fn().mockRejectedValue(new Error("Container not found")) };
    mockDockerService.docker.getContainer.mockReturnValue(mockContainer);

    const response = await request(server)
      .post("/exec-container")
      .send({ container: "postgres-16", command: "ls" });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Container not found");
  });
});
