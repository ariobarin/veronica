import path from "node:path";
import { realpath, stat } from "node:fs/promises";

function assertRelative(input: string): void {
  if (!input) throw new Error("Path must not be empty");
  if (path.isAbsolute(input)) throw new Error("Absolute paths are not allowed");
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the exposed root");
  }
}

function lexicalCandidate(root: string, input: string): string {
  assertRelative(input);
  const candidate = path.resolve(root, input);
  assertInside(root, candidate);
  return candidate;
}

export async function canonicalizeRoot(input: string): Promise<string> {
  const root = await realpath(path.resolve(input));
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error("Exposed root must be a directory");
  return root;
}

export async function resolveExistingPath(root: string, input: string): Promise<string> {
  const candidate = lexicalCandidate(root, input);
  const resolved = await realpath(candidate);
  assertInside(root, resolved);
  return resolved;
}

export async function resolveWritePath(root: string, input: string): Promise<string> {
  const candidate = lexicalCandidate(root, input);
  let current = candidate;

  while (true) {
    try {
      const resolvedAncestor = await realpath(current);
      assertInside(root, resolvedAncestor);
      const suffix = path.relative(current, candidate);
      const resolvedCandidate = path.resolve(resolvedAncestor, suffix);
      assertInside(root, resolvedCandidate);
      return resolvedCandidate;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error("Could not resolve a writable path inside the exposed root");
      current = parent;
    }
  }
}
