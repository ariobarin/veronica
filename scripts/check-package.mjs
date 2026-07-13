import { spawnSync } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required to verify the package");

await rm(path.join(root, "dist"), { recursive: true, force: true });
const packed = spawnSync(process.execPath, [npmCli, "pack", "--dry-run"], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe"
});
if (packed.status !== 0) {
  process.stdout.write(packed.stdout ?? "");
  process.stderr.write(packed.stderr ?? "");
  process.exit(packed.status ?? 1);
}

for (const target of ["dist/cli.js", "dist/server.js"]) {
  const file = path.join(root, target);
  await access(file);
  const firstLine = (await readFile(file, "utf8")).split(/\r?\n/, 1)[0];
  if (firstLine !== "#!/usr/bin/env node") {
    throw new Error(`${target} is missing its Node shebang`);
  }
}

console.log("Package dry run contains executable CLI and gateway entrypoints");
