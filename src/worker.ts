import os from "node:os";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  deviceJobSchema,
  MAX_TEXT_BYTES,
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

export async function executeWorkerRequest(root: string, request: WorkerRequest): Promise<unknown> {
  if (request.type === "open_workspace") {
    const workspace = await resolveExistingPath(root, request.path);
    const metadata = await stat(workspace);
    if (!metadata.isDirectory()) throw new Error("Workspace path must be a directory");
    return { path: request.path };
  }

  const workspace = await resolveExistingPath(root, request.workspace);
  const workspaceMetadata = await stat(workspace);
  if (!workspaceMetadata.isDirectory()) throw new Error("Workspace is no longer a directory");

  if (request.type === "read_file") {
    const file = await resolveExistingPath(workspace, request.path);
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error("Requested path is not a file");
    if (metadata.size > MAX_TEXT_BYTES) throw new Error("File exceeds the 1 MiB prototype limit");
    return { content: await readFile(file, "utf8") };
  }

  if (request.type === "write_file") {
    if (Buffer.byteLength(request.content, "utf8") > MAX_TEXT_BYTES) {
      throw new Error("Content exceeds the 1 MiB prototype limit");
    }
    const file = await resolveWritePath(workspace, request.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, request.content, "utf8");
    return { bytesWritten: Buffer.byteLength(request.content, "utf8") };
  }

  return await runCommand(
    workspace,
    request.command,
    request.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS
  );
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

      let result: WorkerResult;
      try {
        result = { ok: true, value: await executeWorkerRequest(root, polled.job.request) };
      } catch (error) {
        result = { ok: false, error: errorMessage(error) };
      }

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
