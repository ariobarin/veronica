import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Broker } from "../src/broker.js";
import { resolveOAuthConfig } from "../src/auth.js";
import { createGatewayApp } from "../src/server.js";
import { runWorker } from "../src/worker.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("gateway routes real workspace operations through a polling worker", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "veronica-integration-"));
  const canonicalRoot = await realpath(root);
  await writeFile(path.join(root, "README.md"), "hello", "utf8");
  const broker = new Broker();
  const oauth = resolveOAuthConfig({
    VERONICA_OAUTH_ISSUER: "https://tenant.example.com/",
    VERONICA_OAUTH_AUDIENCE: "https://veronica.example.com/",
    VERONICA_OAUTH_RESOURCE: "https://veronica.example.com/"
  });
  const token = "d".repeat(32);
  const app = createGatewayApp(
    {
      deviceToken: token,
      oauth,
      verifier: {
        async verifyAccessToken() {
          throw new Error("OAuth is not used by this worker integration test");
        }
      }
    },
    broker
  );
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });

  const controller = new AbortController();
  const gateway = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const worker = runWorker({
    root,
    rootLabel: "integration-root",
    name: "integration-worker",
    gateway,
    token,
    signal: controller.signal
  });

  t.after(async () => {
    controller.abort();
    await worker;
    await new Promise<void>((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(() => broker.listDevices().some(device => device.name === "integration-worker" && device.online));
  const workspace = await broker.openWorkspace(undefined, ".");

  const read = await broker.executeInWorkspace(workspace.id, workspacePath => ({
    type: "read_file",
    workspace: workspacePath,
    path: "README.md"
  }));
  assert.deepEqual(read, { ok: true, value: { content: "hello", sha256: sha256("hello") } });

  const write = await broker.executeInWorkspace(workspace.id, workspacePath => ({
    type: "write_file",
    workspace: workspacePath,
    path: "notes/result.txt",
    content: "written through the gateway"
  }));
  assert.deepEqual(write, {
    ok: true,
    value: { bytesWritten: 27, sha256: sha256("written through the gateway") }
  });

  const command = await broker.executeInWorkspace(workspace.id, workspacePath => ({
    type: "run_command",
    workspace: workspacePath,
    argv: [process.execPath, "-p", "process.cwd()"],
    timeoutSeconds: 10
  }));
  assert.equal(command.ok, true);
  if (command.ok) {
    const value = command.value as { exitCode: number | null; stdout: string; timedOut: boolean };
    assert.equal(value.exitCode, 0);
    assert.equal(value.stdout.trim(), canonicalRoot);
    assert.equal(value.timedOut, false);
  }

  assert.equal(broker.closeWorkspace(workspace.id), true);
});
