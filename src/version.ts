import { readFileSync } from "node:fs";

const packageFile = new URL("../package.json", import.meta.url);
const packageMetadata = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: unknown };

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error(`Invalid package version in ${packageFile.pathname}`);
}

export const VERONICA_VERSION = packageMetadata.version;
