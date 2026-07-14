import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  deviceJobSchema,
  MAX_TEXT_BYTES,
  toWorkerError,
  VeronicaError,
  type DeviceJob,
  type WorkerRequest,
  type WorkerResult
} from "./protocol.js";
import { canonicalizeRoot, resolveExistingPath, resolveWritePath } from "./path-policy.js";

const registerResponseSchema = z.object({ deviceId: z.string().uuid() });
const pollResponseSchema = z.object({ job: deviceJobSchema.nullable() });

class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function postJson<T>(
  gateway: string,
  pathname: string,
  token: string,
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(new URL(pathname, gateway), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const text = await response.text();
    throw new GatewayError(text || `Gateway request failed with ${response.status}`, response.status);
  }

  return (await response.json()) as T;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

async function runCommand(cwd: string, command: string, timeoutSeconds: number) {
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL ?? "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];

  return await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;

    const capture = (chunk: Buffer, target: Buffer[]) => {
      const remaining = MAX_TEXT_BYTES - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(accepted);
      capturedBytes += accepted.length;
      if (accepted.length !== chunk.length) truncated = true;
    };

    child.stdout.on("data", (chunk: Buffer) => capture(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, stderr));
    child.on("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
        timedOut
      });
    });
  });
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readTextFile(file: string): Promise<{ content: string; sha256: string }> {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new VeronicaError("invalid_request", "Requested path is not a file");
  if (metadata.size > MAX_TEXT_BYTES) throw new VeronicaError("invalid_request", "File exceeds the 1 MiB limit");
  const bytes = await readFile(file);
  if (bytes.length > MAX_TEXT_BYTES) throw new VeronicaError("invalid_request", "File exceeds the 1 MiB limit");
  return { content: bytes.toString("utf8"), sha256: sha256(bytes) };
}

async function assertExpectedHash(file: string, expectedSha256: string): Promise<void> {
  let current: Buffer;
  try {
    current = await readFile(file);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") throw new VeronicaError("conflict", "File does not exist at the expected revision");
    throw error;
  }
  if (sha256(current) !== expectedSha256) {
    throw new VeronicaError("conflict", "File changed since it was read");
  }
}

async function replaceFileAtomically(file: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.veronica-${randomUUID()}.tmp`);
  let existingMode: number | undefined;
  try {
    const existing = await open(file, "r+");
    try {
      existingMode = (await existing.stat()).mode;
    } finally {
      await existing.close();
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code !== "ENOENT") throw error;
  }

  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: existingMode });
    if (existingMode !== undefined && process.platform !== "win32") await chmod(temporary, existingMode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function executeWorkerRequest(root: string, request: WorkerRequest): Promise<unknown> {
  if (request.type === "open_workspace") {
    const workspace = await resolveExistingPath(root, request.path);
    const metadata = await stat(workspace);
    if (!metadata.isDirectory()) throw new VeronicaError("invalid_request", "Workspace path must be a directory");
    return { path: request.path };
  }

  const workspace = await resolveExistingPath(root, request.workspace);
  const workspaceMetadata = await stat(workspace);
  if (!workspaceMetadata.isDirectory()) {
    throw new VeronicaError("invalid_request", "Workspace is no longer a directory");
  }

  if (request.type === "read_file") {
    const file = await resolveExistingPath(workspace, request.path);
    return await readTextFile(file);
  }

  if (request.type === "write_file") {
    const file = await resolveWritePath(workspace, request.path);
    await mkdir(path.dirname(file), { recursive: true });
    if (request.expectedSha256) await assertExpectedHash(file, request.expectedSha256);
    await replaceFileAtomically(file, request.content);
    return {
      bytesWritten: Buffer.byteLength(request.content, "utf8"),
      sha256: sha256(request.content)
    };
  }

  return await runCommand(
    workspace,
    request.command,
    request.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS
  );
}

export async function executeDeviceJob(root: string, job: DeviceJob): Promise<WorkerResult> {
  try {
    return { ok: true, value: await executeWorkerRequest(root, job.request) };
  } catch (error) {
    return { ok: false, error: toWorkerError(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type WorkerOptions = {
  root: string;
  name: string;
  gateway: string;
  token: string;
  signal?: AbortSignal;
};

export async function runWorker(options: WorkerOptions): Promise<void> {
  const root = await canonicalizeRoot(options.root);
  let deviceId: string | undefined;

  console.error(`Veronica exposing ${root} as ${options.name}`);

  while (!options.signal?.aborted) {
    try {
      if (!deviceId) {
        const registered = registerResponseSchema.parse(
          await postJson<unknown>(
            options.gateway,
            "/device/register",
            options.token,
            { name: options.name, platform: `${process.platform}/${process.arch}`, hostname: os.hostname() },
            options.signal
          )
        );
        deviceId = registered.deviceId;
        console.error(`Connected to ${options.gateway} as ${options.name}`);
      }

      const polled = pollResponseSchema.parse(
        await postJson<unknown>(
          options.gateway,
          "/device/poll",
          options.token,
          { deviceId, waitMs: 25_000 },
          options.signal
        )
      );

      if (!polled.job) continue;
      const result = await executeDeviceJob(root, polled.job);

      await postJson(
        options.gateway,
        "/device/result",
        options.token,
        { deviceId, jobId: polled.job.id, result },
        options.signal
      );
    } catch (error) {
      if (options.signal?.aborted) break;
      if (error instanceof GatewayError && error.status === 404) deviceId = undefined;
      console.error(`Veronica connection error: ${errorMessage(error)}`);
      await sleep(2_000, options.signal);
    }
  }
}
