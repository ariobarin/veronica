import { z } from "zod/v4";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
export const MAX_COMMAND_TIMEOUT_SECONDS = 3600;

export const relativePathSchema = z.string().min(1).max(4096);
export const commandSchema = z.string().min(1).max(100_000);
export const commandArgumentSchema = z.string().max(32_768);
export const argvSchema = z.array(commandArgumentSchema).min(1).max(1024);
export const timeoutSecondsSchema = z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_SECONDS);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const textContentSchema = z.string().refine(value => Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES, {
  message: "Content exceeds the 1 MiB limit"
});

export const commandInvocationSchema = z
  .object({
    argv: argvSchema.optional(),
    shellCommand: commandSchema.optional(),
    stdin: textContentSchema.optional()
  })
  .superRefine((value, context) => {
    if (Number(value.argv !== undefined) + Number(value.shellCommand !== undefined) !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of argv or shell_command"
      });
    }
  });

export const veronicaErrorCodeSchema = z.enum([
  "invalid_request",
  "not_found",
  "conflict",
  "unavailable",
  "timeout",
  "operation_failed"
]);
export type VeronicaErrorCode = z.infer<typeof veronicaErrorCodeSchema>;

export class VeronicaError extends Error {
  constructor(
    readonly code: VeronicaErrorCode,
    message: string
  ) {
    super(message);
  }
}

export const workerErrorSchema = z.object({
  code: veronicaErrorCodeSchema,
  message: z.string().min(1).max(10_000)
});
export type WorkerError = z.infer<typeof workerErrorSchema>;

export function toWorkerError(error: unknown): WorkerError {
  if (error instanceof VeronicaError) return { code: error.code, message: error.message };
  return { code: "operation_failed", message: error instanceof Error ? error.message : String(error) };
}

const openWorkspaceRequestSchema = z.object({
  type: z.literal("open_workspace"),
  path: relativePathSchema
});

const readFileRequestSchema = z.object({
  type: z.literal("read_file"),
  workspace: relativePathSchema,
  path: relativePathSchema
});

const writeFileRequestSchema = z.object({
  type: z.literal("write_file"),
  workspace: relativePathSchema,
  path: relativePathSchema,
  content: textContentSchema,
  expectedSha256: sha256Schema.optional()
});

const runCommandRequestSchema = z
  .object({
    type: z.literal("run_command"),
    workspace: relativePathSchema,
    argv: argvSchema.optional(),
    shellCommand: commandSchema.optional(),
    stdin: textContentSchema.optional(),
    timeoutSeconds: timeoutSecondsSchema
  })
  .superRefine((value, context) => {
    if (Number(value.argv !== undefined) + Number(value.shellCommand !== undefined) !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of argv or shell_command"
      });
    }
  });

export const workerRequestSchema = z.union([
  openWorkspaceRequestSchema,
  readFileRequestSchema,
  writeFileRequestSchema,
  runCommandRequestSchema
]);

export type WorkerRequest = z.infer<typeof workerRequestSchema>;

export const workerResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: workerErrorSchema })
]);
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const deviceJobSchema = z.object({
  id: z.string().uuid(),
  request: workerRequestSchema
});
export type DeviceJob = z.infer<typeof deviceJobSchema>;

export const registerDeviceSchema = z.object({
  name: z.string().trim().min(1).max(64),
  platform: z.string().trim().min(1).max(64),
  rootLabel: z.string().trim().min(1).max(128).optional()
});

export const pollDeviceSchema = z.object({
  deviceId: z.string().uuid(),
  waitMs: z.number().int().min(0).max(30_000).default(25_000)
});

export const submitResultSchema = z.object({
  deviceId: z.string().uuid(),
  jobId: z.string().uuid(),
  result: workerResultSchema
});

export const readFileValueSchema = z.object({
  content: z.string(),
  sha256: sha256Schema
});

export const writeFileValueSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
  sha256: sha256Schema
});

export const commandValueSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  spawnError: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean()
});
