import { error, info, warn } from "../utils/console";
import { httpService } from "./Http";
import { DockerService } from "./Docker";
import { ContainerIdentity, identityFromEnv, identityFromLabels } from "../utils/containerIdentity";

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

  constructor(dockerService: DockerService) {
    this.docker = dockerService;
  }

  // Start watching the Docker events. Uses dockerode's own `/events` stream
  // (the same client already used for every other Docker call) rather than
  // shelling out to a `docker` CLI binary — the agent image doesn't ship one,
  // so the previous spawn-based approach never actually ran.
  start(): void {
    if (this.state === "running" || this.state === "starting") {
      info(this.name, "Docker event watcher already running or starting");
      return;
    }

    this.state = "starting";

    this.docker.docker
      .getEvents({})
      .then(stream => {
        this.eventStream = stream;

        stream.on("data", chunk => this.handleChunk(chunk as Buffer));

        stream.on("error", err => {
          error(this.name, "Docker events stream error", { error: (err as Error).message });
          this.eventStream = null;
          this.state = "stopped";
          this.scheduleRestart();
        });

        stream.on("end", () => {
          warn(this.name, "Docker events stream ended");
          this.eventStream = null;
          this.state = "stopped";
          this.scheduleRestart();
        });

        this.state = "running";
        this.retryCount = 0; // Reset retry count on successful start
        info(this.name, "Docker event watcher started successfully");
      })
      .catch(err => {
        error(this.name, "Failed to start watcher", { error: (err as Error).message });
        this.state = "stopped";
        this.scheduleRestart();
      });
  }

  // Stop watching the Docker events
  stop(): void {
    if (this.state === "stopped" || this.state === "stopping") {
      return;
    }

    this.state = "stopping";
    info(this.name, "Stopping Docker event watcher");

    if (this.eventStream) {
      const stream = this.eventStream as NodeJS.ReadableStream & { destroy?: () => void };
      stream.destroy?.();
      this.eventStream = null;
    }

    this.buffer = "";
    this.state = "stopped";
  }

  // Restart the watcher
  restart(): void {
    info(this.name, "Restarting Docker event watcher");
    this.stop();
    // Small delay before restart
    setTimeout(() => this.start(), 1000);
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
    const delay = Math.min(this.initialRetryDelay * Math.pow(2, this.retryCount), this.maxRetryDelay);

    this.retryCount++;

    info(this.name, "Scheduling restart", {
      delay,
      attempt: this.retryCount,
    });

    setTimeout(() => this.start(), delay);
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

      if (!line) continue;

      // Extract the nanosecond timestamp from the raw text: JSON.parse turns a
      // 19-digit integer into a float and silently rounds it, so the exact value
      // has to be read before parsing.
      const timeNano = WatcherService.extractTimeNano(line);

      try {
        const event = JSON.parse(line) as DockerEvent;
        // Don't await - process events asynchronously
        this.handleEvent(event, timeNano).catch(err => {
          error(this.name, "Error handling event", {
            error: err.message,
            event: event.Action,
          });
        });
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

  // Handle parsed Docker event
  private async handleEvent(event: DockerEvent, timeNano: string | null): Promise<void> {
    if (!this.shouldForward(event)) {
      return;
    }

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

      const eventId = this.buildEventId(event, timeNano);

      if (eventId) {
        payload.event_id = eventId;
      }
    }

    // Enrich an image pull with the details only an inspect can give — the raw
    // event carries just the reference. `Actor.ID` is that reference; a failed
    // inspect still forwards the bare event. Image payloads are deliberately
    // left as they were before identity work began.
    if (event.Action === "pull" && event.Type === "image") {
      try {
        const image = await this.docker.getImage(event.Actor.ID);

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

    // Enrich with container details on creation
    if (event.Action === "create" && event.Type === "container") {
      await this.enrichContainerCreate(payload, event);
    } else if (event.Type === "container") {
      // start/die/destroy and friends carry the container's labels on the event
      // itself, so identity survives without an inspect.
      this.applyIdentity(payload.attributes, identityFromLabels(event.Actor.Attributes));
    }

    // Use postSafe to avoid throwing on http failures
    const success = await httpService.postSafe({
      type: "docker_event",
      payload,
    });

    if (!success) {
      warn(this.name, "Failed to forward event", {
        action: event.Action,
        id: event.Actor.ID,
      });
    }
  }

  /**
   * Enriches a container create with the details only an inspect can give.
   * Identity comes from the inspect's managed labels with the legacy `CORE_*`
   * environment as a fallback; only the selected identity fields are forwarded,
   * never the environment itself. The historical create shape is preserved.
   */
  private async enrichContainerCreate(payload: EventPayload, event: DockerEvent): Promise<void> {
    try {
      const inspect = await this.docker.getContainer(event.Actor.ID);
      const [image, tag] = this.parseImageTag(inspect.Config.Image);
      const fromLabels = identityFromLabels(inspect.Config?.Labels);
      const fromEnv = identityFromEnv(inspect.Config?.Env);

      payload.attributes = {
        id: inspect.Id,
        name: inspect.Name.replace(/^\//, ""),
        image,
        tag,
        state: inspect.State.Status,
        created: inspect.Created,
        application_id: fromLabels.application_id ?? fromEnv.application_id,
        environment_id: fromLabels.environment_id ?? fromEnv.environment_id,
        deployment_id: fromLabels.deployment_id ?? fromEnv.deployment_id,
      };

      if (fromLabels.workload_role) {
        payload.attributes.workload_role = fromLabels.workload_role;
      }
    } catch (err) {
      error(this.name, "Failed to enrich event with container details", {
        error: (err as Error).message,
        containerId: event.Actor.ID,
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

      this.applyIdentity(payload.attributes, identityFromLabels(event.Actor.Attributes));
    }
  }

  private buildEventId(event: DockerEvent, timeNano: string | null): string | null {
    const occurrence = timeNano ?? (Number.isFinite(event.time) ? String(event.time) : null);

    if (!occurrence) {
      return null;
    }

    return `${event.Type}:${event.Action}:${event.Actor.ID}:${occurrence}`;
  }

  /** Copies the known identity fields onto an event's attributes. */
  private applyIdentity(attributes: Record<string, unknown>, identity: ContainerIdentity): void {
    if (identity.application_id !== null) {
      attributes.application_id = identity.application_id;
    }

    if (identity.environment_id !== null) {
      attributes.environment_id = identity.environment_id;
    }

    if (identity.deployment_id !== null) {
      attributes.deployment_id = identity.deployment_id;
    }

    if (identity.workload_role !== null) {
      attributes.workload_role = identity.workload_role;
    }
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
