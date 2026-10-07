/**
 * Identity shared between the deploy path (which stamps containers with labels)
 * and the event watcher (which reads them back off Docker events, or off an
 * inspect when one is still possible).
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

export function emptyIdentity(): ContainerIdentity {
  return {
    application_id: null,
    environment_id: null,
    deployment_id: null,
    workload_role: null,
  };
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

/** Identity read straight off Docker-event (or inspect) attributes. */
export function identityFromLabels(labels?: Record<string, string> | null): ContainerIdentity {
  if (!labels) {
    return emptyIdentity();
  }

  return {
    application_id: labels[MANAGED_LABEL_KEYS.applicationId] ?? null,
    environment_id: labels[MANAGED_LABEL_KEYS.environmentId] ?? null,
    deployment_id: labels[MANAGED_LABEL_KEYS.deploymentId] ?? null,
    workload_role: normalizeWorkloadRole(labels[MANAGED_LABEL_KEYS.workloadRole]),
  };
}

/** First non-null wins, per field. Sources are tried in the order given. */
export function mergeIdentity(...sources: Array<ContainerIdentity | null | undefined>): ContainerIdentity {
  const merged = emptyIdentity();

  for (const source of sources) {
    if (!source) {
      continue;
    }

    merged.application_id ??= source.application_id;
    merged.environment_id ??= source.environment_id;
    merged.deployment_id ??= source.deployment_id;
    merged.workload_role ??= source.workload_role;
  }

  return merged;
}

export function hasIdentity(identity: ContainerIdentity): boolean {
  return Boolean(identity.application_id || identity.environment_id || identity.deployment_id || identity.workload_role);
}

/** Builds the labels a deploy stamps onto a container. Empty fields are omitted. */
export function buildManagedLabels(input: {
  applicationId?: string | null;
  environmentId?: string | null;
  deploymentId?: string | null;
  workloadRole?: WorkloadRole | null;
}): Record<string, string> {
  const labels: Record<string, string> = {};

  if (input.applicationId) {
    labels[MANAGED_LABEL_KEYS.applicationId] = input.applicationId;
  }

  if (input.environmentId) {
    labels[MANAGED_LABEL_KEYS.environmentId] = input.environmentId;
  }

  if (input.deploymentId) {
    labels[MANAGED_LABEL_KEYS.deploymentId] = input.deploymentId;
  }

  const workloadRole = normalizeWorkloadRole(input.workloadRole);

  if (workloadRole) {
    labels[MANAGED_LABEL_KEYS.workloadRole] = workloadRole;
  }

  return labels;
}

/**
 * Flattens identity into the attribute keys Core already understands
 * (`application_id`, `environment_id`, `deployment_id`) plus `workload_role`.
 * `includeNulls` keeps the create contract stable: create has always sent those
 * three keys even when their value was unknown.
 */
export function identityToAttributes(identity: ContainerIdentity, includeNulls = false): Record<string, string | null> {
  const attributes: Record<string, string | null> = {};

  if (includeNulls || identity.application_id !== null) {
    attributes.application_id = identity.application_id;
  }

  if (includeNulls || identity.environment_id !== null) {
    attributes.environment_id = identity.environment_id;
  }

  if (includeNulls || identity.deployment_id !== null) {
    attributes.deployment_id = identity.deployment_id;
  }

  if (includeNulls || identity.workload_role !== null) {
    attributes.workload_role = identity.workload_role;
  }

  return attributes;
}
