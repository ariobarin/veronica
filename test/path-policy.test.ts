import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizeRoot, resolveExistingPath, resolveWritePath } from "../src/path-policy.js";

test("path policy keeps access inside the exposed root", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "veronica-outside-"));
  t.after(async () => {
    await rm(rootInput, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  await mkdir(path.join(rootInput, "repo"));
  await writeFile(path.join(rootInput, "repo", "README.md"), "hello", "utf8");
  const root = await canonicalizeRoot(rootInput);

  assert.equal(await resolveExistingPath(root, "repo/README.md"), path.join(root, "repo", "README.md"));
  assert.equal(await resolveWritePath(root, "repo/src/new.ts"), path.join(root, "repo", "src", "new.ts"));
  await assert.rejects(resolveExistingPath(root, "../outside"), /escapes the exposed root/);
  await assert.rejects(resolveWritePath(root, "../outside.txt"), /escapes the exposed root/);

  if (process.platform !== "win32") {
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(root, "link"));
    await assert.rejects(resolveExistingPath(root, "link/secret.txt"), /escapes the exposed root/);
    await assert.rejects(resolveWritePath(root, "link/new.txt"), /escapes the exposed root/);
  }
});
