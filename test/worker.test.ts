import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizeRoot } from "../src/path-policy.js";
import { executeWorkerRequest } from "../src/worker.js";

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

  const longName = `${"x".repeat(220)}.txt`;
  await executeWorkerRequest(root, {
    type: "write_file",
    workspace: ".",
    path: longName,
    content: "long name"
  });
  assert.equal(await readFile(path.join(root, longName), "utf8"), "long name");

  if (process.platform !== "win32") {
    const executable = path.join(root, "script.sh");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o751);
    await executeWorkerRequest(root, {
      type: "write_file",
      workspace: ".",
      path: "script.sh",
      content: "#!/bin/sh\nprintf preserved\n"
    });
    assert.equal((await stat(executable)).mode & 0o777, 0o751);
  }

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

