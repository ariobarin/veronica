import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../src/doctor.js";

test("doctor times out while reading a stalled health response body", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-body-timeout-"));
  const root = path.join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);

  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/device/poll") {
      return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new Error("health body aborted")),
          { once: true }
        );
      }
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const startedAt = Date.now();
  const checks = await runDoctor({
    configPath: path.join(directory, "missing.json"),
    root,
    gateway: "http://127.0.0.1:39100",
    workerToken: "worker-token",
    requestTimeoutMs: 20,
    fetcher
  });

  assert.equal(checks.find(check => check.name === "gateway health")?.ok, false);
  assert.match(checks.find(check => check.name === "gateway health")?.detail ?? "", /health body aborted/);
  assert.equal(checks.find(check => check.name === "worker authentication")?.ok, true);
  assert.ok(Date.now() - startedAt < 1_000);
});
