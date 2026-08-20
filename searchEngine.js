const vscode = require("vscode");
const childProcess = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { t } = require("./i18n");

/**
 * @typedef {vscode.QuickPickItem & {
 *   filePath?: string;
 *   lineNumber?: number;
 *   column?: number;
 *   commandId?: string;
 * }} SearchItem
 */

const DEFAULT_EXCLUDE_GLOBS = [
  "**/{node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,.parcel-cache,.venv,venv,coverage,tmp,temp,target,vendor,.pnpm-store,.yarn}/**",
  "**/.pnpm/**",
  "**/bower_components/**",
  "**/[Bb]in/**",
  "**/[Oo]bj/**",
  "**/.vs/**",
  "**/*.dtbcache",
  "**/*.dtbcache.v2",
  "**/*.bin",
  "**/*.exe",
  "**/*.dll",
  "**/*.pdb",
  "**/*.obj",
  "**/*.o",
  "**/*.a",
  "**/*.lib",
  "**/*.so",
  "**/*.dylib",
  "**/*.class",
  "**/*.jar",
  "**/*.wasm",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.webp",
  "**/*.ico",
  "**/*.pdf",
  "**/*.zip",
  "**/*.7z",
  "**/*.rar",
  "**/*.gz",
  "**/*.tar",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.eot",
  "**/*.mp3",
  "**/*.mp4",
  "**/*.wav",
  "**/*.suo",
  "**/*.user",
  "**/*.map",
  "**/.vscode/swiftfind-path-index.cache",
  "**/.vscode/swiftfind-path-index.cache.*"
];

/** Path index for Files/Folders tabs (and git-aware refresh). */
const pathIndex = {
  rootPath: "",
  excludeGitIgnored: true,
  excludeGlobsKey: "",
  gitignoreKey: "",
  gitHead: "",
  /** @type {string[]} */
  files: [],
  /** Original-case basenames parallel to `files`. */
  /** @type {string[]} */
  fileBaseNames: [],
  /** Lowercased basenames parallel to `files`. */
  /** @type {string[]} */
  fileBases: [],
  /** @type {Set<string>} */
  fileSet: new Set(),
  /** @type {string[]} */
  folders: [],
  /** Lowercased folder paths parallel to `folders`. */
  /** @type {string[]} */
  folderLowers: [],
  /** @type {Set<string>} */
  folderSet: new Set(),
  /** @type {Map<string, number[]> | null} */
  fileCharIndex: null,
  /** @type {Map<string, number[]> | null} */
  folderCharIndex: null,
  dirty: true,
  /** @type {Promise<number> | null} */
  buildPromise: null,
  /** @type {ReturnType<typeof setTimeout> | null} */
  settleTimer: null,
  /** @type {ReturnType<typeof setTimeout> | null} */
  persistTimer: null,
  /** @type {ReturnType<typeof setTimeout> | null} */
  searchIndexTimer: null,
  /** @type {(() => void) | null} */
  onInvalidate: null
};

const PATH_INDEX_CACHE_VERSION = 2;
const PATH_INDEX_CACHE_NAME = "swiftfind-path-index.cache";

/** Hard-excluded path segments (case-insensitive) — always on, O(path). */
const IGNORED_PATH_SEGMENTS = new Set(["bin", "obj", ".vs", "node_modules", ".git", ".pnpm"]);

/** @type {{ root: string, value: string, at: number }} */
let gitHeadCache = { root: "", value: "", at: 0 };

function getRootPath() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
}

function getExcludeGlobs() {
  const configured = vscode.workspace.getConfiguration("swiftFind").get("excludeGlobs");
  if (Array.isArray(configured) && configured.length) {
    return configured.map((g) => String(g || "").trim().replaceAll("\\", "/")).filter(Boolean);
  }
  return DEFAULT_EXCLUDE_GLOBS.slice();
}

function excludeGlobsKey() {
  return getExcludeGlobs().join("\n");
}

function getConfig() {
  const c = vscode.workspace.getConfiguration("swiftFind");
  const raw = Number(c.get("maxResults", 5000));
  const configured = Number.isFinite(raw) ? raw : 5000;
  return {
    // Honor settings; clamp only to keep UI/process safe.
    maxResults: Math.min(100000, Math.max(50, Math.floor(configured))),
    caseInsensitive: c.get("caseInsensitive", true),
    preview: c.get("preview", true),
    searchOnType: c.get("searchOnType", true) !== false,
    excludeGlobs: getExcludeGlobs()
  };
}

function getDefaultSearchOptions() {
  return {
    matchCase: false,
    wholeWord: false,
    useRegex: false,
    fuzzy: false,
    excludeGitIgnored: true,
    excludeSearchIgnored: true
  };
}

function mergeOptions(options) {
  const opts = { ...getDefaultSearchOptions(), ...(options || {}) };
  opts.scopePath = normalizeScopePath(opts.scopePath);
  // Always honor workspace .gitignore (even for tracked files rg would still search).
  opts.excludeGitIgnored = true;
  return opts;
}

function normalizeScopePath(scopePath) {
  return String(scopePath || "").replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
}

function normalizeRelPath(filePath, rootPath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (path.isAbsolute(filePath)) {
    return path.relative(rootPath, filePath).replaceAll("\\", "/");
  }
  return normalized;
}

function pathInScope(p, scope) {
  if (!scope) return true;
  const norm = String(p || "").replaceAll("\\", "/");
  if (!norm) return false;
  if (norm === scope) return true;
  return norm.startsWith(scope.endsWith("/") ? scope : `${scope}/`);
}

function makeItem(filePath, lineNumber, column, detail) {
  return {
    label: `${path.basename(filePath)} : ${lineNumber}`,
    description: filePath,
    detail: detail.trim(),
    filePath,
    lineNumber,
    column
  };
}

function parseSearchLine(line, rootPath, withColumn) {
  const m = withColumn
    ? line.match(/^(.*?):(\d+):(\d+):(.*)$/)
    : line.match(/^(.*?):(\d+):(.*)$/);
  if (!m) return undefined;
  const filePath = normalizeRelPath(m[1], rootPath);
  return makeItem(filePath, Number(m[2]), withColumn ? Number(m[3]) : 1, withColumn ? m[4] : m[3]);
}

const parseRipgrepLine = (line, rootPath) => parseSearchLine(line, rootPath, true);

function fuzzyScore(text, pattern) {
  if (!pattern) return 0;
  const hay = String(text || "").toLowerCase();
  const needle = String(pattern || "").toLowerCase();
  let j = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < hay.length && j < needle.length; i += 1) {
    if (hay[i] === needle[j]) {
      j += 1;
      streak += 1;
      score += 2 + streak;
    } else {
      streak = 0;
    }
  }
  return j === needle.length ? score : -1;
}

function toRegExpFromGlob(glob) {
  const raw = String(glob).replaceAll("\\", "/");
  // Preserve character classes like [Bb]; escape other regex metacharacters.
  let esc = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "[") {
      const end = raw.indexOf("]", i + 1);
      if (end > i) {
        esc += raw.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if ("+.^${}()|\\".includes(ch)) esc += `\\${ch}`;
    else esc += ch;
  }
  let rx = esc.replace(/\*\*/g, "###DOUBLE_STAR###").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/###DOUBLE_STAR###/g, ".*");
  // `**/*.bin` should also match root-level `file.bin`
  if (raw.startsWith("**/")) {
    rx = `(?:.*\\/)?${rx.replace(/^\.\*\//, "")}`;
  }
  return new RegExp(`^${rx}$`, "i");
}

/**
 * Convert a single gitignore pattern (no leading ! or trailing /) to a path regex.
 * @param {string} pattern
 * @param {boolean} anchored relative to repo root (leading / or contains /)
 */
function gitIgnorePatternToRegExp(pattern, anchored) {
  let esc = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end > i) {
        esc += pattern.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        esc += "###DOUBLE_STAR###";
        i += 1;
      } else {
        esc += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      esc += "[^/]";
      continue;
    }
    if ("+.^${}()|\\".includes(ch)) esc += `\\${ch}`;
    else esc += ch;
  }
  const body = esc.replace(/###DOUBLE_STAR###/g, ".*");
  const flags = process.platform === "win32" ? "i" : "";
  if (anchored) {
    return new RegExp(`^${body}(?:/.*)?$`, flags);
  }
  return new RegExp(`(?:^|/)${body}(?:/.*)?$`, flags);
}

/**
 * @typedef {{ negation: boolean, regex: RegExp }} GitIgnoreComplexRule
 * @typedef {{
 *   exact: Set<string>,
 *   dirs: string[],
 *   names: Set<string>,
 *   suffixes: string[],
 *   complex: GitIgnoreComplexRule[],
 *   hasNegation: boolean
 * }} GitIgnoreMatcher
 */

function normIgnorePath(p) {
  const s = String(p || "").replaceAll("\\", "/").replace(/^\.\//, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Expand simple case-class patterns like [Bb]in → "bin" (null if not expandable).
 * @param {string} pattern
 * @returns {string | null}
 */
function expandCaseClassPattern(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") return null;
    if (ch === "?") return null;
    if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) return null;
      const cls = pattern.slice(i + 1, end);
      if (cls.length === 2 && cls[0].toLowerCase() === cls[1].toLowerCase()) {
        out += cls[0].toLowerCase();
        i = end;
        continue;
      }
      return null;
    }
    out += ch.toLowerCase();
  }
  return out || null;
}

/**
 * Cheap segment check: .../bin/... , .../obj/..., etc.
 * @param {string} relPath
 */
function hasIgnoredPathSegment(relPath) {
  const p = String(relPath || "").replaceAll("\\", "/");
  if (!p) return false;
  let start = 0;
  const lower = p.toLowerCase();
  while (start <= lower.length) {
    const slash = lower.indexOf("/", start);
    const seg = slash < 0 ? lower.slice(start) : lower.slice(start, slash);
    if (seg && IGNORED_PATH_SEGMENTS.has(seg)) return true;
    if (slash < 0) break;
    start = slash + 1;
  }
  return false;
}

/**
 * Build a fast matcher: exact paths / dir prefixes / basenames / *.ext — regex only for wildcards.
 * @param {string} content
 * @returns {GitIgnoreMatcher}
 */
function buildGitIgnoreMatcher(content) {
  /** @type {GitIgnoreMatcher} */
  const matcher = {
    exact: new Set(),
    dirs: [],
    names: new Set(),
    suffixes: [],
    complex: [],
    hasNegation: false
  };
  /** @type {string[]} */
  const dirSet = [];

  for (const line of String(content || "").split(/\r?\n/)) {
    let s = line.trim();
    if (!s || s.startsWith("#")) continue;
    let negation = false;
    if (s.startsWith("!")) {
      negation = true;
      s = s.slice(1);
      matcher.hasNegation = true;
    }
    s = s.replaceAll("\\", "/");
    if (s.startsWith("\\") && s.length > 1) s = s.slice(1);
    let dirOnly = false;
    if (s.endsWith("/")) {
      dirOnly = true;
      s = s.slice(0, -1);
    }
    if (!s) continue;
    let anchored = s.startsWith("/");
    if (anchored) s = s.slice(1);
    if (s.includes("/")) anchored = true;

    // [Bb]in / [Oo]bj → literal segment names (huge win vs regex-per-path).
    if (!negation && !anchored) {
      const expanded = expandCaseClassPattern(s);
      if (expanded && !expanded.includes("/")) {
        matcher.names.add(expanded);
        if (dirOnly) dirSet.push(expanded);
        continue;
      }
    }

    const norm = normIgnorePath(s);
    const hasWild = /[*?[\]|]/.test(s);

    if (negation || hasWild) {
      if (!negation && !anchored && /^(\*\.[^*/?[\]]+)$/.test(s)) {
        matcher.suffixes.push(normIgnorePath(s.slice(1)));
        continue;
      }
      matcher.complex.push({
        negation,
        regex: gitIgnorePatternToRegExp(s, anchored)
      });
      continue;
    }

    if (anchored || s.includes("/")) {
      const base = s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s;
      const looksLikeFile = base.includes(".");
      if (dirOnly || !looksLikeFile) {
        dirSet.push(norm);
        matcher.exact.add(norm);
      } else {
        matcher.exact.add(norm);
      }
      continue;
    }

    matcher.names.add(norm);
    if (dirOnly) dirSet.push(norm);
  }

  // Always seed common .NET / JS noise even if .gitignore omitted them.
  for (const name of IGNORED_PATH_SEGMENTS) matcher.names.add(name);

  matcher.dirs = [...new Set(dirSet)].sort((a, b) => a.length - b.length);
  return matcher;
}

/** @type {{ root: string, key: string, matcher: GitIgnoreMatcher, at: number }} */
let gitIgnoreCache = {
  root: "",
  key: "",
  matcher: { exact: new Set(), dirs: [], names: new Set(), suffixes: [], complex: [], hasNegation: false },
  at: 0
};

function gitIgnoreContentKey(content) {
  const s = String(content || "");
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h >>> 0}`;
}

async function loadGitIgnoreRules(rootPath) {
  if (!rootPath) return gitIgnoreCache.matcher;
  // Trust watcher invalidation — do not re-read .gitignore on every search.
  if (gitIgnoreCache.root === rootPath && gitIgnoreCache.key) {
    return gitIgnoreCache.matcher;
  }
  try {
    const raw = await fs.readFile(path.join(rootPath, ".gitignore"), "utf8");
    const key = gitIgnoreContentKey(raw);
    const matcher = buildGitIgnoreMatcher(raw);
    gitIgnoreCache = { root: rootPath, key, matcher, at: Date.now() };
    return matcher;
  } catch {
    const matcher = buildGitIgnoreMatcher("");
    gitIgnoreCache = { root: rootPath, key: "missing", matcher, at: Date.now() };
    return matcher;
  }
}

function clearGitIgnoreCache() {
  gitIgnoreCache = {
    root: "",
    key: "",
    matcher: { exact: new Set(), dirs: [], names: new Set(), suffixes: [], complex: [], hasNegation: false },
    at: 0
  };
}

/**
 * Always-on ignore check (gitignore + hard segment rules).
 * @param {string} relPath
 * @param {GitIgnoreMatcher=} matcherOpt
 */
function isGitIgnoredPath(relPath, matcherOpt) {
  const raw = String(relPath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!raw || raw === ".gitignore") return false;
  // O(segments) — catches KDR.Lobby/bin even with a stale matcher/cache.
  if (hasIgnoredPathSegment(raw)) return true;

  const matcher = matcherOpt || gitIgnoreCache.matcher;
  if (
    !matcher ||
    (!matcher.exact.size && !matcher.dirs.length && !matcher.names.size && !matcher.suffixes.length && !matcher.complex.length)
  ) {
    return false;
  }
  const p = normIgnorePath(raw);

  if (!matcher.hasNegation) {
    if (matcher.exact.has(p)) return true;
    for (let i = 0; i < matcher.dirs.length; i += 1) {
      const d = matcher.dirs[i];
      if (p === d || p.startsWith(`${d}/`)) return true;
    }
    if (matcher.names.size) {
      if (matcher.names.has(p)) return true;
      let start = 0;
      while (start <= p.length) {
        const slash = p.indexOf("/", start);
        const seg = slash < 0 ? p.slice(start) : p.slice(start, slash);
        if (seg && matcher.names.has(seg)) return true;
        if (slash < 0) break;
        start = slash + 1;
      }
    }
    for (let i = 0; i < matcher.suffixes.length; i += 1) {
      if (p.endsWith(matcher.suffixes[i])) return true;
    }
    for (let i = 0; i < matcher.complex.length; i += 1) {
      if (matcher.complex[i].regex.test(raw) || matcher.complex[i].regex.test(p)) return true;
    }
    return false;
  }

  let ignored = false;
  if (matcher.exact.has(p)) ignored = true;
  for (let i = 0; i < matcher.dirs.length; i += 1) {
    const d = matcher.dirs[i];
    if (p === d || p.startsWith(`${d}/`)) ignored = true;
  }
  if (matcher.names.size) {
    let start = 0;
    while (start <= p.length) {
      const slash = p.indexOf("/", start);
      const seg = slash < 0 ? p.slice(start) : p.slice(start, slash);
      if (seg && matcher.names.has(seg)) ignored = true;
      if (slash < 0) break;
      start = slash + 1;
    }
  }
  for (let i = 0; i < matcher.suffixes.length; i += 1) {
    if (p.endsWith(matcher.suffixes[i])) ignored = true;
  }
  for (let i = 0; i < matcher.complex.length; i += 1) {
    const rule = matcher.complex[i];
    if (!rule.regex.test(raw) && !rule.regex.test(p)) continue;
    ignored = !rule.negation;
  }
  return ignored;
}

/** @type {RegExp[] | null} */
let cachedExcludeRegexes = null;
/** @type {string} */
let cachedExcludeRegexesKey = "";

function getExcludeRegexes() {
  const key = excludeGlobsKey();
  if (cachedExcludeRegexes && cachedExcludeRegexesKey === key) return cachedExcludeRegexes;
  cachedExcludeRegexesKey = key;
  cachedExcludeRegexes = getExcludeGlobs().map((g) => toRegExpFromGlob(g));
  return cachedExcludeRegexes;
}

/**
 * @param {string} relPath
 * @param {{ gitIgnore?: boolean }=} opts gitIgnore defaults to true
 */
function isExcludedPath(relPath, opts) {
  const p = String(relPath || "").replaceAll("\\", "/");
  if (!p) return false;
  if (hasIgnoredPathSegment(p)) return true;
  if (
    p.includes("/dist/") ||
    p.includes("/build/") ||
    p.includes("/.next/") ||
    p.includes("/target/") ||
    p.includes("/vendor/") ||
    p.endsWith("/swiftfind-path-index.cache") ||
    p.includes("/swiftfind-path-index.cache.")
  ) {
    return true;
  }
  if (opts?.gitIgnore !== false && isGitIgnoredPath(p)) return true;
  const base = path.posix.basename(p);
  return getExcludeRegexes().some((r) => r.test(p) || r.test(base));
}

function applyExcludeGlobs(items, opts) {
  return items.filter((it) => {
    const p = String(it.filePath || it.description || "").replaceAll("\\", "/");
    return !p || !isExcludedPath(p, opts);
  });
}

function findFilesExcludePattern(rootPath) {
  const globs = getExcludeGlobs();
  const pattern = globs.length <= 1 ? globs[0] || "**/.git/**" : `{${globs.join(",")}}`;
  return new vscode.RelativePattern(rootPath, pattern);
}

function pushRgExcludeGlobs(args) {
  for (const g of getExcludeGlobs()) {
    args.push("--glob", `!${g}`);
  }
  return args;
}

/** @type {{ root: string, regexes: RegExp[], at: number, key: string }} */
let searchIgnoreCache = { root: "", regexes: [], at: 0, key: "" };

async function readSearchIgnoreRegexes(rootPath) {
  if (!rootPath) return [];
  if (searchIgnoreCache.root === rootPath && searchIgnoreCache.key) {
    return searchIgnoreCache.regexes;
  }
  try {
    const raw = await fs.readFile(path.join(rootPath, ".searchignore"), "utf8");
    const key = gitIgnoreContentKey(raw);
    const regexes = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((g) => toRegExpFromGlob(g.replaceAll("\\", "/")));
    searchIgnoreCache = { root: rootPath, regexes, at: Date.now(), key };
    return regexes;
  } catch {
    searchIgnoreCache = { root: rootPath, regexes: [], at: Date.now(), key: "missing" };
    return [];
  }
}

function applySearchIgnore(items, ignoreRegexes) {
  if (!ignoreRegexes.length) return items;
  return items.filter((it) => {
    const p = String(it.filePath || it.description || "").replaceAll("\\", "/");
    return !p || !ignoreRegexes.some((r) => r.test(p));
  });
}

function applyScope(items, scopePath) {
  const scope = normalizeScopePath(scopePath);
  if (!scope) return items;
  return items.filter((it) => pathInScope(it.filePath || it.description, scope));
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(query, options, global = false) {
  try {
    const source = options.useRegex ? query : escapeRegex(query);
    const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
    return new RegExp(bounded, `${options.matchCase ? "" : "i"}${global ? "g" : ""}`);
  } catch {
    return null;
  }
}

async function getBundledRipgrepPath() {
  const exeName = process.platform === "win32" ? "rg.exe" : "rg";
  const appRoot = vscode.env.appRoot;
  if (!appRoot) return null;
  for (const candidate of [
    path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exeName),
    path.join(appRoot, "node_modules", "@vscode", "ripgrep", "bin", exeName)
  ]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function rgThreadCount() {
  const cpus = Number(os.cpus()?.length) || 4;
  return String(Math.min(8, Math.max(2, cpus)));
}

async function getSearchFileList(options) {
  await getIndexedPaths();
  const scope = normalizeScopePath(options?.scopePath);
  const files = pathIndex.files;
  if (!files.length) return [];
  if (!scope) return files;
  return files.filter((p) => pathInScope(p, scope));
}

/**
 * @param {string} query
 * @param {Record<string, unknown>=} options
 * @param {boolean} listFiles
 * @param {boolean=} useFilesFrom search only paths piped via --files-from=-
 */
function buildRgArgs(query, options, listFiles, useFilesFrom = false) {
  const args = [
    options?.matchCase ? "" : "-i",
    listFiles ? "-l" : "--no-heading",
    ...(listFiles ? [] : ["--line-number", "--column"]),
    "--color",
    "never",
    "--no-config",
    "--threads",
    rgThreadCount(),
    options?.wholeWord ? "-w" : "",
    options?.useRegex ? "" : "-F",
    "--max-filesize",
    "2M"
  ];
  if (useFilesFrom) {
    // Index is the source of truth — skip VCS/glob re-filters (rg does this with --files-from).
    args.push("--files-from", "-", query);
  } else {
    pushRgExcludeGlobs(args);
    const scopedTarget = normalizeScopePath(options?.scopePath) || ".";
    args.push(query, scopedTarget);
  }
  return args.filter(Boolean);
}

/**
 * @param {import("child_process").ChildProcess} child
 * @param {string[]} files
 */
function writeFilesToRgStdin(child, files) {
  return new Promise((resolve, reject) => {
    if (!child.stdin) {
      resolve();
      return;
    }
    let i = 0;
    const onError = (err) => {
      try {
        child.stdin.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };
    child.stdin.on("error", onError);
    const write = () => {
      try {
        while (i < files.length) {
          const ok = child.stdin.write(`${files[i]}\n`);
          i += 1;
          if (!ok) {
            child.stdin.once("drain", write);
            return;
          }
        }
        child.stdin.end();
        resolve();
      } catch (err) {
        onError(err);
      }
    };
    write();
  });
}

async function runRipgrep(rootPath, query, options, listFiles, files) {
  const rgPath = await getBundledRipgrepPath();
  if (!rgPath) return null;

  const useFilesFrom = Array.isArray(files);
  if (useFilesFrom && !files.length) return [];

  return new Promise((resolve) => {
    const child = childProcess.spawn(rgPath, buildRgArgs(query, options, listFiles, useFilesFrom), {
      cwd: rootPath,
      windowsHide: true,
      stdio: useFilesFrom ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
    });

    if (useFilesFrom) {
      writeFilesToRgStdin(child, files).catch(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      });
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 32 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        resolve(null);
        return;
      }
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      if (listFiles) {
        resolve(lines.map((line) => normalizeRelPath(line.trim(), rootPath)).filter(Boolean));
        return;
      }
      const items = lines.map((line) => parseRipgrepLine(line, rootPath)).filter(Boolean);
      resolve(!items.length && stderr ? null : items);
    });
  });
}

/**
 * Pause / resume / cancel controller for streaming searches.
 * Pause/cancel take effect immediately (stdout pause / child kill), not on the next batch tick.
 */
function createSearchController() {
  let paused = false;
  let cancelled = false;
  /** @type {Array<() => void>} */
  let resumeWaiters = [];
  /** @type {Array<() => void>} */
  let interruptWaiters = [];
  /** @type {import("child_process").ChildProcess | null} */
  let child = null;

  const wake = () => {
    const list = resumeWaiters.splice(0, resumeWaiters.length);
    for (const resolve of list) resolve();
  };

  const interrupt = () => {
    const list = interruptWaiters.splice(0, interruptWaiters.length);
    for (const resolve of list) resolve();
  };

  const applyPauseToChild = () => {
    if (!child?.stdout) return;
    try {
      if (paused) child.stdout.pause();
      else child.stdout.resume();
    } catch {
      // ignore
    }
  };

  const killChild = () => {
    if (!child) return;
    const proc = child;
    child = null;
    try {
      proc.kill();
    } catch {
      // ignore
    }
  };

  return {
    /**
     * @param {import("child_process").ChildProcess} proc
     */
    attachChild(proc) {
      child = proc;
      applyPauseToChild();
      if (cancelled) {
        killChild();
        return;
      }
      proc.once("close", () => {
        if (child === proc) child = null;
      });
    },
    pause() {
      paused = true;
      applyPauseToChild();
      interrupt();
    },
    resume() {
      if (!paused) return;
      paused = false;
      applyPauseToChild();
      interrupt();
      wake();
    },
    cancel() {
      cancelled = true;
      paused = false;
      killChild();
      interrupt();
      wake();
    },
    isPaused: () => paused,
    isCancelled: () => cancelled,
    async waitIfPaused() {
      while (paused && !cancelled) {
        await new Promise((resolve) => {
          resumeWaiters.push(resolve);
        });
      }
    },
    /** Interruptible delay — ends early on pause/resume/cancel. */
    async delay(ms) {
      const waitMs = Math.max(0, Number(ms) || 0);
      if (!waitMs || cancelled) return;
      const start = Date.now();
      while (!cancelled && Date.now() - start < waitMs) {
        if (paused) {
          await this.waitIfPaused();
          return;
        }
        const remaining = waitMs - (Date.now() - start);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, remaining);
          interruptWaiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    }
  };
}

/**
 * Stream ripgrep matches as they arrive (for live UI updates).
 * Yields to the event loop between batches so the webview can paint.
 * @param {{
 *   onBatch?: (payload: { items: SearchItem[], done: boolean, total: number, stopped?: boolean }) => void,
 *   isCancelled?: () => boolean,
 *   maxResults?: number,
 *   filterItem?: (item: SearchItem) => boolean,
 *   controller?: ReturnType<typeof createSearchController>
 * }=} hooks
 * @returns {Promise<SearchItem[] | null>}
 */
async function runRipgrepStreaming(rootPath, query, options, hooks = {}) {
  const rgPath = await getBundledRipgrepPath();
  if (!rgPath) return null;

  const maxResults = Math.max(1, Number(hooks.maxResults) || getConfig().maxResults);
  const onBatch = typeof hooks.onBatch === "function" ? hooks.onBatch : () => {};
  const controller = hooks.controller;
  const isCancelled = () =>
    (typeof hooks.isCancelled === "function" && hooks.isCancelled()) || Boolean(controller?.isCancelled());
  const filterItem = typeof hooks.filterItem === "function" ? hooks.filterItem : () => true;
  const useFilesFrom = Array.isArray(hooks.files);
  if (useFilesFrom && !hooks.files.length) {
    onBatch({ items: [], done: true, total: 0 });
    return [];
  }

  return new Promise((resolve) => {
    const child = childProcess.spawn(rgPath, buildRgArgs(query, options, false, useFilesFrom), {
      cwd: rootPath,
      windowsHide: true,
      stdio: useFilesFrom ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
    });
    if (controller) controller.attachChild(child);
    if (useFilesFrom) {
      writeFilesToRgStdin(child, hooks.files).catch(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      });
    }

    const waitIfPaused = async () => {
      if (controller) await controller.waitIfPaused();
    };
    const paintDelay = async () => {
      if (controller) await controller.delay(0);
      else await new Promise((r) => setTimeout(r, 0));
    };
    const batchSize = 48;

    /** @type {SearchItem[]} */
    const items = [];
    let buffer = "";
    let stderr = "";
    let chain = Promise.resolve();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const killChild = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    };

    const enqueue = (fn) => {
      chain = chain.then(fn).catch(() => {});
    };

    child.stdout.on("data", (chunk) => {
      enqueue(async () => {
        if (settled || isCancelled()) {
          killChild();
          return;
        }
        await waitIfPaused();
        if (settled || isCancelled()) {
          killChild();
          return;
        }
        buffer += String(chunk);
        if (buffer.length > 32 * 1024 * 1024) {
          killChild();
          return;
        }
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() || "";
        for (const line of parts) {
          if (!line) continue;
          if (isCancelled()) {
            killChild();
            return;
          }
          if (items.length >= maxResults) {
            killChild();
            break;
          }
          const item = parseRipgrepLine(line, rootPath);
          if (!item || !filterItem(item)) continue;
          items.push(item);
          if (items.length === 1 || items.length % batchSize === 0) {
            onBatch({ items: items.slice(), done: false, total: items.length });
            await paintDelay();
            await waitIfPaused();
            if (isCancelled()) {
              killChild();
              return;
            }
          }
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", () => finish(null));

    child.on("close", (code) => {
      enqueue(async () => {
        if (isCancelled()) {
          onBatch({ items: items.slice(), done: true, total: items.length, stopped: true });
          finish(items);
          return;
        }
        if (code !== 0 && code !== 1 && !items.length) {
          finish(null);
          return;
        }
        if (!items.length && stderr) {
          finish(null);
          return;
        }
        onBatch({ items: items.slice(), done: true, total: items.length });
        finish(items);
      });
    });
  });
}

/**
 * Progressive text search for live UI — only within the path-index cache.
 */
async function searchTextStreaming(rootPath, query, options, hooks = {}) {
  const onBatch = typeof hooks.onBatch === "function" ? hooks.onBatch : () => {};
  const controller = hooks.controller;
  const isCancelled = () =>
    (typeof hooks.isCancelled === "function" && hooks.isCancelled()) || Boolean(controller?.isCancelled());
  const filterItem = typeof hooks.filterItem === "function" ? hooks.filterItem : () => true;
  const maxResults = Math.max(1, Number(hooks.maxResults) || getConfig().maxResults);
  const opts = mergeOptions(options);

  const files = await getSearchFileList(opts);
  if (isCancelled()) return [];
  if (!files.length) {
    onBatch({ items: [], done: true, total: 0 });
    return [];
  }

  const streamed = await runRipgrepStreaming(rootPath, query, opts, {
    maxResults,
    isCancelled,
    filterItem,
    onBatch,
    controller,
    files
  });
  if (streamed !== null) return streamed;
  if (isCancelled()) return [];

  return fallbackSearchStreaming(rootPath, query, maxResults, opts, {
    onBatch,
    isCancelled,
    filterItem,
    controller,
    files
  });
}

async function fallbackSearchStreaming(rootPath, query, maxResults, options, hooks = {}) {
    const onBatch = typeof hooks.onBatch === "function" ? hooks.onBatch : () => {};
    const controller = hooks.controller;
    const isCancelled = () =>
      (typeof hooks.isCancelled === "function" && hooks.isCancelled()) || Boolean(controller?.isCancelled());
    const waitIfPaused = async () => {
      if (controller) await controller.waitIfPaused();
    };
    const paintDelay = async () => {
      if (controller) await controller.delay(0);
      else await new Promise((r) => setTimeout(r, 0));
    };
    const filterItem = typeof hooks.filterItem === "function" ? hooks.filterItem : () => true;
    const matchCase = Boolean(options?.matchCase);
    const wholeWord = Boolean(options?.wholeWord);
    const useRegex = Boolean(options?.useRegex);
    const needle = matchCase ? query : query.toLowerCase();
    const regex = buildRegex(query, { matchCase, wholeWord, useRegex });
    const files =
      Array.isArray(hooks.files) && hooks.files.length
        ? hooks.files
        : await getSearchFileList(options);

    /** @type {SearchItem[]} */
    const out = [];
    let sincePaint = 0;
    for (const rel of files) {
      await waitIfPaused();
      if (isCancelled() || out.length >= maxResults) break;

      const abs = path.join(rootPath, rel);
      let content;
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        content = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }

      const filePath = normalizeRelPath(abs, rootPath);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length < maxResults; i += 1) {
        if (isCancelled()) break;
        const src = lines[i];
        let at = -1;
        if (regex) {
          const m = regex.exec(src);
          at = m ? m.index : -1;
        } else {
          const hay = matchCase ? src : src.toLowerCase();
          at = hay.indexOf(needle);
          if (wholeWord && at >= 0) {
            const left = at === 0 ? "" : hay[at - 1];
            const right = at + needle.length >= hay.length ? "" : hay[at + needle.length];
            if (!(!/[a-zA-Z0-9_]/.test(left) && !/[a-zA-Z0-9_]/.test(right))) at = -1;
          }
        }
        if (at < 0) continue;
        const item = makeItem(filePath, i + 1, at + 1, lines[i]);
        if (!filterItem(item)) continue;
        out.push(item);
        sincePaint += 1;
        if (out.length === 1 || sincePaint >= 48) {
          sincePaint = 0;
          onBatch({ items: out.slice(), done: false, total: out.length });
          await paintDelay();
          await waitIfPaused();
          if (isCancelled()) break;
        }
      }
    }
    onBatch({
      items: out.slice(),
      done: true,
      total: out.length,
      stopped: isCancelled()
    });
    return out;
}

/**
 * Progressive Files/Folders filter over the path index (supports pause/resume).
 */
async function searchPathIndexStreaming(kind, query, limit, options, hooks = {}) {
  const onBatch = typeof hooks.onBatch === "function" ? hooks.onBatch : () => {};
  const controller = hooks.controller;
  const isCancelled = () =>
    (typeof hooks.isCancelled === "function" && hooks.isCancelled()) || Boolean(controller?.isCancelled());
  const waitIfPaused = async () => {
    if (controller) await controller.waitIfPaused();
  };
  const yieldToEventLoop = async () => {
    if (controller) await controller.delay(0);
    else await new Promise((r) => setTimeout(r, 0));
  };
  const filterItem = typeof hooks.filterItem === "function" ? hooks.filterItem : () => true;
  await getIndexedPaths();
  if (isCancelled()) {
    onBatch({ items: [], done: true, total: 0, stopped: true });
    return [];
  }

  const isFolders = kind === "folders";
  const paths = isFolders ? pathIndex.folders : pathIndex.files;
  const lowers = isFolders ? pathIndex.folderLowers : pathIndex.fileBases;
  const fuzzy = Boolean(options?.fuzzy);
  const needle = String(query || "").toLowerCase();
  const cap = Math.max(1, Number(limit) || 1);
  const candidates = candidateIndicesFor(needle, isFolders ? "folders" : "files");
  if (Array.isArray(candidates) && candidates.length === 0) {
    onBatch({ items: [], done: true, total: 0, stopped: false });
    return [];
  }

  /** @type {{item: SearchItem, s: number}[]} */
  const rows = [];
  let scanned = 0;
  let sincePaint = 0;
  let lastEmitted = 0;

  const consider = (i) => {
    const rel = paths[i];
    if (hasIgnoredPathSegment(rel)) return;
    const hay = lowers[i] || "";
    const s = fuzzy ? fuzzyScore(hay, needle) : hay.includes(needle) ? 1 : -1;
    if (s < 0) return;
    const baseName = isFolders
      ? path.posix.basename(rel)
      : pathIndex.fileBaseNames[i] || path.posix.basename(rel);
    const item = isFolders
      ? {
          label: `$(folder) ${baseName}`,
          description: rel,
          detail: "Folder"
        }
      : {
          label: `$(file) ${baseName}`,
          description: rel,
          detail: "File",
          filePath: rel,
          lineNumber: 1,
          column: 1
        };
    if (!filterItem(item)) return;
    rows.push({ item, s });
    sincePaint += 1;
  };

  const maybePaint = async () => {
    if (!(rows.length === 1 || sincePaint >= 120)) return false;
    sincePaint = 0;
    if (rows.length === lastEmitted) return false;
    lastEmitted = rows.length;
    const partial = rankFuzzy(rows.slice(), cap);
    onBatch({ items: partial, done: false, total: partial.length });
    await yieldToEventLoop();
    await waitIfPaused();
    return isCancelled();
  };

  if (candidates) {
    for (let c = 0; c < candidates.length; c += 1) {
      scanned += 1;
      if (scanned % 4000 === 0) {
        await waitIfPaused();
        if (isCancelled()) break;
        await yieldToEventLoop();
        if (isCancelled()) break;
      }
      consider(candidates[c]);
      if (!fuzzy && rows.length >= cap) break;
      if (await maybePaint()) break;
    }
  } else {
    for (let i = 0; i < paths.length; i += 1) {
      scanned += 1;
      if (scanned % 4000 === 0) {
        await waitIfPaused();
        if (isCancelled()) break;
        await yieldToEventLoop();
        if (isCancelled()) break;
      }
      consider(i);
      if (!fuzzy && rows.length >= cap) break;
      if (await maybePaint()) break;
    }
  }

  const items = rankFuzzy(rows, cap);
  onBatch({ items, done: true, total: items.length, stopped: isCancelled() });
  return items;
}

async function fallbackSearch(rootPath, query, maxResults, options, filesOpt) {
  const matchCase = Boolean(options?.matchCase);
  const wholeWord = Boolean(options?.wholeWord);
  const useRegex = Boolean(options?.useRegex);
  const needle = matchCase ? query : query.toLowerCase();
  const regex = buildRegex(query, { matchCase, wholeWord, useRegex });
  const files = Array.isArray(filesOpt) ? filesOpt : await getSearchFileList(options);

  /** @type {SearchItem[]} */
  const out = [];
  for (const rel of files) {
    if (out.length >= maxResults) break;
    const abs = path.join(rootPath, rel);
    let content;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const filePath = normalizeRelPath(abs, rootPath);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < maxResults; i += 1) {
      const src = lines[i];
      let at = -1;
      if (regex) {
        const m = regex.exec(src);
        at = m ? m.index : -1;
      } else {
        const hay = matchCase ? src : src.toLowerCase();
        at = hay.indexOf(needle);
        if (wholeWord && at >= 0) {
          const left = at === 0 ? "" : hay[at - 1];
          const right = at + needle.length >= hay.length ? "" : hay[at + needle.length];
          if (!(!/[a-zA-Z0-9_]/.test(left) && !/[a-zA-Z0-9_]/.test(right))) at = -1;
        }
      }
      if (at < 0) continue;
      out.push(makeItem(filePath, i + 1, at + 1, lines[i]));
    }
  }
  return out;
}

async function search(text, options) {
  if (!text || text.trim().length <= 1) return [];
  const rootPath = getRootPath();
  if (!rootPath) return [];

  await loadGitIgnoreRules(rootPath);
  const cfg = getConfig();
  const opts = mergeOptions(options);
  const q = text.trim();
  const noResults = [{ label: t("No results found", "Brak wynikow"), alwaysShow: true }];
  const timeoutMsg = [
    { label: t("Search timeout (narrow query)", "Przekroczono czas wyszukiwania (zawęź frazę)"), alwaysShow: true }
  ];
  const files = await getSearchFileList(opts);
  if (!files.length) return noResults;

  const rgItems = await runRipgrep(rootPath, q, opts, false, files);
  if (rgItems) {
    return rgItems.length ? rgItems.slice(0, cfg.maxResults) : noResults;
  }
  try {
    const items = await fallbackSearch(rootPath, q, cfg.maxResults, opts, files);
    return items.length ? items : timeoutMsg;
  } catch {
    throw new Error("Search failed.");
  }
}

function rankFuzzy(rows, limit) {
  const cap = Math.max(1, Number(limit) || 1);
  if (!rows.length) return [];
  // Non-fuzzy matches all share score 1 — skip expensive sort.
  if (rows.length > 1 && rows[0].s === 1) {
    let allSame = true;
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].s !== 1) {
        allSame = false;
        break;
      }
    }
    if (allSame) return rows.slice(0, cap).map((r) => r.item);
  }
  if (rows.length <= cap) {
    rows.sort((a, b) => b.s - a.s);
    return rows.map((r) => r.item);
  }
  rows.sort((a, b) => b.s - a.s);
  return rows.slice(0, cap).map((r) => r.item);
}

async function readGitHead(rootPath) {
  try {
    return (await fs.readFile(path.join(rootPath, ".git", "HEAD"), "utf8")).trim();
  } catch {
    return "";
  }
}

async function readGitHeadCached(rootPath) {
  const now = Date.now();
  if (gitHeadCache.root === rootPath && now - gitHeadCache.at < 2500) {
    return gitHeadCache.value;
  }
  const value = await readGitHead(rootPath);
  gitHeadCache = { root: rootPath, value, at: now };
  return value;
}

function clearGitHeadCache() {
  gitHeadCache = { root: "", value: "", at: 0 };
}

function cmpPath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function foldersFromFiles(files) {
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const rel of files) {
    let dir = path.posix.dirname(rel);
    while (dir && dir !== ".") {
      dirs.add(dir);
      const parent = path.posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...dirs].sort(cmpPath);
}

/**
 * Posting lists: char -> indices into lowers[] that contain that char.
 * Used to skip most of the index for uncommon query characters.
 * @param {string[]} lowers
 */
function buildCharPostings(lowers) {
  /** @type {Map<string, number[]>} */
  const map = new Map();
  for (let i = 0; i < lowers.length; i += 1) {
    const b = lowers[i];
    /** @type {Set<string>} */
    const seen = new Set();
    for (let k = 0; k < b.length; k += 1) {
      const ch = b[k];
      if (seen.has(ch)) continue;
      seen.add(ch);
      let arr = map.get(ch);
      if (!arr) {
        arr = [];
        map.set(ch, arr);
      }
      arr.push(i);
    }
  }
  return map;
}

function rebuildSearchIndexes() {
  pathIndex.fileCharIndex = buildCharPostings(pathIndex.fileBases);
  pathIndex.folderCharIndex = buildCharPostings(pathIndex.folderLowers);
}

function scheduleRebuildSearchIndexes() {
  if (pathIndex.searchIndexTimer) clearTimeout(pathIndex.searchIndexTimer);
  pathIndex.searchIndexTimer = setTimeout(() => {
    pathIndex.searchIndexTimer = null;
    rebuildSearchIndexes();
  }, 250);
}

/**
 * @param {number[]} a sorted ascending
 * @param {number[]} b sorted ascending
 */
function intersectSortedIndices(a, b) {
  if (!a.length || !b.length) return [];
  if (a.length > b.length) return intersectSortedIndices(b, a);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const av = a[i];
    const bv = b[j];
    if (av === bv) {
      out.push(av);
      i += 1;
      j += 1;
    } else if (av < bv) i += 1;
    else j += 1;
  }
  return out;
}

/**
 * @param {string} needle lowercased
 * @param {"files"|"folders"} kind
 * @returns {number[] | null} candidate indices, empty array = no match, null = scan all
 */
function candidateIndicesFor(needle, kind) {
  const lowers = kind === "folders" ? pathIndex.folderLowers : pathIndex.fileBases;
  const index = kind === "folders" ? pathIndex.folderCharIndex : pathIndex.fileCharIndex;
  if (!needle || !index || !lowers.length) return null;
  /** @type {number[][]} */
  const lists = [];
  for (let k = 0; k < needle.length; k += 1) {
    const arr = index.get(needle[k]);
    if (!arr || !arr.length) return [];
    lists.push(arr);
  }
  if (!lists.length) return null;
  if (lists.length === 1) {
    const only = lists[0];
    return only.length > lowers.length * 0.42 ? null : only;
  }
  lists.sort((a, b) => a.length - b.length);
  let best = lists[0];
  for (let n = 1; n < lists.length; n += 1) {
    best = intersectSortedIndices(best, lists[n]);
    if (!best.length) return [];
    if (best.length > lowers.length * 0.42) return null;
  }
  return best.length > lowers.length * 0.42 ? null : best;
}

/**
 * @param {string[]} files
 * @param {string[]=} foldersOpt
 * @param {boolean=} deferCharIndex schedule char postings off the hot path (disk load)
 */
function setPathIndexFiles(files, foldersOpt, deferCharIndex = false) {
  pathIndex.files = files;
  pathIndex.fileBaseNames = files.map((rel) => path.posix.basename(rel));
  pathIndex.fileBases = pathIndex.fileBaseNames.map((b) => b.toLowerCase());
  pathIndex.fileSet = new Set(files);
  pathIndex.folders = foldersOpt || foldersFromFiles(files);
  pathIndex.folderLowers = pathIndex.folders.map((d) => d.toLowerCase());
  pathIndex.folderSet = new Set(pathIndex.folders);
  if (deferCharIndex) {
    pathIndex.fileCharIndex = null;
    pathIndex.folderCharIndex = null;
    scheduleRebuildSearchIndexes();
  } else {
    rebuildSearchIndexes();
  }
}

function addFolderChainToIndex(rel) {
  let dir = path.posix.dirname(rel);
  while (dir && dir !== ".") {
    if (!pathIndex.folderSet.has(dir)) {
      pathIndex.folderSet.add(dir);
      pathIndex.folders.push(dir);
      pathIndex.folderLowers.push(dir.toLowerCase());
    }
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function rebuildFoldersFromFiles() {
  pathIndex.folders = foldersFromFiles(pathIndex.files);
  pathIndex.folderLowers = pathIndex.folders.map((d) => d.toLowerCase());
  pathIndex.folderSet = new Set(pathIndex.folders);
}

function getIndexCachePath(rootPath) {
  return path.join(rootPath, ".vscode", PATH_INDEX_CACHE_NAME);
}

function schedulePersistPathIndex() {
  if (pathIndex.persistTimer) clearTimeout(pathIndex.persistTimer);
  pathIndex.persistTimer = setTimeout(() => {
    pathIndex.persistTimer = null;
    persistPathIndexToDisk().catch(() => {});
  }, 900);
}

async function flushPathIndexCache() {
  if (pathIndex.persistTimer) {
    clearTimeout(pathIndex.persistTimer);
    pathIndex.persistTimer = null;
  }
  if (pathIndex.searchIndexTimer) {
    clearTimeout(pathIndex.searchIndexTimer);
    pathIndex.searchIndexTimer = null;
    rebuildSearchIndexes();
  }
  await persistPathIndexToDisk();
}

/**
 * Delete `.vscode/swiftfind-path-index.cache` and rebuild the in-memory + disk index.
 * @returns {Promise<{ ok: boolean, count?: number, message?: string }>}
 */
async function rebuildPathIndexCache() {
  const rootPath = getRootPath();
  if (!rootPath) {
    const message = t("Open a workspace folder first.", "Najpierw otwórz folder roboczy.");
    vscode.window.showWarningMessage(message);
    return { ok: false, message };
  }

  if (pathIndex.persistTimer) {
    clearTimeout(pathIndex.persistTimer);
    pathIndex.persistTimer = null;
  }
  if (pathIndex.settleTimer) {
    clearTimeout(pathIndex.settleTimer);
    pathIndex.settleTimer = null;
  }
  if (pathIndex.searchIndexTimer) {
    clearTimeout(pathIndex.searchIndexTimer);
    pathIndex.searchIndexTimer = null;
  }
  pathIndex.buildPromise = null;

  const cachePath = getIndexCachePath(rootPath);
  try {
    await fs.unlink(cachePath);
  } catch {
    // missing is fine
  }
  // Remove leftover temp writes from a crashed persist.
  try {
    const dir = path.join(rootPath, ".vscode");
    const names = await fs.readdir(dir);
    await Promise.all(
      names
        .filter((n) => n.startsWith(`${PATH_INDEX_CACHE_NAME}.`) && n.endsWith(".tmp"))
        .map((n) => fs.unlink(path.join(dir, n)).catch(() => {}))
    );
  } catch {
    // ignore
  }

  clearGitIgnoreCache();
  clearGitHeadCache();
  pathIndex.rootPath = "";
  pathIndex.files = [];
  pathIndex.fileBaseNames = [];
  pathIndex.fileBases = [];
  pathIndex.fileSet = new Set();
  pathIndex.folders = [];
  pathIndex.folderLowers = [];
  pathIndex.folderSet = new Set();
  pathIndex.fileCharIndex = null;
  pathIndex.folderCharIndex = null;
  pathIndex.gitignoreKey = "";
  pathIndex.gitHead = "";
  pathIndex.excludeGlobsKey = "";
  pathIndex.dirty = true;

  await warmPathIndex("workspace");
  return { ok: true, count: pathIndex.files.length };
}

async function persistPathIndexToDisk() {
  const rootPath = pathIndex.rootPath || getRootPath();
  if (!rootPath || pathIndex.dirty || !pathIndex.files.length) return;
  const dir = path.join(rootPath, ".vscode");
  await fs.mkdir(dir, { recursive: true });
  const target = getIndexCachePath(rootPath);
  const tmp = `${target}.${process.pid}.tmp`;
  const meta = JSON.stringify({
    v: PATH_INDEX_CACHE_VERSION,
    excludeGitIgnored: pathIndex.excludeGitIgnored,
    globsKey: pathIndex.excludeGlobsKey,
    gitignoreKey: pathIndex.gitignoreKey,
    gitHead: pathIndex.gitHead,
    count: pathIndex.files.length
  });
  const content =
    `SWIFTFIND_PATH_INDEX_V1\n${meta}\n---files---\n${pathIndex.files.join("\n")}\n---folders---\n${pathIndex.folders.join("\n")}\n`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, target);
  } catch {
    // Windows can't rename over an existing file.
    try {
      await fs.unlink(target);
    } catch {
      // ignore
    }
    await fs.rename(tmp, target);
  }
}

/**
 * @returns {Promise<boolean>}
 */
async function tryLoadPathIndexFromDisk(rootPath, excludeGitIgnored, globsKey, gitHead, gitignoreKey) {
  try {
    const raw = await fs.readFile(getIndexCachePath(rootPath), "utf8");
    if (!raw.startsWith("SWIFTFIND_PATH_INDEX_V1\n")) return false;
    const filesMarker = "\n---files---\n";
    const foldersMarker = "\n---folders---\n";
    const filesAt = raw.indexOf(filesMarker);
    if (filesAt < 0) return false;
    const metaLine = raw.slice("SWIFTFIND_PATH_INDEX_V1\n".length, filesAt);
    const meta = JSON.parse(metaLine);
    if (!meta || meta.v !== PATH_INDEX_CACHE_VERSION) return false;
    if (Boolean(meta.excludeGitIgnored) !== Boolean(excludeGitIgnored)) return false;
    if (String(meta.globsKey || "") !== globsKey) return false;
    if (String(meta.gitignoreKey || "") !== String(gitignoreKey || "")) return false;
    if (String(meta.gitHead || "") !== String(gitHead || "")) return false;

    const foldersAt = raw.indexOf(foldersMarker, filesAt);
    const filesBlock =
      foldersAt >= 0
        ? raw.slice(filesAt + filesMarker.length, foldersAt)
        : raw.slice(filesAt + filesMarker.length);
    const foldersBlock = foldersAt >= 0 ? raw.slice(foldersAt + foldersMarker.length) : "";
    const files = filesBlock.split(/\r?\n/).filter(Boolean);
    const folders = foldersBlock.split(/\r?\n/).filter(Boolean);
    if (!files.length) return false;

    pathIndex.rootPath = rootPath;
    pathIndex.excludeGitIgnored = Boolean(excludeGitIgnored);
    pathIndex.excludeGlobsKey = globsKey;
    pathIndex.gitignoreKey = String(gitignoreKey || "");
    pathIndex.gitHead = String(gitHead || "");
    setPathIndexFiles(files, folders.length ? folders : undefined, true);
    pathIndex.dirty = false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Stream `rg --files` line-by-line (avoids one giant stdout string).
 * Trusts rg `--glob` excludes; skips a second JS exclude pass for speed.
 */
async function listWorkspaceFilesWithRg(rootPath, excludeGitIgnored) {
  const rgPath = await getBundledRipgrepPath();
  if (!rgPath) return null;
  const args = [
      "--files",
      "--color",
      "never",
      "--no-messages",
      "--no-config",
      "--threads",
      rgThreadCount(),
      excludeGitIgnored ? "" : "--no-ignore-vcs"
    ].filter(Boolean);
    pushRgExcludeGlobs(args);
    return new Promise((resolve) => {
    const child = childProcess.spawn(rgPath, args, {
      cwd: rootPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    /** @type {string[]} */
    const files = [];
    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const p = normalizeRelPath(trimmed, rootPath);
        if (p) files.push(p);
      }
      if (files.length > 500000) {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (buffer.trim()) {
        const p = normalizeRelPath(buffer.trim(), rootPath);
        if (p) files.push(p);
      }
      if (code !== 0 && code !== 1 && !files.length) {
        finish(null);
        return;
      }
      finish(files);
    });
  });
}

async function listWorkspaceFilesFallback(rootPath) {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootPath, "**/*"),
    findFilesExcludePattern(rootPath),
    100000
  );
  return uris.map((uri) => normalizeRelPath(uri.fsPath, rootPath)).filter((p) => p && !isExcludedPath(p));
}

function invalidatePathIndex(reason = "manual") {
  pathIndex.dirty = true;
  if (reason === "git-head") clearGitHeadCache();
  if (pathIndex.settleTimer) clearTimeout(pathIndex.settleTimer);
  // FS churn: longer settle so we coalesce bursts instead of rebuilding constantly.
  const delay =
    reason === "git-head" ? 500 : reason === "fs" ? 1200 : reason === "workspace" ? 200 : 50;
  pathIndex.settleTimer = setTimeout(() => {
    pathIndex.settleTimer = null;
    warmPathIndex(reason).catch(() => {});
  }, delay);
  try {
    pathIndex.onInvalidate?.(reason);
  } catch {
    // ignore listener errors
  }
}

/**
 * Map a workspace URI to a relative index path, or "" if outside/excluded.
 * @param {vscode.Uri | undefined} uri
 */
function uriToIndexRel(uri) {
  if (!uri || uri.scheme === "untitled") return "";
  const root = pathIndex.rootPath || getRootPath();
  if (!root) return "";
  const rel = normalizeRelPath(uri.fsPath, root);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  if (isExcludedPath(rel)) return "";
  return rel.replaceAll("\\", "/");
}

/**
 * Incremental create/delete/rename patch — avoids full `rg --files` on every FS event.
 * Falls back to a coalesced full rebuild when the index is not ready.
 * @param {{
 *   created?: readonly vscode.Uri[],
 *   deleted?: readonly vscode.Uri[],
 *   renamed?: readonly { oldUri: vscode.Uri, newUri: vscode.Uri }[]
 * }} delta
 */
function patchPathIndexFromFs(delta) {
  if (
    pathIndex.dirty ||
    pathIndex.buildPromise ||
    !pathIndex.rootPath ||
    pathIndex.rootPath !== getRootPath()
  ) {
    invalidatePathIndex("fs");
    return false;
  }

  /** @type {string[]} */
  const toAdd = [];
  /** @type {string[]} */
  const toRemove = [];
  /** @type {{ from: string, to: string }[]} */
  const prefixRewrites = [];

  for (const uri of delta.created || []) {
    const rel = uriToIndexRel(uri);
    if (rel) toAdd.push(rel);
  }
  for (const uri of delta.deleted || []) {
    const root = pathIndex.rootPath;
    if (!root || !uri) continue;
    const rel = normalizeRelPath(uri.fsPath, root).replaceAll("\\", "/");
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) toRemove.push(rel);
  }
  for (const entry of delta.renamed || []) {
    const root = pathIndex.rootPath;
    if (!root || !entry?.oldUri || !entry?.newUri) continue;
    const oldRel = normalizeRelPath(entry.oldUri.fsPath, root).replaceAll("\\", "/");
    const newRel = normalizeRelPath(entry.newUri.fsPath, root).replaceAll("\\", "/");
    if (!oldRel || oldRel.startsWith("..") || path.isAbsolute(oldRel)) continue;
    if (pathIndex.fileSet.has(oldRel)) {
      toRemove.push(oldRel);
      if (newRel && !newRel.startsWith("..") && !path.isAbsolute(newRel) && !isExcludedPath(newRel)) {
        toAdd.push(newRel);
      }
    } else if (newRel && !newRel.startsWith("..") && !path.isAbsolute(newRel)) {
      // Folder rename: rewrite all indexed paths under the old prefix.
      prefixRewrites.push({ from: oldRel, to: newRel });
    }
  }

  let changed = false;

  for (const { from, to } of prefixRewrites) {
    const fromPrefix = from.endsWith("/") ? from : `${from}/`;
    const toPrefix = to.endsWith("/") ? to : `${to}/`;
    const nextFiles = [];
    const nextBaseNames = [];
    const nextBases = [];
    let rewriteChanged = false;
    for (let i = 0; i < pathIndex.files.length; i += 1) {
      const f = pathIndex.files[i];
      let next = f;
      if (f === from) next = to;
      else if (f.startsWith(fromPrefix)) next = toPrefix + f.slice(fromPrefix.length);
      if (next !== f) rewriteChanged = true;
      if (isExcludedPath(next)) continue;
      nextFiles.push(next);
      if (next === f) {
        nextBaseNames.push(pathIndex.fileBaseNames[i]);
        nextBases.push(pathIndex.fileBases[i]);
      } else {
        const base = path.posix.basename(next);
        nextBaseNames.push(base);
        nextBases.push(base.toLowerCase());
      }
    }
    if (rewriteChanged) {
      pathIndex.files = nextFiles;
      pathIndex.fileBaseNames = nextBaseNames;
      pathIndex.fileBases = nextBases;
      pathIndex.fileSet = new Set(nextFiles);
      rebuildFoldersFromFiles();
      changed = true;
    }
  }

  let removedAny = false;
  if (toRemove.length) {
    /** @type {Set<string>} */
    const drop = new Set();
    for (const rel of toRemove) {
      if (pathIndex.fileSet.has(rel)) {
        drop.add(rel);
        continue;
      }
      const prefix = rel.endsWith("/") ? rel : `${rel}/`;
      for (const f of pathIndex.fileSet) {
        if (f === rel || f.startsWith(prefix)) drop.add(f);
      }
    }
    if (drop.size) {
      const nextFiles = [];
      const nextBaseNames = [];
      const nextBases = [];
      for (let i = 0; i < pathIndex.files.length; i += 1) {
        const f = pathIndex.files[i];
        if (drop.has(f)) continue;
        nextFiles.push(f);
        nextBaseNames.push(pathIndex.fileBaseNames[i]);
        nextBases.push(pathIndex.fileBases[i]);
      }
      if (nextFiles.length !== pathIndex.files.length) {
        pathIndex.files = nextFiles;
        pathIndex.fileBaseNames = nextBaseNames;
        pathIndex.fileBases = nextBases;
        pathIndex.fileSet = new Set(nextFiles);
        removedAny = true;
        changed = true;
      }
    }
  }

  for (const rel of toAdd) {
    if (pathIndex.fileSet.has(rel)) continue;
    pathIndex.fileSet.add(rel);
    pathIndex.files.push(rel);
    const base = path.posix.basename(rel);
    pathIndex.fileBaseNames.push(base);
    pathIndex.fileBases.push(base.toLowerCase());
    addFolderChainToIndex(rel);
    changed = true;
  }

  if (removedAny) rebuildFoldersFromFiles();
  if (changed) {
    // Char postings are stale until rebuilt; null forces a safe linear scan.
    pathIndex.fileCharIndex = null;
    pathIndex.folderCharIndex = null;
    scheduleRebuildSearchIndexes();
    schedulePersistPathIndex();
  }
  return changed;
}

async function rebuildPathIndex(rootPath, excludeGitIgnored) {
  const gitHead = await readGitHeadCached(rootPath);
  const globsKey = excludeGlobsKey();
  await loadGitIgnoreRules(rootPath);
  const gitignoreKey = gitIgnoreCache.key;
  let files = await listWorkspaceFilesWithRg(rootPath, true);
  if (!files) files = await listWorkspaceFilesFallback(rootPath);
  // rg already applied VCS ignore + globs; only drop tracked-but-ignored paths via fast matcher.
  files = files.filter((p) => p && !isGitIgnoredPath(p));
  files.sort(cmpPath);
  pathIndex.rootPath = rootPath;
  pathIndex.excludeGitIgnored = true;
  pathIndex.excludeGlobsKey = globsKey;
  pathIndex.gitignoreKey = gitignoreKey;
  pathIndex.gitHead = gitHead;
  setPathIndexFiles(files);
  pathIndex.dirty = false;
  schedulePersistPathIndex();
  return files.length;
}

/** Cached workspace path list (always applies .gitignore + excludeGlobs). */
async function getIndexedPaths() {
  const rootPath = getRootPath();
  if (!rootPath) return { files: [], folders: [], rebuilt: false, count: 0 };

  const gitHead = await readGitHeadCached(rootPath);
  const globsKey = excludeGlobsKey();
  await loadGitIgnoreRules(rootPath);
  const gitignoreKey = gitIgnoreCache.key;
  const mode = true;
  const needsRebuild =
    pathIndex.dirty ||
    pathIndex.rootPath !== rootPath ||
    pathIndex.excludeGitIgnored !== mode ||
    pathIndex.excludeGlobsKey !== globsKey ||
    pathIndex.gitignoreKey !== gitignoreKey ||
    pathIndex.gitHead !== gitHead;

  if (!needsRebuild) {
    return {
      files: pathIndex.files,
      folders: pathIndex.folders,
      rebuilt: false,
      count: pathIndex.files.length
    };
  }

  // Prefer disk cache over a full workspace walk, except when memory is only
  // marked dirty (incremental patches may be newer than the file on disk).
  const onlyDirty =
    pathIndex.dirty &&
    pathIndex.files.length > 0 &&
    pathIndex.rootPath === rootPath &&
    pathIndex.excludeGitIgnored === mode &&
    pathIndex.excludeGlobsKey === globsKey &&
    pathIndex.gitignoreKey === gitignoreKey &&
    pathIndex.gitHead === gitHead;
  if (!onlyDirty) {
    const loaded = await tryLoadPathIndexFromDisk(rootPath, mode, globsKey, gitHead, gitignoreKey);
    if (loaded) {
      return {
        files: pathIndex.files,
        folders: pathIndex.folders,
        rebuilt: false,
        count: pathIndex.files.length
      };
    }
  }

  if (pathIndex.buildPromise) {
    await pathIndex.buildPromise;
    if (
      !pathIndex.dirty &&
      pathIndex.rootPath === rootPath &&
      pathIndex.excludeGitIgnored === mode &&
      pathIndex.excludeGlobsKey === globsKey &&
      pathIndex.gitignoreKey === gitignoreKey &&
      pathIndex.gitHead === gitHead
    ) {
      return {
        files: pathIndex.files,
        folders: pathIndex.folders,
        rebuilt: false,
        count: pathIndex.files.length
      };
    }
  }

  pathIndex.buildPromise = rebuildPathIndex(rootPath, mode);
  try {
    const count = await pathIndex.buildPromise;
    return { files: pathIndex.files, folders: pathIndex.folders, rebuilt: true, count };
  } finally {
    pathIndex.buildPromise = null;
  }
}

/** Toast only for meaningful rebuilds — not every single file create/delete. */
const INDEX_TOAST_REASONS = new Set(["startup", "workspace", "git-head"]);

/**
 * @param {string=} reason
 */
async function warmPathIndex(reason = "startup") {
  const rootPath = getRootPath();
  if (!rootPath) {
    pathIndex.rootPath = "";
    pathIndex.files = [];
    pathIndex.fileBaseNames = [];
    pathIndex.fileBases = [];
    pathIndex.fileSet = new Set();
    pathIndex.folders = [];
    pathIndex.folderLowers = [];
    pathIndex.folderSet = new Set();
    pathIndex.fileCharIndex = null;
    pathIndex.folderCharIndex = null;
    pathIndex.gitHead = "";
    pathIndex.gitignoreKey = "";
    pathIndex.dirty = true;
    return;
  }

  // Startup: try disk cache first (silent). Only toast when we must rebuild.
  if (reason === "startup") {
    const gitHead = await readGitHeadCached(rootPath);
    const globsKey = excludeGlobsKey();
    await loadGitIgnoreRules(rootPath);
    const loaded = await tryLoadPathIndexFromDisk(
      rootPath,
      true,
      globsKey,
      gitHead,
      gitIgnoreCache.key
    );
    if (loaded) return;
  }

  if (!INDEX_TOAST_REASONS.has(reason)) {
    await getIndexedPaths();
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "SwiftFind",
      cancellable: false
    },
    async (progress) => {
      progress.report({
        message: t("Rebuilding file index…", "Odbudowa indeksu plików…")
      });
      const result = await getIndexedPaths();
      if (!result.rebuilt) return;
      progress.report({
        message: t(`Indexed ${result.count} files`, `Zaindeksowano ${result.count} plików`)
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  );
}

/** @type {vscode.Disposable | null} */
let gitHeadWatcher = null;
/** @type {vscode.Disposable | null} */
let gitIgnoreWatcher = null;

function bindGitHeadWatcher() {
  if (gitHeadWatcher) {
    gitHeadWatcher.dispose();
    gitHeadWatcher = null;
  }
  const rootPath = getRootPath();
  if (!rootPath) return;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(rootPath), ".git/HEAD")
  );
  const onHead = () => {
    clearGitHeadCache();
    invalidatePathIndex("git-head");
  };
  watcher.onDidChange(onHead);
  watcher.onDidCreate(onHead);
  watcher.onDidDelete(onHead);
  gitHeadWatcher = watcher;
}

function bindGitIgnoreWatcher() {
  if (gitIgnoreWatcher) {
    gitIgnoreWatcher.dispose();
    gitIgnoreWatcher = null;
  }
  const rootPath = getRootPath();
  if (!rootPath) return;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(rootPath), ".gitignore")
  );
  const onIgnore = () => {
    clearGitIgnoreCache();
    invalidatePathIndex("workspace");
  };
  watcher.onDidChange(onIgnore);
  watcher.onDidCreate(onIgnore);
  watcher.onDidDelete(onIgnore);
  gitIgnoreWatcher = watcher;
}

/**
 * Watch .git/HEAD + .gitignore + workspace folder changes so index stays fresh.
 * @param {vscode.ExtensionContext} context
 * @param {{ onInvalidate?: (reason: string) => void }=} hooks
 */
function initPathIndexWatchers(context, hooks) {
  pathIndex.onInvalidate = hooks?.onInvalidate || null;
  warmPathIndex("startup").catch(() => {});
  bindGitHeadWatcher();
  bindGitIgnoreWatcher();
  context.subscriptions.push({
    dispose: () => {
      if (gitHeadWatcher) {
        gitHeadWatcher.dispose();
        gitHeadWatcher = null;
      }
      if (gitIgnoreWatcher) {
        gitIgnoreWatcher.dispose();
        gitIgnoreWatcher = null;
      }
    }
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearGitIgnoreCache();
      searchIgnoreCache = { root: "", regexes: [], at: 0, key: "" };
      invalidatePathIndex("workspace");
      bindGitHeadWatcher();
      bindGitIgnoreWatcher();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("swiftFind.excludeGlobs")) {
        cachedExcludeRegexes = null;
        cachedExcludeRegexesKey = "";
        invalidatePathIndex("workspace");
      }
    })
  );
}

async function searchFiles(query, limit, options) {
  if (!query) return [];
  await getIndexedPaths();
  const fuzzy = Boolean(options?.fuzzy);
  const needle = query.toLowerCase();
  const cap = Math.max(1, Number(limit) || 1);
  const candidates = candidateIndicesFor(needle, "files");
  if (Array.isArray(candidates) && candidates.length === 0) return [];
  /** @type {{item: SearchItem, s: number}[]} */
  const rows = [];
  const files = pathIndex.files;
  const bases = pathIndex.fileBases;
  const baseNames = pathIndex.fileBaseNames;
  const visit = (i) => {
    const rel = files[i];
    if (hasIgnoredPathSegment(rel)) return;
    const base = bases[i] || "";
    const s = fuzzy ? fuzzyScore(base, needle) : base.includes(needle) ? 1 : -1;
    if (s < 0) return;
    rows.push({
      item: {
        label: `$(file) ${baseNames[i] || path.posix.basename(rel)}`,
        description: rel,
        detail: "File",
        filePath: rel,
        lineNumber: 1,
        column: 1
      },
      s
    });
  };
  if (candidates) {
    for (let c = 0; c < candidates.length; c += 1) {
      visit(candidates[c]);
      if (!fuzzy && rows.length >= cap) break;
    }
  } else {
    for (let i = 0; i < files.length; i += 1) {
      visit(i);
      if (!fuzzy && rows.length >= cap) break;
    }
  }
  return rankFuzzy(rows, cap);
}

async function searchFolders(query, limit, options) {
  if (!query) return [];
  await getIndexedPaths();
  const fuzzy = Boolean(options?.fuzzy);
  const needle = query.toLowerCase();
  const cap = Math.max(1, Number(limit) || 1);
  const candidates = candidateIndicesFor(needle, "folders");
  if (Array.isArray(candidates) && candidates.length === 0) return [];
  /** @type {{item: SearchItem, s: number}[]} */
  const rows = [];
  const folders = pathIndex.folders;
  const lowers = pathIndex.folderLowers;
  const visit = (i) => {
    const dir = folders[i];
    if (hasIgnoredPathSegment(dir)) return;
    const hay = lowers[i] || "";
    const s = fuzzy ? fuzzyScore(hay, needle) : hay.includes(needle) ? 1 : -1;
    if (s < 0) return;
    rows.push({
      item: {
        label: `$(folder) ${path.posix.basename(dir)}`,
        description: dir,
        detail: "Folder"
      },
      s
    });
  };
  if (candidates) {
    for (let c = 0; c < candidates.length; c += 1) {
      visit(candidates[c]);
      if (!fuzzy && rows.length >= cap) break;
    }
  } else {
    for (let i = 0; i < folders.length; i += 1) {
      visit(i);
      if (!fuzzy && rows.length >= cap) break;
    }
  }
  return rankFuzzy(rows, cap);
}

async function searchSymbols(query, limit, options) {
  if (!query) return [];
  const symbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query);
  if (!Array.isArray(symbols)) return [];
  const fuzzy = Boolean(options?.fuzzy);
  const filtered = fuzzy
    ? symbols
        .map((s) => ({ s, score: fuzzyScore(`${s?.name || ""} ${s?.containerName || ""}`, query) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.s)
    : symbols;
  /** @type {SearchItem[]} */
  const out = [];
  for (const s of filtered.slice(0, limit)) {
    const filePath = s?.location?.uri?.fsPath ? normalizeRelPath(s.location.uri.fsPath, getRootPath()) : "";
    out.push({
      label: `$(symbol-class) ${s.name || "Symbol"}`,
      description: filePath || s.containerName || "",
      detail: s.containerName || "Symbol",
      filePath: filePath || undefined,
      lineNumber: (s?.location?.range?.start?.line || 0) + 1,
      column: (s?.location?.range?.start?.character || 0) + 1
    });
  }
  return out;
}

async function searchCommands(query, limit, options) {
  const cmds = await vscode.commands.getCommands(true);
  const needle = String(query || "").toLowerCase();
  const fuzzy = Boolean(options?.fuzzy);
  const filtered = (fuzzy
    ? cmds
        .map((c) => ({ c, score: fuzzyScore(c, needle) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c)
    : cmds.filter((c) => c.toLowerCase().includes(needle))
  ).slice(0, limit);
  return filtered.map((cmd) => ({
    label: `$(terminal) ${cmd}`,
    detail: "Command",
    commandId: cmd
  }));
}

async function searchByTab(tab, query, options) {
  const q = String(query || "").trim();
  if (!q) return [];

  const max = getConfig().maxResults;
  const opts = mergeOptions(options);
  const rootPath = getRootPath();
  await loadGitIgnoreRules(rootPath);
  const searchIgnoreRegexes = opts.excludeSearchIgnored ? await readSearchIgnoreRegexes(rootPath) : [];
  const tabName = String(tab || "text");
  // Files/folders index and ripgrep already applied .gitignore + excludeGlobs —
  // avoid re-running the full matcher on every hit (was the main slowdown).
  const alreadyFiltered = tabName === "files" || tabName === "folders" || tabName === "text";
  const scoped = (arr) => {
    const narrowed = applyScope(applySearchIgnore(arr, searchIgnoreRegexes), opts.scopePath);
    return alreadyFiltered ? narrowed : applyExcludeGlobs(narrowed);
  };

  const handlers = {
    files: () => searchFiles(q, max, opts),
    folders: () => searchFolders(q, max, opts),
    text: () => search(q, opts),
    symbols: () => searchSymbols(q, max, opts),
    commands: () => searchCommands(q, max, opts)
  };
  return scoped(await (handlers[tabName] || handlers.text)());
}

/**
 * Like searchByTab, but emits partial result batches for live UI (fullscreen).
 * @param {"files"|"folders"|"text"|"symbols"|"commands"} tab
 * @param {string} query
 * @param {Record<string, unknown>=} options
 * @param {{
 *   onBatch?: (payload: { items: SearchItem[], done: boolean, total: number, stopped?: boolean }) => void,
 *   isCancelled?: () => boolean,
 *   controller?: ReturnType<typeof createSearchController>
 * }=} hooks
 */
async function searchByTabStreaming(tab, query, options, hooks = {}) {
  const onBatch = typeof hooks.onBatch === "function" ? hooks.onBatch : () => {};
  const controller = hooks.controller;
  const isCancelled = () =>
    (typeof hooks.isCancelled === "function" && hooks.isCancelled()) || Boolean(controller?.isCancelled());
  const q = String(query || "").trim();
  if (!q) {
    onBatch({ items: [], done: true, total: 0 });
    return [];
  }

  const normalizedTab = String(tab || "text");
  const max = getConfig().maxResults;
  const opts = mergeOptions(options);
  const rootPath = getRootPath();
  await loadGitIgnoreRules(rootPath);
  const searchIgnoreRegexes = opts.excludeSearchIgnored ? await readSearchIgnoreRegexes(rootPath) : [];
  // Index + ripgrep already honor ignores; only re-filter symbols (and keep scope/.searchignore).
  const accept = (item) => {
    const scoped = applyScope(applySearchIgnore([item], searchIgnoreRegexes), opts.scopePath);
    return scoped.length > 0;
  };
  const emit = (batch) => {
    if (isCancelled() && !batch.done) return;
    onBatch(batch);
  };

  if (isCancelled()) return [];

  if (normalizedTab === "text") {
    if (!rootPath) {
      onBatch({ items: [], done: true, total: 0 });
      return [];
    }
    return searchTextStreaming(rootPath, q, opts, {
      maxResults: max,
      isCancelled,
      filterItem: accept,
      controller,
      onBatch: emit
    });
  }

  if (normalizedTab === "files" || normalizedTab === "folders") {
    return searchPathIndexStreaming(normalizedTab, q, max, opts, {
      isCancelled,
      filterItem: accept,
      controller,
      onBatch: emit
    });
  }

  // Symbols / commands: emit progressive paint after collection.
  const collectors = {
    symbols: () => searchSymbols(q, max, opts),
    commands: () => searchCommands(q, max, opts)
  };
  const raw = await (collectors[normalizedTab] || collectors.symbols)();
  if (isCancelled()) {
    onBatch({ items: [], done: true, total: 0, stopped: true });
    return [];
  }
  const items = applyExcludeGlobs(applyScope(applySearchIgnore(raw, searchIgnoreRegexes), opts.scopePath));
  if (items.length > 40) {
    for (let i = 40; i < items.length; i += 60) {
      if (controller) await controller.waitIfPaused();
      if (isCancelled()) {
        onBatch({ items: items.slice(0, i), done: true, total: i, stopped: true });
        return items.slice(0, i);
      }
      onBatch({ items: items.slice(0, i), done: false, total: i });
      if (controller) await controller.delay(0);
      else await new Promise((r) => setTimeout(r, 0));
    }
  }
  onBatch({ items, done: true, total: items.length, stopped: isCancelled() });
  return items;
}

function replaceInString(text, findQuery, replaceStr, options) {
  const re = buildRegex(findQuery, options, true);
  if (!re) return { newText: text, count: 0, error: "invalid_pattern" };
  const matches = text.match(re);
  const count = matches ? matches.length : 0;
  if (!count) return { newText: text, count: 0 };
  return { newText: text.replace(re, replaceStr ?? ""), count };
}

/**
 * Collect per-match line previews for Replace UI (Rider-style tree).
 * @returns {{ count: number, previews: Array<{lineNumber:number, column:number, before:string, after:string, matchLength:number}>, error?: string }}
 */
function collectReplacePreviews(text, findQuery, replaceStr, options, maxPreviews) {
  const re = buildRegex(findQuery, options, true);
  if (!re) return { count: 0, previews: [], error: "invalid_pattern" };
  const localRe = buildRegex(findQuery, options, false);
  const limit = Math.max(0, Number(maxPreviews) || 0);
  /** @type {Array<{lineNumber:number, column:number, before:string, after:string, matchLength:number}>} */
  const previews = [];
  let count = 0;
  let match = re.exec(text);
  while (match) {
    count += 1;
    if (previews.length < limit) {
      const idx = match.index;
      const beforeChunk = text.slice(0, idx);
      const lineNumber = beforeChunk.split(/\r?\n/).length;
      const nl = Math.max(beforeChunk.lastIndexOf("\n"), beforeChunk.lastIndexOf("\r"));
      const lineStart = nl + 1;
      let lineEnd = text.indexOf("\n", idx);
      if (lineEnd < 0) lineEnd = text.length;
      if (lineEnd > 0 && text[lineEnd - 1] === "\r") lineEnd -= 1;
      const line = text.slice(lineStart, lineEnd);
      const column = idx - lineStart + 1;
      const matchLength = match[0].length;
      let replacedMatch = replaceStr ?? "";
      if (localRe) {
        try {
          replacedMatch = match[0].replace(localRe, replaceStr ?? "");
        } catch {
          replacedMatch = replaceStr ?? "";
        }
      }
      const after =
        line.slice(0, Math.max(0, column - 1)) + replacedMatch + line.slice(Math.max(0, column - 1) + matchLength);
      previews.push({ lineNumber, column, before: line, after, matchLength });
    }
    if (!re.global) break;
    if (match[0].length === 0) {
      re.lastIndex += 1;
    }
    match = re.exec(text);
  }
  return { count, previews };
}

async function fallbackListFilesContainingText(rootPath, query, options) {
  const regex = buildRegex(query, {
    matchCase: Boolean(options.matchCase),
    wholeWord: Boolean(options.wholeWord),
    useRegex: Boolean(options.useRegex)
  });
  if (!regex) return [];
  /** @type {Set<string>} */
  const matched = new Set();
  const files = await getSearchFileList(options);
  for (const rel of files) {
    const abs = path.join(rootPath, rel);
    let content;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (regex.test(line)) {
        matched.add(normalizeRelPath(abs, rootPath));
        break;
      }
    }
  }
  return [...matched];
}

function filterPathsForReplace(paths, ignoreRegexes, scopePath) {
  const scope = normalizeScopePath(scopePath);
  let out = paths.map((p) => p.replaceAll("\\", "/")).filter((p) => p && !isExcludedPath(p));
  if (ignoreRegexes.length) out = out.filter((p) => !ignoreRegexes.some((r) => r.test(p)));
  if (scope) out = out.filter((p) => pathInScope(p, scope));
  return out;
}

async function listFilesContainingText(findQuery, options) {
  const rootPath = getRootPath();
  const findTrim = String(findQuery).trim();
  if (!rootPath || !findTrim) return [];

  const opts = mergeOptions(options);
  await loadGitIgnoreRules(rootPath);
  const searchIgnoreRegexes = opts.excludeSearchIgnored ? await readSearchIgnoreRegexes(rootPath) : [];
  const files = await getSearchFileList(opts);
  let paths = await runRipgrep(rootPath, findTrim, opts, true, files);
  if (!paths?.length) paths = await fallbackListFilesContainingText(rootPath, findTrim, opts);
  return [...new Set(filterPathsForReplace(paths || [], searchIgnoreRegexes, opts.scopePath))];
}

function validateReplace(find, options, fuzzyHint) {
  const rootPath = getRootPath();
  if (!rootPath) {
    return { ok: false, message: t("Open a workspace folder first.", "Najpierw otworz folder roboczy.") };
  }
  if (options.fuzzy) {
    return {
      ok: false,
      message: fuzzyHint
        ? t("Replace does not support fuzzy mode. Turn off fuzzy.", "Zamiana nie obsluguje trybu fuzzy. Wylacz fuzzy.")
        : t("Replace does not support fuzzy mode.", "Zamiana nie obsluguje trybu fuzzy.")
    };
  }
  const findTrim = String(find || "").trim();
  if (!findTrim) {
    return { ok: false, message: t("Find text is empty.", "Pusty tekst do znalezienia.") };
  }
  if (!buildRegex(findTrim, options, true)) {
    return { ok: false, message: t("Invalid find pattern.", "Nieprawidlowy wzor wyszukiwania.") };
  }
  return { ok: true, findTrim, rootPath };
}

async function previewReplace(find, replace, options) {
  const opts = mergeOptions(options);
  const check = validateReplace(find, opts, true);
  if (!check.ok) return check;

  const paths = await listFilesContainingText(check.findTrim, opts);
  const replaceStr = String(replace ?? "");
  const light = Boolean(options?.lightPreview);
  let occurrences = 0;
  let filesWithHits = 0;
  const maxFiles = 120;
  const maxPreviewsTotal = 200;
  const perFile = 12;
  /** @type {Array<{filePath:string, count:number, previews:Array<{lineNumber:number, column:number, before:string, after:string, matchLength:number}>}>} */
  const samples = [];
  let previewBudget = light ? 0 : maxPreviewsTotal;

  for (const rel of paths) {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(check.rootPath, rel)));
      const text = doc.getText();
      if (light) {
        const { count } = replaceInString(text, check.findTrim, replaceStr, opts);
        if (!count) continue;
        occurrences += count;
        filesWithHits += 1;
        continue;
      }
      const collected = collectReplacePreviews(
        text,
        check.findTrim,
        replaceStr,
        opts,
        Math.min(perFile, previewBudget)
      );
      if (!collected.count) continue;
      occurrences += collected.count;
      filesWithHits += 1;
      if (samples.length < maxFiles && collected.previews.length) {
        samples.push({
          filePath: rel.replaceAll("\\", "/"),
          count: collected.count,
          previews: collected.previews
        });
        previewBudget -= collected.previews.length;
      }
    } catch {
      // skip unreadable
    }
  }
  return { ok: true, files: filesWithHits, occurrences, samples };
}

async function replaceAllInScope(find, replace, options) {
  const opts = mergeOptions(options);
  const check = validateReplace(find, opts);
  if (!check.ok) return check;

  const paths = await listFilesContainingText(check.findTrim, opts);
  const edit = new vscode.WorkspaceEdit();
  let changedFiles = 0;
  let occurrences = 0;
  const replaceStr = String(replace ?? "");

  for (const rel of paths) {
    const uri = vscode.Uri.file(path.join(check.rootPath, rel));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const { newText, count } = replaceInString(text, check.findTrim, replaceStr, opts);
      if (!count) continue;
      occurrences += count;
      edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), doc.positionAt(text.length)), newText);
      changedFiles += 1;
    } catch {
      // skip unreadable
    }
  }

  if (!changedFiles) {
    return { ok: true, changedFiles: 0, occurrences: 0, message: t("No matches to replace.", "Brak dopasowan do zamiany.") };
  }
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    return { ok: false, message: t("Could not apply workspace edit.", "Nie udalo sie zastosowac zmian.") };
  }
  return { ok: true, changedFiles, occurrences };
}

async function openResult(item, preserveFocus) {
  if (!item.filePath) return;
  const rootPath = getRootPath();
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(rootPath, item.filePath)), {
    preserveFocus: Boolean(preserveFocus)
  });
  const editor =
    vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === path.join(rootPath, item.filePath)
    ) || vscode.window.activeTextEditor;
  if (!editor || editor.document.lineCount <= 0) return;
  const line = Math.min(Math.max(0, (item.lineNumber || 1) - 1), editor.document.lineCount - 1);
  const col = Math.max(0, (item.column || 1) - 1);
  const matchLen = Math.max(0, Number(item.matchLength) || 0);
  const start = new vscode.Position(line, col);
  let end = start;
  if (matchLen > 0) {
    const lineText = editor.document.lineAt(line).text;
    const clamped = Math.min(matchLen, Math.max(0, lineText.length - col));
    end = new vscode.Position(line, col + clamped);
  }
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
}

module.exports = {
  getConfig,
  search,
  openResult,
  searchByTab,
  searchByTabStreaming,
  createSearchController,
  previewReplace,
  replaceAllInScope,
  patchPathIndexFromFs,
  flushPathIndexCache,
  rebuildPathIndexCache,
  initPathIndexWatchers
};
