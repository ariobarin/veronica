import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatDoctorChecks, runDoctor } from "../src/doctor.js";

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

test("doctor verifies a healthy private worker path", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-"));
  const configPath = path.join(directory, "config.json");
  const root = path.join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(
    configPath,
    `${JSON.stringify({ gateway: { deviceToken: "d".repeat(32), hosts: ["127.0.0.1"] } })}\n`,
    { mode: 0o600 }
  );
  if (process.platform !== "win32") await chmod(configPath, 0o600);

  const fetcher: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "veronica" });
    assert.equal(url.pathname, "/device/poll");
    assert.equal(init?.headers && new Headers(init.headers).get("authorization"), "Bearer worker-token");
    assert.equal(init?.body, "{}");
    return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
  };

  const checks = await runDoctor({
    configPath,
    root,
    gateway: "http://127.0.0.1:39100",
    gatewayHosts: ["127.0.0.1"],
    workerToken: "worker-token",
    nodeVersion: "20.0.0",
    fetcher
  });
  assert.equal(checks.every(check => check.ok), true);
  assert.equal(checks.find(check => check.name === "gateway listeners")?.skipped, undefined);
  assert.match(formatDoctorChecks(checks), /✓ worker authentication: token accepted/);
});

test("doctor probes the saved gateway port when no worker URL is configured", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-port-"));
  const configPath = path.join(directory, "config.json");
  const root = path.join(directory, "repo");
  const requested: URL[] = [];
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(
    configPath,
    `${JSON.stringify({ gateway: { deviceToken: "d".repeat(32), hosts: ["127.0.0.1"], port: 43123 } })}\n`,
    { mode: 0o600 }
  );

  const fetcher: typeof fetch = async input => {
    const url = requestUrl(input);
    requested.push(url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "veronica" });
    return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
  };
  const checks = await runDoctor({
    configPath,
    root,
    gateway: "http://127.0.0.1:39100",
    gatewayHosts: ["127.0.0.1"],
    workerToken: "d".repeat(32),
    environment: {},
    fetcher
  });

  assert.equal(checks.every(check => check.ok), true);
  assert.equal(requested.length, 2);
  assert.deepEqual(requested.map(url => url.port), ["43123", "43123"]);
});

test("doctor exposes unsafe listeners, missing credentials, and failed health", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-fail-"));
  const root = path.join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);

  const checks = await runDoctor({
    configPath: path.join(directory, "missing.json"),
    root,
    gateway: "http://127.0.0.1:39100",
    gatewayHosts: ["0.0.0.0"],
    environment: { VERONICA_HOSTS: "0.0.0.0" },
    nodeVersion: "18.0.0",
    fetcher: async () => new Response("unavailable", { status: 503 })
  });
  assert.equal(checks.find(check => check.name === "Node.js")?.ok, false);
  assert.equal(checks.find(check => check.name === "config")?.skipped, true);
  assert.equal(checks.find(check => check.name === "gateway listeners")?.ok, false);
  assert.equal(checks.find(check => check.name === "gateway health")?.ok, false);
  assert.equal(checks.find(check => check.name === "worker authentication")?.ok, false);
  assert.match(formatDoctorChecks(checks), /✗ worker authentication: worker token is missing/);
});

test("doctor marks listener safety unknown on a worker-only machine", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-worker-"));
  const configPath = path.join(directory, "config.json");
  const root = path.join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(
    configPath,
    `${JSON.stringify({ worker: { token: "worker-token", gateway: "http://private.test" } })}\n`,
    { mode: 0o600 }
  );

  const fetcher: typeof fetch = async input => {
    const url = requestUrl(input);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "veronica" });
    return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
  };
  const checks = await runDoctor({
    configPath,
    root,
    gateway: "http://private.test",
    gatewayHosts: ["127.0.0.1"],
    workerToken: "worker-token",
    fetcher
  });
  const listeners = checks.find(check => check.name === "gateway listeners");
  assert.equal(listeners?.ok, true);
  assert.equal(listeners?.skipped, true);
  assert.match(formatDoctorChecks(checks), /- gateway listeners: not configured on this machine/);
});

test("doctor reports a rejected worker token", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-auth-"));
  const root = path.join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);

  const fetcher: typeof fetch = async input => {
    const url = requestUrl(input);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "veronica" });
    return new Response("unauthorized", { status: 401 });
  };
  const checks = await runDoctor({
    configPath: path.join(directory, "missing.json"),
    root,
    gateway: "http://127.0.0.1:39100",
    workerToken: "wrong-token",
    fetcher
  });
  assert.equal(checks.find(check => check.name === "worker authentication")?.ok, false);
  assert.match(formatDoctorChecks(checks), /token rejected with HTTP 401/);
});


test("doctor reports malformed saved configuration", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-malformed-"));
  const configPath = path.join(directory, "config.json");
  const root = path.join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(configPath, "{not-json", { mode: 0o600 });

  const checks = await runDoctor({
    configPath,
    root,
    gateway: "http://127.0.0.1:39100",
    workerToken: "worker-token",
    fetcher: async input => {
      const url = requestUrl(input);
      if (url.pathname === "/healthz") return Response.json({ ok: true, service: "veronica" });
      return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
    }
  });

  assert.equal(checks.find(check => check.name === "config")?.ok, false);
  assert.equal(checks.find(check => check.name === "gateway listeners")?.ok, false);
  assert.match(formatDoctorChecks(checks), /Invalid Veronica config JSON/);
});
