/**
 * Reads deployment-supplied identity from Docker events or an inspect when one
 * is still possible.
 *
 * Docker merges a container's `Config.Labels` into `Actor.Attributes` for every
 * container lifecycle event, so these labels survive onto `start`/`die`/
 * `destroy` without an inspect. That is what makes identity recoverable after a
 * container is gone.
 */
export const MANAGED_LABEL_PREFIX = "io.serversinc.agent";

export const MANAGED_LABEL_KEYS = {
  applicationId: `${MANAGED_LABEL_PREFIX}.application_id`,
  environmentId: `${MANAGED_LABEL_PREFIX}.environment_id`,
  deploymentId: `${MANAGED_LABEL_PREFIX}.deployment_id`,
  workloadRole: `${MANAGED_LABEL_PREFIX}.workload_role`,
} as const;

export const WORKLOAD_ROLES = {
  runtime: "runtime",
  prestep: "prestep",
} as const;

export type WorkloadRole = (typeof WORKLOAD_ROLES)[keyof typeof WORKLOAD_ROLES];

/** Only `runtime`/`prestep` are trusted; anything else is ignored. */
export function normalizeWorkloadRole(value: unknown): WorkloadRole | null {
  if (typeof value !== "string") {
    return null;
  }

  return value === WORKLOAD_ROLES.runtime || value === WORKLOAD_ROLES.prestep ? value : null;
}

export interface ContainerIdentity {
  application_id: string | null;
  environment_id: string | null;
  deployment_id: string | null;
  workload_role: string | null;
}

/**
 * Parses raw `KEY=VALUE` env entries, keeping everything after the first `=`
 * (a value may itself contain `=`).
 */
export function parseContainerEnv(env?: readonly string[] | null): Map<string, string> {
  const map = new Map<string, string>();

  for (const entry of env ?? []) {
    const separator = entry.indexOf("=");

    if (separator === -1) {
      map.set(entry, "");

      continue;
    }

    map.set(entry.slice(0, separator), entry.slice(separator + 1));
  }

  return map;
}

/** The legacy fallback: identity that predates the managed labels. */
export function identityFromEnv(env?: readonly string[] | null): ContainerIdentity {
  const map = parseContainerEnv(env);

  return {
    application_id: map.get("CORE_APP_ID") ?? null,
    environment_id: map.get("CORE_ENV_ID") ?? null,
    deployment_id: map.get("CORE_DEPLOYMENT_ID") ?? null,
    workload_role: null,
  };
}

/** Identity read straight off Docker-event (or inspect) labels. */
export function identityFromLabels(labels?: Record<string, string> | null): ContainerIdentity {
  if (!labels) {
    return {
      application_id: null,
      environment_id: null,
      deployment_id: null,
      workload_role: null,
    };
  }

  return {
    application_id: labels[MANAGED_LABEL_KEYS.applicationId] ?? null,
    environment_id: labels[MANAGED_LABEL_KEYS.environmentId] ?? null,
    deployment_id: labels[MANAGED_LABEL_KEYS.deploymentId] ?? null,
    workload_role: normalizeWorkloadRole(labels[MANAGED_LABEL_KEYS.workloadRole]),
  };
}
