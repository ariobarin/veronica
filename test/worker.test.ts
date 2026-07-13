import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizeRoot } from "../src/path-policy.js";
import { executeWorkerRequest } from "../src/worker.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("worker executes file requests with revision checks", async t => {
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

  await assert.rejects(
    executeWorkerRequest(root, {
      type: "write_file",
      workspace: ".",
      path: "missing/guarded.txt",
      content: "replacement",
      expectedSha256: sha256("missing")
    }),
    error => error instanceof Error && "code" in error && error.code === "conflict"
  );
  await assert.rejects(
    access(path.join(root, "missing")),
    error => error instanceof Error && "code" in error && error.code === "ENOENT"
  );

  const largeFile = path.join(root, "large.txt");
  await writeFile(largeFile, "x".repeat(1024 * 1024 + 1), "utf8");
  await assert.rejects(
    executeWorkerRequest(root, {
      type: "write_file",
      workspace: ".",
      path: "large.txt",
      content: "replacement",
      expectedSha256: sha256("irrelevant")
    }),
    error =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_request" &&
      /exceeds the 1 MiB limit/.test(error.message)
  );
  assert.equal((await stat(largeFile)).size, 1024 * 1024 + 1);

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

    if (process.getuid?.() !== 0) {
      const readOnly = path.join(root, "read-only.txt");
      await writeFile(readOnly, "original", "utf8");
      await chmod(readOnly, 0o444);
      await assert.rejects(
        executeWorkerRequest(root, {
          type: "write_file",
          workspace: ".",
          path: "read-only.txt",
          content: "replacement"
        }),
        error =>
          error instanceof Error &&
          "code" in error &&
          (error.code === "EACCES" || error.code === "EPERM")
      );
      assert.equal(await readFile(readOnly, "utf8"), "original");
    }
  }
});

test("direct argv execution preserves arguments and standard input", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-command-"));
  t.after(() => rm(rootInput, { recursive: true, force: true }));
  const root = await canonicalizeRoot(rootInput);

  const argumentsResult = (await executeWorkerRequest(root, {
    type: "run_command",
    workspace: ".",
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "argument with spaces",
      "snowman-☃"
    ],
    timeoutSeconds: 10
  })) as {
    exitCode: number | null;
    spawnError: string | null;
    stdout: string;
    timedOut: boolean;
  };
  assert.equal(argumentsResult.exitCode, 0);
  assert.equal(argumentsResult.spawnError, null);
  assert.deepEqual(JSON.parse(argumentsResult.stdout), ["argument with spaces", "snowman-☃"]);
  assert.equal(argumentsResult.timedOut, false);

  const stdinResult = (await executeWorkerRequest(root, {
    type: "run_command",
    workspace: ".",
    argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
    stdin: "hello through stdin",
    timeoutSeconds: 10
  })) as {
    exitCode: number | null;
    spawnError: string | null;
    stdout: string;
  };
  assert.equal(stdinResult.exitCode, 0);
  assert.equal(stdinResult.spawnError, null);
  assert.equal(stdinResult.stdout, "hello through stdin");

  const shellResult = (await executeWorkerRequest(root, {
    type: "run_command",
    workspace: ".",
    shellCommand: process.platform === "win32" ? "echo shell-mode" : "printf shell-mode",
    timeoutSeconds: 10
  })) as {
    exitCode: number | null;
    spawnError: string | null;
    stdout: string;
  };
  assert.equal(shellResult.exitCode, 0);
  assert.equal(shellResult.spawnError, null);
  assert.equal(shellResult.stdout.trim(), "shell-mode");

  if (process.platform === "win32") {
    const batchResult = (await executeWorkerRequest(root, {
      type: "run_command",
      workspace: ".",
      argv: ["npm.cmd", "--version"],
      timeoutSeconds: 10
    })) as {
      exitCode: number | null;
      spawnError: string | null;
      stdout: string;
    };
    assert.equal(batchResult.exitCode, 0);
    assert.equal(batchResult.spawnError, null);
    assert.match(batchResult.stdout.trim(), /^\d+\.\d+\.\d+/);
  }
});

test("command execution reports spawn errors without throwing", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-spawn-"));
  t.after(() => rm(rootInput, { recursive: true, force: true }));
  const root = await canonicalizeRoot(rootInput);

  const result = (await executeWorkerRequest(root, {
    type: "run_command",
    workspace: ".",
    argv: ["veronica-executable-that-does-not-exist"],
    timeoutSeconds: 10
  })) as {
    exitCode: number | null;
    spawnError: string | null;
    timedOut: boolean;
  };
  assert.equal(result.exitCode, null);
  assert.match(result.spawnError ?? "", /ENOENT|not found/i);
  assert.equal(result.timedOut, false);
});

test("command timeout terminates descendant processes", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-timeout-"));
  t.after(() => rm(rootInput, { recursive: true, force: true }));
  const root = await canonicalizeRoot(rootInput);
  const marker = path.join(root, "descendant-survived.txt");
  const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 2000)`;
  const parentCode = [
    'const { spawn } = require("node:child_process")',
    `spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" })`,
    "setTimeout(() => {}, 10000)"
  ].join(";");

  const result = (await executeWorkerRequest(root, {
    type: "run_command",
    workspace: ".",
    argv: [process.execPath, "-e", parentCode],
    timeoutSeconds: 1
  })) as {
    timedOut: boolean;
    spawnError: string | null;
  };
  assert.equal(result.timedOut, true);
  assert.equal(result.spawnError, null);
  await new Promise(resolve => setTimeout(resolve, 2500));
  await assert.rejects(access(marker), error => error instanceof Error && "code" in error && error.code === "ENOENT");
});
