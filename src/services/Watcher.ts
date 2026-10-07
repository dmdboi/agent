import { error, info, warn } from "../utils/console";
import { httpService } from "./Http";
import { DockerService } from "./Docker";
import {
  ContainerIdentity,
  hasIdentity,
  identityFromEnv,
  identityFromLabels,
  identityToAttributes,
  mergeIdentity,
} from "../utils/containerIdentity";

interface DockerEvent {
  Type: "container" | "image" | "volume" | "network" | "plugin" | string;
  Action: string;
  Actor: {
    ID: string;
    Attributes: Record<string, string>;
  };
  time: number;
  timeNano: number;
  scope?: "local" | "swarm";
  status?: string;
}

interface EventPayload {
  event: string;
  type: string;
  id: string;
  time: number;
  /** Exact decimal nanosecond timestamp, kept as a string (see extractTimeNano). */
  timeNano?: string;
  /** Stable identity for one occurrence: type + action + Docker id + occurrence. */
  event_id?: string;
  attributes: Record<string, unknown>;
}

interface RetryTimer {
  timer: NodeJS.Timeout;
  resolve: (delivered: boolean) => void;
}

interface QueuedEvent {
  event: DockerEvent;
  timeNano: string | null;
  eventId: string | null;
  /** The exact id used for dedupe; null when only a second-precision id exists. */
  dedupeId: string | null;
  /** The lifecycle this event was accepted under; invalidated by shutdown. */
  lifecycle: number;
}

interface ContainerQueue {
  items: QueuedEvent[];
  active: boolean;
}

export interface WatcherOptions {
  /** Total queued + active events allowed before new ones are dropped. */
  maxPendingEvents?: number;
  /** Events processed (inspect + post) concurrently across all containers. */
  maxConcurrentProcessing?: number;
  /** A single container/image inspect may not pin a worker longer than this. */
  inspectTimeoutMs?: number;
}

type WatcherState = "stopped" | "starting" | "running" | "stopping";

export class WatcherService {
  public readonly name = "Watcher";

  private readonly docker: DockerService;
  private eventStream: NodeJS.ReadableStream | null = null;
  private buffer = "";
  private state: WatcherState = "stopped";

  private readonly maxBufferSize = 1024 * 1024; // 1MB max buffer
  private readonly initialRetryDelay = 5000;
  private readonly maxRetryDelay = 60000;
  private retryCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  /** True while the watcher is wanted; false only after stop()/shutdown(). */
  private desiredRunning = false;
  /** Increments only on intentional shutdown, invalidating queued deliveries. */
  private lifecycle = 0;
  /** Increments on every start()/stop(), invalidating stale getEvents promises. */
  private connectAttempt = 0;

  /**
   * Bounded scheduler. Each container has a FIFO queue processed one event at a
   * time (preserving create → start → die → destroy order), while a global
   * worker cap bounds concurrent inspects/posts across all containers. Total
   * queued + active events is capped, so a burst cannot grow memory or open an
   * unbounded number of Docker/HTTP calls.
   */
  private readonly queues = new Map<string, ContainerQueue>();
  private pendingCount = 0;
  private activeCount = 0;
  private readonly maxPendingEvents: number;
  private readonly maxConcurrentProcessing: number;
  private readonly inspectTimeoutMs: number;

  /**
   * Ids with an event queued or in flight. A second copy of the same event is
   * ignored while the first is pending.
   */
  private readonly pendingEventIds = new Set<string>();

  /**
   * Ids whose event was successfully delivered — the only ids that suppress a
   * Docker reconnect overlap. A dropped event releases its pending marker and is
   * never added here, so a later overlap can reattempt it.
   */
  private readonly deliveredEventIds = new Set<string>();
  private readonly deliveredEventIdOrder: string[] = [];
  private readonly maxDeliveredEventIds = 4096;

  /**
   * Identity learned from a create inspect or a labelled event, keyed by
   * container id. This is the only way a legacy (env-only) container keeps its
   * identity after it is gone and an inspect is no longer possible.
   */
  private readonly identityCache = new Map<string, ContainerIdentity>();
  private readonly maxIdentityCacheEntries = 2048;

  private lastEventSince = 0;

  /** In-flight delivery backoff timers, cancelled on stop/shutdown. */
  private readonly retryTimers = new Set<RetryTimer>();

  /**
   * Live underlying Docker inspect requests, including ones we have stopped
   * waiting on. A timed-out inspect is not cancellable, so its slot is held
   * until it settles; once the cap is reached further enrichment is skipped and
   * the label fallback is forwarded instead.
   */
  private outstandingInspections = 0;

  /** Backpressure on delivery backoff; beyond this the event is dropped. */
  private readonly maxPendingRetries = 1000;

  private readonly retryDelays = [1000, 2000, 4000];

  constructor(dockerService: DockerService, options: WatcherOptions = {}) {
    this.docker = dockerService;
    this.maxPendingEvents = options.maxPendingEvents ?? 1000;
    this.maxConcurrentProcessing = options.maxConcurrentProcessing ?? 8;
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? 5000;
  }

  // Start watching the Docker events. Uses dockerode's own `/events` stream
  // (the same client already used for every other Docker call) rather than
  // shelling out to a `docker` CLI binary — the agent image doesn't ship one,
  // so the previous spawn-based approach never actually ran.
  start(): void {
    if (this.desiredRunning && (this.state === "running" || this.state === "starting")) {
      info(this.name, "Docker event watcher already running or starting");
      return;
    }

    this.desiredRunning = true;
    this.state = "starting";

    // A manual start supersedes a scheduled reconnect, so only one stream lives.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const attempt = ++this.connectAttempt;

    const events = this.lastEventSince > 0
      ? this.docker.docker.getEvents({ since: this.lastEventSince })
      : this.docker.docker.getEvents();

    events
      .then(stream => {
        // The promise may resolve after a stop()/restart(); never install a
        // stream whose attempt is no longer current.
        if (!this.desiredRunning || attempt !== this.connectAttempt) {
          this.destroyStream(stream);
          return;
        }

        this.installStream(stream, attempt);
      })
      .catch(err => {
        if (!this.desiredRunning || attempt !== this.connectAttempt) {
          return;
        }

        error(this.name, "Failed to start watcher", { error: (err as Error).message });
        this.state = "stopped";
        this.scheduleRestart();
      });
  }

  private installStream(stream: NodeJS.ReadableStream, attempt: number): void {
    this.eventStream = stream;

    const isCurrent = (): boolean => attempt === this.connectAttempt && this.eventStream === stream;

    stream.on("data", chunk => {
      if (!isCurrent()) {
        return;
      }

      this.handleChunk(chunk as Buffer);
    });

    stream.on("error", err => {
      if (!isCurrent()) {
        return;
      }

      error(this.name, "Docker events stream error", { error: (err as Error).message });
      this.onStreamClosed();
    });

    stream.on("end", () => {
      if (!isCurrent()) {
        return;
      }

      warn(this.name, "Docker events stream ended");
      this.onStreamClosed();
    });

    this.state = "running";
    this.retryCount = 0; // Reset retry count on successful start
    info(this.name, "Docker event watcher started successfully", {
      since: this.lastEventSince > 0 ? this.lastEventSince : undefined,
    });
  }

  /**
   * A stream failure/end while we still want to run schedules a reconnect.
   * Queued deliveries are not dropped here — delivery is independent of the
   * Docker stream and must survive a reconnect. The old connection is destroyed
   * (after clearing its identity, so a late `end` it emits is ignored) rather
   * than left live.
   */
  private onStreamClosed(): void {
    const stream = this.eventStream;
    this.eventStream = null;
    this.buffer = "";
    this.state = "stopped";

    if (stream) {
      this.destroyStream(stream);
    }

    if (this.desiredRunning) {
      this.scheduleRestart();
    }
  }

  private destroyStream(stream: NodeJS.ReadableStream): void {
    try {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    } catch {
      // A stream that is already gone needs no cleanup.
    }
  }

  // Stop watching the Docker events
  stop(): void {
    if (this.state !== "stopped") {
      info(this.name, "Stopping Docker event watcher");
    }

    this.desiredRunning = false;
    // Invalidate every queued delivery and any in-flight getEvents promise.
    this.lifecycle++;
    this.connectAttempt++;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.cancelRetryTimers();

    const stream = this.eventStream;
    this.eventStream = null;

    if (stream) {
      // Cleared above, so a late `end` from this stream is already stale.
      this.destroyStream(stream);
    }

    this.buffer = "";
    this.state = "stopped";

    // Flush queued items now: they see the new lifecycle and are dropped,
    // releasing their pending dedup markers instead of waiting for a restart.
    this.drain();
  }

  // Restart the watcher
  restart(): void {
    info(this.name, "Restarting Docker event watcher");
    this.stop();
    this.scheduleStart(1000);
  }

  // Cleanup on shutdown
  shutdown(): void {
    info(this.name, "Shutting down Docker event watcher");
    this.stop();
  }

  // Get current state
  getState(): WatcherState {
    return this.state;
  }

  // Schedule restart with exponential backoff
  private scheduleRestart(): void {
    if (this.restartTimer) {
      return;
    }

    const delay = Math.min(this.initialRetryDelay * Math.pow(2, this.retryCount), this.maxRetryDelay);

    this.retryCount++;

    info(this.name, "Scheduling restart", {
      delay,
      attempt: this.retryCount,
    });

    this.scheduleStart(delay);
  }

  private scheduleStart(delay: number): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  // Handle raw stdout chunks (buffer + parse by line)
  private handleChunk(chunk: Buffer): void {
    this.buffer += chunk.toString();

    // Prevent buffer overflow
    if (this.buffer.length > this.maxBufferSize) {
      warn(this.name, "Buffer size exceeded, truncating", {
        size: this.buffer.length,
      });
      this.buffer = this.buffer.slice(-this.maxBufferSize / 2);
    }

    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);

      if (!line) {
        continue;
      }

      // Extract the nanosecond timestamp from the raw text: JSON.parse turns a
      // 19-digit integer into a float and silently rounds it, so the exact value
      // has to be read before parsing.
      const timeNano = WatcherService.extractTimeNano(line);

      try {
        const event = JSON.parse(line) as DockerEvent;

        if (Number.isFinite(event.time) && event.time > 0) {
          this.lastEventSince = Math.max(this.lastEventSince, event.time);
        }

        this.enqueueEvent(event, timeNano);
      } catch (err) {
        error(this.name, "Failed to parse Docker event", {
          error: (err as Error).message,
          raw: line.substring(0, 200), // Truncate long lines in logs
        });
      }
    }
  }

  /**
   * Reads `"timeNano":<digits>` from the raw line, verbatim. Returns null for a
   * missing or zero value, and strips leading zeros so the caller can compare
   * cheaply. Never goes through Number, so values above 2^53 stay exact.
   */
  private static extractTimeNano(rawLine: string): string | null {
    const match = /"timeNano"\s*:\s*(\d+)/.exec(rawLine);

    if (!match) {
      return null;
    }

    if (/^0+$/.test(match[1])) {
      return null;
    }

    return match[1].replace(/^0+(?=\d)/, "");
  }

  // Accept a parsed event into the bounded scheduler.
  private enqueueEvent(event: DockerEvent, timeNano: string | null): void {
    if (!this.shouldForward(event)) {
      return;
    }

    const eventId = this.buildEventId(event, timeNano);

    // Dedupe only on exact (timeNano-backed) ids: a second-precision fallback
    // could collide two real events and drop one.
    const dedupeId = timeNano && eventId ? eventId : null;

    if (dedupeId) {
      if (this.deliveredEventIds.has(dedupeId)) {
        info(this.name, "Skipping duplicate event already delivered", { eventId: dedupeId });

        return;
      }

      if (this.pendingEventIds.has(dedupeId)) {
        info(this.name, "Skipping duplicate event already pending", { eventId: dedupeId });

        return;
      }
    }

    if (this.pendingCount >= this.maxPendingEvents) {
      warn(this.name, "Dropping event: pending queue full", {
        eventId,
        action: event.Action,
        pending: this.pendingCount,
        limit: this.maxPendingEvents,
      });

      return;
    }

    const key = `${event.Type}:${event.Actor.ID}`;
    let queue = this.queues.get(key);

    if (!queue) {
      queue = { items: [], active: false };
      this.queues.set(key, queue);
    }

    if (dedupeId) {
      this.pendingEventIds.add(dedupeId);
    }

    queue.items.push({ event, timeNano, eventId, dedupeId, lifecycle: this.lifecycle });
    this.pendingCount++;

    this.drain();
  }

  private buildEventId(event: DockerEvent, timeNano: string | null): string | null {
    if (event.Type !== "container") {
      return null;
    }

    const occurrence = timeNano ?? (Number.isFinite(event.time) ? String(event.time) : null);

    if (!occurrence) {
      return null;
    }

    return `${event.Type}:${event.Action}:${event.Actor.ID}:${occurrence}`;
  }

  private rememberDeliveredId(eventId: string): void {
    if (this.deliveredEventIds.has(eventId)) {
      return;
    }

    this.deliveredEventIds.add(eventId);
    this.deliveredEventIdOrder.push(eventId);

    while (this.deliveredEventIdOrder.length > this.maxDeliveredEventIds) {
      const oldest = this.deliveredEventIdOrder.shift();

      if (oldest) {
        this.deliveredEventIds.delete(oldest);
      }
    }
  }

  private rememberIdentity(containerId: string, identity: ContainerIdentity): void {
    if (!hasIdentity(identity)) {
      return;
    }

    if (!this.identityCache.has(containerId) && this.identityCache.size >= this.maxIdentityCacheEntries) {
      const oldest = this.identityCache.keys().next().value;

      if (oldest) {
        this.identityCache.delete(oldest);
      }
    }

    this.identityCache.set(containerId, identity);
  }

  /** Start as many container heads as the global worker cap allows. */
  private drain(): void {
    while (this.activeCount < this.maxConcurrentProcessing) {
      const next = this.takeNext();

      if (!next) {
        return;
      }

      const { key, queue, item } = next;
      queue.active = true;
      this.activeCount++;
      void this.runQueueItem(key, queue, item);
    }
  }

  /** Fair cursor: rotate the chosen queue to the back so a busy queue cannot starve the rest. */
  private takeNext(): { key: string; queue: ContainerQueue; item: QueuedEvent } | null {
    for (const [key, queue] of this.queues) {
      if (!queue.active && queue.items.length > 0) {
        const item = queue.items.shift();

        if (item) {
          this.queues.delete(key);
          this.queues.set(key, queue);

          return { key, queue, item };
        }
      }
    }

    return null;
  }

  private async runQueueItem(key: string, queue: ContainerQueue, item: QueuedEvent): Promise<void> {
    let delivered = false;

    try {
      delivered = await this.runItem(item);
    } catch (err) {
      error(this.name, "Error handling event", {
        error: (err as Error).message,
        event: item.event.Action,
      });
    } finally {
      if (item.dedupeId) {
        this.pendingEventIds.delete(item.dedupeId);

        // Only a successful delivery suppresses a future overlap.
        if (delivered) {
          this.rememberDeliveredId(item.dedupeId);
        }
      }

      this.activeCount--;
      this.pendingCount--;
      queue.active = false;

      if (queue.items.length === 0 && this.queues.get(key) === queue) {
        this.queues.delete(key);
      }

      this.drain();
    }
  }

  private async runItem(item: QueuedEvent): Promise<boolean> {
    if (item.lifecycle !== this.lifecycle || !this.desiredRunning) {
      warn(this.name, "Dropping queued event: superseded by shutdown", {
        eventId: item.eventId,
        action: item.event.Action,
      });

      return false;
    }

    const payload = await this.buildPayload(item.event, item.timeNano, item.eventId);

    return this.deliver(payload, item.event, item.lifecycle);
  }

  private async buildPayload(event: DockerEvent, timeNano: string | null, eventId: string | null): Promise<EventPayload> {
    const payload: EventPayload = {
      event: event.Action,
      type: event.Type,
      id: event.Actor.ID,
      time: event.time,
      attributes: { ...event.Actor.Attributes },
    };

    if (event.Type === "container") {
      if (timeNano) {
        payload.timeNano = timeNano;
      }

      if (eventId) {
        payload.event_id = eventId;
      }
    }

    // Enrich an image pull with the details only an inspect can give — the raw
    // event carries just the reference. `Actor.ID` is that reference; a failed
    // inspect still forwards the bare event. Image payloads are deliberately
    // left as they were before identity work began.
    if (event.Action === "pull" && event.Type === "image") {
      await this.enrichImagePull(payload, event);

      return payload;
    }

    if (event.Type === "container") {
      await this.enrichContainerEvent(payload, event);
    }

    return payload;
  }

  private async enrichImagePull(payload: EventPayload, event: DockerEvent): Promise<void> {
    try {
      const image = await this.inspectWithTimeout(() => this.docker.getImage(event.Actor.ID));

      payload.attributes = {
        docker_id: image.Id,
        repo_tags: image.RepoTags ?? [],
        repo_digests: image.RepoDigests ?? [],
        size: image.Size,
        created: image.Created,
      };
    } catch (err) {
      error(this.name, "Failed to enrich event with image details", {
        error: (err as Error).message,
        imageRef: event.Actor.ID,
      });
      // Continue forwarding even if enrichment fails
    }
  }

  private async enrichContainerEvent(payload: EventPayload, event: DockerEvent): Promise<void> {
    const containerId = event.Actor.ID;
    const cached = this.identityCache.get(containerId);
    const fromEvent = identityFromLabels(event.Actor.Attributes);

    if (event.Action === "create") {
      let identity = fromEvent;

      try {
        const inspect = await this.inspectWithTimeout(() => this.docker.getContainer(containerId));
        const [image, tag] = this.parseImageTag(inspect.Config.Image);

        payload.attributes = {
          ...payload.attributes,
          id: inspect.Id,
          name: inspect.Name.replace(/^\//, ""),
          image,
          tag,
          state: inspect.State.Status,
          created: inspect.Created,
        };

        // Trusted precedence: event labels > inspect labels > env > cache.
        identity = mergeIdentity(fromEvent, identityFromLabels(inspect.Config?.Labels), identityFromEnv(inspect.Config?.Env), cached);
      } catch (err) {
        error(this.name, "Failed to enrich event with container details", {
          error: (err as Error).message,
          containerId,
        });

        // The event's raw `image` is the full reference. Split it so a create
        // without an inspect still carries the separated image/tag shape Core
        // already expects.
        const rawImage = payload.attributes.image;

        if (typeof rawImage === "string" && rawImage) {
          const [image, tag] = this.parseImageTag(rawImage);
          payload.attributes.image = image;
          payload.attributes.tag = tag;
        }

        identity = mergeIdentity(fromEvent, cached);
      }

      this.rememberIdentity(containerId, identity);

      // Create keeps its historical shape: the three identity keys are always
      // present (null when unknown). `workload_role` is additive.
      Object.assign(payload.attributes, identityToAttributes(identity, true));

      return;
    }

    const identity = mergeIdentity(fromEvent, cached);
    this.rememberIdentity(containerId, identity);
    Object.assign(payload.attributes, identityToAttributes(identity, false));
  }

  /**
   * Races an inspect against a timer so one stalled container cannot pin a
   * worker. The underlying Docker request is not cancellable here, so its slot
   * is held until it settles even after we stop waiting; when the cap is
   * reached further enrichment is skipped (the caller forwards the label
   * fallback and logs). This bounds live hung Docker calls at the same cap as
   * concurrent processing.
   */
  private async inspectWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    if (this.outstandingInspections >= this.maxConcurrentProcessing) {
      throw new Error(`inspect skipped: ${this.outstandingInspections} inspections already outstanding`);
    }

    this.outstandingInspections++;

    const underlying = operation().finally(() => {
      this.outstandingInspections--;
    });

    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`inspect timed out after ${this.inspectTimeoutMs}ms`)), this.inspectTimeoutMs);
    });

    try {
      return await Promise.race([underlying, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Deliver, retrying a failed webhook a bounded number of times. The same
   * immutable payload object is sent each attempt, so the body and event id are
   * identical on retry. There is no disk persistence, so this is best-effort:
   * a shutdown or exhausted retries drops the event with an explicit log and
   * releases its pending dedup marker so a later overlap can reattempt.
   */
  private async deliver(payload: EventPayload, event: DockerEvent, lifecycle: number): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (lifecycle !== this.lifecycle || !this.desiredRunning) {
        warn(this.name, "Dropping event: watcher stopped before delivery", {
          eventId: payload.event_id,
          action: event.Action,
        });

        return false;
      }

      const success = await httpService.postSafe({
        type: "docker_event",
        payload,
      });

      if (success) {
        return true;
      }

      if (attempt >= this.retryDelays.length) {
        warn(this.name, "Event delivery failed after retries; event dropped", {
          eventId: payload.event_id,
          action: event.Action,
          attempts: attempt + 1,
        });

        return false;
      }

      const delay = this.retryDelays[attempt];

      warn(this.name, "Event delivery failed; retrying", {
        eventId: payload.event_id,
        action: event.Action,
        attempt: attempt + 1,
        delay,
      });

      if (this.retryTimers.size >= this.maxPendingRetries) {
        warn(this.name, "Dropping event: retry backlog full", { eventId: payload.event_id });

        return false;
      }

      if (!(await this.waitForRetry(delay))) {
        warn(this.name, "Dropping event: shutdown during retry backoff", { eventId: payload.event_id });

        return false;
      }
    }
  }

  private waitForRetry(ms: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const entry: RetryTimer = {
        timer: undefined as unknown as NodeJS.Timeout,
        resolve,
      };

      entry.timer = setTimeout(() => {
        this.retryTimers.delete(entry);
        resolve(true);
      }, ms);

      this.retryTimers.add(entry);
    });
  }

  private cancelRetryTimers(): void {
    for (const entry of this.retryTimers) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }

    this.retryTimers.clear();
  }

  // Filter logic (customizable later)
  private shouldForward(event: DockerEvent): boolean {
    if (event.Type === "image") {
      return event.Action === "pull" || event.Action === "delete";
    }

    if (event.Type !== "container") {
      return false;
    }

    // Skip stop and kill events
    const skipActions = ["stop", "kill"];
    if (skipActions.includes(event.Action)) {
      return false;
    }

    return true;
  }

  // Parse image and tag, handling edge cases
  private parseImageTag(imageName: string): [string, string] {
    const lastColon = imageName.lastIndexOf(":");

    // No colon or colon is part of registry (e.g., localhost:5000/image)
    if (lastColon === -1 || imageName.indexOf("/") > lastColon) {
      return [imageName, "latest"];
    }

    const image = imageName.substring(0, lastColon);
    const tag = imageName.substring(lastColon + 1);

    return [image, tag || "latest"];
  }
}
