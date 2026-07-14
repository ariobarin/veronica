import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizeRoot } from "../src/path-policy.js";
import { executeWorkerRequest } from "../src/worker.js";

test("worker executes file and command requests inside a workspace", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-worker-"));
  t.after(() => rm(rootInput, { recursive: true, force: true }));
  await writeFile(path.join(rootInput, "README.md"), "hello", "utf8");
  const root = await canonicalizeRoot(rootInput);

  assert.deepEqual(await executeWorkerRequest(root, { type: "open_workspace", path: "." }), { path: "." });
  assert.deepEqual(
    await executeWorkerRequest(root, { type: "read_file", workspace: ".", path: "README.md" }),
    { content: "hello" }
  );
  assert.deepEqual(
    await executeWorkerRequest(root, {
      type: "write_file",
      workspace: ".",
      path: "src/new.txt",
      content: "written"
    }),
    { bytesWritten: 7 }
  );
  assert.equal(await readFile(path.join(root, "src", "new.txt"), "utf8"), "written");

  const command = (await executeWorkerRequest(root, {
    type: "run_command",
    workspace: ".",
    command: process.platform === "win32" ? "cd" : "pwd",
    timeoutSeconds: 10
  })) as {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
  };
  assert.equal(command.exitCode, 0);
  assert.equal(command.stdout.trim(), await realpath(root));
  assert.equal(command.stderr, "");
  assert.equal(command.truncated, false);
  assert.equal(command.timedOut, false);
});
