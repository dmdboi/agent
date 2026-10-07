import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { WatcherService } from "../../src/services/Watcher";
import { createDockerMock } from "../helpers/dockerMockFactory";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));
vi.mock("../../src/services/Http", () => ({
  httpService: { postSafe: vi.fn().mockResolvedValue(true) },
}));

import { httpService } from "../../src/services/Http";
import { MANAGED_LABEL_KEYS } from "../../src/utils/containerIdentity";

function fakeEventStream(): EventEmitter & { destroy: () => void } {
  const stream = new EventEmitter() as EventEmitter & { destroy: () => void };
  stream.destroy = vi.fn();
  return stream;
}

const managedLabels = {
  [MANAGED_LABEL_KEYS.applicationId]: "app-1",
  [MANAGED_LABEL_KEYS.environmentId]: "env-1",
  [MANAGED_LABEL_KEYS.deploymentId]: "dep-1",
  [MANAGED_LABEL_KEYS.workloadRole]: "runtime",
};

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const emitEvent = (stream: EventEmitter, event: Record<string, unknown>): void => {
  stream.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
};

function forwardedPayloads(): any[] {
  return (httpService.postSafe as any).mock.calls.map((call: any[]) => call[0].payload);
}

describe("WatcherService", () => {
  let mockDockerService: any;
  let stream: EventEmitter & { destroy: () => void };

  beforeEach(() => {
    stream = fakeEventStream();
    mockDockerService = createDockerMock({
      docker: { getEvents: vi.fn().mockResolvedValue(stream) } as any,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to dockerode's event stream (not a spawned CLI process) and reaches running state", async () => {
    const watcher = new WatcherService(mockDockerService);

    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockDockerService.docker.getEvents).toHaveBeenCalled();
    expect(watcher.getState()).toBe("running");
  });

  it("forwards a container create event to Core once enriched from the container inspect", async () => {
    mockDockerService.getContainer = vi.fn().mockResolvedValue({
      Id: "abc123",
      Name: "/my-app-container",
      Config: { Image: "nginx:latest", Env: ["CORE_APP_ID=app-1", "CORE_DEPLOYMENT_ID=dep-1"] },
      State: { Status: "running" },
      Created: "2026-01-01T00:00:00Z",
    });

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "container",
          Action: "create",
          Actor: { ID: "abc123", Attributes: {} },
          time: 0,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(httpService.postSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "docker_event",
        payload: expect.objectContaining({
          event: "create",
          id: "abc123",
          attributes: expect.objectContaining({
            application_id: "app-1",
            deployment_id: "dep-1",
          }),
        }),
      }),
    );
  });

  it("enriches an image pull event from the image inspect before forwarding", async () => {
    mockDockerService.getImage = vi.fn().mockResolvedValue({
      Id: "sha256:redis7",
      RepoTags: ["redis:7"],
      RepoDigests: ["redis@sha256:digest"],
      Size: 128_000_000,
      Created: "2026-09-01T00:00:00Z",
    });

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "image",
          Action: "pull",
          Actor: { ID: "redis:7", Attributes: { name: "redis:7" } },
          time: 1_700_000_000,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockDockerService.getImage).toHaveBeenCalledWith("redis:7");
    expect(httpService.postSafe).toHaveBeenCalledWith({
      type: "docker_event",
      payload: {
        event: "pull",
        type: "image",
        id: "redis:7",
        time: 1_700_000_000,
        attributes: {
          docker_id: "sha256:redis7",
          repo_tags: ["redis:7"],
          repo_digests: ["redis@sha256:digest"],
          size: 128_000_000,
          created: "2026-09-01T00:00:00Z",
        },
      },
    });
  });

  it("still forwards an image pull event when the inspect fails", async () => {
    mockDockerService.getImage = vi.fn().mockRejectedValue(new Error("no such image"));

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "image",
          Action: "pull",
          Actor: { ID: "ghost:latest", Attributes: { name: "ghost:latest" } },
          time: 42,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(httpService.postSafe).toHaveBeenCalledWith({
      type: "docker_event",
      payload: {
        event: "pull",
        type: "image",
        id: "ghost:latest",
        time: 42,
        attributes: { name: "ghost:latest" },
      },
    });
  });

  it("forwards an image delete event without an inspect", async () => {
    mockDockerService.getImage = vi.fn();

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "image",
          Action: "delete",
          Actor: { ID: "sha256:gone", Attributes: {} },
          time: 7,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockDockerService.getImage).not.toHaveBeenCalled();
    expect(httpService.postSafe).toHaveBeenCalledWith({
      type: "docker_event",
      payload: { event: "delete", type: "image", id: "sha256:gone", time: 7, attributes: {} },
    });
  });

  it("does not forward image tag events", async () => {
    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Type: "image",
          Action: "tag",
          Actor: { ID: "sha256:x", Attributes: {} },
          time: 1,
          timeNano: 0,
        }) + "\n",
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(httpService.postSafe).not.toHaveBeenCalled();
  });

  it("drops back to stopped when the event stream ends, so scheduleRestart can retry", async () => {
    vi.useFakeTimers();

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(watcher.getState()).toBe("running");

    stream.emit("end");

    expect(watcher.getState()).toBe("stopped");

    // Drain the pending scheduleRestart() timer so it doesn't leak past the test.
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  // --- identity prerequisites -------------------------------------------------

  it("keeps labels-derived identity when the container inspect fails after deletion", async () => {
    mockDockerService.getContainer = vi.fn().mockRejectedValue(new Error("No such container"));

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    emitEvent(stream, {
      Type: "container",
      Action: "create",
      Actor: { ID: "deadbeef", Attributes: { ...managedLabels, image: "ghcr.io/acme/app:1" } },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_123_456_789,
    });

    await flush();

    const [payload] = forwardedPayloads();
    expect(payload.attributes).toMatchObject({
      application_id: "app-1",
      environment_id: "env-1",
      deployment_id: "dep-1",
      workload_role: "runtime",
    });
    expect(payload.event).toBe("create");
  });

  it("surfaces identity from event attributes for start/die/destroy without inspecting", async () => {
    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    for (const action of ["start", "die", "destroy"]) {
      emitEvent(stream, {
        Type: "container",
        Action: action,
        Actor: { ID: "deadbeef", Attributes: { ...managedLabels } },
        time: 1_700_000_000,
        timeNano: 1_700_000_000_100_000_000,
      });
    }

    await flush();

    expect(mockDockerService.getContainer).not.toHaveBeenCalled();
    expect(forwardedPayloads().map(p => p.event)).toEqual(["start", "die", "destroy"]);
    for (const payload of forwardedPayloads()) {
      expect(payload.attributes).toMatchObject({
        application_id: "app-1",
        deployment_id: "dep-1",
        workload_role: "runtime",
      });
    }
  });

  it("distinguishes prestep workloads from runtime workloads by label", async () => {
    mockDockerService.getContainer = vi.fn().mockResolvedValue({
      Id: "prestep1",
      Name: "/prestep",
      Config: { Image: "app:1", Env: [], Labels: { ...managedLabels, [MANAGED_LABEL_KEYS.workloadRole]: "prestep" } },
      State: { Status: "created" },
      Created: "2026-01-01T00:00:00Z",
    });

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    emitEvent(stream, {
      Type: "container",
      Action: "create",
      Actor: { ID: "prestep1", Attributes: { ...managedLabels, [MANAGED_LABEL_KEYS.workloadRole]: "prestep" } },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_100_000_002,
    });

    await flush();

    expect(forwardedPayloads()[0].attributes.workload_role).toBe("prestep");
  });

  it("never forwards container environment secrets", async () => {
    mockDockerService.getContainer = vi.fn().mockResolvedValue({
      Id: "abc123",
      Name: "/app",
      Config: {
        Image: "app:1",
        Env: ["CORE_APP_ID=app-1", "DB_PASSWORD=super-secret-value", "API_KEY=another-secret"],
        Labels: {},
      },
      State: { Status: "running" },
      Created: "2026-01-01T00:00:00Z",
    });

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    emitEvent(stream, {
      Type: "container",
      Action: "create",
      Actor: { ID: "abc123", Attributes: {} },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_100_000_003,
    });

    await flush();

    const serialised = JSON.stringify(forwardedPayloads()[0]);
    expect(serialised).not.toContain("super-secret-value");
    expect(serialised).not.toContain("another-secret");
    expect(forwardedPayloads()[0].attributes.application_id).toBe("app-1");
  });

  // --- exact timestamps -------------------------------------------------------

  it("preserves an exact timeNano above 2^53 from a chunk split across boundaries", async () => {
    // Built as literal text: JSON.stringify on a JS number would round the
    // 19-digit value before it ever reached the watcher.
    const raw =
      '{"Type":"container","Action":"start","Actor":{"ID":"abc123","Attributes":{}},"time":1700000000,"timeNano":1700000000123456789}';

    // Split inside the 19-digit timestamp so extraction must work on the raw text.
    const splitAt = raw.indexOf("1700000000123456789") + 5;

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit("data", Buffer.from(raw.slice(0, splitAt)));
    stream.emit("data", Buffer.from(`${raw.slice(splitAt)}\n`));

    await flush();

    const [payload] = forwardedPayloads();
    expect(payload.timeNano).toBe("1700000000123456789");
    // The same value parsed as a JS number and re-stringified is demonstrably wrong.
    expect(String(Number("1700000000123456789"))).not.toBe("1700000000123456789");
    expect(payload.event_id).toBe("container:start:abc123:1700000000123456789");
    expect(payload.time).toBe(1_700_000_000);
  });

  it("does not invent a timeNano when Docker omits or zeroes it", async () => {
    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    emitEvent(stream, {
      Type: "container",
      Action: "start",
      Actor: { ID: "abc123", Attributes: {} },
      time: 1_700_000_000,
      timeNano: 0,
    });

    await flush();

    const [payload] = forwardedPayloads();
    expect(payload).not.toHaveProperty("timeNano");
    expect(payload.event_id).toBe("container:start:abc123:1700000000");
  });

  it("splits the raw event image and tag when the create inspect fails", async () => {
    mockDockerService.getContainer = vi.fn().mockRejectedValue(new Error("gone"));

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await flush();

    emitEvent(stream, {
      Type: "container",
      Action: "create",
      Actor: { ID: "c1", Attributes: { image: "registry.local:5000/acme/app:1.2", name: "app-1", ...managedLabels } },
      time: 1,
      timeNano: 100_000_000_000_070,
    });
    await flush();

    const attributes = forwardedPayloads()[0].attributes;
    expect(attributes.image).toBe("registry.local:5000/acme/app");
    expect(attributes.tag).toBe("1.2");
    expect(attributes.name).toBe("app-1");
  });
});
