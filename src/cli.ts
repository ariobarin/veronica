#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { canonicalizeRoot } from "./path-policy.js";
import { runWorker } from "./worker.js";

const execFileAsync = promisify(execFile);

function usage(): string {
  return `Veronica

Usage:
  veronica expose [path] [--name <name>] [--gateway <url>] [--allow-broad-root]

Environment:
  VERONICA_GATEWAY   Gateway URL, default http://127.0.0.1:3000
  VERONICA_TOKEN     Private worker bearer token

With no path, Veronica exposes the current Git worktree root. Outside a Git worktree, pass an explicit path.
`;
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
  let gateway = environment.VERONICA_GATEWAY ?? "http://127.0.0.1:3000";
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
  const home = await canonicalizeRoot(options.home ?? os.homedir());
  const filesystemRoot = path.parse(root).root;
  if (!options.allowBroadRoot && (samePath(root, home) || samePath(root, filesystemRoot))) {
    throw new Error("Refusing to expose a home or filesystem root. Pass --allow-broad-root to confirm this boundary.");
  }

  return {
    root,
    label: path.basename(root) || root,
    source
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...commandArgs] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command !== "expose") throw new Error(`Unknown command: ${command}\n\n${usage()}`);

  const options = parseExposeArgs(commandArgs);
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
