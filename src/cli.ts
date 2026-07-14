#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_GATEWAY } from "./defaults.js";
import { canonicalizeRoot } from "./path-policy.js";
import { runWorker } from "./worker.js";

const execFileAsync = promisify(execFile);

function usage(): string {
  return `Veronica

Usage:
  veronica [path] [--name <name>] [--gateway <url>] [--allow-broad-root]
  veronica expose [path] [--name <name>] [--gateway <url>] [--allow-broad-root]
  veronica gateway
  veronica --help

Environment:
  VERONICA_GATEWAY   Gateway URL, default ${DEFAULT_GATEWAY}
  VERONICA_TOKEN     Private worker bearer token

With no command, Veronica exposes the current Git worktree root. Outside a Git worktree, pass an explicit path.
`;
}

export type CliCommand = { kind: "help" } | { kind: "gateway" } | { kind: "expose"; args: string[] };

export function parseCliCommand(args: string[]): CliCommand {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || command === "help") return { kind: "help" };
  if (command === "gateway") {
    if (rest.length > 0) throw new Error(`Unexpected gateway argument: ${rest[0]}`);
    return { kind: "gateway" };
  }
  if (command === "expose") return { kind: "expose", args: rest };
  return { kind: "expose", args };
}

export type ExposeOptions = {
  root?: string;
  name: string;
  gateway: string;
  token: string;
  allowBroadRoot: boolean;
};

export function parseExposeArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  hostname = os.hostname()
): ExposeOptions {
  let root: string | undefined;
  let name = hostname;
  let gateway = environment.VERONICA_GATEWAY ?? DEFAULT_GATEWAY;
  const token = environment.VERONICA_TOKEN ?? "";
  let allowBroadRoot = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--allow-broad-root") {
      allowBroadRoot = true;
      continue;
    }
    if (arg === "--name" || arg === "--gateway") {
      const value = args[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--name") name = value;
      if (arg === "--gateway") gateway = value;
      continue;
    }
    if (arg?.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    if (root !== undefined) throw new Error(`Unexpected argument: ${arg}`);
    root = arg;
  }

  if (!token) throw new Error("Set VERONICA_TOKEN before starting a worker");
  return { root, name, gateway, token, allowBroadRoot };
}

type ResolveExposeRootOptions = {
  cwd?: string;
  home?: string;
  allowBroadRoot?: boolean;
  findGitRoot?: (cwd: string) => Promise<string>;
};

async function defaultFindGitRoot(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  const root = stdout.trim();
  if (!root) throw new Error("Git did not return a worktree root");
  return root;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function rootLabel(root: string): string {
  const raw = (path.basename(root) || root).trim() || "workspace";
  let label = "";
  for (const character of raw) {
    if (label.length + character.length > 128) break;
    label += character;
  }
  return label;
}

export async function resolveExposeRoot(
  requestedRoot: string | undefined,
  options: ResolveExposeRootOptions = {}
): Promise<{ root: string; label: string; source: "explicit" | "git" }> {
  const cwd = options.cwd ?? process.cwd();
  let selected: string;
  let source: "explicit" | "git";
  if (requestedRoot !== undefined) {
    selected = path.resolve(cwd, requestedRoot);
    source = "explicit";
  } else {
    try {
      selected = await (options.findGitRoot ?? defaultFindGitRoot)(cwd);
    } catch {
      throw new Error("No Git worktree found. Pass the directory to expose explicitly.");
    }
    source = "git";
  }

  const root = await canonicalizeRoot(selected);
  let home: string | undefined;
  try {
    home = await canonicalizeRoot(options.home ?? os.homedir());
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  const filesystemRoot = path.parse(root).root;
  if (!options.allowBroadRoot && ((home !== undefined && samePath(root, home)) || samePath(root, filesystemRoot))) {
    throw new Error("Refusing to expose a home or filesystem root. Pass --allow-broad-root to confirm this boundary.");
  }

  return {
    root,
    label: rootLabel(root),
    source
  };
}

async function expose(args: string[]): Promise<void> {
  const options = parseExposeArgs(args);
  const selected = await resolveExposeRoot(options.root, { allowBroadRoot: options.allowBroadRoot });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await runWorker({
      root: selected.root,
      rootLabel: selected.label,
      name: options.name,
      gateway: options.gateway,
      token: options.token,
      signal: controller.signal
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = parseCliCommand(args);
  if (command.kind === "help") {
    console.log(usage());
    return;
  }
  if (command.kind === "gateway") {
    const { startServer } = await import("./server.js");
    startServer();
    return;
  }
  await expose(command.args);
}

export function isCliMainModule(
  entrypoint: string | undefined,
  moduleUrl: string,
  canonicalize: (value: string) => string = realpathSync
): boolean {
  if (!entrypoint) return false;
  return canonicalize(path.resolve(entrypoint)) === canonicalize(fileURLToPath(moduleUrl));
}

if (isCliMainModule(process.argv[1], import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
