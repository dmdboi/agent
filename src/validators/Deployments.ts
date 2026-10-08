import { z } from "zod";

export const createDeploymentSchema = z.object({
  deployment_id: z.string().min(1),
  strategy: z.enum(["rolling", "recreate"]).default("rolling"),
  container: z
    .object({
      name: z.string().min(1),
      image: z.string().min(1),
      networks: z.array(z.string()).optional(),
    })
    .passthrough(),
  health: z
    .object({
      path: z.string().default("/up"),
      port: z.number().int().positive().max(65535),
      timeout_s: z.number().int().positive().max(600).default(120),
      interval_s: z.number().int().positive().max(60).default(3),
    })
    .optional(),
  retire: z.array(z.string()).default([]),
  stop_grace_seconds: z.number().int().nonnegative().max(600).optional(),
  prestep: z
    .object({
      run: z.boolean().default(false),
      command: z.array(z.string()).min(1).default(["php", "artisan", "migrate", "--pretend"]),
      labels: z.record(z.string()).optional(),
    })
    .optional(),
});

export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;
