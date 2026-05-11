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
 * }} SearchItem
 */

function getRootPath() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
}

function getConfig() {
  const c = vscode.workspace.getConfiguration("swiftFind");
  const configured = c.get("maxResults", 2000);
  return {
    // Keep results high by default; small values hide too much data.
    maxResults: Math.max(500, Number(configured) || 2000),
    caseInsensitive: c.get("caseInsensitive", true),
    preview: c.get("preview", true)
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

function quoteArg(arg) {
  if (process.platform === "win32") {
    return `"${String(arg).replace(/"/g, '\\"')}"`;
  }
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

/**
 * @param {string} line
 * @param {string} rootPath
 * @returns {SearchItem | undefined}
 */
function parseFindstrLine(line, rootPath) {
  const m = line.match(/^(.*?):(\d+):(.*)$/);
  if (!m) {
    return undefined;
  }
  const filePath = normalizeRelPath(m[1], rootPath);
  const lineNumber = Number(m[2]);
  const text = m[3].trim();
  return {
    label: `${path.basename(filePath)} : ${lineNumber}`,
    description: filePath,
    detail: text,
    filePath,
    lineNumber,
    column: 1
  };
}

/**
 * @param {string} line
 * @param {string} rootPath
 * @returns {SearchItem | undefined}
 */
function parseRipgrepLine(line, rootPath) {
  const m = line.match(/^(.*?):(\d+):(\d+):(.*)$/);
  if (!m) {
    return undefined;
  }
  const filePath = normalizeRelPath(m[1], rootPath);
  return {
    label: `${path.basename(filePath)} : ${Number(m[2])}`,
    description: filePath,
    detail: m[4].trim(),
    filePath,
    lineNumber: Number(m[2]),
    column: Number(m[3])
  };
}

function fuzzyScore(text, pattern) {
  if (!pattern) return 0;
  const t = String(text || "").toLowerCase();
  const p = String(pattern || "").toLowerCase();
  let j = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && j < p.length; i += 1) {
    if (t[i] === p[j]) {
      j += 1;
      streak += 1;
      score += 2 + streak;
    } else {
      streak = 0;
    }
  }
  return j === p.length ? score : -1;
}

function toRegExpFromGlob(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const rx = esc.replace(/\*\*/g, "###DOUBLE_STAR###").replace(/\*/g, "[^/]*").replace(/###DOUBLE_STAR###/g, ".*");
  return new RegExp(`^${rx}$`, "i");
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

/**
 * @param {SearchItem[]} items
 * @param {RegExp[]} ignoreRegexes
 */
function applySearchIgnore(items, ignoreRegexes) {
  if (!ignoreRegexes.length) return items;
  return items.filter((it) => {
    const p = String(it.filePath || it.description || "").replaceAll("\\", "/");
    if (!p) return true;
    return !ignoreRegexes.some((r) => r.test(p));
  });
}

/**
 * @param {SearchItem[]} items
 * @param {string | undefined} scopePath
 */
function applyScope(items, scopePath) {
  const scope = normalizeScopePath(scopePath);
  if (!scope) return items;
  return items.filter((it) => {
    const p = String(it.filePath || it.description || "").replaceAll("\\", "/");
    if (!p) {
      // Commands etc.
      return false;
    }
    if (p === scope) return true;
    return p.startsWith(scope.endsWith("/") ? scope : scope + "/");
  });
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

async function getBundledRipgrepPath() {
  const exeName = process.platform === "win32" ? "rg.exe" : "rg";
  const appRoot = vscode.env.appRoot;
  if (!appRoot) {
    return null;
  }
  const candidates = [
    path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exeName),
    path.join(appRoot, "node_modules", "@vscode", "ripgrep", "bin", exeName)
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

/**
 * @param {string} rootPath
 * @param {string} query
 * @param {{maxResults:number, caseInsensitive:boolean}} cfg
 * @param {{matchCase?:boolean, wholeWord?:boolean, useRegex?:boolean}} options
 * @returns {Promise<SearchItem[] | null>}
 */
function searchWithBundledRg(rootPath, query, cfg, options) {
  return new Promise(async (resolve) => {
    const rgPath = await getBundledRipgrepPath();
    if (!rgPath) {
      resolve(null);
      return;
    }

    const scopedTarget = normalizeScopePath(options?.scopePath) || ".";
    const args = [
      options?.matchCase ? "" : "-i",
      "--no-heading",
      "--line-number",
      "--column",
      "--color",
      "never",
      options?.wholeWord ? "-w" : "",
      options?.useRegex ? "" : "-F",
      options?.excludeGitIgnored ? "" : "--no-ignore-vcs",
      "--max-filesize",
      "2M",
      query,
      scopedTarget
    ].filter(Boolean);

    const child = childProcess.spawn(rgPath, args, {
      cwd: rootPath,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 32 * 1024 * 1024) {
        child.kill();
      }
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
      const items = lines
        .map((line) => parseRipgrepLine(line, rootPath))
        .filter(Boolean)
        .slice(0, cfg.maxResults);
      if (!items.length && stderr) {
        resolve(null);
        return;
      }
      resolve(items);
    });
  });
}

/**
 * @param {string} rootPath
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<SearchItem[]>}
 */
function fallbackSearch(rootPath, query, maxResults, options) {
  return new Promise((resolve) => {
    const scope = normalizeScopePath(options?.scopePath);
    const include = new vscode.RelativePattern(
      rootPath,
      scope ? (scope.includes(".") ? scope : `${scope}/**/*`) : "**/*"
    );
    const exclude = new vscode.RelativePattern(
      rootPath,
      "**/{node_modules,.git,dist,build,out,.next,.cache,.venv,venv}/**"
    );
    const matchCase = Boolean(options?.matchCase);
    const wholeWord = Boolean(options?.wholeWord);
    const useRegex = Boolean(options?.useRegex);
    const needle = matchCase ? query : query.toLowerCase();
    const regex = buildRegex(query, { matchCase, wholeWord, useRegex });

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
                const leftOk = !/[a-zA-Z0-9_]/.test(left);
                const rightOk = !/[a-zA-Z0-9_]/.test(right);
                if (!(leftOk && rightOk)) {
                  at = -1;
                }
              }
            }
            if (at < 0) continue;
            out.push({
              label: `${path.basename(filePath)} : ${i + 1}`,
              description: filePath,
              detail: lines[i].trim(),
              filePath,
              lineNumber: i + 1,
              column: at + 1
            });
          }
        }
        resolve(out);
      })
      .catch(() => resolve([]));
  });
}

/**
 * @param {string} text
 * @param {{matchCase?:boolean, wholeWord?:boolean, useRegex?:boolean}=} options
 * @returns {Promise<SearchItem[]>}
 */
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
    const opts = { ...getDefaultSearchOptions(), ...(options || {}) };
    const q = text.trim();

    searchWithBundledRg(rootPath, q, cfg, opts).then((rgItems) => {
      if (rgItems && rgItems.length) {
        resolve(rgItems);
        return;
      }

      if (process.platform !== "win32") {
        resolve([{ label: t("No results found", "Brak wynikow"), alwaysShow: true }]);
        return;
      }

      const caseOpt = opts.matchCase ? "" : "/I";
      const safeQuery = q.replace(/"/g, '""');
      const findstrPattern = buildFindstrPattern(safeQuery, opts);
      const command = [
        "cmd /d /s /c",
        quoteArg(`findstr ${caseOpt} /S /N ${opts.useRegex || opts.wholeWord ? "/R" : ""} /C:"${findstrPattern}" *`)
      ].join(" ");

      childProcess.exec(
        command,
        { cwd: rootPath, maxBuffer: 32 * 1024 * 1024, timeout: 30000 },
        (err, stdout, stderr) => {
          const timeoutHit = Boolean(err && err.killed);
          if (timeoutHit) {
            fallbackSearch(rootPath, q, cfg.maxResults, opts).then((items) => {
              resolve(items.length ? items : [{ label: t("Search timeout (narrow query)", "Przekroczono czas wyszukiwania (zawęź frazę)"), alwaysShow: true }]);
            });
            return;
          }

          if (err && err.code !== 1) {
            fallbackSearch(rootPath, q, cfg.maxResults, opts)
              .then((items) => {
                if (items.length) {
                  resolve(items);
                  return;
                }
                reject(new Error(`findstr failed (${err.code}). ${stderr || "Unknown error."}`));
              })
              .catch(() => reject(new Error(`findstr failed (${err.code}). ${stderr || "Unknown error."}`)));
            return;
          }

          const lines = String(stdout)
            .split(/\r?\n/)
            .filter(Boolean);
          const items = lines.map((line) => parseFindstrLine(line, rootPath)).filter(Boolean);
          if (items.length) {
            fallbackSearch(rootPath, q, cfg.maxResults, opts).then((fallbackItems) => {
              const merged = mergeUniqueResults(items, fallbackItems);
              resolve(merged.slice(0, cfg.maxResults));
            });
            return;
          }

          fallbackSearch(rootPath, q, cfg.maxResults, opts).then((fallbackItems) => {
            resolve(fallbackItems.length ? fallbackItems : [{ label: t("No results found", "Brak wynikow"), alwaysShow: true }]);
          });
        }
      );
    });
  });
}

/**
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<SearchItem[]>}
 */
async function searchFiles(query, limit) {
  const rootPath = getRootPath();
  if (!rootPath || !query) return [];
  const include = new vscode.RelativePattern(rootPath, "**/*");
  const exclude = new vscode.RelativePattern(
    rootPath,
    "**/{node_modules,.git,dist,build,out,.next,.cache,.venv,venv}/**"
  );
  const uris = await vscode.workspace.findFiles(include, exclude, Math.max(limit * 25, 3000));
  const needle = query.toLowerCase();
  const fuzzy = Boolean(arguments[2]?.fuzzy);
  /** @type {{item: SearchItem, s: number}[]} */
  const rows = [];
  for (const uri of uris) {
    const rel = normalizeRelPath(uri.fsPath, rootPath);
    const base = path.posix.basename(rel).toLowerCase();
    const s = fuzzy ? fuzzyScore(base, needle) : (base.includes(needle) ? 1 : -1);
    if (s < 0) continue;
    rows.push({ item: {
      label: `$(file) ${path.posix.basename(rel)}`,
      description: rel,
      detail: "File",
      filePath: rel,
      lineNumber: 1,
      column: 1
    }, s });
  }
  rows.sort((a, b) => b.s - a.s);
  return rows.slice(0, limit).map((r) => r.item);
}

/**
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<SearchItem[]>}
 */
async function searchFolders(query, limit) {
  const rootPath = getRootPath();
  if (!rootPath || !query) return [];
  const include = new vscode.RelativePattern(rootPath, "**/*");
  const exclude = new vscode.RelativePattern(
    rootPath,
    "**/{node_modules,.git,dist,build,out,.next,.cache,.venv,venv}/**"
  );
  const uris = await vscode.workspace.findFiles(include, exclude, Math.max(limit * 30, 5000));
  const needle = query.toLowerCase();
  const dirs = new Set();
  for (const uri of uris) {
    const rel = normalizeRelPath(uri.fsPath, rootPath);
    const dir = path.posix.dirname(rel);
    if (dir && dir !== ".") dirs.add(dir);
  }
  const fuzzy = Boolean(arguments[2]?.fuzzy);
  /** @type {{item: SearchItem, s: number}[]} */
  const rows = [];
  for (const dir of [...dirs].sort((a, b) => a.localeCompare(b))) {
    const s = fuzzy ? fuzzyScore(dir, needle) : (dir.toLowerCase().includes(needle) ? 1 : -1);
    if (s < 0) continue;
    rows.push({ item: {
      label: `$(folder) ${path.posix.basename(dir)}`,
      description: dir,
      detail: "Folder"
    }, s });
  }
  rows.sort((a, b) => b.s - a.s);
  return rows.slice(0, limit).map((r) => r.item);
}

/**
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<SearchItem[]>}
 */
async function searchSymbols(query, limit) {
  if (!query) return [];
  /** @type {any[]} */
  const symbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query);
  if (!Array.isArray(symbols)) return [];
  /** @type {SearchItem[]} */
  const out = [];
  const fuzzy = Boolean(arguments[2]?.fuzzy);
  const filtered = fuzzy
    ? symbols
        .map((s) => ({ s, score: fuzzyScore(`${s?.name || ""} ${s?.containerName || ""}`, query) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.s)
    : symbols;
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

/**
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<SearchItem[]>}
 */
async function searchCommands(query, limit) {
  const cmds = await vscode.commands.getCommands(true);
  const needle = String(query || "").toLowerCase();
  const fuzzy = Boolean(arguments[2]?.fuzzy);
  const filtered = (fuzzy
    ? cmds
        .map((c) => ({ c, score: fuzzyScore(c, needle) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c)
    : cmds.filter((c) => c.toLowerCase().includes(needle))).slice(0, limit);
  return filtered.map((cmd) => ({
    label: `$(terminal) ${cmd}`,
    detail: "Command",
    commandId: cmd
  }));
}

/**
 * @param {"files"|"folders"|"text"|"symbols"|"commands"} tab
 * @param {string} query
 * @param {{matchCase?:boolean, wholeWord?:boolean, useRegex?:boolean}=} options
 */
async function searchByTab(tab, query, options) {
  const normalizedTab = String(tab || "text");
  const q = String(query || "").trim();
  if (!q) {
    return [];
  }
  const max = Math.max(100, Math.min(getConfig().maxResults, 2500));

  const opts = { ...getDefaultSearchOptions(), ...(options || {}) };
  opts.scopePath = normalizeScopePath(opts.scopePath);
  const rootPath = getRootPath();
  const searchIgnoreRegexes = opts.excludeSearchIgnored ? await readSearchIgnoreRegexes(rootPath) : [];
  const scoped = (arr) => applyScope(applySearchIgnore(arr, searchIgnoreRegexes), opts.scopePath);

  if (normalizedTab === "files") return scoped(await searchFiles(q, max, opts));
  if (normalizedTab === "folders") return scoped(await searchFolders(q, max, opts));
  if (normalizedTab === "text") return scoped(await search(q, opts));
  if (normalizedTab === "symbols") return scoped(await searchSymbols(q, max, opts));
  if (normalizedTab === "commands") return scoped(await searchCommands(q, max, opts));

  return scoped(await search(q, opts));
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(query, options) {
  try {
    const source = options.useRegex ? query : escapeRegex(query);
    const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
    return new RegExp(bounded, options.matchCase ? "" : "i");
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

/**
 * @param {SearchItem[]} primary
 * @param {SearchItem[]} secondary
 * @returns {SearchItem[]}
 */
function mergeUniqueResults(primary, secondary) {
  const out = [];
  const seen = new Set();
  for (const item of [...primary, ...secondary]) {
    const key = `${item.filePath || ""}:${item.lineNumber || 0}:${item.column || 0}:${item.detail || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * @param {string} src
 * @param {string} query
 * @param {{matchCase?:boolean, wholeWord?:boolean, useRegex?:boolean}} options
 */
function lineMatchesFind(src, query, options) {
  const regex = buildRegex(query, {
    matchCase: Boolean(options.matchCase),
    wholeWord: Boolean(options.wholeWord),
    useRegex: Boolean(options.useRegex)
  });
  if (!regex) return false;
  return Boolean(regex.exec(src));
}

/**
 * @param {string} query
 * @param {{matchCase?:boolean, wholeWord?:boolean, useRegex?:boolean}} options
 */
function buildReplaceRegex(query, options) {
  try {
    const source = options.useRegex ? query : escapeRegex(query);
    const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
    return new RegExp(bounded, `${options.matchCase ? "" : "i"}g`);
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @param {string} findQuery
 * @param {string} replaceStr
 * @param {{matchCase?:boolean, wholeWord?:boolean, useRegex?:boolean}} options
 */
function replaceInString(text, findQuery, replaceStr, options) {
  const re = buildReplaceRegex(findQuery, options);
  if (!re) {
    return { newText: text, count: 0, error: "invalid_pattern" };
  }
  const matches = text.match(re);
  const count = matches ? matches.length : 0;
  if (!count) {
    return { newText: text, count: 0 };
  }
  const newText = text.replace(re, replaceStr ?? "");
  return { newText, count };
}

/**
 * @param {string} rootPath
 * @param {string} query
 * @param {Record<string, unknown>} options
 * @returns {Promise<string[] | null>}
 */
function rgListFilesWithMatches(rootPath, query, options) {
  return new Promise(async (resolve) => {
    const rgPath = await getBundledRipgrepPath();
    if (!rgPath) {
      resolve(null);
      return;
    }
    const scopedTarget = normalizeScopePath(options?.scopePath) || ".";
    const args = [
      options?.matchCase ? "" : "-i",
      "-l",
      "--color",
      "never",
      options?.wholeWord ? "-w" : "",
      options?.useRegex ? "" : "-F",
      options?.excludeGitIgnored ? "" : "--no-ignore-vcs",
      "--max-filesize",
      "2M",
      query,
      scopedTarget
    ].filter(Boolean);

    const child = childProcess.spawn(rgPath, args, {
      cwd: rootPath,
      windowsHide: true
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 32 * 1024 * 1024) {
        child.kill();
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        resolve(null);
        return;
      }
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const files = lines
        .map((line) => normalizeRelPath(line.trim(), rootPath))
        .filter(Boolean);
      resolve(files);
    });
  });
}

/**
 * @param {string} rootPath
 * @param {string} query
 * @param {Record<string, unknown>} options
 * @returns {Promise<string[]>}
 */
async function fallbackListFilesContainingText(rootPath, query, options) {
  const scope = normalizeScopePath(options?.scopePath);
  const include = new vscode.RelativePattern(
    rootPath,
    scope ? (scope.includes(".") ? scope : `${scope}/**/*`) : "**/*"
  );
  const exclude = new vscode.RelativePattern(
    rootPath,
    "**/{node_modules,.git,dist,build,out,.next,.cache,.venv,venv}/**"
  );
  const uris = await vscode.workspace.findFiles(include, exclude, 5000);
  /** @type {Set<string>} */
  const matched = new Set();
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
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (lineMatchesFind(line, query, options)) {
        matched.add(filePath);
        break;
      }
    }
  }
  return [...matched];
}

/**
 * @param {string[]} paths
 * @param {RegExp[]} ignoreRegexes
 * @param {string | undefined} scopePath
 */
function filterPathsForReplace(paths, ignoreRegexes, scopePath) {
  const scope = normalizeScopePath(scopePath);
  let out = paths.map((p) => p.replaceAll("\\", "/"));
  if (ignoreRegexes.length) {
    out = out.filter((p) => !ignoreRegexes.some((r) => r.test(p)));
  }
  if (scope) {
    out = out.filter((p) => {
      if (p === scope) return true;
      return p.startsWith(scope.endsWith("/") ? scope : `${scope}/`);
    });
  }
  return out;
}

/**
 * @param {string} findQuery
 * @param {Record<string, unknown>} options
 * @returns {Promise<string[]>}
 */
async function listFilesContainingText(findQuery, options) {
  const rootPath = getRootPath();
  if (!rootPath || !String(findQuery).trim()) {
    return [];
  }
  const opts = { ...getDefaultSearchOptions(), ...(options || {}) };
  opts.scopePath = normalizeScopePath(opts.scopePath);
  const searchIgnoreRegexes = opts.excludeSearchIgnored ? await readSearchIgnoreRegexes(rootPath) : [];

  let paths = await rgListFilesWithMatches(rootPath, String(findQuery).trim(), opts);
  if (!paths || !paths.length) {
    paths = await fallbackListFilesContainingText(rootPath, String(findQuery).trim(), opts);
  }
  const filtered = filterPathsForReplace(paths, searchIgnoreRegexes, opts.scopePath);
  return [...new Set(filtered)];
}

/**
 * @param {string} find
 * @param {string} replace
 * @param {Record<string, unknown>} options
 */
async function previewReplace(find, replace, options) {
  const rootPath = getRootPath();
  if (!rootPath) {
    return { ok: false, message: t("Open a workspace folder first.", "Najpierw otworz folder roboczy.") };
  }
  const opts = { ...getDefaultSearchOptions(), ...(options || {}) };
  if (opts.fuzzy) {
    return {
      ok: false,
      message: t("Replace does not support fuzzy mode. Turn off fuzzy.", "Zamiana nie obsluguje trybu fuzzy. Wylacz fuzzy.")
    };
  }
  const findTrim = String(find || "").trim();
  if (!findTrim) {
    return { ok: false, message: t("Find text is empty.", "Pusty tekst do znalezienia.") };
  }
  const testRe = buildReplaceRegex(findTrim, opts);
  if (!testRe) {
    return { ok: false, message: t("Invalid find pattern.", "Nieprawidlowy wzor wyszukiwania.") };
  }

  const paths = await listFilesContainingText(findTrim, opts);
  const unique = [...new Set(paths)];
  let occurrences = 0;
  let filesWithHits = 0;
  for (const rel of unique) {
    const abs = path.join(rootPath, rel);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      const text = doc.getText();
      const { count } = replaceInString(text, findTrim, String(replace ?? ""), opts);
      if (count > 0) {
        occurrences += count;
        filesWithHits += 1;
      }
    } catch {
      // Skip unreadable files.
    }
  }
  return { ok: true, files: filesWithHits, occurrences };
}

/**
 * @param {string} find
 * @param {string} replace
 * @param {Record<string, unknown>} options
 */
async function replaceAllInScope(find, replace, options) {
  const rootPath = getRootPath();
  if (!rootPath) {
    return { ok: false, message: t("Open a workspace folder first.", "Najpierw otworz folder roboczy.") };
  }
  const opts = { ...getDefaultSearchOptions(), ...(options || {}) };
  if (opts.fuzzy) {
    return {
      ok: false,
      message: t("Replace does not support fuzzy mode.", "Zamiana nie obsluguje trybu fuzzy.")
    };
  }
  const findTrim = String(find || "").trim();
  if (!findTrim) {
    return { ok: false, message: t("Find text is empty.", "Pusty tekst do znalezienia.") };
  }
  const testRe = buildReplaceRegex(findTrim, opts);
  if (!testRe) {
    return { ok: false, message: t("Invalid find pattern.", "Nieprawidlowy wzor wyszukiwania.") };
  }

  const paths = await listFilesContainingText(findTrim, opts);
  const unique = [...new Set(paths)];
  const edit = new vscode.WorkspaceEdit();
  let changedFiles = 0;
  let occurrences = 0;
  const replaceStr = String(replace ?? "");

  for (const rel of unique) {
    const uri = vscode.Uri.file(path.join(rootPath, rel));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const { newText, count } = replaceInString(text, findTrim, replaceStr, opts);
      if (!count) continue;
      occurrences += count;
      const endPos = doc.positionAt(text.length);
      edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), endPos), newText);
      changedFiles += 1;
    } catch {
      // Skip unreadable files.
    }
  }

  if (changedFiles === 0) {
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
  const fileUri = vscode.Uri.file(path.join(rootPath, item.filePath));
  await vscode.window.showTextDocument(fileUri, { preserveFocus });
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const line = Math.max(0, (item.lineNumber || 1) - 1);
  const col = Math.max(0, (item.column || 1) - 1);
  const pos = new vscode.Position(line, col);
  const range = new vscode.Range(pos, pos);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

module.exports = {
  getConfig,
  search,
  openResult,
  searchByTab,
  previewReplace,
  replaceAllInScope
};
