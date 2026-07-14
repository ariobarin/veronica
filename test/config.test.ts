import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateDeviceToken, readConfig, resolveConfigPath, writeConfig } from "../src/config.js";

test("config paths honor explicit, XDG, and Windows locations", () => {
  assert.equal(
    resolveConfigPath({ environment: { VERONICA_CONFIG: "./custom.json" }, home: "/home/test", platform: "linux" }),
    path.resolve("custom.json")
  );
  assert.equal(
    resolveConfigPath({ environment: { XDG_CONFIG_HOME: "/config" }, home: "/home/test", platform: "linux" }),
    path.join("/config", "veronica", "config.json")
  );
  assert.equal(
    resolveConfigPath({ environment: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, platform: "win32" }),
    path.join("C:\\Users\\test\\AppData\\Roaming", "Veronica", "config.json")
  );
});

test("config round trips through a protected atomic file", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-config-"));
  const file = path.join(directory, "nested", "config.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const config = {
    worker: { gateway: "http://127.0.0.1:39100", token: "worker-token", name: "laptop" },
    gateway: { deviceToken: "d".repeat(32), hosts: ["127.0.0.1"], port: 39100 }
  };
  await writeConfig(config, file);
  assert.deepEqual(await readConfig(file), config);
  assert.equal((await readFile(file, "utf8")).endsWith("\n"), true);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("missing config is empty and malformed config is rejected", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-config-invalid-"));
  const missing = path.join(directory, "missing.json");
  const invalid = path.join(directory, "invalid.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.deepEqual(await readConfig(missing), {});
  await writeFile(invalid, "{not-json", "utf8");
  await assert.rejects(readConfig(invalid), /Invalid Veronica config JSON/);
});

test("generated device tokens have 256 bits of random hex", () => {
  const first = generateDeviceToken();
  const second = generateDeviceToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});
