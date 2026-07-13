import { z } from "zod/v4";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
export const MAX_COMMAND_TIMEOUT_SECONDS = 3600;

const relativePathSchema = z.string().min(1).max(4096);

export const workerRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("open_workspace"),
    path: relativePathSchema
  }),
  z.object({
    type: z.literal("read_file"),
    workspace: relativePathSchema,
    path: relativePathSchema
  }),
  z.object({
    type: z.literal("write_file"),
    workspace: relativePathSchema,
    path: relativePathSchema,
    content: z.string()
  }),
  z.object({
    type: z.literal("run_command"),
    workspace: relativePathSchema,
    command: z.string().min(1).max(100_000),
    timeoutSeconds: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_SECONDS)
  })
]);

export type WorkerRequest = z.infer<typeof workerRequestSchema>;

export type WorkerResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export const deviceJobSchema = z.object({
  id: z.string().uuid(),
  request: workerRequestSchema
});

export type DeviceJob = z.infer<typeof deviceJobSchema>;

export const registerDeviceSchema = z.object({
  name: z.string().trim().min(1).max(64),
  platform: z.string().trim().min(1).max(64)
});

export const pollDeviceSchema = z.object({
  deviceId: z.string().uuid(),
  waitMs: z.number().int().min(0).max(30_000).default(25_000)
});

export const submitResultSchema = z.object({
  deviceId: z.string().uuid(),
  jobId: z.string().uuid(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.string().min(1).max(10_000) })
  ])
});
