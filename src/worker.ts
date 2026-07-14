import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

type RunCommandRequest = Extract<WorkerRequest, { type: "run_command" }>;

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

function resolveWindowsCommand(cwd: string, file: string): string {
  const extensions = path.extname(file)
    ? [""]
    : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const names = extensions.map(extension => `${file}${extension}`);
  const candidates = path.isAbsolute(file)
    ? names
    : file.includes("/") || file.includes("\\")
      ? names.map(name => path.resolve(cwd, name))
      : (process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .flatMap(directory => names.map(name => path.join(directory, name)));
  return candidates.find(candidate => existsSync(candidate)) ?? file;
}

function quoteWindowsBatchArgument(value: string): string {
  if (/[\r\n"%!]/.test(value)) {
    throw new VeronicaError(
      "invalid_request",
      "Windows batch argv does not support quotes, percent signs, exclamation marks, or newlines; use shell_command"
    );
  }
  return `"${value}"`;
}

function commandInvocation(
  cwd: string,
  request: RunCommandRequest
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (request.argv) {
    const [file, ...args] = request.argv;
    if (!file) throw new VeronicaError("invalid_request", "argv must contain an executable");
    if (process.platform === "win32") {
      const resolvedFile = resolveWindowsCommand(cwd, file);
      if (/\.(?:cmd|bat)$/i.test(resolvedFile)) {
        const command = [resolvedFile, ...args].map(quoteWindowsBatchArgument).join(" ");
        return {
          file: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", `call ${command}`],
          windowsVerbatimArguments: true
        };
      }
      return { file: resolvedFile, args };
    }
    return { file, args };
  }
  if (request.shellCommand === undefined) {
    throw new VeronicaError("invalid_request", "Provide exactly one of argv or shell_command");
  }
  if (process.platform === "win32") {
    const file = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "cmd.exe") : "cmd.exe";
    return { file, args: ["/d", "/s", "/c", request.shellCommand] };
  }
  return { file: "/bin/sh", args: ["-c", request.shellCommand] };
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      killer.on("error", () => {
        try {
          process.kill(pid);
        } catch {
          // The process already exited.
        }
        finish();
      });
      killer.on("close", finish);
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  await new Promise<void>(resolve => {
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process group already exited.
      }
      resolve();
    }, 500);
  });
}

async function runCommand(cwd: string, request: RunCommandRequest, signal?: AbortSignal) {
  const invocation = commandInvocation(cwd, request);
  return await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    spawnError: string | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
  }>(resolve => {
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;

    const startTermination = () => {
      termination ??= terminateProcessTree(child.pid);
      return termination;
    };
    const abort = () => {
      void startTermination();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

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

    const finish = async (exitCode: number | null, exitSignal: NodeJS.Signals | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (termination) await termination;
      resolve({
        exitCode,
        signal: exitSignal,
        spawnError,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
        timedOut
      });
    };

    child.stdout.on("data", (chunk: Buffer) => capture(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, stderr));
    child.stdin.on("error", () => undefined);
    child.on("error", error => void finish(null, null, error.message));
    child.on("close", (exitCode, signal) => void finish(exitCode, signal, null));

    if (request.stdin === undefined) child.stdin.end();
    else child.stdin.end(request.stdin, "utf8");

    timer = setTimeout(() => {
      timedOut = true;
      void startTermination();
    }, (request.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000);
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
  let metadata;
  try {
    metadata = await stat(file);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") throw new VeronicaError("conflict", "File does not exist at the expected revision");
    throw error;
  }
  if (!metadata.isFile()) throw new VeronicaError("invalid_request", "Expected revision path is not a file");
  if (metadata.size > MAX_TEXT_BYTES) throw new VeronicaError("invalid_request", "File exceeds the 1 MiB limit");

  let current: Buffer;
  try {
    current = await readFile(file);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") throw new VeronicaError("conflict", "File does not exist at the expected revision");
    throw error;
  }
  if (current.length > MAX_TEXT_BYTES) throw new VeronicaError("invalid_request", "File exceeds the 1 MiB limit");
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

export async function executeWorkerRequest(
  root: string,
  request: WorkerRequest,
  signal?: AbortSignal
): Promise<unknown> {
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
    if (request.expectedSha256) await assertExpectedHash(file, request.expectedSha256);
    await mkdir(path.dirname(file), { recursive: true });
    await replaceFileAtomically(file, request.content);
    return {
      bytesWritten: Buffer.byteLength(request.content, "utf8"),
      sha256: sha256(request.content)
    };
  }

  return await runCommand(workspace, request, signal);
}

export async function executeDeviceJob(
  root: string,
  job: DeviceJob,
  signal?: AbortSignal
): Promise<WorkerResult> {
  try {
    return { ok: true, value: await executeWorkerRequest(root, job.request, signal) };
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
      const result = await executeDeviceJob(root, polled.job, options.signal);

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
