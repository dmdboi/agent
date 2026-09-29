import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

import { DockerService } from "./Docker";
import { GitService, GitCloneError } from "./Git";
import { httpService } from "./Http";
import { error, info, warn } from "../utils/console";
import config from "../config";

export interface BuildOptions {
  name: string; // owner/repo
  tag: string; // commit sha
  applicationId: string;
  deploymentId: string;
  token: string;
  buildArgs?: Record<string, string>;
  push?: { image: string; registry?: string; username?: string; password?: string };
}

type BuildFailureReason = GitCloneError["reason"] | "no_dockerfile" | "build_failed" | "push_failed" | "invalid_application_id";

class PushError extends Error {
  readonly reason = "push_failed" as const;
}

class NoDockerfileError extends Error {
  readonly reason = "no_dockerfile" as const;
}

export class BuildService {
  public readonly name = "Build";

  constructor(
    private readonly dockerService: DockerService,
    private readonly gitService: GitService = new GitService(),
  ) {}

  // Fire-and-forget entry point: clones, builds, and reports the outcome to CORE_URL.
  // Never throws — failures are reported as a `build_failed` event instead.
  async buildFromRepo(options: BuildOptions): Promise<void> {
    const { name, tag, applicationId, deploymentId, token, buildArgs, push } = options;
    const imageTag = `${name.toLowerCase()}:${tag}`;

    // applicationId feeds directly into a filesystem path below. The HTTP-layer schema already
    // requires a ULID, but that's a caller-side guarantee — re-check it here since this is the
    // code that would actually suffer a path-traversal write/rm if it were ever wrong.
    if (!/^[A-Za-z0-9_-]+$/.test(applicationId)) {
      error(this.name, "Refusing to build: unsafe applicationId", { applicationId });
      await this.reportFailure(applicationId, deploymentId, name, tag, "invalid_application_id", "Invalid applicationId");
      return;
    }

    const workDir = join(config.REPOS_DIR, `${applicationId}-${randomUUID()}`);

    try {
      await mkdir(workDir, { recursive: true });

      // GitService always rejects with a GitCloneError (clone_failed | checkout_failed) — that's
      // its contract, so no need to normalize other error shapes here.
      await this.gitService.cloneAndCheckout(name, tag, token, workDir);

      if (!existsSync(join(workDir, "Dockerfile"))) {
        throw new NoDockerfileError(`No Dockerfile found at the root of ${name}@${tag}`);
      }

      await this.dockerService.buildImage(workDir, imageTag, buildArgs);

      info(this.name, "Build completed", { name, tag, applicationId, deploymentId, image: imageTag });

      const image = push ? await this.pushBuiltImage(imageTag, push) : imageTag;

      // `image` is the exact reference the caller can hand straight to POST /containers.
      // deploymentId lets the caller update the exact Deployment this build was for,
      // rather than guessing "whichever build is still pending for this application" —
      // which breaks as soon as two builds for the same app are in flight or one was
      // never resolved.
      await httpService.postSafe({
        type: "build_completed",
        applicationId,
        deploymentId,
        image,
      });
    } catch (err) {
      const reason: BuildFailureReason = err instanceof GitCloneError || err instanceof NoDockerfileError || err instanceof PushError ? err.reason : "build_failed";
      await this.reportFailure(applicationId, deploymentId, name, tag, reason, (err as Error).message);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // Pushes the freshly built image and drops the local tags whether or not the push succeeded,
  // so a build server does not accumulate an image per commit. Returns the pushed reference.
  private async pushBuiltImage(imageTag: string, push: NonNullable<BuildOptions["push"]>): Promise<string> {
    try {
      await this.dockerService.pushImage(imageTag, push.image, {
        registry: push.registry,
        username: push.username,
        password: push.password,
      });
    } catch (err) {
      throw new PushError((err as Error).message);
    } finally {
      for (const ref of [push.image, imageTag]) {
        await this.dockerService.removeImage(ref).catch(err => {
          warn(this.name, "Failed to remove local image after push", { ref, error: (err as Error).message });
        });
      }
    }

    return push.image;
  }

  private async reportFailure(
    applicationId: string,
    deploymentId: string,
    repo: string,
    commit: string,
    reason: BuildFailureReason,
    message: string,
  ): Promise<void> {
    error(this.name, "Build failed", { repo, commit, applicationId, deploymentId, reason, error: message });

    await httpService.postSafe({
      type: "build_failed",
      applicationId,
      deploymentId,
      repo,
      commit,
      reason,
      error: message,
    });
  }
}
