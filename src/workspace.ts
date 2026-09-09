import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isCode } from "./store.js";

const excluded = new Set([".git", ".orchestrator", "node_modules"]);
const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Normalizes writable scopes and rejects traversal, symlinks and protected storage. */
export function validateScopes(root: string, files: string[]): string[] {
  return [
    ...new Set(
      files.map((file) => {
        if (isAbsolute(file) || file.split(/[\\/]/).includes("..") || file.includes("\\"))
          throw new Error(`Invalid workspace path: ${file}`);
        const normalized = relative(root, resolve(root, file)) || ".";
        if (
          normalized.split(sep).some((part) => excluded.has(part)) ||
          normalized === "orchestrator.json"
        )
          throw new Error(`Protected path: ${file}`);
        assertLocalPath(root, resolve(root, file));
        return normalized.split(sep).join("/");
      }),
    ),
  ].sort();
}

/** Returns a relative path only if every existing component stays inside the workspace. */
export function assertLocalPath(root: string, path: string): string {
  const rel = relative(root, resolve(root, path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Path is outside the workspace");
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error(`Symlink paths are not writable: ${rel}`);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
  return rel.split(sep).join("/");
}

/** Tests whether a normalized path belongs to an assignment's declared scopes. */
export function inScope(path: string, scopes: string[]): boolean {
  return scopes.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`));
}

/** Hash tracked and nonignored files, including uncommitted and untracked content. */
export function fingerprint(root: string, inputs: string[] = []): string {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_OUTPUT_LIMIT,
    })
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    if (existsSync(join(root, ".git"))) throw error;
    files = walk(root);
  }
  for (const input of inputs) {
    assertLocalPath(root, resolve(root, input));
    try {
      files.push(
        ...(lstatSync(join(root, input)).isDirectory()
          ? walk(root, input === "." ? "" : input)
          : [input]),
      );
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      files.push(input);
    }
  }
  const hash = createHash("sha256");
  for (const path of [...new Set(files)].sort()) {
    if (path.split("/").some((part) => excluded.has(part))) continue;
    const absolute = join(root, path);
    hash.update(`${path}\0`);
    try {
      const stat = lstatSync(absolute);
      hash.update(`${stat.mode}\0`);
      if (stat.isSymbolicLink()) hash.update(`symlink:${readlinkSync(absolute)}`);
      else if (stat.isFile()) hash.update(readFileSync(absolute));
      else throw new Error(`Unsupported verification input: ${path}`);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      hash.update("deleted");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walk(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (excluded.has(entry.name)) return [];
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

const OUTPUT_LIMIT = 32000;
/** Executes a configured argv without a shell, with bounded output and runtime. */
export async function runCheck(
  root: string,
  name: string,
  argv: string[],
  timeoutMs: number,
  sharedProcessGroup = false,
) {
  const executable = argv[0];
  if (!executable) throw new Error("Empty verification command");
  return await new Promise<{
    name: string;
    argv: string[];
    exitCode: number | null;
    output: string;
    passed: boolean;
  }>((resolveResult) => {
    const child = spawn(executable, argv.slice(1), {
      cwd: realpathSync(root),
      detached: !sharedProcessGroup && process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      try {
        process.kill(
          process.platform === "win32" || sharedProcessGroup ? child.pid : -child.pid,
          "SIGKILL",
        );
      } catch (error) {
        if (!isCode(error, "ESRCH")) output += `\nCancellation failed: ${String(error)}`;
      }
    }, timeoutMs);
    const append = (data: Buffer) => {
      output = (output + data.toString()).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      output += `\n${error.message}`;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult({
        name,
        argv,
        exitCode,
        output: timedOut ? `${output}\nVerification timed out` : output,
        passed: exitCode === 0 && !timedOut,
      });
    });
  });
}
