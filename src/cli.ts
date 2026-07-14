#!/usr/bin/env node

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorker } from "./worker.js";

function usage(): string {
  return `Veronica

Usage:
  veronica expose [path] [--name <name>] [--gateway <url>] [--token <token>]

Environment:
  VERONICA_GATEWAY   Gateway URL, default http://127.0.0.1:3000
  VERONICA_TOKEN     Private worker bearer token
`;
}

export type ExposeOptions = {
  root: string;
  name: string;
  gateway: string;
  token: string;
};

export function parseExposeArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  hostname = os.hostname()
): ExposeOptions {
  let root = ".";
  let rootSet = false;
  let name = hostname;
  let gateway = environment.VERONICA_GATEWAY ?? "http://127.0.0.1:3000";
  let token = environment.VERONICA_TOKEN ?? "";

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--name" || arg === "--gateway" || arg === "--token") {
      const value = args[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--name") name = value;
      if (arg === "--gateway") gateway = value;
      if (arg === "--token") token = value;
      continue;
    }
    if (arg?.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    if (rootSet) throw new Error(`Unexpected argument: ${arg}`);
    root = arg ?? ".";
    rootSet = true;
  }

  if (!token) throw new Error("Set VERONICA_TOKEN or pass --token");
  return { root, name, gateway, token };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...commandArgs] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command !== "expose") throw new Error(`Unknown command: ${command}\n\n${usage()}`);

  const options = parseExposeArgs(commandArgs);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await runWorker({ ...options, signal: controller.signal });
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
