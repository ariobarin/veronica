import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeConfig } from "../src/cli.js";

test("an explicitly supplied empty token file never falls back to stale credentials", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-empty-token-"));
  const configFile = path.join(directory, "config.json");
  const tokenFile = path.join(directory, "token");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await initializeConfig({ target: "worker" }, { VERONICA_TOKEN: "old-token" }, configFile);
  await writeFile(tokenFile, " \n\t", "utf8");

  await assert.rejects(
    initializeConfig({ target: "worker", tokenFile }, { VERONICA_TOKEN: "environment-token" }, configFile),
    /token file is empty/
  );
});
