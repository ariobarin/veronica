#!/usr/bin/env node

import os from "node:os";
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

type ExposeOptions = {
  root: string;
  name: string;
  gateway: string;
  token: string;
};

function parseExposeArgs(args: string[]): ExposeOptions {
  let root = ".";
  let rootSet = false;
  let name = os.hostname();
  let gateway = process.env.VERONICA_GATEWAY ?? "http://127.0.0.1:3000";
  let token = process.env.VERONICA_TOKEN ?? "";

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

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command !== "expose") throw new Error(`Unknown command: ${command}\n\n${usage()}`);

  const options = parseExposeArgs(args);
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

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
