import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatDoctorChecks, runDoctor } from "../src/doctor.js";

test("doctor reports an invalid port override and continues other checks", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-bad-port-"));
  const root = path.join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);

  const requested: URL[] = [];
  const checks = await runDoctor({
    configPath: path.join(directory, "missing.json"),
    root,
    gateway: "http://127.0.0.1:39100",
    gatewayHosts: ["127.0.0.1"],
    workerToken: "worker-token",
    environment: { VERONICA_PORT: "39100oops" },
    fetcher: async input => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      requested.push(url);
      if (url.pathname === "/healthz") return Response.json({ ok: true, service: "veronica" });
      return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
    }
  });

  assert.equal(checks.find(check => check.name === "gateway configuration")?.ok, false);
  assert.match(formatDoctorChecks(checks), /Invalid port: 39100oops/);
  assert.equal(checks.find(check => check.name === "gateway health")?.ok, true);
  assert.equal(checks.find(check => check.name === "worker authentication")?.ok, true);
  assert.deepEqual(requested.map(url => url.port), ["39100", "39100"]);
});


test("doctor reports an empty host override and continues other checks", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-doctor-bad-hosts-"));
  const root = path.join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root);

  const checks = await runDoctor({
    configPath: path.join(directory, "missing.json"),
    root,
    gateway: "http://127.0.0.1:39100",
    workerToken: "worker-token",
    environment: { VERONICA_HOSTS: "," },
    fetcher: async input => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/healthz") return Response.json({ ok: true, service: "veronica" });
      return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
    }
  });

  assert.equal(checks.find(check => check.name === "gateway listeners")?.ok, false);
  assert.equal(checks.find(check => check.name === "gateway configuration")?.ok, false);
  assert.match(formatDoctorChecks(checks), /VERONICA_HOSTS must contain at least one value/);
  assert.equal(checks.find(check => check.name === "gateway health")?.ok, true);
  assert.equal(checks.find(check => check.name === "worker authentication")?.ok, true);
});
