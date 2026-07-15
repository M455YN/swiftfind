const vscode = require("vscode");
const childProcess = require("child_process");
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
  "**/{node_modules,.git,dist,build,out,.next,.cache,.venv,venv}/**",
  "**/*.dtbcache",
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
  "**/*.wav"
];

/** Path index for Files/Folders tabs (and git-aware refresh). */
const pathIndex = {
  rootPath: "",
  excludeGitIgnored: true,
  excludeGlobsKey: "",
  gitHead: "",
  /** @type {string[]} */
  files: [],
  /** @type {string[]} */
  folders: [],
  dirty: true,
  /** @type {Promise<void> | null} */
  buildPromise: null,
  /** @type {ReturnType<typeof setTimeout> | null} */
  settleTimer: null,
  /** @type {(() => void) | null} */
  onInvalidate: null
};

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
  return opts;
}

function quoteArg(arg) {
  if (process.platform === "win32") {
    return `"${String(arg).replace(/"/g, '\\"')}"`;
  }
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
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
const parseFindstrLine = (line, rootPath) => parseSearchLine(line, rootPath, false);

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
  const esc = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let rx = esc.replace(/\*\*/g, "###DOUBLE_STAR###").replace(/\*/g, "[^/]*").replace(/###DOUBLE_STAR###/g, ".*");
  // `**/*.bin` should also match root-level `file.bin`
  if (raw.startsWith("**/")) {
    rx = `(?:.*\\/)?${rx.replace(/^\.\*\//, "")}`;
  }
  return new RegExp(`^${rx}$`, "i");
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

function isExcludedPath(relPath) {
  const p = String(relPath || "").replaceAll("\\", "/");
  if (!p) return false;
  const base = path.posix.basename(p);
  return getExcludeRegexes().some((r) => r.test(p) || r.test(base));
}

function applyExcludeGlobs(items) {
  return items.filter((it) => {
    const p = String(it.filePath || it.description || "").replaceAll("\\", "/");
    return !p || !isExcludedPath(p);
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

async function readSearchIgnoreRegexes(rootPath) {
  try {
    const raw = await fs.readFile(path.join(rootPath, ".searchignore"), "utf8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((g) => toRegExpFromGlob(g.replaceAll("\\", "/")));
  } catch {
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

function buildFindstrPattern(query, options) {
  if (options.useRegex) {
    return options.wholeWord ? `\\<${query}\\>` : query;
  }
  const safe = query.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
  return options.wholeWord ? `\\<${safe}\\>` : query;
}

function workspacePatterns(rootPath, scopePath) {
  const scope = normalizeScopePath(scopePath);
  const include = new vscode.RelativePattern(
    rootPath,
    scope ? (scope.includes(".") ? scope : `${scope}/**/*`) : "**/*"
  );
  return { include, exclude: findFilesExcludePattern(rootPath) };
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

function buildRgArgs(query, options, listFiles) {
  const scopedTarget = normalizeScopePath(options?.scopePath) || ".";
  const args = [
    options?.matchCase ? "" : "-i",
    listFiles ? "-l" : "--no-heading",
    ...(listFiles ? [] : ["--line-number", "--column"]),
    "--color",
    "never",
    options?.wholeWord ? "-w" : "",
    options?.useRegex ? "" : "-F",
    options?.excludeGitIgnored ? "" : "--no-ignore-vcs",
    "--max-filesize",
    "2M"
  ];
  pushRgExcludeGlobs(args);
  args.push(query, scopedTarget);
  return args.filter(Boolean);
}

function runRipgrep(rootPath, query, options, listFiles) {
  return new Promise(async (resolve) => {
    const rgPath = await getBundledRipgrepPath();
    if (!rgPath) {
      resolve(null);
      return;
    }

    const child = childProcess.spawn(rgPath, buildRgArgs(query, options, listFiles), {
      cwd: rootPath,
      windowsHide: true
    });

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
 */
function createSearchController() {
  let paused = false;
  let cancelled = false;
  /** @type {Array<() => void>} */
  let resumeWaiters = [];

  const wake = () => {
    const list = resumeWaiters.splice(0, resumeWaiters.length);
    for (const resolve of list) resolve();
  };

  return {
    pause() {
      paused = true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      wake();
    },
    cancel() {
      cancelled = true;
      paused = false;
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
function runRipgrepStreaming(rootPath, query, options, hooks = {}) {
  return new Promise(async (resolve) => {
    const rgPath = await getBundledRipgrepPath();
    if (!rgPath) {
      resolve(null);
      return;
    }

    const maxResults = Math.max(1, Number(hooks.maxResults) || getConfig().maxResults);
    const onBatch = typeof hooks.onBatch === "function" ? hooks.onBatch : () => {};
    const controller = hooks.controller;
    const isCancelled = () =>
      (typeof hooks.isCancelled === "function" && hooks.isCancelled()) || Boolean(controller?.isCancelled());
    const filterItem = typeof hooks.filterItem === "function" ? hooks.filterItem : () => true;
    const child = childProcess.spawn(rgPath, buildRgArgs(query, options, false), {
      cwd: rootPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const waitIfPaused = async () => {
      if (!controller) return;
      if (controller.isPaused()) {
        try {
          child.stdout.pause();
        } catch {
          // ignore
        }
      }
      await controller.waitIfPaused();
      try {
        child.stdout.resume();
      } catch {
        // ignore
      }
    };
    const batchSize = 12;
    const paintDelayMs = 24;

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
          if (items.length >= maxResults) {
            killChild();
            break;
          }
          const item = parseRipgrepLine(line, rootPath);
          if (!item || !filterItem(item)) continue;
          items.push(item);
          if (items.length === 1 || items.length % batchSize === 0) {
            onBatch({ items: items.slice(), done: false, total: items.length });
            await new Promise((r) => setTimeout(r, paintDelayMs));
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
 * Progressive text search for live UI (rg stream, then findstr/JS with yields).
 */
async function searchTextStreaming(rootPath, query, options, hooks = {}) {
  const onBatch = typeof hooks.onBatch === "function" ? hooks.onBatch : () => {};
  const controller = hooks.controller;
  const isCancelled = () =>
    (typeof hooks.isCancelled === "function" && hooks.isCancelled()) || Boolean(controller?.isCancelled());
  const filterItem = typeof hooks.filterItem === "function" ? hooks.filterItem : () => true;
  const maxResults = Math.max(1, Number(hooks.maxResults) || getConfig().maxResults);
  const opts = mergeOptions(options);

  const streamed = await runRipgrepStreaming(rootPath, query, opts, {
    maxResults,
    isCancelled,
    filterItem,
    onBatch,
    controller
  });
  if (streamed !== null) return streamed;
  if (isCancelled()) return [];

  return fallbackSearchStreaming(rootPath, query, maxResults, opts, {
    onBatch,
    isCancelled,
    filterItem,
    controller
  });
}

function fallbackSearchStreaming(rootPath, query, maxResults, options, hooks = {}) {
  return new Promise((resolve) => {
    const onBatch = typeof hooks.onBatch === "function" ? hooks.onBatch : () => {};
    const controller = hooks.controller;
    const isCancelled = () =>
      (typeof hooks.isCancelled === "function" && hooks.isCancelled()) || Boolean(controller?.isCancelled());
    const waitIfPaused = async () => {
      if (controller) await controller.waitIfPaused();
    };
    const filterItem = typeof hooks.filterItem === "function" ? hooks.filterItem : () => true;
    const matchCase = Boolean(options?.matchCase);
    const wholeWord = Boolean(options?.wholeWord);
    const useRegex = Boolean(options?.useRegex);
    const needle = matchCase ? query : query.toLowerCase();
    const regex = buildRegex(query, { matchCase, wholeWord, useRegex });
    const { include, exclude } = workspacePatterns(rootPath, options?.scopePath);

    vscode.workspace
      .findFiles(include, exclude, Math.max(maxResults * 30, 2000))
      .then(async (uris) => {
        /** @type {SearchItem[]} */
        const out = [];
        let sincePaint = 0;
        for (const uri of uris) {
          await waitIfPaused();
          if (isCancelled() || out.length >= maxResults) break;

          let stat;
          try {
            stat = await fs.stat(uri.fsPath);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;

          let content;
          try {
            content = await fs.readFile(uri.fsPath, "utf8");
          } catch {
            continue;
          }

          const filePath = normalizeRelPath(uri.fsPath, rootPath);
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
            const item = makeItem(filePath, i + 1, at + 1, lines[i]);
            if (!filterItem(item)) continue;
            out.push(item);
            sincePaint += 1;
            if (out.length === 1 || sincePaint >= 12) {
              sincePaint = 0;
              onBatch({ items: out.slice(), done: false, total: out.length });
              await new Promise((r) => setTimeout(r, 24));
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
        resolve(out);
      })
      .catch(() => {
        onBatch({ items: [], done: true, total: 0 });
        resolve([]);
      });
  });
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
  const filterItem = typeof hooks.filterItem === "function" ? hooks.filterItem : () => true;
  const { files, folders } = await getIndexedPaths(options?.excludeGitIgnored !== false);
  const source = kind === "folders" ? folders : files;
  const fuzzy = Boolean(options?.fuzzy);
  const needle = String(query || "").toLowerCase();
  /** @type {{item: SearchItem, s: number}[]} */
  const rows = [];
  let sincePaint = 0;

  for (const rel of source) {
    await waitIfPaused();
    if (isCancelled()) break;
    const hay = kind === "folders" ? rel : path.posix.basename(rel);
    const s = fuzzy ? fuzzyScore(hay, needle) : hay.toLowerCase().includes(needle) ? 1 : -1;
    if (s < 0) continue;
    const item =
      kind === "folders"
        ? {
            label: `$(folder) ${path.posix.basename(rel)}`,
            description: rel,
            detail: "Folder"
          }
        : {
            label: `$(file) ${path.posix.basename(rel)}`,
            description: rel,
            detail: "File",
            filePath: rel,
            lineNumber: 1,
            column: 1
          };
    if (!filterItem(item)) continue;
    rows.push({ item, s });
    sincePaint += 1;
    if (rows.length === 1 || sincePaint >= 40) {
      sincePaint = 0;
      const partial = rankFuzzy(rows.slice(), limit);
      onBatch({ items: partial, done: false, total: partial.length });
      await new Promise((r) => setTimeout(r, 16));
      await waitIfPaused();
      if (isCancelled()) break;
    }
  }

  const items = rankFuzzy(rows, limit);
  onBatch({ items, done: true, total: items.length, stopped: isCancelled() });
  return items;
}

function searchWithBundledRg(rootPath, query, cfg, options) {
  return runRipgrep(rootPath, query, options, false).then((items) =>
    items ? items.slice(0, cfg.maxResults) : null
  );
}

function lineMatchesFind(src, query, options) {
  const regex = buildRegex(query, {
    matchCase: Boolean(options.matchCase),
    wholeWord: Boolean(options.wholeWord),
    useRegex: Boolean(options.useRegex)
  });
  return Boolean(regex?.exec(src));
}

async function scanFilesForMatches(rootPath, query, options, onMatch) {
  const { include, exclude } = workspacePatterns(rootPath, options?.scopePath);
  const uris = await vscode.workspace.findFiles(include, exclude, 5000);
  for (const uri of uris) {
    let stat;
    try {
      stat = await fs.stat(uri.fsPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;

    let content;
    try {
      content = await fs.readFile(uri.fsPath, "utf8");
    } catch {
      continue;
    }

    const filePath = normalizeRelPath(uri.fsPath, rootPath);
    onMatch(filePath, content.split(/\r?\n/));
  }
}

function fallbackSearch(rootPath, query, maxResults, options) {
  return new Promise((resolve) => {
    const matchCase = Boolean(options?.matchCase);
    const wholeWord = Boolean(options?.wholeWord);
    const useRegex = Boolean(options?.useRegex);
    const needle = matchCase ? query : query.toLowerCase();
    const regex = buildRegex(query, { matchCase, wholeWord, useRegex });
    const { include, exclude } = workspacePatterns(rootPath, options?.scopePath);

    vscode.workspace
      .findFiles(include, exclude, Math.max(maxResults * 30, 2000))
      .then(async (uris) => {
        /** @type {SearchItem[]} */
        const out = [];
        for (const uri of uris) {
          if (out.length >= maxResults) break;

          let stat;
          try {
            stat = await fs.stat(uri.fsPath);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;

          let content;
          try {
            content = await fs.readFile(uri.fsPath, "utf8");
          } catch {
            continue;
          }

          const filePath = normalizeRelPath(uri.fsPath, rootPath);
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
        resolve(out);
      })
      .catch(() => resolve([]));
  });
}

function search(text, options) {
  return new Promise((resolve, reject) => {
    if (!text || text.trim().length <= 1) {
      resolve([]);
      return;
    }
    const rootPath = getRootPath();
    if (!rootPath) {
      resolve([]);
      return;
    }

    const cfg = getConfig();
    const opts = mergeOptions(options);
    const q = text.trim();
    const noResults = [{ label: t("No results found", "Brak wynikow"), alwaysShow: true }];
    const timeoutMsg = [{ label: t("Search timeout (narrow query)", "Przekroczono czas wyszukiwania (zawęź frazę)"), alwaysShow: true }];

    const finishFallback = (items, empty) => resolve(items.length ? items : empty || noResults);

    searchWithBundledRg(rootPath, q, cfg, opts).then((rgItems) => {
      if (rgItems?.length) {
        resolve(rgItems);
        return;
      }
      if (process.platform !== "win32") {
        resolve(noResults);
        return;
      }

      const caseOpt = opts.matchCase ? "" : "/I";
      const safeQuery = q.replace(/"/g, '""');
      const findstrPattern = buildFindstrPattern(safeQuery, opts);
      const command = [
        "cmd /d /s /c",
        quoteArg(`findstr ${caseOpt} /S /N ${opts.useRegex || opts.wholeWord ? "/R" : ""} /C:"${findstrPattern}" *`)
      ].join(" ");

      childProcess.exec(command, { cwd: rootPath, maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
        if (err?.killed) {
          fallbackSearch(rootPath, q, cfg.maxResults, opts).then((items) => finishFallback(items, timeoutMsg));
          return;
        }
        if (err && err.code !== 1) {
          fallbackSearch(rootPath, q, cfg.maxResults, opts)
            .then((items) => (items.length ? resolve(items) : reject(new Error(`findstr failed (${err.code}).`))))
            .catch(() => reject(new Error(`findstr failed (${err.code}).`)));
          return;
        }

        const items = String(stdout)
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => parseFindstrLine(line, rootPath))
          .filter(Boolean);

        if (items.length) {
          fallbackSearch(rootPath, q, cfg.maxResults, opts).then((fallbackItems) =>
            resolve(mergeUniqueResults(items, fallbackItems).slice(0, cfg.maxResults))
          );
          return;
        }
        fallbackSearch(rootPath, q, cfg.maxResults, opts).then((items) => finishFallback(items));
      });
    });
  });
}

function rankFuzzy(rows, limit) {
  rows.sort((a, b) => b.s - a.s);
  return rows.slice(0, limit).map((r) => r.item);
}

async function readGitHead(rootPath) {
  try {
    return (await fs.readFile(path.join(rootPath, ".git", "HEAD"), "utf8")).trim();
  } catch {
    return "";
  }
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
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

function listWorkspaceFilesWithRg(rootPath, excludeGitIgnored) {
  return new Promise(async (resolve) => {
    const rgPath = await getBundledRipgrepPath();
    if (!rgPath) {
      resolve(null);
      return;
    }
    const args = ["--files", "--color", "never", excludeGitIgnored ? "" : "--no-ignore-vcs"].filter(Boolean);
    pushRgExcludeGlobs(args);
    const child = childProcess.spawn(rgPath, args, { cwd: rootPath, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 64 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", () => {});
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        resolve(null);
        return;
      }
      resolve(
        stdout
          .split(/\r?\n/)
          .map((l) => normalizeRelPath(l.trim(), rootPath))
          .filter((p) => p && !isExcludedPath(p))
      );
    });
  });
}

async function listWorkspaceFilesFallback(rootPath) {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootPath, "**/*"),
    findFilesExcludePattern(rootPath),
    100000
  );
  return uris
    .map((uri) => normalizeRelPath(uri.fsPath, rootPath))
    .filter((p) => p && !isExcludedPath(p));
}

function invalidatePathIndex(reason = "manual") {
  pathIndex.dirty = true;
  if (pathIndex.settleTimer) clearTimeout(pathIndex.settleTimer);
  // Checkout/FS churn and folder switches: rebuild after a short settle.
  const delay =
    reason === "git-head" ? 400 : reason === "fs" ? 200 : reason === "workspace" ? 150 : 50;
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

async function rebuildPathIndex(rootPath, excludeGitIgnored) {
  const gitHead = await readGitHead(rootPath);
  const globsKey = excludeGlobsKey();
  let files = await listWorkspaceFilesWithRg(rootPath, excludeGitIgnored);
  if (!files) files = await listWorkspaceFilesFallback(rootPath);
  files = files.filter((p) => !isExcludedPath(p));
  files.sort((a, b) => a.localeCompare(b));
  pathIndex.rootPath = rootPath;
  pathIndex.excludeGitIgnored = excludeGitIgnored;
  pathIndex.excludeGlobsKey = globsKey;
  pathIndex.gitHead = gitHead;
  pathIndex.files = files;
  pathIndex.folders = foldersFromFiles(files);
  pathIndex.dirty = false;
  return files.length;
}

/**
 * Cached workspace path list. Rebuilds when dirty, root changes, ignore mode
 * flips, or git HEAD (branch/checkout) differs from the indexed snapshot.
 * @returns {Promise<{ files: string[], folders: string[], rebuilt: boolean, count: number }>}
 */
async function getIndexedPaths(excludeGitIgnored = true) {
  const rootPath = getRootPath();
  if (!rootPath) return { files: [], folders: [], rebuilt: false, count: 0 };

  const gitHead = await readGitHead(rootPath);
  const globsKey = excludeGlobsKey();
  const needsRebuild =
    pathIndex.dirty ||
    pathIndex.rootPath !== rootPath ||
    pathIndex.excludeGitIgnored !== Boolean(excludeGitIgnored) ||
    pathIndex.excludeGlobsKey !== globsKey ||
    pathIndex.gitHead !== gitHead;

  if (!needsRebuild) {
    return {
      files: pathIndex.files,
      folders: pathIndex.folders,
      rebuilt: false,
      count: pathIndex.files.length
    };
  }

  if (pathIndex.buildPromise) {
    await pathIndex.buildPromise;
    if (
      !pathIndex.dirty &&
      pathIndex.rootPath === rootPath &&
      pathIndex.excludeGitIgnored === Boolean(excludeGitIgnored) &&
      pathIndex.excludeGlobsKey === globsKey &&
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

  pathIndex.buildPromise = rebuildPathIndex(rootPath, Boolean(excludeGitIgnored));
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
    pathIndex.folders = [];
    pathIndex.gitHead = "";
    pathIndex.dirty = true;
    return;
  }

  if (!INDEX_TOAST_REASONS.has(reason)) {
    await getIndexedPaths(true);
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
      const result = await getIndexedPaths(true);
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
  const onHead = () => invalidatePathIndex("git-head");
  watcher.onDidChange(onHead);
  watcher.onDidCreate(onHead);
  watcher.onDidDelete(onHead);
  gitHeadWatcher = watcher;
}

/**
 * Watch .git/HEAD + workspace folder changes so branch/folder switches refresh the index.
 * @param {vscode.ExtensionContext} context
 * @param {{ onInvalidate?: (reason: string) => void }=} hooks
 */
function initPathIndexWatchers(context, hooks) {
  pathIndex.onInvalidate = hooks?.onInvalidate || null;
  warmPathIndex("startup").catch(() => {});
  bindGitHeadWatcher();
  context.subscriptions.push({
    dispose: () => {
      if (gitHeadWatcher) {
        gitHeadWatcher.dispose();
        gitHeadWatcher = null;
      }
    }
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidatePathIndex("workspace");
      bindGitHeadWatcher();
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
  const { files } = await getIndexedPaths(options?.excludeGitIgnored !== false);
  const fuzzy = Boolean(options?.fuzzy);
  const needle = query.toLowerCase();
  /** @type {{item: SearchItem, s: number}[]} */
  const rows = [];
  for (const rel of files) {
    const base = path.posix.basename(rel).toLowerCase();
    const s = fuzzy ? fuzzyScore(base, needle) : base.includes(needle) ? 1 : -1;
    if (s < 0) continue;
    rows.push({
      item: {
        label: `$(file) ${path.posix.basename(rel)}`,
        description: rel,
        detail: "File",
        filePath: rel,
        lineNumber: 1,
        column: 1
      },
      s
    });
  }
  return rankFuzzy(rows, limit);
}

async function searchFolders(query, limit, options) {
  if (!query) return [];
  const { folders } = await getIndexedPaths(options?.excludeGitIgnored !== false);
  const fuzzy = Boolean(options?.fuzzy);
  const needle = query.toLowerCase();
  /** @type {{item: SearchItem, s: number}[]} */
  const rows = [];
  for (const dir of folders) {
    const s = fuzzy ? fuzzyScore(dir, needle) : dir.toLowerCase().includes(needle) ? 1 : -1;
    if (s < 0) continue;
    rows.push({
      item: {
        label: `$(folder) ${path.posix.basename(dir)}`,
        description: dir,
        detail: "Folder"
      },
      s
    });
  }
  return rankFuzzy(rows, limit);
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
  const searchIgnoreRegexes = opts.excludeSearchIgnored ? await readSearchIgnoreRegexes(rootPath) : [];
  const scoped = (arr) =>
    applyExcludeGlobs(applyScope(applySearchIgnore(arr, searchIgnoreRegexes), opts.scopePath));

  const handlers = {
    files: () => searchFiles(q, max, opts),
    folders: () => searchFolders(q, max, opts),
    text: () => search(q, opts),
    symbols: () => searchSymbols(q, max, opts),
    commands: () => searchCommands(q, max, opts)
  };
  return scoped(await (handlers[String(tab || "text")] || handlers.text)());
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
  const searchIgnoreRegexes = opts.excludeSearchIgnored ? await readSearchIgnoreRegexes(rootPath) : [];
  const accept = (item) => {
    const p = String(item.filePath || item.description || "").replaceAll("\\", "/");
    if (p && isExcludedPath(p)) return false;
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
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onBatch({ items, done: true, total: items.length, stopped: isCancelled() });
  return items;
}

function mergeUniqueResults(primary, secondary) {
  const out = [];
  const seen = new Set();
  for (const item of [...primary, ...secondary]) {
    const key = `${item.filePath || ""}:${item.lineNumber || 0}:${item.column || 0}:${item.detail || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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
  /** @type {Set<string>} */
  const matched = new Set();
  await scanFilesForMatches(rootPath, query, options, (filePath, lines) => {
    for (const line of lines) {
      if (lineMatchesFind(line, query, options)) {
        matched.add(filePath);
        break;
      }
    }
  });
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
  const searchIgnoreRegexes = opts.excludeSearchIgnored ? await readSearchIgnoreRegexes(rootPath) : [];
  let paths = await runRipgrep(rootPath, findTrim, opts, true);
  if (!paths?.length) paths = await fallbackListFilesContainingText(rootPath, findTrim, opts);
  return [...new Set(filterPathsForReplace(paths, searchIgnoreRegexes, opts.scopePath))];
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
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(rootPath, item.filePath)), { preserveFocus });
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const pos = new vscode.Position(Math.max(0, (item.lineNumber || 1) - 1), Math.max(0, (item.column || 1) - 1));
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
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
  invalidatePathIndex,
  warmPathIndex,
  initPathIndexWatchers
};
