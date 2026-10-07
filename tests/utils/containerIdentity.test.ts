import { describe, it, expect } from "vitest";
import {
  MANAGED_LABEL_KEYS,
  buildManagedLabels,
  emptyIdentity,
  hasIdentity,
  identityFromEnv,
  identityFromLabels,
  identityToAttributes,
  mergeIdentity,
  parseContainerEnv,
} from "../../src/utils/containerIdentity";

describe("containerIdentity", () => {
  it("parses env entries keeping everything after the first '='", () => {
    const env = parseContainerEnv(["A=1", "B=two=three", "FLAG"]);

    expect(env.get("A")).toBe("1");
    expect(env.get("B")).toBe("two=three");
    expect(env.get("FLAG")).toBe("");
  });

  it("reads the legacy CORE_* env fallback", () => {
    expect(identityFromEnv(["CORE_APP_ID=app-1", "CORE_ENV_ID=env-1", "CORE_DEPLOYMENT_ID=dep-1"])).toEqual({
      application_id: "app-1",
      environment_id: "env-1",
      deployment_id: "dep-1",
      workload_role: null,
    });
    expect(identityFromEnv(undefined)).toEqual(emptyIdentity());
  });

  it("reads managed labels off event or inspect attributes", () => {
    expect(
      identityFromLabels({
        [MANAGED_LABEL_KEYS.applicationId]: "app-1",
        [MANAGED_LABEL_KEYS.environmentId]: "env-1",
        [MANAGED_LABEL_KEYS.deploymentId]: "dep-1",
        [MANAGED_LABEL_KEYS.workloadRole]: "prestep",
        "traefik.enable": "true",
      }),
    ).toEqual({
      application_id: "app-1",
      environment_id: "env-1",
      deployment_id: "dep-1",
      workload_role: "prestep",
    });
    expect(identityFromLabels(null)).toEqual(emptyIdentity());
  });

  it("ignores an unknown workload role rather than forwarding it", () => {
    expect(identityFromLabels({ [MANAGED_LABEL_KEYS.workloadRole]: "bogus" }).workload_role).toBeNull();
    expect(identityFromLabels({ [MANAGED_LABEL_KEYS.workloadRole]: "runtime" }).workload_role).toBe("runtime");
    expect(buildManagedLabels({ workloadRole: "bogus" as never })).toEqual({});
  });

  it("merges identity with trusted precedence event > inspect > env > cache", () => {
    const merged = mergeIdentity(
      { application_id: "event", environment_id: null, deployment_id: null, workload_role: null },
      { application_id: "inspect", environment_id: null, deployment_id: null, workload_role: null },
      { application_id: "env", environment_id: "env-env", deployment_id: null, workload_role: null },
      { application_id: "cache", environment_id: "cache-env", deployment_id: "cache-dep", workload_role: "prestep" },
    );

    expect(merged).toEqual({
      application_id: "event",
      environment_id: "env-env",
      deployment_id: "cache-dep",
      workload_role: "prestep",
    });
  });

  it("merges identity with first non-null winning per field", () => {
    const merged = mergeIdentity(
      { application_id: null, environment_id: "env-a", deployment_id: null, workload_role: null },
      { application_id: "app-b", environment_id: "env-b", deployment_id: "dep-b", workload_role: "runtime" },
    );

    expect(merged).toEqual({
      application_id: "app-b",
      environment_id: "env-a",
      deployment_id: "dep-b",
      workload_role: "runtime",
    });
  });

  it("builds managed labels, omitting empty fields", () => {
    expect(
      buildManagedLabels({ applicationId: "app-1", environmentId: null, deploymentId: "dep-1", workloadRole: "runtime" }),
    ).toEqual({
      [MANAGED_LABEL_KEYS.applicationId]: "app-1",
      [MANAGED_LABEL_KEYS.deploymentId]: "dep-1",
      [MANAGED_LABEL_KEYS.workloadRole]: "runtime",
    });
  });

  it("flattens identity to attributes, optionally including nulls", () => {
    const identity = { application_id: "app-1", environment_id: null, deployment_id: null, workload_role: "runtime" };

    expect(identityToAttributes(identity)).toEqual({ application_id: "app-1", workload_role: "runtime" });
    expect(identityToAttributes(identity, true)).toEqual({
      application_id: "app-1",
      environment_id: null,
      deployment_id: null,
      workload_role: "runtime",
    });
  });

  it("reports whether any identity field is known", () => {
    expect(hasIdentity(emptyIdentity())).toBe(false);
    expect(hasIdentity({ ...emptyIdentity(), deployment_id: "dep-1" })).toBe(true);
  });
});
