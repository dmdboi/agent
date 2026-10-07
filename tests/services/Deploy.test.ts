import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "stream";

import { DeployService, DeployOptions } from "../../src/services/Deploy";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/Http", () => ({ httpService: { post: postMock } }));

function makeDocker(overrides: Record<string, unknown> = {}) {
  return {
    checkImageExists: vi.fn().mockResolvedValue(true),
    pullImage: vi.fn().mockResolvedValue(undefined),
    createContainer: vi.fn().mockResolvedValue({ id: "new-container-000000000000" }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    getContainer: vi.fn().mockResolvedValue({
      State: { Status: "running", Running: true, Restarting: false },
      NetworkSettings: { Networks: { traefik: { IPAddress: "172.20.0.5" } } },
    }),
    docker: { createContainer: vi.fn() },
    ...overrides,
  };
}

function baseOptions(over: Partial<DeployOptions> = {}): DeployOptions {
  return {
    deploymentId: "dep_1",
    strategy: "rolling",
    container: { name: "app-1", image: "ghcr.io/acme/app:1", networks: ["traefik"] },
    health: { path: "/up", port: 8000, timeoutSeconds: 5, intervalSeconds: 1 },
    retire: ["old-container-1"],
    ...over,
  };
}

describe("DeployService", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rolling: creates the new container, health-gates it, retires the old, reports completed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const docker = makeDocker();

    await new DeployService(docker as never).deploy(baseOptions());

    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ name: "app-1", Image: "ghcr.io/acme/app:1" }));
    expect(docker.startContainer).toHaveBeenCalledWith("new-container-000000000000");
    expect(docker.stopContainer).toHaveBeenCalledWith("old-container-1", 140);
    expect(docker.removeContainer).toHaveBeenCalledWith("old-container-1", true);
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "deployment_status", deploymentId: "dep_1", status: "completed", retired: ["old-container-1"], discarded: [] }),
    );
  });

  it("uses stopGraceSeconds to override the default stop grace when retiring", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const docker = makeDocker();

    await new DeployService(docker as never).deploy(baseOptions({ stopGraceSeconds: 15 }));

    expect(docker.stopContainer).toHaveBeenCalledWith("old-container-1", 15);
  });

  it("honours an explicit stopGraceSeconds of 0 (kill with no grace)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const docker = makeDocker();

    await new DeployService(docker as never).deploy(baseOptions({ stopGraceSeconds: 0 }));

    expect(docker.stopContainer).toHaveBeenCalledWith("old-container-1", 0);
  });

  it("rolling: an unhealthy new container is discarded, the old one is left running, reports rolled_back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const docker = makeDocker();

    await new DeployService(docker as never).deploy(baseOptions({ health: { path: "/up", port: 8000, timeoutSeconds: 0, intervalSeconds: 1 } }));

    expect(docker.stopContainer).toHaveBeenCalledWith("new-container-000000000000", 10);
    expect(docker.removeContainer).toHaveBeenCalledWith("new-container-000000000000", true);
    expect(docker.stopContainer).not.toHaveBeenCalledWith("old-container-1", expect.anything());
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rolled_back",
        error: expect.any(String),
        retired: [],
        discarded: ["new-container-000000000000"],
      }),
    );
  });

  it("recreate: stops the old container before creating the new one, removes it only once healthy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const docker = makeDocker();

    await new DeployService(docker as never).deploy(baseOptions({ strategy: "recreate" }));

    expect(docker.stopContainer).toHaveBeenCalledWith("old-container-1", 140);
    expect(docker.stopContainer.mock.invocationCallOrder[0]).toBeLessThan(docker.createContainer.mock.invocationCallOrder[0]);
    expect(docker.removeContainer).toHaveBeenCalledWith("old-container-1", true);
    expect(docker.removeContainer.mock.invocationCallOrder[0]).toBeGreaterThan(docker.createContainer.mock.invocationCallOrder[0]);
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", retired: ["old-container-1"], discarded: [] }),
    );
  });

  it("recreate: a failed health check restores the old container and reports rolled_back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const docker = makeDocker();

    await new DeployService(docker as never).deploy(
      baseOptions({ strategy: "recreate", health: { path: "/up", port: 8000, timeoutSeconds: 0, intervalSeconds: 1 } }),
    );

    expect(docker.removeContainer).not.toHaveBeenCalledWith("old-container-1", expect.anything());
    expect(docker.startContainer).toHaveBeenCalledWith("old-container-1");
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rolled_back",
        retired: [],
        discarded: ["new-container-000000000000"],
      }),
    );
  });

  it("recreate: a failed health check reports failed when the old container cannot be restored", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const docker = makeDocker({
      startContainer: vi.fn().mockImplementation((id: string) => {
        if (id === "old-container-1") {
          return Promise.reject(new Error("no such container"));
        }

        return Promise.resolve(undefined);
      }),
    });

    await new DeployService(docker as never).deploy(
      baseOptions({ strategy: "recreate", health: { path: "/up", port: 8000, timeoutSeconds: 0, intervalSeconds: 1 } }),
    );

    expect(docker.startContainer).toHaveBeenCalledWith("old-container-1");
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", retired: [], discarded: ["new-container-000000000000"] }),
    );
  });

  it("recreate: a throw after the old container is stopped restarts it", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const docker = makeDocker({ createContainer: vi.fn().mockRejectedValue(new Error("image pull failed")) });

    await new DeployService(docker as never).deploy(baseOptions({ strategy: "recreate" }));

    expect(docker.stopContainer).toHaveBeenCalledWith("old-container-1", 140);
    expect(docker.startContainer).toHaveBeenCalledWith("old-container-1");
    expect(docker.removeContainer).not.toHaveBeenCalledWith("old-container-1", expect.anything());
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "image pull failed", retired: [], discarded: [] }),
    );
  });

  it("prestep: a non-zero pre-step aborts before any swap and reports failed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const stream = new PassThrough();
    stream.end();
    const oneShot = {
      attach: vi.fn().mockResolvedValue(stream),
      start: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue({ StatusCode: 1 }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const docker = makeDocker({ docker: { createContainer: vi.fn().mockResolvedValue(oneShot) } });

    await new DeployService(docker as never).deploy(baseOptions({ prestep: { run: true, command: ["php", "artisan", "migrate", "--pretend"] } }));

    expect(oneShot.remove).toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", retired: [], discarded: [] }),
    );
  });

  it("a thrown error reports failed with no retired or discarded containers", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const docker = makeDocker({ createContainer: vi.fn().mockRejectedValue(new Error("image pull failed")) });

    await new DeployService(docker as never).deploy(baseOptions());

    expect(docker.stopContainer).not.toHaveBeenCalledWith("old-container-1", expect.anything());
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: "image pull failed",
        retired: [],
        discarded: [],
      }),
    );
  });

  it("a container that fails to be removed is kept out of the retired list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const docker = makeDocker({ removeContainer: vi.fn().mockRejectedValue(new Error("remove failed")) });

    await new DeployService(docker as never).deploy(baseOptions());

    expect(docker.removeContainer).toHaveBeenCalledWith("old-container-1", true);
    expect(postMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", retired: [], discarded: [] }),
    );
  });

  it("prestep: a passing pre-step proceeds with the swap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const stream = new PassThrough();
    stream.end();
    const oneShot = {
      attach: vi.fn().mockResolvedValue(stream),
      start: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const docker = makeDocker({ docker: { createContainer: vi.fn().mockResolvedValue(oneShot) } });

    await new DeployService(docker as never).deploy(baseOptions({ retire: [], prestep: { run: true, command: ["true"] } }));

    expect(docker.createContainer).toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("with no health check, accepts a container that stays running", async () => {
    vi.useFakeTimers();
    const docker = makeDocker();

    const pending = new DeployService(docker as never).deploy(baseOptions({ health: undefined, retire: [] }));
    await vi.runAllTimersAsync();
    await pending;

    expect(postMock).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("with no health check, rolls back a container that is not running", async () => {
    vi.useFakeTimers();
    const docker = makeDocker({ getContainer: vi.fn().mockResolvedValue({ State: { Running: false, Restarting: false } }) });

    const pending = new DeployService(docker as never).deploy(baseOptions({ health: undefined }));
    await vi.runAllTimersAsync();
    await pending;

    expect(docker.stopContainer).toHaveBeenCalledWith("new-container-000000000000", 10);
    expect(docker.stopContainer).not.toHaveBeenCalledWith("old-container-1", expect.anything());
    expect(postMock).toHaveBeenCalledWith(expect.objectContaining({ status: "rolled_back" }));
  });

  it("retries the status callback with backoff before giving up", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    postMock.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(undefined);
    vi.useFakeTimers();
    const docker = makeDocker();

    const pending = new DeployService(docker as never).deploy(baseOptions({ retire: [] }));
    await vi.runAllTimersAsync();
    await pending;

    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("stamps managed identity labels on the runtime container", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const docker = makeDocker();

    await new DeployService(docker as never).deploy(
      baseOptions({
        retire: [],
        container: {
          name: "app-1",
          image: "app:1",
          networks: ["traefik"],
          environment: ["CORE_APP_ID=app-1", "CORE_ENV_ID=env-1"],
          labels: { "traefik.enable": "true" },
        },
      }),
    );

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Labels: expect.objectContaining({
          "traefik.enable": "true",
          "io.serversinc.agent.application_id": "app-1",
          "io.serversinc.agent.environment_id": "env-1",
          "io.serversinc.agent.deployment_id": "dep_1",
          "io.serversinc.agent.workload_role": "runtime",
        }),
      }),
    );
  });

  it("marks only the pre-step container as a prestep workload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const stream = new PassThrough();
    stream.end();
    const oneShot = {
      attach: vi.fn().mockResolvedValue(stream),
      start: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const prestepCreate = vi.fn().mockResolvedValue(oneShot);
    const docker = makeDocker({ docker: { createContainer: prestepCreate } });

    await new DeployService(docker as never).deploy(
      baseOptions({
        retire: [],
        prestep: { run: true, command: ["true"] },
        container: {
          name: "app-1",
          image: "app:1",
          networks: ["traefik"],
          environment: ["CORE_APP_ID=app-1"],
          labels: { "traefik.enable": "true" },
        },
      }),
    );

    expect(prestepCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        Labels: {
          "io.serversinc.agent.application_id": "app-1",
          "io.serversinc.agent.deployment_id": "dep_1",
          "io.serversinc.agent.workload_role": "prestep",
        },
      }),
    );
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Labels: expect.objectContaining({ "io.serversinc.agent.workload_role": "runtime" }),
      }),
    );
  });
});
