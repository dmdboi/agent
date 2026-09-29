import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { BuildService } from "../../src/services/BuildService";
import { GitCloneError } from "../../src/services/Git";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

const { postSafeMock } = vi.hoisted(() => ({ postSafeMock: vi.fn().mockResolvedValue(true) }));
vi.mock("../../src/services/Http", () => ({ httpService: { postSafe: postSafeMock } }));

vi.mock("../../src/config", () => ({ default: { REPOS_DIR: join(tmpdir(), "agent-build-test") } }));

describe("BuildService", () => {
  const options = { name: "owner/repo", tag: "abc123", applicationId: "app_1", deploymentId: "deploy_1", token: "gh_token" };

  beforeEach(() => {
    postSafeMock.mockClear();
  });

  afterEach(async () => {
    await rm(join(tmpdir(), "agent-build-test"), { recursive: true, force: true });
  });

  it("clones, builds, and reports build_completed on success", async () => {
    const dockerService = { buildImage: vi.fn().mockResolvedValue(undefined) };
    const gitService = {
      cloneAndCheckout: vi.fn().mockImplementation(async (_repo, _tag, _token, destDir) => {
        // simulate a real checkout: create the dir + a Dockerfile
        const { mkdir, writeFile } = await import("fs/promises");
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, "Dockerfile"), "FROM scratch\n");
      }),
    };

    const service = new BuildService(dockerService as any, gitService as any);
    await service.buildFromRepo(options);

    expect(gitService.cloneAndCheckout).toHaveBeenCalledWith("owner/repo", "abc123", "gh_token", expect.any(String));
    expect(dockerService.buildImage).toHaveBeenCalledWith(expect.any(String), "owner/repo:abc123", undefined);
    expect(postSafeMock).toHaveBeenCalledWith({
      type: "build_completed",
      applicationId: "app_1",
      deploymentId: "deploy_1",
      image: "owner/repo:abc123",
    });
  });

  it("forwards buildArgs to DockerService.buildImage", async () => {
    const dockerService = { buildImage: vi.fn().mockResolvedValue(undefined) };
    const gitService = {
      cloneAndCheckout: vi.fn().mockImplementation(async (_repo, _tag, _token, destDir) => {
        const { mkdir, writeFile } = await import("fs/promises");
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, "Dockerfile"), "FROM scratch\n");
      }),
    };

    const service = new BuildService(dockerService as any, gitService as any);
    await service.buildFromRepo({ ...options, buildArgs: { NODE_ENV: "production" } });

    expect(dockerService.buildImage).toHaveBeenCalledWith(expect.any(String), "owner/repo:abc123", { NODE_ENV: "production" });
  });

  it("reports build_failed distinctly for a clone failure, without touching Docker", async () => {
    const dockerService = { buildImage: vi.fn() };
    const gitService = {
      cloneAndCheckout: vi.fn().mockRejectedValue(new GitCloneError("auth failed", "clone_failed")),
    };

    const service = new BuildService(dockerService as any, gitService as any);
    await service.buildFromRepo(options);

    expect(dockerService.buildImage).not.toHaveBeenCalled();
    expect(postSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "build_failed", applicationId: "app_1", reason: "clone_failed", error: expect.stringContaining("auth failed") }),
    );
  });

  it("reports build_failed distinctly for a missing Dockerfile, without touching Docker", async () => {
    const dockerService = { buildImage: vi.fn() };
    const gitService = {
      cloneAndCheckout: vi.fn().mockImplementation(async (_repo, _tag, _token, destDir) => {
        const { mkdir } = await import("fs/promises");
        await mkdir(destDir, { recursive: true }); // no Dockerfile written
      }),
    };

    const service = new BuildService(dockerService as any, gitService as any);
    await service.buildFromRepo(options);

    expect(dockerService.buildImage).not.toHaveBeenCalled();
    expect(postSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "build_failed", reason: "no_dockerfile", error: expect.stringContaining("No Dockerfile found") }),
    );
  });

  it("reports build_failed when the Docker build itself fails", async () => {
    const dockerService = { buildImage: vi.fn().mockRejectedValue(new Error("Dockerfile parse error")) };
    const gitService = {
      cloneAndCheckout: vi.fn().mockImplementation(async (_repo, _tag, _token, destDir) => {
        const { mkdir, writeFile } = await import("fs/promises");
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, "Dockerfile"), "garbage\n");
      }),
    };

    const service = new BuildService(dockerService as any, gitService as any);
    await service.buildFromRepo(options);

    expect(postSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "build_failed", reason: "build_failed", error: expect.stringContaining("Dockerfile parse error") }),
    );
  });

  it("refuses a path-traversal applicationId without touching git, Docker, or the filesystem", async () => {
    const dockerService = { buildImage: vi.fn() };
    const gitService = { cloneAndCheckout: vi.fn() };

    const service = new BuildService(dockerService as any, gitService as any);
    await service.buildFromRepo({ ...options, applicationId: "../../etc" });

    expect(gitService.cloneAndCheckout).not.toHaveBeenCalled();
    expect(dockerService.buildImage).not.toHaveBeenCalled();
    expect(postSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "build_failed", applicationId: "../../etc", reason: "invalid_application_id", error: "Invalid applicationId" }),
    );
  });

  describe("with a push target", () => {
    const push = { image: "ghcr.io/owner/repo:abc123", registry: "ghcr.io", username: "user", password: "secret" };

    const gitServiceWithDockerfile = () => ({
      cloneAndCheckout: vi.fn().mockImplementation(async (_repo, _tag, _token, destDir) => {
        const { mkdir, writeFile } = await import("fs/promises");
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, "Dockerfile"), "FROM scratch\n");
      }),
    });

    it("pushes the built image, reports the pushed reference, and removes the local tags", async () => {
      const dockerService = {
        buildImage: vi.fn().mockResolvedValue(undefined),
        pushImage: vi.fn().mockResolvedValue(undefined),
        removeImage: vi.fn().mockResolvedValue(undefined),
      };

      await new BuildService(dockerService as any, gitServiceWithDockerfile() as any).buildFromRepo({ ...options, push });

      expect(dockerService.pushImage).toHaveBeenCalledWith("owner/repo:abc123", "ghcr.io/owner/repo:abc123", {
        registry: "ghcr.io",
        username: "user",
        password: "secret",
      });
      expect(dockerService.removeImage.mock.calls).toEqual([["ghcr.io/owner/repo:abc123"], ["owner/repo:abc123"]]);
      expect(postSafeMock).toHaveBeenCalledWith({
        type: "build_completed",
        applicationId: "app_1",
        deploymentId: "deploy_1",
        image: "ghcr.io/owner/repo:abc123",
      });
    });

    it("reports build_failed with reason push_failed and removes the local tags when the push fails", async () => {
      const dockerService = {
        buildImage: vi.fn().mockResolvedValue(undefined),
        pushImage: vi.fn().mockRejectedValue(new Error("denied: permission_denied")),
        removeImage: vi.fn().mockResolvedValue(undefined),
      };

      await new BuildService(dockerService as any, gitServiceWithDockerfile() as any).buildFromRepo({ ...options, push });

      expect(dockerService.removeImage.mock.calls).toEqual([["ghcr.io/owner/repo:abc123"], ["owner/repo:abc123"]]);
      expect(postSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "build_failed", reason: "push_failed", error: "denied: permission_denied" }),
      );
    });

    it("still reports build_completed when removing the local tags fails", async () => {
      const dockerService = {
        buildImage: vi.fn().mockResolvedValue(undefined),
        pushImage: vi.fn().mockResolvedValue(undefined),
        removeImage: vi.fn().mockRejectedValue(new Error("image is in use")),
      };

      await new BuildService(dockerService as any, gitServiceWithDockerfile() as any).buildFromRepo({ ...options, push });

      expect(postSafeMock).toHaveBeenCalledWith(expect.objectContaining({ type: "build_completed", image: "ghcr.io/owner/repo:abc123" }));
    });
  });
});
