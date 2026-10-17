// Builds ReviewData from a local git repository: the commits in the range, each changed
// file's hunks with the commit that added every line, dependency changes in lockfiles,
// and the workflow files the page reads. The output's keys, key order and values are a
// fixed format (test/fixtures/review-data.json pins it), so several helpers below keep
// Python-style semantics on purpose: universal newlines, str.strip, pathlib suffixes, truthiness.

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { GIT_ENV, mapLimit, run, type RunResult } from "./exec.ts";
import type { Commit, DiffFile, DiffLine, Hunk, NpmDep, RefInfo, ReviewData } from "./types.ts";
import { isGenerated } from "@diffline/core/files";

/** A git command failed while building the review data. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

const LANGS = new Map<string, string>(Object.entries({
  ".ts": "ts", ".tsx": "tsx", ".js": "ts", ".jsx": "tsx", ".mjs": "ts", ".cjs": "ts",
  ".json": "json", ".sql": "sql", ".yml": "yaml", ".yaml": "yaml", ".md": "md", ".sh": "sh", ".rs": "rust",
}));
// Files at the head commit that the review page reads: CODEOWNERS, for the owner tags on changed files.
const WORKSPACE_FILES = [".github/CODEOWNERS"];
const MAX_CONTEXT_LINES = 3000;
const BLAME_PARALLEL = 8;
// [^\n] instead of "." because JS "." also stops at U+2028 and U+2029; a line only ends at \n.
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?([^\n]*)$/;
const DIFF_GIT_RE = /^diff --git a\/([^\n]*) b\/([^\n]*)$/;
const BLAME_RE = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/;

/* ---------- Python-style semantics the output format depends on ---------- */

/** subprocess.run(text=True) turns \r\n and lone \r into \n (universal newlines). */
const pyText = (s: string): string => (s.includes("\r") ? s.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : s);

// str.isspace(): JS trim() differs (it strips U+FEFF but not \x1c-\x1f or \x85).
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const PY_SPLIT_RE = new RegExp(`[${PY_WS}]+`);
/** str.strip() with no arguments. */
const pyStrip = (s: string): string => s.replace(PY_STRIP_RE, "");

/** Compare strings by code point, like Python's sorted(). */
function cmpCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates (astral code points) sort after the rest of the BMP.
    const sx = x >= 0xd800 && x <= 0xdfff;
    const sy = y >= 0xd800 && y <= 0xdfff;
    if (sx !== sy) return sx ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}

/** The parts of PurePosixPath that the export uses: name, suffix (Python 3.14 rules), parent, with_name. */
function posixPath(path: string): { root: string; tail: string[] } {
  const root = path.startsWith("//") && !path.startsWith("///") ? "//" : path.startsWith("/") ? "/" : "";
  return { root, tail: path.split("/").filter((p) => p !== "" && p !== ".") };
}
const pathStr = (p: { root: string; tail: string[] }): string => p.root + p.tail.join("/") || ".";
const pathName = (p: { tail: string[] }): string => (p.tail.length ? p.tail[p.tail.length - 1] : "");
function pathSuffix(name: string): string {
  const stripped = name.replace(/^\.+/, "");
  const i = stripped.lastIndexOf(".");
  return i === -1 ? "" : stripped.slice(i);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isDict = (v: unknown): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/** dict.get(key): None for a missing key; AttributeError for anything but a dict. */
function pyGet(obj: Json | undefined, key: string): Json {
  if (!isDict(obj)) throw new TypeError(`'${obj === null ? "NoneType" : typeof obj}' object has no attribute 'get'`);
  return Object.hasOwn(obj, key) ? obj[key] : null;
}
function pyTruthy(v: Json | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}
/** `name in container` for the JSON value types. */
function pyContains(container: Json, name: string): boolean {
  if (isDict(container)) return Object.hasOwn(container, name);
  if (Array.isArray(container)) return container.some((v) => pyEq(v, name));
  if (typeof container === "string") return container.includes(name);
  throw new TypeError("argument of type is not iterable");
}
/** Python == on JSON values (dicts ignore key order, True == 1). */
function pyEq(a: Json, b: Json): boolean {
  if (typeof a === "boolean") a = Number(a);
  if (typeof b === "boolean") b = Number(b);
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => pyEq(v, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
  }
  return false;
}

/* ---------- git ---------- */

interface GitResult {
  args: string[];
  result: RunResult;
}

function gitRun(repo: string, args: string[]): Promise<GitResult> {
  return run("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { env: GIT_ENV }).then((result) => ({ args, result }));
}

/** The command's output, or ExportError when it fails. */
function ok({ args, result }: GitResult): string {
  if (result.code !== 0) throw new ExportError(`git ${args.join(" ")} failed:\n${pyStrip(pyText(result.stderr))}`);
  return pyText(result.stdout);
}
/** The command's output, or null when it fails. */
const okOrNull = ({ result }: GitResult): string | null => (result.code === 0 ? pyText(result.stdout) : null);

async function git(repo: string, args: string[]): Promise<string> {
  return ok(await gitRun(repo, args));
}

const diffArgs = (a: string, b: string, context = 3): string[] => ["diff", "--no-color", "--no-ext-diff", "-M", `--unified=${context}`, a, b];

const FOUND_RE = /^[0-9a-f]{40,64} (blob|tree|commit|tag) (\d+)$/;

/**
 * Read many `<rev>:<path>` objects through one `git cat-file --batch` process.
 * Returns the text of each blob (what `git show <rev>:<path>` prints for a blob),
 * null when the object doesn't exist (`git show` fails too), or undefined when
 * `git show` must answer (trees, gitlinks, names cat-file can't take on one line).
 */
function catFileBatch(repo: string, specs: string[]): Promise<Array<string | null | undefined>> {
  const results = new Array<string | null | undefined>(specs.length).fill(undefined);
  const sent: number[] = [];
  specs.forEach((s, i) => {
    if (!s.includes("\n")) sent.push(i);
  });
  if (!sent.length) return Promise.resolve(results);
  return new Promise((done, fail) => {
    const child = spawn("git", ["-C", repo, "-c", "core.quotePath=false", "cat-file", "--batch"], {
      env: GIT_ENV,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.on("error", fail);
    child.stdin.on("error", () => {
      /* reported through close */
    });
    child.on("close", () => {
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const i of sent) {
        const nl = buf.indexOf(10, pos);
        if (nl === -1) break; // the process died: the rest falls back to git show
        const header = buf.toString("utf8", pos, nl);
        const found = FOUND_RE.exec(header);
        if (!found) {
          results[i] = header.endsWith(" missing") ? null : undefined;
          pos = nl + 1;
          continue;
        }
        const size = Number(found[2]);
        const end = nl + 1 + size;
        if (end > buf.length) break;
        if (found[1] === "blob") results[i] = pyText(buf.toString("utf8", nl + 1, end));
        pos = end + 1;
      }
      // Whatever a failed process didn't answer stays undefined and goes to git show.
      done(results);
    });
    child.stdin.end(sent.map((i) => specs[i]).join("\n") + "\n");
  });
}

/** `git show <rev>:<path>` output, or null. */
async function show(repo: string, spec: string): Promise<string | null> {
  return okOrNull(await gitRun(repo, ["show", spec]));
}

/** Read objects in one batch and ask `git show` only for what the batch can't answer. */
async function readObjects(repo: string, specs: string[]): Promise<Array<string | null>> {
  const batch = await catFileBatch(repo, specs);
  return Promise.all(batch.map((v, i) => (v === undefined ? show(repo, specs[i]) : v)));
}

/* ---------- patch parsing ---------- */

export type ParsedLine = [" " | "+" | "-", number | null, number | null, string];
export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: ParsedLine[];
}
export interface ParsedFile {
  path: string;
  oldPath: string | null;
  status: DiffFile["status"];
  similarity: number | null;
  binary: boolean;
  hunks: ParsedHunk[];
}

/** Parse `git diff` output into files and hunks. Lines are [type, old, new, text]. */
export function parsePatch(text: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let cur: ParsedFile | null = null;
  let hunk: ParsedHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split("\n")) {
    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      // The tag is the line's first code point: keep a surrogate pair together.
      const c = raw.charCodeAt(0);
      const tagLen = c >= 0xd800 && c <= 0xdbff && raw.length > 1 ? 2 : raw.length ? 1 : 0;
      const tag = raw.slice(0, tagLen);
      const body = raw.slice(tagLen);
      if (tag === "\\") continue; // "\ No newline at end of file"
      if (tag === "-") {
        hunk.lines.push(["-", oldNo, null, body]);
        oldNo++;
        oldLeft--;
      } else if (tag === "+") {
        hunk.lines.push(["+", null, newNo, body]);
        newNo++;
        newLeft--;
      } else {
        // context line; tolerate a stripped trailing space on blank lines
        hunk.lines.push([" ", oldNo, newNo, body]);
        oldNo++;
        newNo++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    hunk = null;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("diff --git ")) {
      const m = DIFF_GIT_RE.exec(raw);
      cur = { path: m ? m[2] : "", oldPath: m ? m[1] : null, status: "modified", similarity: null, binary: false, hunks: [] };
      files.push(cur);
      continue;
    }
    if (cur === null) continue;
    const m = HUNK_RE.exec(raw);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] !== undefined ? Number(m[2]) : 1;
      newLeft = m[4] !== undefined ? Number(m[4]) : 1;
      hunk = { oldStart: oldNo, oldLines: oldLeft, newStart: newNo, newLines: newLeft, section: pyStrip(m[5]), lines: [] };
      cur.hunks.push(hunk);
    } else if (raw.startsWith("new file mode")) {
      cur.status = "added";
    } else if (raw.startsWith("deleted file mode")) {
      cur.status = "deleted";
    } else if (raw.startsWith("similarity index ")) {
      const words = pyStrip(raw).split(PY_SPLIT_RE);
      const n = Number(words[words.length - 1].replace(/%+$/, ""));
      if (!Number.isInteger(n)) throw new Error(`invalid literal for int(): ${raw}`);
      cur.similarity = n;
    } else if (raw.startsWith("rename from ")) {
      cur.oldPath = raw.slice("rename from ".length);
      cur.status = "renamed";
    } else if (raw.startsWith("rename to ")) {
      cur.path = raw.slice("rename to ".length);
    } else if (raw.startsWith("Binary files ")) {
      cur.binary = true;
    }
  }
  return files;
}

/* ---------- the facts around the diff ---------- */

interface SinceChanges {
  added: Set<number>;
  removed: Array<[number, string]>;
}

/** Per file: new-side lines added since `since`, and deleted texts with their positions. */
function sinceChanges(patch: string): Map<string, SinceChanges> {
  const changes = new Map<string, SinceChanges>();
  for (const f of parsePatch(patch)) {
    const added = new Set<number>();
    const removed: Array<[number, string]> = [];
    for (const h of f.hunks) {
      for (const [kind, , nw, text] of h.lines) {
        if (kind === "+") added.add(nw as number);
        // With --unified=0 a deletion sits right after new line `newStart`.
        else if (kind === "-") removed.push([h.newStart, text]);
      }
    }
    changes.set(f.path, { added, removed });
  }
  return changes;
}

function parseBlame(out: string): Map<number, string> {
  const shas = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = BLAME_RE.exec(line);
    if (m) shas.set(Number(m[2]), m[1]);
  }
  return shas;
}

function npmLockSummary(texts: { oldLock: string | null; newLock: string | null; oldPkg: string | null; newPkg: string | null }) {
  const load = (text: string | null): Json => {
    if (!text) return {};
    try {
      return JSON.parse(text) as Json;
    } catch {
      return {};
    }
  };
  const oldLock = load(texts.oldLock);
  const newLock = load(texts.newLock);
  const oldPkg = load(texts.oldPkg);
  const newPkg = load(texts.newPkg);
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const orEmpty = (v: Json): Json => (pyTruthy(v) ? v : {});

  const packages = (lock: Json): Map<string, Json> => {
    const all = orEmpty(pyGet(lock, "packages"));
    if (!isDict(all)) throw new TypeError("'packages' has no attribute 'items'");
    return new Map(Object.entries(all).filter(([k]) => k.startsWith("node_modules/")));
  };
  const requested = (name: string): boolean => {
    for (const f of fields) {
      const a = pyGet(orEmpty(pyGet(oldPkg, f)), name);
      if (!pyEq(a, pyGet(orEmpty(pyGet(newPkg, f)), name))) return true;
    }
    return false;
  };
  const direct = (name: string): boolean => {
    for (const f of fields) {
      if (pyContains(orEmpty(pyGet(newPkg, f)), name) || pyContains(orEmpty(pyGet(oldPkg, f)), name)) return true;
    }
    return false;
  };

  const old = packages(oldLock);
  const nw = packages(newLock);
  const added: NpmDep[] = [];
  const removed: NpmDep[] = [];
  const updated: NpmDep[] = [];
  const keys = [...new Set([...old.keys(), ...nw.keys()])].sort(cmpCodePoints);
  for (const key of keys) {
    const parts = key.split("node_modules/");
    const name = parts[parts.length - 1];
    const a = old.has(key) ? old.get(key)! : undefined;
    const b = nw.has(key) ? nw.get(key)! : undefined;
    const src = pyTruthy(b) ? b : a;
    const info = { name, dev: pyTruthy(pyGet(src ?? null, "dev")), direct: direct(name), requested: requested(name) };
    // A missing version is written as null; the type says optional string, so cast.
    if (a === undefined) added.push({ ...info, version: pyGet(b!, "version") } as NpmDep);
    else if (b === undefined) removed.push({ ...info, version: pyGet(a, "version") } as NpmDep);
    else if (!pyEq(pyGet(a, "version"), pyGet(b, "version"))) {
      updated.push({ ...info, from: pyGet(a, "version"), to: pyGet(b, "version") } as NpmDep);
    }
  }
  return { manager: "npm" as const, added, removed, updated };
}

function testHint(path: string, tree: Set<string>, changed: Set<string>): DiffFile["tests"] {
  const p = posixPath(path);
  const name = pathName(p);
  const suffix = pathSuffix(name);
  if (![".ts", ".tsx", ".js", ".jsx"].includes(suffix) || TEST_FILE_RE.test(name)) return null;
  const stem = name.slice(0, name.length - suffix.length);
  for (const sfx of [suffix, ".ts", ".tsx"]) {
    for (const kind of ["test", "spec"]) {
      const candidate = pathStr({ root: p.root, tail: [...p.tail.slice(0, -1), `${stem}.${kind}${sfx}`] });
      if (tree.has(candidate)) return { path: candidate, changed: changed.has(candidate) };
    }
  }
  return null;
}

/** The current UTC time to the second, as 2026-01-02T03:04:05+00:00. */
const nowIso = (): string => new Date().toISOString().slice(0, 19) + "+00:00";

/* ---------- build ---------- */

/** Return the ReviewData for the diff between `base` and `head` (three-dot semantics). */
export async function buildReviewData(
  repo: string,
  base: string,
  head: string,
  since?: string | null,
  labels?: { base?: string; head?: string; since?: string },
): Promise<ReviewData> {
  const abs = resolve(repo);
  repo = await realpath(abs).catch(() => abs);
  const names = labels || {};

  // One round for everything that only needs the refs. The diff, tree and since-diff run on
  // the refs too, speculatively; they're used only when they're provably what the same
  // commands on the SHAs print, and rerun otherwise. Errors surface in the order the
  // commands would run one at a time: base, head, merge base, log.
  const at = (ref: string) => `${ref}^{commit}`;
  const [baseRes, headRes, mbRes, sinceRes, diffSpec, treeSpec, sinceDiffSpec] = await Promise.all([
    gitRun(repo, ["rev-parse", "--verify", at(base)]),
    gitRun(repo, ["rev-parse", "--verify", at(head)]),
    gitRun(repo, ["merge-base", "--all", at(base), at(head)]),
    since ? gitRun(repo, ["rev-parse", "--verify", "-q", at(since)]) : null,
    // With a single merge base, `git diff A...B` is `git diff $(git merge-base A B) B`.
    gitRun(repo, ["diff", "--no-color", "--no-ext-diff", "-M", "--unified=3", `${at(base)}...${at(head)}`]),
    gitRun(repo, ["ls-tree", "-r", "--name-only", at(head)]),
    since ? gitRun(repo, diffArgs(at(since), at(head), 0)) : null,
  ]);
  const baseSha = pyStrip(ok(baseRes));
  const headSha = pyStrip(ok(headRes));
  // `merge-base` prints the first line of what `merge-base --all` prints; on failure, rerun
  // the plain command for its exact error.
  const bases = mbRes.result.code === 0 ? pyText(mbRes.result.stdout).split("\n").filter(Boolean) : [];
  const mergeBase = bases.length ? pyStrip(bases[0]) : pyStrip(await git(repo, ["merge-base", baseSha, headSha]));
  // `rev-parse --verify -q` prints nothing for an unknown since, which is then ignored.
  const sinceOut = sinceRes ? okOrNull(sinceRes) : null;
  const sinceSha = sinceOut ? pyStrip(sinceOut) : null;

  const logP = gitRun(repo, ["log", "--reverse", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e", `${mergeBase}..${headSha}`]);
  const speculative = (res: GitResult | null, usable: boolean) => (res && usable && res.result.code === 0 ? pyText(res.result.stdout) : null);
  let diffText = speculative(diffSpec, bases.length === 1);
  let treeText = speculative(treeSpec, true);
  let sinceDiffText = sinceSha ? speculative(sinceDiffSpec, true) : null;
  if (diffText === null || treeText === null || (sinceSha && sinceDiffText === null)) {
    ok(await logP); // log comes before these one at a time, so its error wins
    diffText ??= await git(repo, diffArgs(mergeBase, headSha));
    treeText ??= await git(repo, ["ls-tree", "-r", "--name-only", headSha]);
    if (sinceSha) sinceDiffText ??= await git(repo, diffArgs(sinceSha, headSha, 0));
  }

  const files = parsePatch(diffText);
  const changedPaths = new Set(files.map((f) => f.path));
  const tree = new Set(treeText.split("\n").filter(Boolean));
  const fresh = sinceDiffText !== null ? sinceChanges(sinceDiffText) : new Map<string, SinceChanges>();

  // Blame stops at the merge base: a line it gives to a commit outside merge_base..head
  // maps to -1 either way, and the walk below the merge base is most of a full blame's cost.
  // Files without added lines never read their blame, so they skip it. Blame depends only
  // on the path, so a path listed twice gets the same answer either way.
  const hasAdded = (f: ParsedFile) => f.hunks.some((h) => h.lines.some((l) => l[0] === "+"));
  const toBlame = [...new Set(files.filter((f) => f.status !== "deleted" && !f.binary && hasAdded(f)).map((f) => f.path))];
  const blamesP = mapLimit(toBlame, BLAME_PARALLEL, async (path) => {
    const res = await gitRun(repo, ["blame", "--porcelain", `^${mergeBase}`, headSha, "--", path]);
    return parseBlame(okOrNull(res) ?? "");
  });

  // Every file read goes through one cat-file process.
  const generated = files.map((f) => isGenerated(f.path));
  const specs: string[] = [];
  const contentAt = files.map((f, i) => (f.status !== "deleted" && !f.binary && !generated[i] ? specs.push(`${headSha}:${f.path}`) - 1 : -1));
  const npmAt = files.map((f) => {
    const p = posixPath(f.path);
    const name = pathName(p);
    if (name !== "package-lock.json" && name !== "npm-shrinkwrap.json") return -1;
    const parentStr = pathStr({ root: p.root, tail: p.tail.slice(0, -1) });
    const pkg = parentStr === "." ? "package.json" : `${parentStr}/package.json`;
    return specs.push(`${mergeBase}:${f.path}`, `${headSha}:${f.path}`, `${mergeBase}:${pkg}`, `${headSha}:${pkg}`) - 4;
  });
  const workspaceAt = specs.length;
  specs.push(...WORKSPACE_FILES.map((p) => `${headSha}:${p}`));

  const textsP = readObjects(repo, specs);
  // Keep a failure here from going unhandled if the log check below throws first.
  textsP.catch(() => {});
  blamesP.catch(() => {});

  const commits: Commit[] = [];
  for (const rec of ok(await logP).split("\x1e")) {
    const record = rec.replace(/^\n+|\n+$/g, "");
    if (!record) continue;
    const parts = record.split("\x1f");
    if (parts.length !== 7) throw new Error(`expected 7 log fields, got ${parts.length}`);
    const [sha, short, author, email, date, subject, body] = parts;
    commits.push({ sha, short, author, email, date, subject, body: pyStrip(body) });
  }
  const commitIndex = new Map(commits.map((c, i) => [c.sha, i]));
  const sinceIndex = sinceSha ? (commitIndex.get(sinceSha) ?? -1) : null;

  const [blameList, texts] = await Promise.all([blamesP, textsP]);
  const blames = new Map<string, Map<number, string>>();
  toBlame.forEach((p, i) => blames.set(p, blameList[i]));

  const outFiles: DiffFile[] = files.map((f, fi) => {
    const path = f.path;
    let oldPath = f.oldPath;
    if (f.status === "added") oldPath = null;
    else if (f.status !== "renamed") oldPath = oldPath === path ? null : oldPath;

    const authors = blames.get(path) ?? new Map<number, string>();
    const changedSince = fresh.get(path) ?? { added: new Set<number>(), removed: [] };
    const removedTexts = new Map<string, number>();
    for (const [, text] of changedSince.removed) removedTexts.set(text, (removedTexts.get(text) ?? 0) + 1);

    let additions = 0;
    let deletions = 0;
    const hunks: Hunk[] = f.hunks.map((h) => {
      const lo = h.newStart;
      const hi = h.newStart + h.newLines;
      let hunkFresh = changedSince.removed.some(([pos]) => lo - 1 <= pos && pos <= hi);
      const lines: DiffLine[] = h.lines.map(([kind, o, n, text]) => {
        let commit = -1;
        if (kind === "+") {
          additions++;
          const sha = authors.get(n as number);
          commit = sha === undefined ? -1 : (commitIndex.get(sha) ?? -1);
        } else if (kind === "-") deletions++;
        let isFresh: 0 | 1 = 0;
        if (sinceSha) {
          if (kind === "+" && changedSince.added.has(n as number)) isFresh = 1;
          else if (kind === "-" && (removedTexts.get(text) ?? 0) > 0) {
            removedTexts.set(text, removedTexts.get(text)! - 1);
            isFresh = 1;
          }
        }
        hunkFresh = hunkFresh || isFresh === 1;
        return [kind, o, n, text, commit, isFresh];
      });
      return { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, section: h.section, lines, fresh: hunkFresh };
    });

    let content: string[] | undefined;
    if (contentAt[fi] !== -1) {
      const text = texts[contentAt[fi]];
      if (text !== null) {
        const lines = text.split("\n");
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        if (lines.length <= MAX_CONTEXT_LINES) content = lines;
      }
    }
    const lang = LANGS.get(pathSuffix(pathName(posixPath(path))).toLowerCase()) ?? "text";
    const out: DiffFile = {
      path, oldPath, status: f.status, similarity: f.similarity, binary: f.binary, hunks,
      lang, generated: generated[fi], additions, deletions,
      ...(content ? { content } : {}),
      tests: testHint(path, tree, changedPaths),
    };
    const at = npmAt[fi];
    if (at !== -1) {
      out.deps = npmLockSummary({ oldLock: texts[at], newLock: texts[at + 1], oldPkg: texts[at + 2], newPkg: texts[at + 3] });
    }
    return out;
  });

  const workspace: Record<string, string> = {};
  WORKSPACE_FILES.forEach((p, i) => {
    const text = texts[workspaceAt + i];
    if (text !== null) workspace[p] = text;
  });

  const refInfo = (ref: string, sha: string): RefInfo => ({ ref, sha, short: sha.slice(0, 7) });
  const label = (key: "base" | "head" | "since", fallback: string): string => names[key] !== undefined ? names[key] : fallback;
  return {
    version: 1,
    generatedAt: nowIso(),
    repo: basename(repo),
    base: refInfo(label("base", base), baseSha),
    head: refInfo(label("head", head), headSha),
    mergeBase,
    since: sinceSha ? { ...refInfo(label("since", since as string), sinceSha), index: sinceIndex as number } : null,
    commits,
    files: outFiles,
    workspace,
  };
}
