import { describe, it, expect } from "vitest";
import { createImageSchema } from "../../src/validators/Images";

describe("createImageSchema", () => {
  const valid = {
    name: "owner/repo",
    tag: "a1b2c3d",
    applicationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    token: "gh_token",
  };

  it("accepts a valid payload", () => {
    expect(createImageSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    "owner",
    "owner/repo/extra",
    "owner//repo",
    "owner/../repo",
    "owner/repo; rm -rf /",
  ])("rejects a malformed name %j", name => {
    expect(createImageSchema.safeParse({ ...valid, name }).success).toBe(false);
  });

  it.each(["not-a-sha", "abc", "g1b2c3d", "abc123; rm -rf /"])("rejects a non-commit-sha tag %j", tag => {
    expect(createImageSchema.safeParse({ ...valid, tag }).success).toBe(false);
  });

  it.each(["../../etc/passwd", "app_1", "not-a-ulid"])("rejects a non-ULID applicationId %j", applicationId => {
    expect(createImageSchema.safeParse({ ...valid, applicationId }).success).toBe(false);
  });

  it.each(["../../etc/passwd", "deploy_1", "not-a-ulid"])("rejects a non-ULID deploymentId %j", deploymentId => {
    expect(createImageSchema.safeParse({ ...valid, deploymentId }).success).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(createImageSchema.safeParse({ ...valid, token: "" }).success).toBe(false);
  });

  it("accepts a payload without buildArgs", () => {
    expect(createImageSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts valid buildArgs", () => {
    const result = createImageSchema.safeParse({ ...valid, buildArgs: { NODE_ENV: "production", API_URL: "https://example.com" } });
    expect(result.success).toBe(true);
  });

  it.each(["1BAD", "bad-key", "bad key", ""])("rejects a buildArgs key that isn't a valid identifier %j", key => {
    expect(createImageSchema.safeParse({ ...valid, buildArgs: { [key]: "value" } }).success).toBe(false);
  });

  it("accepts a push target and keeps its fields", () => {
    const push = { image: "ghcr.io/owner/repo:a1b2c3d", registry: "ghcr.io", username: "user", password: "secret" };
    const result = createImageSchema.safeParse({ ...valid, push });
    expect(result.success && result.data.push).toEqual(push);
  });

  it.each(["repo:tag", "ghcr.io/owner/repo", "ghcr.io/owner/repo:tag; rm -rf /", "ghcr.io/owner/re po:tag"])(
    "rejects a malformed push image %j",
    image => {
      expect(createImageSchema.safeParse({ ...valid, push: { image } }).success).toBe(false);
    },
  );

  it("accepts a push image with a registry port", () => {
    expect(createImageSchema.safeParse({ ...valid, push: { image: "registry.internal:5000/owner/repo:a1b2c3d" } }).success).toBe(true);
  });
});
