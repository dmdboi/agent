import { describe, it, expect } from "vitest";
import {
  MANAGED_LABEL_KEYS,
  buildManagedLabels,
  identityFromEnv,
  identityFromLabels,
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
    expect(identityFromEnv(undefined)).toEqual({
      application_id: null,
      environment_id: null,
      deployment_id: null,
      workload_role: null,
    });
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
    expect(identityFromLabels(null)).toEqual({
      application_id: null,
      environment_id: null,
      deployment_id: null,
      workload_role: null,
    });
  });

  it("ignores an unknown workload role rather than forwarding it", () => {
    expect(identityFromLabels({ [MANAGED_LABEL_KEYS.workloadRole]: "bogus" }).workload_role).toBeNull();
    expect(identityFromLabels({ [MANAGED_LABEL_KEYS.workloadRole]: "runtime" }).workload_role).toBe("runtime");
    expect(buildManagedLabels({ workloadRole: "bogus" as never })).toEqual({});
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
});
