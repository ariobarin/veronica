import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizeRoot } from "../src/path-policy.js";
import { executeDeviceJob, executeWorkerRequest } from "../src/worker.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("worker executes file and command requests inside a workspace", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-worker-"));
  t.after(() => rm(rootInput, { recursive: true, force: true }));
  await writeFile(path.join(rootInput, "README.md"), "hello", "utf8");
  const root = await canonicalizeRoot(rootInput);

  assert.deepEqual(await executeWorkerRequest(root, { type: "open_workspace", path: "." }), { path: "." });
  assert.deepEqual(
    await executeWorkerRequest(root, { type: "read_file", workspace: ".", path: "README.md" }),
    { content: "hello", sha256: sha256("hello") }
  );
  assert.deepEqual(
    await executeWorkerRequest(root, {
      type: "write_file",
      workspace: ".",
      path: "src/new.txt",
      content: "written"
    }),
    { bytesWritten: 7, sha256: sha256("written") }
  );
  assert.equal(await readFile(path.join(root, "src", "new.txt"), "utf8"), "written");

  assert.deepEqual(
    await executeWorkerRequest(root, {
      type: "write_file",
      workspace: ".",
      path: "README.md",
      content: "updated",
      expectedSha256: sha256("hello")
    }),
    { bytesWritten: 7, sha256: sha256("updated") }
  );
  await assert.rejects(
    executeWorkerRequest(root, {
      type: "write_file",
      workspace: ".",
      path: "README.md",
      content: "stale overwrite",
      expectedSha256: sha256("hello")
    }),
    error => error instanceof Error && "code" in error && error.code === "conflict"
  );
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "updated");
  assert.equal((await readdir(root)).some(entry => entry.endsWith(".tmp")), false);

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

test("worker rejects expired jobs before execution", async () => {
  const result = await executeDeviceJob(
    ".",
    {
      id: randomUUID(),
      expiresAt: Date.now() - 1,
      request: { type: "open_workspace", path: "." }
    },
    Date.now()
  );
  assert.deepEqual(result, {
    ok: false,
    error: { code: "expired", message: "Device job expired before execution" }
  });
});
