import { z } from "zod";

export const pullImageSchema = z.object({
  name: z.string(),
});

export const pushTargetSchema = z.object({
  image: z.string().regex(/^[\w.-]+(:[0-9]+)?(\/[\w.-]+)+:[\w][\w.-]{0,127}$/, "image must be a registry reference in the form host[:port]/path:tag"),
  registry: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

export const createImageSchema = z.object({
  name: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "name must be a GitHub repo in the form owner/repo"),
  tag: z.string().regex(/^[0-9a-fA-F]{7,40}$/, "tag must be a git commit sha"),
  applicationId: z.string().ulid("applicationId must be a ULID"),
  deploymentId: z.string().ulid("deploymentId must be a ULID"),
  token: z.string().min(1),
  buildArgs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "build arg keys must be valid identifiers"), z.string()).optional(),
  push: pushTargetSchema.optional(),
});
