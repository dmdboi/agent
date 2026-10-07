import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { WatcherService } from "../../src/services/Watcher";
import { createDockerMock } from "../helpers/dockerMockFactory";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));
vi.mock("../../src/services/Http", () => ({
  httpService: { postSafe: vi.fn().mockResolvedValue(true) },
}));

import { httpService } from "../../src/services/Http";
import { warn, error as consoleError } from "../../src/utils/console";
import { MANAGED_LABEL_KEYS } from "../../src/utils/containerIdentity";

function fakeEventStream(): EventEmitter & { destroy: () => void } {
  const stream = new EventEmitter() as EventEmitter & { destroy: () => void };
  stream.destroy = vi.fn();
  return stream;
}

/** A promise whose settlement the test controls, for a deliberately slow inspect. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

/** Drain many scheduler batches (real-timer tests). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }

  await new Promise(resolve => setTimeout(resolve, 0));

  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
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
    (httpService.postSafe as any).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
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
    // Environment-based identity fields stay present even when the inspect fails.
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

  it("keeps a legacy container's identity from the create inspect on a later destroy", async () => {
    // No managed labels (legacy container); only the env fallback carries identity.
    mockDockerService.getContainer = vi.fn().mockResolvedValue({
      Id: "legacy1",
      Name: "/legacy",
      Config: { Image: "legacy:1", Env: ["CORE_APP_ID=app-9", "CORE_DEPLOYMENT_ID=dep-9"] },
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
      Actor: { ID: "legacy1", Attributes: {} },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_100_000_001,
    });
    await flush();

    // Container is gone by the destroy: no inspect, no labels on the event.
    emitEvent(stream, {
      Type: "container",
      Action: "destroy",
      Actor: { ID: "legacy1", Attributes: {} },
      time: 1_700_000_010,
      timeNano: 1_700_000_010_100_000_000,
    });
    await flush();

    const destroy = forwardedPayloads().at(-1)!;
    expect(destroy.event).toBe("destroy");
    expect(destroy.attributes).toMatchObject({
      application_id: "app-9",
      deployment_id: "dep-9",
    });
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

  // --- exact timestamps and identity -----------------------------------------

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

  it("dedupes a replayed event id from a reconnect overlap", async () => {
    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    const event = {
      Type: "container",
      Action: "start",
      Actor: { ID: "abc123", Attributes: {} },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_123_456_789,
    };

    emitEvent(stream, event);
    emitEvent(stream, event);
    await flush();

    expect(httpService.postSafe).toHaveBeenCalledTimes(1);
  });

  // --- ordering ---------------------------------------------------------------

  it("processes create/start/die/destroy in order for one container despite a delayed create inspect", async () => {
    const inspect = deferred<any>();
    mockDockerService.getContainer = vi.fn().mockReturnValue(inspect.promise);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await Promise.resolve();
    await Promise.resolve();

    const at = (action: string, nano: number) =>
      emitEvent(stream, {
        Type: "container",
        Action: action,
        Actor: { ID: "abc123", Attributes: { ...managedLabels } },
        time: 1_700_000_000,
        timeNano: nano,
      });

    at("create", 1_700_000_000_100_000_000);
    at("start", 1_700_000_000_200_000_000);
    at("die", 1_700_000_000_300_000_000);
    at("destroy", 1_700_000_000_400_000_000);

    // Nothing beyond the create can be delivered while the inspect is outstanding.
    await flush();
    expect(forwardedPayloads().map(p => p.event)).toEqual([]);

    inspect.resolve({
      Id: "abc123",
      Name: "/app",
      Config: { Image: "app:1", Env: [] },
      State: { Status: "created" },
      Created: "2026-01-01T00:00:00Z",
    });

    await flush();

    expect(forwardedPayloads().map(p => p.event)).toEqual(["create", "start", "die", "destroy"]);
  });

  // --- bounded delivery retries ----------------------------------------------

  it("retries a transient webhook failure with an identical payload and event id", async () => {
    vi.useFakeTimers();
    (httpService.postSafe as any).mockReset();
    (httpService.postSafe as any).mockResolvedValueOnce(false).mockResolvedValue(true);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    emitEvent(stream, {
      Type: "container",
      Action: "die",
      Actor: { ID: "abc123", Attributes: { ...managedLabels } },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_123_456_789,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(httpService.postSafe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(httpService.postSafe).toHaveBeenCalledTimes(2);

    const calls = (httpService.postSafe as any).mock.calls;
    expect(calls[0][0].payload).toBe(calls[1][0].payload);
    expect(calls[0][0].payload.event_id).toBe(calls[1][0].payload.event_id);
    expect(calls[0][0].payload.attributes).toMatchObject({ application_id: "app-1" });
  });

  it("drops an event after a bounded number of failed attempts", async () => {
    vi.useFakeTimers();
    (httpService.postSafe as any).mockReset();
    (httpService.postSafe as any).mockResolvedValue(false);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    emitEvent(stream, {
      Type: "container",
      Action: "die",
      Actor: { ID: "abc123", Attributes: {} },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_123_456_789,
    });

    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 100);

    // 1 initial attempt + 3 bounded retries.
    expect(httpService.postSafe).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      "Watcher",
      "Event delivery failed after retries; event dropped",
      expect.objectContaining({ action: "die" }),
    );
  });

  it("cancels pending delivery retries and the stream restart on shutdown", async () => {
    vi.useFakeTimers();
    (httpService.postSafe as any).mockReset();
    (httpService.postSafe as any).mockResolvedValue(false);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    emitEvent(stream, {
      Type: "container",
      Action: "die",
      Actor: { ID: "abc123", Attributes: {} },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_123_456_789,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(httpService.postSafe).toHaveBeenCalledTimes(1);

    stream.emit("end"); // schedules a restart timer while the retry is pending
    watcher.shutdown();
    const getEventsCallsAfterShutdown = mockDockerService.docker.getEvents.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(httpService.postSafe).toHaveBeenCalledTimes(1);
    expect(mockDockerService.docker.getEvents.mock.calls.length).toBe(getEventsCallsAfterShutdown);
    expect(watcher.getState()).toBe("stopped");
  });

  it("reconnects with a bounded `since` overlap after the stream ends", async () => {
    vi.useFakeTimers();

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    emitEvent(stream, {
      Type: "container",
      Action: "start",
      Actor: { ID: "abc123", Attributes: {} },
      time: 1_700_000_123,
      timeNano: 1_700_000_123_123_456_789,
    });
    await vi.advanceTimersByTimeAsync(0);

    stream.emit("end");
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockDockerService.docker.getEvents).toHaveBeenLastCalledWith({ since: 1_700_000_123 });
  });

  // --- bounded scheduler (blocker 1) -----------------------------------------

  it("caps global processing concurrency across many containers and recovers", async () => {
    const inspect = deferred<any>();
    mockDockerService.getContainer = vi.fn().mockReturnValue(inspect.promise);

    const watcher = new WatcherService(mockDockerService, { maxConcurrentProcessing: 2, maxPendingEvents: 100, inspectTimeoutMs: 100_000 });
    watcher.start();
    await flush();

    for (let i = 0; i < 5; i++) {
      emitEvent(stream, {
        Type: "container",
        Action: "create",
        Actor: { ID: `c${i}`, Attributes: {} },
        time: 1,
        timeNano: 100_000_000_000_000 + i,
      });
    }

    await flush();
    expect(mockDockerService.getContainer).toHaveBeenCalledTimes(2);

    inspect.resolve({ Id: "c", Name: "/c", Config: { Image: "app:1", Env: [] }, State: { Status: "running" }, Created: "x" });

    await settle();
    expect(mockDockerService.getContainer).toHaveBeenCalledTimes(5);
    expect(httpService.postSafe).toHaveBeenCalledTimes(5);
  });

  it("processes a single-container burst one event at a time and recovers", async () => {
    const inspect = deferred<any>();
    mockDockerService.getContainer = vi.fn().mockReturnValue(inspect.promise);

    const watcher = new WatcherService(mockDockerService, { maxConcurrentProcessing: 4, maxPendingEvents: 10, inspectTimeoutMs: 100_000 });
    watcher.start();
    await flush();

    emitEvent(stream, { Type: "container", Action: "create", Actor: { ID: "c1", Attributes: {} }, time: 1, timeNano: 100_000_000_000_001 });
    emitEvent(stream, { Type: "container", Action: "start", Actor: { ID: "c1", Attributes: {} }, time: 2, timeNano: 100_000_000_000_002 });
    emitEvent(stream, { Type: "container", Action: "die", Actor: { ID: "c1", Attributes: {} }, time: 3, timeNano: 100_000_000_000_003 });

    await flush();
    expect(mockDockerService.getContainer).toHaveBeenCalledTimes(1);
    expect(httpService.postSafe).not.toHaveBeenCalled();

    inspect.resolve({ Id: "c1", Name: "/c1", Config: { Image: "app:1", Env: [] }, State: { Status: "running" }, Created: "x" });

    await settle();
    expect(forwardedPayloads().map(payload => payload.event)).toEqual(["create", "start", "die"]);
  });

  it("drops events beyond the pending limit and recovers when capacity frees", async () => {
    const inspect = deferred<any>();
    mockDockerService.getContainer = vi.fn().mockReturnValue(inspect.promise);

    const watcher = new WatcherService(mockDockerService, { maxConcurrentProcessing: 1, maxPendingEvents: 2, inspectTimeoutMs: 100_000 });
    watcher.start();
    await flush();

    for (let i = 0; i < 3; i++) {
      emitEvent(stream, { Type: "container", Action: "create", Actor: { ID: `c${i}`, Attributes: {} }, time: 1, timeNano: 100_000_000_000_010 + i });
    }

    await flush();
    expect(warn).toHaveBeenCalledWith("Watcher", "Dropping event: pending queue full", expect.objectContaining({ action: "create" }));
    expect(mockDockerService.getContainer).toHaveBeenCalledTimes(1);

    inspect.resolve({ Id: "c", Name: "/c", Config: { Image: "app:1", Env: [] }, State: { Status: "running" }, Created: "x" });
    await settle();
    expect(mockDockerService.getContainer).toHaveBeenCalledTimes(2);

    // Capacity has freed up again: a later event is accepted.
    emitEvent(stream, { Type: "container", Action: "create", Actor: { ID: "c9", Attributes: {} }, time: 5, timeNano: 100_000_000_000_099 });
    await settle();
    expect(httpService.postSafe).toHaveBeenCalledTimes(3);
  });

  it("times out a stalled inspect and forwards the labels-derived payload", async () => {
    mockDockerService.getContainer = vi.fn().mockReturnValue(new Promise(() => {}));

    const watcher = new WatcherService(mockDockerService, { inspectTimeoutMs: 15 });
    watcher.start();
    await flush();

    emitEvent(stream, { Type: "container", Action: "create", Actor: { ID: "c1", Attributes: { ...managedLabels } }, time: 1, timeNano: 100_000_000_000_020 });

    await new Promise(resolve => setTimeout(resolve, 60));

    const [payload] = forwardedPayloads();
    expect(payload.attributes).toMatchObject({ application_id: "app-1", workload_role: "runtime" });
    expect(mockDockerService.getContainer).toHaveBeenCalledTimes(1);
  });

  it("bounds live hung inspect calls and still forwards label fallbacks", async () => {
    const inspect = deferred<any>();
    mockDockerService.getContainer = vi.fn().mockReturnValue(inspect.promise);

    const watcher = new WatcherService(mockDockerService, { maxConcurrentProcessing: 2, maxPendingEvents: 100, inspectTimeoutMs: 15 });
    watcher.start();
    await flush();

    for (let i = 0; i < 6; i++) {
      emitEvent(stream, {
        Type: "container",
        Action: "create",
        Actor: { ID: `c${i}`, Attributes: { ...managedLabels } },
        time: 1,
        timeNano: 200_000_000_000_000 + i,
      });
    }

    await new Promise(resolve => setTimeout(resolve, 80));

    // The underlying Docker calls never exceed the cap even though every worker
    // timed out and moved on.
    expect(mockDockerService.getContainer).toHaveBeenCalledTimes(2);
    expect(httpService.postSafe).toHaveBeenCalledTimes(6);
    for (const payload of forwardedPayloads()) {
      expect(payload.attributes).toMatchObject({ application_id: "app-1", workload_role: "runtime" });
    }
    expect(consoleError).toHaveBeenCalledWith(
      "Watcher",
      "Failed to enrich event with container details",
      expect.objectContaining({ error: expect.stringContaining("inspect skipped") }),
    );

    // Settling the hung calls releases the slots.
    inspect.resolve({ Id: "c", Name: "/c", Config: { Image: "app:1", Env: [] }, State: { Status: "running" }, Created: "x" });
    await flush();

    emitEvent(stream, { Type: "container", Action: "create", Actor: { ID: "c9", Attributes: { ...managedLabels } }, time: 2, timeNano: 200_000_000_000_099 });
    await flush();
    expect(mockDockerService.getContainer).toHaveBeenCalledTimes(3);
  });

  it("rotates queues so a continuously busy container cannot starve others", async () => {
    const watcher = new WatcherService(mockDockerService, { maxConcurrentProcessing: 1, maxPendingEvents: 100 });
    watcher.start();
    await flush();

    const start = (id: string, nano: number) =>
      emitEvent(stream, { Type: "container", Action: "start", Actor: { ID: id, Attributes: {} }, time: 1, timeNano: nano });

    start("a", 300_000_000_000_001);
    start("a", 300_000_000_000_002);
    start("a", 300_000_000_000_003);
    start("b", 300_000_000_000_009);

    await settle();

    expect(forwardedPayloads().map(payload => payload.id)).toEqual(["a", "a", "b", "a"]);
  });

  // --- stream lifecycle / generations (blocker 2) ----------------------------

  it("destroys a stream that resolves after stop instead of installing it", async () => {
    vi.useFakeTimers();
    const events = deferred<any>();
    mockDockerService.docker.getEvents = vi.fn().mockReturnValue(events.promise);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    watcher.stop();

    const late = fakeEventStream();
    events.resolve(late);
    await vi.advanceTimersByTimeAsync(0);

    expect(late.destroy).toHaveBeenCalled();
    expect(watcher.getState()).toBe("stopped");

    late.emit("end");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockDockerService.docker.getEvents).toHaveBeenCalledTimes(1);
  });

  it("does not restart when a failed start rejects after stop", async () => {
    vi.useFakeTimers();
    const events = deferred<any>();
    mockDockerService.docker.getEvents = vi.fn().mockReturnValue(events.promise);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    watcher.stop();

    events.reject(new Error("docker gone"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(watcher.getState()).toBe("stopped");
    expect(mockDockerService.docker.getEvents).toHaveBeenCalledTimes(1);
  });

  it("a manual start during the reconnect backoff cancels the scheduled restart", async () => {
    vi.useFakeTimers();
    const stream1 = fakeEventStream();
    const stream2 = fakeEventStream();
    const getEvents = vi.fn().mockResolvedValueOnce(stream1).mockResolvedValueOnce(stream2);
    mockDockerService.docker.getEvents = getEvents;

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    stream1.emit("end"); // schedules a reconnect
    watcher.start(); // a manual start supersedes it
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale stream's error and end after a newer start", async () => {
    vi.useFakeTimers();
    const stream1 = fakeEventStream();
    const stream2 = fakeEventStream();
    const getEvents = vi.fn().mockResolvedValueOnce(stream1).mockResolvedValueOnce(stream2);
    mockDockerService.docker.getEvents = getEvents;

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getState()).toBe("running");

    watcher.stop();
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getState()).toBe("running");

    stream1.emit("end");
    stream1.emit("error", new Error("stale"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(watcher.getState()).toBe("running");
    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect when stop() destroys a stream whose destroy emits end", async () => {
    vi.useFakeTimers();
    const s = fakeEventStream();
    s.destroy = vi.fn(() => {
      s.emit("end");
    });
    mockDockerService.docker.getEvents = vi.fn().mockResolvedValue(s);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    watcher.shutdown();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(watcher.getState()).toBe("stopped");
    expect(mockDockerService.docker.getEvents).toHaveBeenCalledTimes(1);
  });

  it("destroys the connection on a stream error exactly once and reconnects once", async () => {
    vi.useFakeTimers();
    const stream1 = fakeEventStream();
    const stream2 = fakeEventStream();
    const getEvents = vi.fn().mockResolvedValueOnce(stream1).mockResolvedValueOnce(stream2);
    mockDockerService.docker.getEvents = getEvents;

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    stream1.emit("error", new Error("boom"));
    expect(stream1.destroy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(stream2.destroy).not.toHaveBeenCalled();
    expect(watcher.getState()).toBe("running");
  });

  it("discards a partial line from a closed stream before reconnecting", async () => {
    vi.useFakeTimers();
    const stream1 = fakeEventStream();
    const stream2 = fakeEventStream();
    mockDockerService.docker.getEvents = vi.fn().mockResolvedValueOnce(stream1).mockResolvedValueOnce(stream2);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    stream1.emit("data", Buffer.from('{"Type":"container","Action":"start","Actor":{"ID":"partial"'));
    stream1.emit("end");
    await vi.advanceTimersByTimeAsync(5000);

    emitEvent(stream2, { Type: "container", Action: "start", Actor: { ID: "fresh", Attributes: {} }, time: 5, timeNano: 5 });
    await vi.advanceTimersByTimeAsync(0);

    expect(forwardedPayloads()).toHaveLength(1);
    expect(forwardedPayloads()[0].id).toBe("fresh");
  });

  // --- delivered vs pending dedup, generations (blocker 3) -------------------

  it("releases a dropped event's dedup marker so a later overlap reattempts", async () => {
    vi.useFakeTimers();
    const postSafe = httpService.postSafe as any;
    postSafe.mockReset();
    postSafe.mockResolvedValue(false);

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    const event = { Type: "container", Action: "die", Actor: { ID: "abc", Attributes: {} }, time: 100, timeNano: 100_000_000_000_000_001 };
    emitEvent(stream, event);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 100);
    expect(postSafe).toHaveBeenCalledTimes(4);

    const stream2 = fakeEventStream();
    mockDockerService.docker.getEvents = vi.fn().mockResolvedValue(stream2);
    stream.emit("end");
    await vi.advanceTimersByTimeAsync(5000);

    postSafe.mockResolvedValue(true);
    emitEvent(stream2, event);
    await vi.advanceTimersByTimeAsync(0);

    expect(postSafe).toHaveBeenCalledTimes(5);
  });

  it("never posts an old generation's event after a stop/restart", async () => {
    vi.useFakeTimers();
    const inspect = deferred<any>();
    mockDockerService.getContainer = vi.fn().mockReturnValue(inspect.promise);

    const watcher = new WatcherService(mockDockerService, { inspectTimeoutMs: 100_000 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    emitEvent(stream, { Type: "container", Action: "create", Actor: { ID: "c1", Attributes: {} }, time: 1, timeNano: 100_000_000_000_030 });
    await vi.advanceTimersByTimeAsync(0);

    watcher.stop();

    const stream2 = fakeEventStream();
    mockDockerService.docker.getEvents = vi.fn().mockResolvedValue(stream2);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    inspect.resolve({ Id: "c1", Name: "/c1", Config: { Image: "app:1", Env: [] }, State: { Status: "running" }, Created: "x" });
    await vi.advanceTimersByTimeAsync(0);
    expect(httpService.postSafe).not.toHaveBeenCalled();

    emitEvent(stream2, { Type: "container", Action: "start", Actor: { ID: "c2", Attributes: {} }, time: 10, timeNano: 100_000_000_000_040 });
    await vi.advanceTimersByTimeAsync(0);
    expect(httpService.postSafe).toHaveBeenCalledTimes(1);
  });

  it("delivers a create that was mid-inspect when the stream reconnected", async () => {
    vi.useFakeTimers();
    const inspect = deferred<any>();
    mockDockerService.getContainer = vi.fn().mockReturnValue(inspect.promise);

    const stream2 = fakeEventStream();
    mockDockerService.docker.getEvents = vi.fn().mockResolvedValueOnce(stream).mockResolvedValueOnce(stream2);

    const watcher = new WatcherService(mockDockerService, { inspectTimeoutMs: 100_000 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    emitEvent(stream, { Type: "container", Action: "create", Actor: { ID: "c1", Attributes: {} }, time: 1, timeNano: 100_000_000_000_050 });
    await vi.advanceTimersByTimeAsync(0);
    expect(httpService.postSafe).not.toHaveBeenCalled();

    stream.emit("end");
    await vi.advanceTimersByTimeAsync(5000);

    inspect.resolve({ Id: "c1", Name: "/c1", Config: { Image: "app:1", Env: [] }, State: { Status: "running" }, Created: "x" });
    await vi.advanceTimersByTimeAsync(0);

    expect(httpService.postSafe).toHaveBeenCalledTimes(1);
  });

  // --- identity precedence and fallbacks (blockers 4-5) ----------------------

  it("prefers event labels over inspect labels over env", async () => {
    mockDockerService.getContainer = vi.fn().mockResolvedValue({
      Id: "c1",
      Name: "/c1",
      Config: {
        Image: "app:1",
        Env: ["CORE_APP_ID=env-app"],
        Labels: { [MANAGED_LABEL_KEYS.applicationId]: "inspect-app" },
      },
      State: { Status: "running" },
      Created: "x",
    });

    const watcher = new WatcherService(mockDockerService);
    watcher.start();
    await flush();

    emitEvent(stream, { Type: "container", Action: "create", Actor: { ID: "c1", Attributes: { [MANAGED_LABEL_KEYS.applicationId]: "event-app" } }, time: 1, timeNano: 100_000_000_000_060 });
    await flush();

    expect(forwardedPayloads()[0].attributes.application_id).toBe("event-app");
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
