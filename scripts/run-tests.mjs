import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const tests = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...(await findTests(candidate)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) tests.push(candidate);
  }
  return tests;
}

const coverage = process.argv.includes("--coverage");
const tests = (await findTests("test")).sort();
if (tests.length === 0) throw new Error("No test files found");

const arguments_ = ["--import", "tsx", "--test"];
if (coverage) arguments_.push("--experimental-test-coverage");
arguments_.push(...tests);

const result = spawnSync(process.execPath, arguments_, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
