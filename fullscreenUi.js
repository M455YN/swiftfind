const vscode = require("vscode");
const path = require("path");
const {
  searchByTabStreaming,
  openResult,
  createSearchController,
  previewReplace,
  replaceAllInScope,
  getConfig
} = require("./searchEngine");
const { isPolish } = require("./i18n");
const { markDirty } = require("./quickPickUi");
const { isModernUiEnabled, modernUiBodyClass, modernUiSharedCss } = require("./modernUi");

/** @type {vscode.WebviewPanel | null} */
let fullscreenPanel = null;
let searchSeq = 0;
/** @type {ReturnType<typeof createSearchController> | null} */
let activeSearchController = null;

function normalizePayload(payload) {
  if (typeof payload === "string") {
    return {
      query: payload,
      replace: "",
      showReplace: false,
      options: {
        matchCase: false,
        wholeWord: false,
        useRegex: false,
        fuzzy: false,
        excludeGitIgnored: true,
        excludeSearchIgnored: true,
        scopePath: ""
      }
    };
  }
  return {
    query: payload?.query || payload?.find || "",
    replace: String(payload?.replace ?? ""),
    showReplace: Boolean(payload?.showReplace),
    options: {
      matchCase: Boolean(payload?.options?.matchCase),
      wholeWord: Boolean(payload?.options?.wholeWord),
      useRegex: Boolean(payload?.options?.useRegex),
      fuzzy: Boolean(payload?.options?.fuzzy),
      excludeGitIgnored: payload?.options?.excludeGitIgnored !== false,
      excludeSearchIgnored: payload?.options?.excludeSearchIgnored !== false,
      scopePath: String(payload?.options?.scopePath || "")
    }
  };
}

function optionsFromMessage(msg) {
  return {
    matchCase: Boolean(msg.matchCase),
    wholeWord: Boolean(msg.wholeWord),
    useRegex: Boolean(msg.useRegex),
    fuzzy: Boolean(msg.fuzzy),
    excludeGitIgnored: Boolean(msg.excludeGitIgnored),
    excludeSearchIgnored: Boolean(msg.excludeSearchIgnored),
    scopePath: String(msg.scopePath || "")
  };
}

function openPayloadFromMessage(msg) {
  return {
    filePath: msg.filePath,
    lineNumber: Number(msg.lineNumber || 1),
    column: Number(msg.column || 1),
    matchLength: Number(msg.matchLength || 0)
  };
}

function wireFullscreenMessages(panel) {
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === "pauseSearch") {
      activeSearchController?.pause();
      return;
    }
    if (msg.type === "resumeSearch") {
      activeSearchController?.resume();
      return;
    }
    if (msg.type === "stopSearch") {
      activeSearchController?.cancel();
      return;
    }

    if (msg.type === "search") {
      const reqId = Number(msg.requestId || 0) || ++searchSeq;
      searchSeq = Math.max(searchSeq, reqId);
      activeSearchController?.cancel();
      const controller = createSearchController();
      activeSearchController = controller;
      const q = String(msg.query || "").trim();
      const tab = String(msg.tab || "text");
      panel.webview.postMessage({ type: "searchStarted", requestId: reqId, tab, query: q });
      try {
        const opts = optionsFromMessage(msg);
        await searchByTabStreaming(tab, q, opts, {
          controller,
          isCancelled: () =>
            reqId !== searchSeq || panel !== fullscreenPanel || controller.isCancelled(),
          onBatch: ({ items, done, total, stopped }) => {
            if (reqId !== searchSeq || panel !== fullscreenPanel) return;
            panel.webview.postMessage({
              type: done ? "results" : "resultsPartial",
              items,
              tab,
              requestId: reqId,
              query: q,
              total,
              done,
              stopped: Boolean(stopped)
            });
          }
        });
      } catch (error) {
        if (reqId !== searchSeq || panel !== fullscreenPanel) return;
        panel.webview.postMessage({
          type: "searchError",
          requestId: reqId,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (activeSearchController === controller) activeSearchController = null;
      }
      return;
    }

    if (msg.type === "select") {
      if (msg.commandId) return;
      await openResult(openPayloadFromMessage(msg), getConfig().preview);
      return;
    }

    if (msg.type === "open") {
      if (msg.commandId) {
        await vscode.commands.executeCommand(String(msg.commandId));
        return;
      }
      await openResult(openPayloadFromMessage(msg), false);
      return;
    }

    if (msg.type === "revealInExplorer") {
      const rel = String(msg.filePath || "");
      const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!root || !rel) return;
      const uri = vscode.Uri.file(path.join(root, rel));
      await vscode.commands.executeCommand("revealFileInOS", uri);
      return;
    }

    if (msg.type === "openSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "swiftFind");
      return;
    }

    if (msg.type === "pickScopeFolder") {
      const pl = isPolish();
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) {
        vscode.window.showWarningMessage(
          pl ? "SwiftFind: najpierw otwórz folder roboczy." : "SwiftFind: open a workspace folder first."
        );
        return;
      }
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: root.uri,
        openLabel: pl ? "Szukaj tutaj" : "Search here",
        title: pl ? "Wybierz folder wyszukiwania" : "Choose search folder"
      });
      if (!uris?.length) return;
      const pickedFs = uris[0].fsPath;
      const rootFs = root.uri.fsPath;
      if (path.resolve(pickedFs) === path.resolve(rootFs)) {
        panel.webview.postMessage({ type: "setScope", scopePath: "" });
        return;
      }
      const rel = path.relative(rootFs, pickedFs);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        vscode.window.showWarningMessage(
          pl
            ? "SwiftFind: folder musi być wewnątrz otwartego workspace."
            : "SwiftFind: folder must be inside the open workspace."
        );
        return;
      }
      panel.webview.postMessage({
        type: "setScope",
        scopePath: rel.replaceAll("\\", "/")
      });
      return;
    }

    if (msg.type === "previewReplace") {
      panel.webview.postMessage({ type: "replacePreviewStarted" });
      try {
        const r = await previewReplace(String(msg.find || ""), String(msg.replace || ""), optionsFromMessage(msg));
        panel.webview.postMessage({ type: "replacePreviewResult", ...r });
      } catch (error) {
        panel.webview.postMessage({
          type: "replacePreviewResult",
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (msg.type === "replaceAll") {
      const pl = isPolish();
      const findStr = String(msg.find || "").trim();
      const opts = optionsFromMessage(msg);
      const prev = await previewReplace(findStr, String(msg.replace || ""), { ...opts, lightPreview: true });
      if (!prev.ok) {
        panel.webview.postMessage({ type: "replaceResult", ok: false, message: prev.message || "" });
        return;
      }
      if (!prev.occurrences) {
        panel.webview.postMessage({
          type: "replaceResult",
          ok: true,
          changedFiles: 0,
          occurrences: 0,
          message: pl ? "Brak dopasowań." : "No matches."
        });
        return;
      }
      const yes = pl ? "Zamień" : "Replace";
      const no = pl ? "Anuluj" : "Cancel";
      const msgBody = pl
        ? `Zamienić ${prev.occurrences} wystąpień w ${prev.files} plikach?`
        : `Replace ${prev.occurrences} occurrence(s) in ${prev.files} file(s)?`;
      const choice = await vscode.window.showWarningMessage(msgBody, { modal: true }, yes, no);
      if (choice !== yes) {
        panel.webview.postMessage({ type: "replaceResult", ok: false, cancelled: true });
        return;
      }
      const r = await replaceAllInScope(findStr, String(msg.replace || ""), opts);
      if (r.ok && r.changedFiles) markDirty();
      panel.webview.postMessage({ type: "replaceResult", ...r });
    }
  });
}

async function moveFullscreenTabToFirst() {
  try {
    await vscode.commands.executeCommand("moveActiveEditor", { to: "first", by: "tab" });
  } catch {
    try {
      await vscode.commands.executeCommand("workbench.action.moveEditorToStart");
    } catch {
      // Older hosts may lack these commands.
    }
  }
}

/**
 * @param {{query?:string, find?:string, replace?:string, showReplace?:boolean, options?:Record<string, unknown>} | string | undefined} payload
 */
async function openFullscreenSearch(payload) {
  const { query, options, replace, showReplace } = normalizePayload(payload);
  const title = "SwiftFind";

  if (fullscreenPanel) {
    fullscreenPanel.title = title;
    fullscreenPanel.reveal(vscode.ViewColumn.Active, false);
    try {
      await vscode.commands.executeCommand("workbench.action.unpinEditor");
    } catch {
      // ignore
    }
    await moveFullscreenTabToFirst();
    fullscreenPanel.webview.postMessage({
      type: "hydrate",
      query,
      replace,
      showReplace,
      options,
      modernUi: isModernUiEnabled()
    });
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "swiftFindFullscreen",
    title,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  fullscreenPanel = panel;
  searchSeq = 0;
  activeSearchController = null;
  panel.webview.html = getHtml(query || "", options, { replace, showReplace });
  wireFullscreenMessages(panel);

  panel.onDidDispose(() => {
    if (fullscreenPanel === panel) {
      activeSearchController?.cancel();
      activeSearchController = null;
      fullscreenPanel = null;
      searchSeq = 0;
    }
  });

  setTimeout(() => {
    if (fullscreenPanel === panel) {
      void moveFullscreenTabToFirst();
    }
  }, 30);
}

function getHtml(initialQuery, initialOptions, extras = {}) {
  const initialReplace = String(extras.replace || "");
  const initialShowReplace = Boolean(extras.showReplace);
  const pl = isPolish();
  const L = {
    resultsTitle: "SwiftFind",
    files: pl ? "Pliki" : "Files",
    folders: pl ? "Foldery" : "Folders",
    text: pl ? "Tekst" : "Text",
    symbols: pl ? "Symbole" : "Symbols",
    commands: pl ? "Polecenia" : "Commands",
    search: pl ? "Szukaj" : "Search",
    query: pl ? "Szukaj w projekcie…" : "Search in project…",
    noResults: pl ? "Brak wyników" : "No results found",
    matchCase: pl ? "Uwzględniaj wielkość liter (Alt+C)" : "Match Case (Alt+C)",
    wholeWord: pl ? "Całe słowa (Alt+W)" : "Words (Alt+W)",
    regex: pl ? "Regex (Alt+R)" : "Regex (Alt+R)",
    fuzzy: pl ? "Fuzzy (Alt+F)" : "Fuzzy (Alt+F)",
    exclGit: pl ? "Pomiń Git ignored (Alt+G)" : "Exclude Git ignored (Alt+G)",
    exclSearch: pl ? "Pomiń .searchignore (Alt+S)" : "Exclude .searchignore (Alt+S)",
    results: pl ? "wyników" : "results",
    matches: pl ? "trafień" : "matches",
    match: pl ? "trafienie" : "match",
    scope: pl ? "Zakres" : "Directory",
    pickScope: pl ? "Folder…" : "Folder…",
    pickScopeTitle: pl ? "Wybierz folder wyszukiwania" : "Choose search folder",
    clearScope: pl ? "Wyczyść" : "Clear",
    findReplace: pl ? "Zamień" : "Replace",
    replaceWith: pl ? "Zamień na" : "Replace",
    replacePreview: pl ? "Podgląd zamiany" : "Preview replace",
    replaceAll: pl ? "Zamień wszystko" : "Replace All",
    searching: pl ? "Wyszukiwanie…" : "Searching…",
    replaceSearching: pl ? "Podgląd zamiany…" : "Building replace preview…",
    typeToSearch: pl ? "Wpisz frazę — wyniki pojawią się na żywo." : "Type to search — results update live.",
    typeThenEnter: pl ? "Wpisz frazę i naciśnij Enter." : "Type a query, then press Enter.",
    foundSoFar: pl ? "znaleziono" : "found",
    pause: pl ? "Wstrzymaj" : "Pause",
    resume: pl ? "Wznów" : "Resume",
    stop: pl ? "Zatrzymaj" : "Stop",
    paused: pl ? "Wstrzymane…" : "Paused…",
    stopped: pl ? "zatrzymano" : "stopped",
    expandAll: pl ? "Rozwiń wszystko" : "Expand all",
    collapseAll: pl ? "Zwiń wszystko" : "Collapse all",
    filesWord: pl ? "plików" : "files",
    occurrences: pl ? "wystąpień" : "occurrences",
    settings: pl ? "Ustawienia SwiftFind" : "SwiftFind Settings"
  };
  const searchOnType = getConfig().searchOnType !== false;
  const queryPlaceholder = searchOnType ? L.query : L.typeThenEnter;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root {
      --sf-border: var(--vscode-panel-border, rgba(127,127,127,.35));
      --sf-muted: color-mix(in srgb, var(--vscode-foreground) 58%, transparent);
      --sf-hit: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 179, 8, .42));
      --sf-hit-border: var(--vscode-editor-findMatchBorder, rgba(234, 179, 8, .75));
      --sf-gutter: color-mix(in srgb, var(--vscode-foreground) 42%, transparent);
      --sf-row-h: 22px;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .chrome {
      position: sticky;
      top: 0;
      z-index: 8;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--sf-border);
      padding: 8px 12px 0;
      display: grid;
      gap: 8px;
    }
    .chrome > .title-row { order: 0; }
    .chrome > .tabs { order: 1; }
    .chrome > .find-row { order: 2; }
    .chrome > .replace-row { order: 3; }
    .chrome > .toolbar { order: 4; }
    .chrome > .progress { order: 5; }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .title {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .02em;
      text-transform: none;
    }
    .title-right {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-left: auto;
    }
    .title-meta {
      font-size: 11px;
      color: var(--sf-muted);
      white-space: nowrap;
    }
    .icon-btn {
      appearance: none;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--sf-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.18));
      color: var(--vscode-foreground);
    }
    .icon-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .icon-btn svg {
      width: 16px;
      height: 16px;
      display: block;
    }
    .icon-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .icon-btn:disabled:hover {
      background: transparent;
      color: var(--sf-muted);
    }
    .icon-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .icon-btn.primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
      color: var(--vscode-button-foreground);
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0;
      border-bottom: 1px solid var(--sf-border);
      margin: 0 -12px;
      padding: 0 12px;
    }
    .tab {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--sf-muted);
      padding: 7px 11px 8px;
      margin: 0 0 -1px;
      border-radius: 0;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 400;
      line-height: 18px;
    }
    .tab:hover { color: var(--vscode-foreground); }
    .tab.active {
      color: var(--vscode-foreground);
      background: transparent;
      border-bottom-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
      font-weight: 600;
    }
    .tab:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .find-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
    }
    .find-field {
      display: flex;
      align-items: stretch;
      border: 1px solid var(--vscode-input-border, var(--sf-border));
      border-radius: 3px;
      background: var(--vscode-input-background);
      overflow: hidden;
      min-height: 28px;
    }
    .find-field:focus-within {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    #q, #replace {
      flex: 1;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      padding: 5px 10px;
      font: inherit;
      min-width: 0;
    }
    #q::placeholder, #replace::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .togs {
      display: flex;
      align-items: center;
      gap: 1px;
      padding: 2px 3px 2px 6px;
      border-left: 1px solid var(--sf-border);
    }
    .find-field-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .find-field-actions .icon-btn {
      width: 28px;
      height: 28px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .find-field-actions .icon-btn:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .find-field-actions .icon-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .find-field-actions .icon-btn.primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .tog {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 22px;
      border-radius: 3px;
      cursor: pointer;
      color: var(--sf-muted);
      user-select: none;
    }
    .tog input {
      position: absolute;
      opacity: 0;
      inset: 0;
      margin: 0;
      cursor: pointer;
    }
    .tog span {
      font-size: 11px;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family), Consolas, monospace;
      line-height: 1;
      pointer-events: none;
    }
    .tog:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.18)); color: var(--vscode-foreground); }
    .tog:has(input:checked) {
      background: var(--vscode-inputOption-activeBackground, color-mix(in srgb, var(--vscode-focusBorder) 28%, transparent));
      color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
      box-shadow: inset 0 0 0 1px var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
    }
    .find-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .btn {
      appearance: none;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 4px 9px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      min-height: 28px;
    }
    .btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-bottom: 8px;
      flex-wrap: wrap;
    }
    .toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .scope {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: min(520px, 70vw);
      font-size: 11px;
      color: var(--sf-muted);
      min-height: 22px;
    }
    .scope.has-path {
      padding: 2px 6px 2px 8px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--vscode-badge-background, #888) 22%, transparent);
      color: var(--vscode-foreground);
    }
    .scope #scopeInfo {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .linkish {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      padding: 0;
    }
    .linkish:hover { text-decoration: underline; }
    .progress {
      height: 2px;
      margin: 0 -12px;
      width: calc(100% + 24px);
      overflow: hidden;
      opacity: 0;
      transition: opacity .15s ease;
      background: transparent;
    }
    .progress.active { opacity: 1; }
    .progress.paused > span { animation-play-state: paused; opacity: .5; }
    .progress > span {
      display: block;
      height: 100%;
      width: 34%;
      background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      animation: sf-indeterminate 1.05s ease-in-out infinite;
    }
    @keyframes sf-indeterminate {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(320%); }
    }
    #summary {
      flex: 0 0 auto;
      padding: 6px 12px;
      font-size: 11px;
      color: var(--sf-muted);
      border-bottom: 1px solid var(--sf-border);
      background: var(--vscode-editor-background);
    }
    #summary.busy { color: var(--vscode-foreground); }
    #out {
      flex: 1 1 auto;
      overflow: auto;
      padding: 4px 0 18px;
    }
    .empty {
      padding: 28px 16px;
      text-align: center;
      color: var(--sf-muted);
      font-size: 12px;
    }
    .folder {
      margin: 0;
    }
    .folder-head {
      display: grid;
      grid-template-columns: 16px 1fr auto;
      gap: 6px;
      align-items: center;
      padding: 3px 12px 3px 8px;
      min-height: var(--sf-row-h);
      cursor: pointer;
      user-select: none;
      font-weight: 600;
    }
    .folder-head:hover { background: var(--vscode-list-hoverBackground); }
    .folder-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .folder > .folder-head .chev {
      transform: rotate(90deg);
    }
    .folder.collapsed > .folder-head .chev { transform: rotate(0deg); }
    .folder.collapsed > .folder-body { display: none; }
    .folder-body {
      margin: 0;
      padding-left: 12px;
      border-left: 1px solid color-mix(in srgb, var(--sf-border) 70%, transparent);
      margin-left: 14px;
    }
    .file {
      margin: 0;
    }
    .file-head {
      display: grid;
      grid-template-columns: 16px 1fr auto;
      gap: 6px;
      align-items: center;
      padding: 3px 12px 3px 4px;
      min-height: var(--sf-row-h);
      cursor: pointer;
      user-select: none;
    }
    .file-head:hover { background: var(--vscode-list-hoverBackground); }
    .chev {
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--sf-muted);
      font-size: 10px;
      transform: rotate(90deg);
      transition: transform .12s ease;
    }
    .file.collapsed .chev { transform: rotate(0deg); }
    .file.collapsed .file-body { display: none; }
    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      font-size: 12px;
    }
    .file-path {
      margin-left: 8px;
      font-weight: 400;
      color: var(--sf-muted);
      font-size: 11px;
    }
    .badge {
      font-size: 10px;
      min-width: 18px;
      text-align: center;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-variant-numeric: tabular-nums;
    }
    .match {
      display: grid;
      grid-template-columns: 54px 1fr;
      gap: 8px;
      align-items: baseline;
      padding: 1px 12px 1px 30px;
      min-height: var(--sf-row-h);
      cursor: pointer;
      border: 1px solid transparent;
    }
    .match:hover { background: var(--vscode-list-hoverBackground); }
    .match.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .match.selected .ln { color: inherit; opacity: .85; }
    .ln {
      font-family: var(--vscode-editor-font-family), Consolas, monospace;
      font-size: 11px;
      color: var(--sf-gutter);
      text-align: right;
      font-variant-numeric: tabular-nums;
      user-select: none;
    }
    .code {
      font-family: var(--vscode-editor-font-family), Consolas, monospace;
      font-size: 12px;
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .code mark {
      background: var(--sf-hit);
      color: inherit;
      border-radius: 2px;
      box-shadow: inset 0 0 0 1px var(--sf-hit-border);
      padding: 0 1px;
    }
    .code.after mark {
      background: var(--vscode-diffEditor-insertedTextBackground, rgba(34, 197, 94, .28));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #3fb950) 55%, transparent);
    }
    .code.after { opacity: .92; }
    .code-stack { min-width: 0; display: grid; gap: 2px; }
    .match.replace-match { align-items: start; padding-top: 3px; padding-bottom: 4px; }
    .match.replace-match .ln { padding-top: 2px; }
    .replace-row {
      display: none;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
    }
    body.replace-open .replace-row { display: grid; }
    body.replace-open #btnReplace { font-weight: 600; }
    .replace-actions { display: none; gap: 6px; align-items: center; }
    body.replace-open .replace-actions { display: inline-flex; }
    .row {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1px;
      padding: 4px 12px 4px 14px;
      cursor: pointer;
      border: 1px solid transparent;
      min-height: 28px;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .row .primary {
      font-weight: 600;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row .secondary {
      font-size: 11px;
      color: var(--sf-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row.selected .secondary { color: inherit; opacity: .85; }
    .section-label {
      padding: 8px 12px 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--sf-muted);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .ctx {
      position: fixed;
      z-index: 100;
      min-width: 190px;
      border: 1px solid var(--vscode-menu-border);
      background: var(--vscode-menu-background);
      color: var(--vscode-menu-foreground);
      border-radius: 4px;
      box-shadow: 0 8px 18px rgba(0,0,0,.28);
      overflow: hidden;
      display: none;
    }
    .ctx button {
      width: 100%;
      text-align: left;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: inherit;
      padding: 7px 10px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .ctx button:hover { background: var(--vscode-list-hoverBackground); }
    @media (max-width: 720px) {
      .find-row, .replace-row { grid-template-columns: 1fr; }
      .find-actions, .find-field-actions { justify-content: flex-end; }
    }
    ${modernUiSharedCss()}
    body.modern-ui {
      background: var(--vscode-surface-background, var(--vscode-editor-background));
      --sf-row-h: 26px;
    }
    body.modern-ui .chrome {
      padding: var(--sf-pad-y, 12px) var(--sf-pad-x, 16px) var(--vscode-spacing-size80, 8px);
      gap: var(--vscode-spacing-size100, 10px);
      background: transparent;
      border-bottom: var(--sf-stroke, 1px) solid var(--sf-border);
    }
    body.modern-ui .chrome > .find-row { order: 1; }
    body.modern-ui .chrome > .tabs { order: 2; }
    body.modern-ui .title {
      font-size: 13px;
      letter-spacing: 0;
    }
    body.modern-ui .tabs {
      gap: 6px;
      border-bottom: 0;
      margin: 0;
      padding: 0;
    }
    body.modern-ui .tab {
      background: var(--vscode-tab-inactiveBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
      color: var(--vscode-tab-inactiveForeground, var(--sf-muted));
      border-bottom: 0;
      margin: 0;
      padding: 5px 12px;
      border-radius: var(--sf-r-surface, 8px);
      font-size: 13px;
    }
    body.modern-ui .tab:hover {
      color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
      background: var(--vscode-tab-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 12%, transparent));
    }
    body.modern-ui .tab.active {
      color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
      background: var(--vscode-tab-activeBackground, color-mix(in srgb, var(--vscode-foreground) 14%, transparent));
      border-bottom: 0;
      font-weight: 500;
    }
    body.modern-ui .find-row {
      display: flex;
      align-items: center;
      gap: 0;
      border: var(--sf-stroke, 1px) solid var(--sf-border);
      border-radius: var(--sf-r-surface, 8px);
      background: var(--vscode-input-background);
      min-height: 32px;
      padding-right: 4px;
    }
    body.modern-ui .find-field {
      flex: 1;
      min-width: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      overflow: visible;
      min-height: 32px;
      outline: none;
    }
    body.modern-ui .find-field:focus-within {
      border-color: transparent;
      outline: none;
    }
    body.modern-ui .find-row:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    body.modern-ui #q,
    body.modern-ui #replace {
      padding: 7px 12px;
    }
    body.modern-ui .togs {
      border-left: 0;
      gap: 0;
      padding: 0 2px;
    }
    body.modern-ui .find-field-actions {
      gap: 0;
      padding-right: 2px;
    }
    body.modern-ui .find-field-actions .icon-btn {
      width: 24px;
      height: 24px;
      border: 0;
      background: transparent;
      color: var(--sf-muted);
    }
    body.modern-ui .find-field-actions .icon-btn:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.18));
      color: var(--vscode-foreground);
    }
    body.modern-ui .find-field-actions .icon-btn.primary {
      background: transparent;
      color: var(--sf-muted);
    }
    body.modern-ui .find-field-actions .icon-btn.primary:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.18));
      color: var(--vscode-foreground);
    }
    body.modern-ui .replace-row .find-field {
      border: var(--sf-stroke, 1px) solid var(--sf-border);
      border-radius: var(--sf-r-surface, 8px);
      background: var(--vscode-input-background);
      min-height: 32px;
    }
    body.modern-ui .btn {
      border-radius: var(--sf-r-ctrl, 4px);
      padding: 5px 12px;
    }
    body.modern-ui .toolbar { gap: var(--sf-gap, 8px); padding-top: 2px; }
    body.modern-ui .badge {
      border-radius: var(--sf-r-badge, 9999px);
      min-width: 20px;
      padding: 2px 7px;
    }
    body.modern-ui .hit { border-radius: var(--vscode-cornerRadius-xSmall, 2px); }
    body.modern-ui .ctx {
      border-radius: var(--sf-r-surface, 8px);
      border-color: var(--sf-border);
      box-shadow: 0 12px 28px rgba(0,0,0,.28);
    }
    body.modern-ui #summary {
      padding: var(--vscode-spacing-size80, 8px) var(--sf-pad-x, 16px);
      background: transparent;
    }
    body.modern-ui #out {
      padding: var(--vscode-spacing-size40, 4px) var(--vscode-spacing-size80, 8px) var(--vscode-spacing-size200, 20px);
    }
    body.modern-ui .folder-head,
    body.modern-ui .file-head,
    body.modern-ui .match,
    body.modern-ui .row {
      border-radius: var(--sf-row-radius, 6px);
      margin: 0 2px;
    }
    body.modern-ui .folder-head,
    body.modern-ui .file-head {
      padding: 4px 10px 4px 8px;
      min-height: 28px;
    }
    body.modern-ui .match,
    body.modern-ui .row {
      padding-top: 3px;
      padding-bottom: 3px;
      padding-right: 10px;
      min-height: var(--sf-row-h);
    }
    body.modern-ui .folder-body {
      margin-left: 4px;
      padding-left: 4px;
    }
    body.modern-ui .progress {
      height: 3px;
      border-radius: var(--sf-r-badge, 9999px);
      overflow: hidden;
    }
  </style>
</head>
<body class="${[initialShowReplace ? "replace-open" : "", modernUiBodyClass()].filter(Boolean).join(" ")}">
  <div class="chrome">
    <div class="title-row">
      <div class="title">${L.resultsTitle}</div>
      <div class="title-right">
        <div class="title-meta" id="titleMeta"></div>
        <button type="button" class="icon-btn" id="btnSettings" title="${L.settings}" aria-label="${L.settings}">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M9.1 4.4 9.4 3H6.6l.3 1.4-.9.5-.9-1.1-1.4.8.5 1.3-1.2.1V9.5l1.2.1-.5 1.3 1.4.8.9-1.1.9.5-.3 1.4h2.8l-.3-1.4.9-.5.9 1.1 1.4-.8-.5-1.3 1.2-.1V6.5l-1.2-.1.5-1.3-1.4-.8-.9 1.1-.9-.5zM8 9.5A1.5 1.5 0 1 1 8 6.5a1.5 1.5 0 0 1 0 3z"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="find-row">
      <div class="find-field">
        <input id="q" placeholder="${queryPlaceholder}" value="${escapeHtml(initialQuery)}" spellcheck="false" autocomplete="off" />
        <div class="togs" aria-label="options">
          <label class="tog" title="${L.matchCase}"><input id="matchCase" type="checkbox" ${initialOptions.matchCase ? "checked" : ""} /><span>Aa</span></label>
          <label class="tog" title="${L.wholeWord}"><input id="wholeWord" type="checkbox" ${initialOptions.wholeWord ? "checked" : ""} /><span>W</span></label>
          <label class="tog" title="${L.regex}"><input id="useRegex" type="checkbox" ${initialOptions.useRegex ? "checked" : ""} /><span>.*</span></label>
          <label class="tog" title="${L.fuzzy}"><input id="fuzzy" type="checkbox" ${initialOptions.fuzzy ? "checked" : ""} /><span>~</span></label>
          <label class="tog" title="${L.exclGit}"><input id="excludeGitIgnored" type="checkbox" ${initialOptions.excludeGitIgnored ? "checked" : ""} /><span>G</span></label>
          <label class="tog" title="${L.exclSearch}"><input id="excludeSearchIgnored" type="checkbox" ${initialOptions.excludeSearchIgnored ? "checked" : ""} /><span>S</span></label>
        </div>
      </div>
      <div class="find-field-actions">
        <button class="icon-btn primary" id="go" type="button" title="${L.search}" aria-label="${L.search}">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10.8 9.9h-.6l-.2-.2a4.4 4.4 0 1 0-.5.5l.2.2v.6l3.4 3.4.9-.9-3.2-3.4zm-4 0A3.1 3.1 0 1 1 9.9 6.8 3.1 3.1 0 0 1 6.8 9.9z"/></svg>
        </button>
        <button class="icon-btn" id="btnPause" type="button" title="${L.pause}" aria-label="${L.pause}" disabled>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.5h2.2v11H4.5zm4.8 0h2.2v11H9.3z"/></svg>
        </button>
        <button class="icon-btn" id="btnStop" type="button" title="${L.stop}" aria-label="${L.stop}" disabled>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.5 3.5h9v9h-9z"/></svg>
        </button>
      </div>
    </div>
    <div class="tabs" id="tabs" role="tablist">
      <button class="tab" data-tab="files" role="tab">${L.files}</button>
      <button class="tab" data-tab="folders" role="tab">${L.folders}</button>
      <button class="tab active" data-tab="text" role="tab">${L.text}</button>
      <button class="tab" data-tab="symbols" role="tab">${L.symbols}</button>
      <button class="tab" data-tab="commands" role="tab">${L.commands}</button>
    </div>
    <div class="replace-row">
      <div class="find-field">
        <input id="replace" placeholder="${L.replaceWith}" value="${escapeHtml(initialReplace)}" spellcheck="false" autocomplete="off" />
      </div>
      <div class="find-actions">
        <button class="btn" id="btnReplacePreview" type="button">${L.replacePreview}</button>
        <button class="btn primary" id="btnReplaceAll" type="button">${L.replaceAll}</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="toolbar-left">
        <button type="button" id="btnReplace" class="btn">${L.findReplace}</button>
        <button type="button" id="btnExpand" class="btn">${L.expandAll}</button>
        <button type="button" id="btnCollapse" class="btn">${L.collapseAll}</button>
        <button type="button" id="btnPickScope" class="btn" title="${L.pickScopeTitle}">${L.pickScope}</button>
        <div class="scope" id="scopeWrap"><span id="scopeInfo"></span><button type="button" id="clearScope" class="linkish" hidden>${L.clearScope}</button></div>
      </div>
    </div>
    <div class="progress" id="progress" aria-hidden="true"><span></span></div>
  </div>
  <div id="summary"></div>
  <div id="out"></div>
  <div id="ctx" class="ctx"><button id="ctxReveal">${pl ? "Pokaż w Eksploratorze Windows" : "Show in Windows Explorer"}</button></div>
  <script>
    const vscode = acquireVsCodeApi();
    const q = document.getElementById("q");
    const go = document.getElementById("go");
    const btnPause = document.getElementById("btnPause");
    const btnStop = document.getElementById("btnStop");
    const btnExpand = document.getElementById("btnExpand");
    const btnCollapse = document.getElementById("btnCollapse");
    const btnReplace = document.getElementById("btnReplace");
    const btnReplacePreview = document.getElementById("btnReplacePreview");
    const btnReplaceAll = document.getElementById("btnReplaceAll");
    const replaceEl = document.getElementById("replace");
    const out = document.getElementById("out");
    const summary = document.getElementById("summary");
    const titleMeta = document.getElementById("titleMeta");
    const progress = document.getElementById("progress");
    const ctx = document.getElementById("ctx");
    const ctxReveal = document.getElementById("ctxReveal");
    const tabsWrap = document.getElementById("tabs");
    const matchCase = document.getElementById("matchCase");
    const wholeWord = document.getElementById("wholeWord");
    const useRegex = document.getElementById("useRegex");
    const fuzzy = document.getElementById("fuzzy");
    const excludeGitIgnored = document.getElementById("excludeGitIgnored");
    const excludeSearchIgnored = document.getElementById("excludeSearchIgnored");
    const scopeInfo = document.getElementById("scopeInfo");
    const scopeWrap = document.getElementById("scopeWrap");
    const clearScopeBtn = document.getElementById("clearScope");
    const btnPickScope = document.getElementById("btnPickScope");
    let scopePath = ${JSON.stringify(initialOptions.scopePath || "")};
    let activeTab = "text";
    const tabOrder = ["files","folders","text","symbols","commands"];
    let ctxItem = null;
    let lastSelectedKey = "";
    let debounceTimer = null;
    let requestId = 0;
    let activeRequestId = 0;
    let searching = false;
    let paused = false;
    let replaceOpen = ${initialShowReplace ? "true" : "false"};
    /** @type {"search"|"replacePreview"} */
    let viewMode = "search";
    let lastSearchItems = [];
    let lastSearchTab = "text";
    let searchOnType = ${searchOnType ? "true" : "false"};
    const collapsedFiles = new Set();
    /** Expanded folder paths. Empty ⇒ all folders collapsed (only top-level names visible). */
    const expandedFolders = new Set();

    function emptyHintText() {
      return searchOnType ? "${L.typeToSearch}" : "${L.typeThenEnter}";
    }

    function refreshQueryPlaceholder() {
      q.placeholder = searchOnType ? "${L.query}" : "${L.typeThenEnter}";
    }

    function setReplaceOpen(on) {
      replaceOpen = !!on;
      document.body.classList.toggle("replace-open", replaceOpen);
      if (!replaceOpen && viewMode === "replacePreview") {
        viewMode = "search";
        if (lastSearchItems.length) render(lastSearchItems, lastSearchTab, { partial: false, stopped: false });
      }
    }

    function itemKey(it) {
      if (!it) return "";
      if (it.commandId) return "cmd:" + it.commandId;
      const fp = String(it.filePath || "");
      if (!fp) return "";
      return fp + ":" + Number(it.lineNumber || 0) + ":" + Number(it.column || 1);
    }

    function searchOptionsPayload() {
      return {
        matchCase: !!matchCase.checked,
        wholeWord: !!wholeWord.checked,
        useRegex: !!useRegex.checked,
        fuzzy: !!fuzzy.checked,
        excludeGitIgnored: !!excludeGitIgnored.checked,
        excludeSearchIgnored: !!excludeSearchIgnored.checked,
        scopePath
      };
    }

    const iconPause = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.5h2.2v11H4.5zm4.8 0h2.2v11H9.3z"/></svg>';
    const iconResume = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5L4 2.5z"/></svg>';

    function updateControlButtons() {
      btnPause.disabled = !searching;
      btnStop.disabled = !searching;
      const pauseLabel = paused ? "${L.resume}" : "${L.pause}";
      btnPause.title = pauseLabel;
      btnPause.setAttribute("aria-label", pauseLabel);
      btnPause.innerHTML = paused ? iconResume : iconPause;
      progress.classList.toggle("paused", searching && paused);
    }

    function setBusy(on, label) {
      searching = !!on;
      if (!searching) paused = false;
      progress.classList.toggle("active", searching);
      progress.setAttribute("aria-hidden", searching ? "false" : "true");
      summary.classList.toggle("busy", searching);
      if (searching) {
        summary.textContent = label || (paused ? "${L.paused}" : "${L.searching}");
        titleMeta.textContent = paused ? "${L.paused}" : "${L.searching}";
      }
      updateControlButtons();
    }

    function applySelectionToRows() {
      if (!lastSelectedKey) return;
      for (const row of out.querySelectorAll(".match, .row")) {
        row.classList.toggle("selected", row.dataset.key === lastSelectedKey);
      }
      const sel = out.querySelector(".match.selected, .row.selected");
      if (sel) sel.scrollIntoView({ block: "nearest" });
    }

    function refreshScopeInfo() {
      if (scopePath) {
        scopeInfo.textContent = "${L.scope}: " + scopePath;
        scopeWrap.classList.add("has-path");
        clearScopeBtn.hidden = false;
      } else {
        scopeInfo.textContent = "";
        scopeWrap.classList.remove("has-path");
        clearScopeBtn.hidden = true;
      }
    }

    function run(immediate) {
      const query = q.value.trim();
      if (!query) {
        if (debounceTimer) clearTimeout(debounceTimer);
        setBusy(false);
        out.innerHTML = '<div class="empty">' + emptyHintText() + '</div>';
        summary.textContent = "";
        titleMeta.textContent = "";
        return;
      }
      const launch = () => {
        refreshScopeInfo();
        viewMode = "search";
        activeRequestId = ++requestId;
        paused = false;
        collapsedFiles.clear();
        expandedFolders.clear();
        setBusy(true, "${L.searching}");
        vscode.postMessage({
          type: "search",
          requestId: activeRequestId,
          query,
          tab: activeTab,
          ...searchOptionsPayload()
        });
      };
      if (immediate) {
        if (debounceTimer) clearTimeout(debounceTimer);
        launch();
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(launch, 160);
    }

    go.addEventListener("click", () => run(true));
    btnPause.addEventListener("click", () => {
      if (!searching) return;
      if (paused) {
        paused = false;
        updateControlButtons();
        summary.textContent = "${L.searching}";
        titleMeta.textContent = "${L.searching}";
        vscode.postMessage({ type: "resumeSearch" });
      } else {
        paused = true;
        updateControlButtons();
        summary.textContent = "${L.paused}";
        titleMeta.textContent = "${L.paused}";
        vscode.postMessage({ type: "pauseSearch" });
      }
    });
    btnStop.addEventListener("click", () => {
      if (!searching) return;
      vscode.postMessage({ type: "stopSearch" });
      // Invalidate in-flight batches immediately so late partials cannot resurrect "searching".
      activeRequestId = ++requestId;
      paused = false;
      setBusy(false);
      render(lastSearchItems, lastSearchTab, { partial: false, stopped: true });
    });
    btnExpand.addEventListener("click", () => {
      collapsedFiles.clear();
      for (const el of out.querySelectorAll(".folder")) {
        const key = el.dataset.folder || "";
        if (key) expandedFolders.add(key);
        el.classList.remove("collapsed");
      }
      for (const el of out.querySelectorAll(".file")) el.classList.remove("collapsed");
    });
    btnCollapse.addEventListener("click", () => {
      expandedFolders.clear();
      for (const el of out.querySelectorAll(".folder")) el.classList.add("collapsed");
      for (const el of out.querySelectorAll(".file")) {
        const key = el.dataset.file || "";
        if (key) collapsedFiles.add(key);
        el.classList.add("collapsed");
      }
    });
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") run(true); });
    q.addEventListener("input", () => {
      if (!searchOnType) {
        if (debounceTimer) clearTimeout(debounceTimer);
        return;
      }
      run(false);
    });
    for (const el of [matchCase, wholeWord, useRegex, fuzzy, excludeGitIgnored, excludeSearchIgnored]) {
      el.addEventListener("change", () => run(true));
    }
    clearScopeBtn.addEventListener("click", () => {
      scopePath = "";
      refreshScopeInfo();
      if (q.value.trim()) run(true);
    });
    btnPickScope.addEventListener("click", () => {
      vscode.postMessage({ type: "pickScopeFolder" });
    });

    document.getElementById("btnReplace").addEventListener("click", () => {
      setReplaceOpen(!replaceOpen);
      if (replaceOpen) replaceEl.focus();
    });
    document.getElementById("btnSettings").addEventListener("click", () => {
      vscode.postMessage({ type: "openSettings" });
    });
    btnReplacePreview.addEventListener("click", () => {
      const find = q.value.trim();
      if (!find) return;
      setReplaceOpen(true);
      setBusy(true, "${L.replaceSearching}");
      vscode.postMessage({
        type: "previewReplace",
        find,
        replace: replaceEl.value,
        ...searchOptionsPayload()
      });
    });
    btnReplaceAll.addEventListener("click", () => {
      const find = q.value.trim();
      if (!find) return;
      setReplaceOpen(true);
      vscode.postMessage({
        type: "replaceAll",
        find,
        replace: replaceEl.value,
        ...searchOptionsPayload()
      });
    });
    replaceEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") btnReplacePreview.click();
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === "config") {
        searchOnType = msg.searchOnType !== false;
        if (typeof msg.modernUi === "boolean") {
          document.body.classList.toggle("modern-ui", msg.modernUi);
        }
        refreshQueryPlaceholder();
        if (!q.value.trim()) {
          out.innerHTML = '<div class="empty">' + emptyHintText() + '</div>';
        }
        return;
      }

      if (msg.type === "setScope") {
        scopePath = String(msg.scopePath || "");
        refreshScopeInfo();
        if (q.value.trim()) run(true);
        return;
      }

      if (msg.type === "hydrate") {
        if (typeof msg.modernUi === "boolean") {
          document.body.classList.toggle("modern-ui", msg.modernUi);
        }
        const opts = msg.options || {};
        q.value = String(msg.query || "");
        replaceEl.value = String(msg.replace || "");
        setReplaceOpen(!!msg.showReplace);
        matchCase.checked = !!opts.matchCase;
        wholeWord.checked = !!opts.wholeWord;
        useRegex.checked = !!opts.useRegex;
        fuzzy.checked = !!opts.fuzzy;
        excludeGitIgnored.checked = opts.excludeGitIgnored !== false;
        excludeSearchIgnored.checked = opts.excludeSearchIgnored !== false;
        scopePath = String(opts.scopePath || "");
        refreshScopeInfo();
        if (q.value.trim()) run(true);
        else {
          out.innerHTML = '<div class="empty">' + emptyHintText() + '</div>';
          summary.textContent = "";
          titleMeta.textContent = "";
          setBusy(false);
          q.focus();
        }
        if (replaceOpen) replaceEl.focus();
        return;
      }

      if (msg.type === "replacePreviewStarted") {
        setBusy(true, "${L.replaceSearching}");
        return;
      }
      if (msg.type === "replacePreviewResult") {
        setBusy(false);
        if (!msg.ok) {
          summary.textContent = msg.message || "Error";
          titleMeta.textContent = "";
          out.innerHTML = '<div class="empty">' + esc(msg.message || "Error") + "</div>";
          return;
        }
        viewMode = "replacePreview";
        summary.textContent = msg.files + " ${L.filesWord}, " + msg.occurrences + " ${L.occurrences}";
        titleMeta.textContent = msg.occurrences ? (msg.occurrences + " ${L.occurrences}") : "${L.noResults}";
        renderReplaceSamples(msg.samples || []);
        return;
      }
      if (msg.type === "replaceResult") {
        setBusy(false);
        if (msg.cancelled) {
          summary.textContent = ${pl ? '"Anulowano."' : '"Cancelled."'};
          return;
        }
        if (!msg.ok) {
          summary.textContent = msg.message || "Error";
          return;
        }
        summary.textContent = ${pl
          ? '"Zamieniono: " + msg.occurrences + " w " + msg.changedFiles + " plikach."'
          : '"Replaced " + msg.occurrences + " in " + msg.changedFiles + " file(s)."'};
        titleMeta.textContent = "";
        if (msg.occurrences) run(true);
        return;
      }

      if (msg.requestId && Number(msg.requestId) !== activeRequestId) return;

      if (msg.type === "searchStarted") {
        paused = false;
        viewMode = "search";
        setBusy(true, "${L.searching}");
        out.innerHTML = "";
        return;
      }
      if (msg.type === "searchError") {
        setBusy(false);
        summary.textContent = msg.message || "Error";
        titleMeta.textContent = "";
        return;
      }
      if (msg.type === "resultsPartial") {
        if (viewMode !== "search") return;
        const items = Array.isArray(msg.items) ? msg.items : [];
        lastSearchItems = items;
        lastSearchTab = msg.tab || activeTab;
        if (!paused) setBusy(true, "${L.searching}");
        requestAnimationFrame(() => {
          if (Number(msg.requestId) !== activeRequestId || viewMode !== "search") return;
          render(items, msg.tab || activeTab, { partial: true, stopped: false });
        });
        return;
      }
      if (msg.type !== "results") return;
      if (viewMode !== "search") return;
      const items = Array.isArray(msg.items) ? msg.items : [];
      lastSearchItems = items;
      lastSearchTab = msg.tab || activeTab;
      const stopped = !!msg.stopped;
      setBusy(false);
      requestAnimationFrame(() => {
        if (msg.requestId && Number(msg.requestId) !== activeRequestId) return;
        if (viewMode !== "search") return;
        render(items, msg.tab || activeTab, { partial: false, stopped });
      });
    });

    function stripIcon(label) {
      return String(label || "").replace(/^\\$\\([^)]+\\)\\s*/, "");
    }

    function splitPath(fp) {
      const p = String(fp || "").replaceAll("\\\\", "/");
      const i = p.lastIndexOf("/");
      if (i < 0) return { name: p || "?", dir: "" };
      return { name: p.slice(i + 1), dir: p.slice(0, i) };
    }

    function highlightLine(detail, query, column) {
      const line = String(detail || "");
      const needle = String(query || "");
      if (!line) return { html: "", start: 0, length: 0 };
      if (!needle) return { html: esc(line), start: 0, length: 0 };
      let start = Math.max(0, Number(column || 1) - 1);
      let len = needle.length;
      if (useRegex.checked) {
        try {
          const flags = matchCase.checked ? "g" : "gi";
          const re = new RegExp(needle, flags);
          const m = re.exec(line);
          if (m) {
            start = m.index;
            len = m[0].length;
          }
        } catch (_) {
          // keep column-based slice
        }
      } else if (start >= line.length || line.substr(start, len).toLowerCase() !== needle.toLowerCase()) {
        const hay = matchCase.checked ? line : line.toLowerCase();
        const n = matchCase.checked ? needle : needle.toLowerCase();
        const at = hay.indexOf(n);
        if (at >= 0) start = at;
      }
      len = Math.max(1, Math.min(len, line.length - start));
      const before = esc(line.slice(0, start));
      const mid = esc(line.slice(start, start + len));
      const after = esc(line.slice(start + len));
      return { html: before + "<mark>" + mid + "</mark>" + after, start, length: len };
    }

    function highlightSpan(line, column, matchLength) {
      const src = String(line || "");
      const start = Math.max(0, Number(column || 1) - 1);
      const len = Math.max(1, Number(matchLength) || 1);
      const end = Math.min(src.length, start + len);
      return esc(src.slice(0, start)) + "<mark>" + esc(src.slice(start, end)) + "</mark>" + esc(src.slice(end));
    }

    function matchLengthFor(it) {
      const hit = highlightLine(it.detail, q.value.trim(), it.column);
      return hit.length || 0;
    }

    function renderReplaceSamples(samples) {
      out.innerHTML = "";
      if (!samples || !samples.length) {
        out.innerHTML = '<div class="empty">${L.noResults}</div>';
        return;
      }
      for (const file of samples) {
        const fp = String(file.filePath || "").replaceAll("\\\\", "/");
        const { name, dir } = splitPath(fp);
        const root = document.createElement("div");
        root.className = "file";
        root.dataset.file = fp;
        if (collapsedFiles.has(fp)) root.classList.add("collapsed");

        const head = document.createElement("div");
        head.className = "file-head";
        const count = Number(file.count || (file.previews || []).length || 0);
        const countLabel = count === 1 ? "${L.match}" : "${L.matches}";
        head.innerHTML =
          '<span class="chev">▸</span>' +
          '<div class="file-name">' + esc(name) +
            (dir ? '<span class="file-path">' + esc(dir) + '</span>' : '') +
          '</div>' +
          '<span class="badge" title="' + count + ' ' + countLabel + '">' + count + '</span>';
        head.addEventListener("click", () => {
          const next = !root.classList.contains("collapsed");
          root.classList.toggle("collapsed", next);
          if (next) collapsedFiles.add(fp);
          else collapsedFiles.delete(fp);
        });

        const body = document.createElement("div");
        body.className = "file-body";
        for (const p of file.previews || []) {
          const row = document.createElement("div");
          row.className = "match replace-match";
          const beforeLen = Number(p.matchLength || 0);
          const afterLen = Math.max(
            1,
            String(p.after || "").length - (String(p.before || "").length - beforeLen)
          );
          row.innerHTML =
            '<div class="ln">' + esc(String(p.lineNumber || "")) + '</div>' +
            '<div class="code-stack">' +
              '<div class="code">' + highlightSpan(p.before, p.column, beforeLen) + '</div>' +
              '<div class="code after">' + highlightSpan(p.after, p.column, afterLen) + '</div>' +
            '</div>';
          row.addEventListener("click", () => {
            for (const r of out.querySelectorAll(".match, .row")) r.classList.remove("selected");
            row.classList.add("selected");
            vscode.postMessage({
              type: "select",
              filePath: fp,
              lineNumber: p.lineNumber,
              column: p.column,
              matchLength: beforeLen
            });
          });
          row.addEventListener("dblclick", () => {
            vscode.postMessage({
              type: "open",
              filePath: fp,
              lineNumber: p.lineNumber,
              column: p.column,
              matchLength: beforeLen
            });
          });
          body.appendChild(row);
        }

        root.appendChild(head);
        root.appendChild(body);
        out.appendChild(root);
      }
    }

    function markSelected(it) {
      lastSelectedKey = itemKey(it);
      for (const r of out.querySelectorAll(".match, .row")) r.classList.remove("selected");
      const el = out.querySelector('[data-key="' + CSS.escape(itemKey(it)) + '"]');
      if (el) el.classList.add("selected");
    }

    function previewItem(it) {
      markSelected(it);
      const matchLength = matchLengthFor(it);
      vscode.postMessage({
        type: "select",
        tab: activeTab,
        query: q.value.trim(),
        filePath: it.filePath,
        lineNumber: it.lineNumber,
        column: it.column,
        commandId: it.commandId,
        matchLength,
        ...searchOptionsPayload()
      });
    }

    function openItem(it) {
      markSelected(it);
      const matchLength = matchLengthFor(it);
      vscode.postMessage({
        type: "open",
        filePath: it.filePath,
        lineNumber: it.lineNumber,
        column: it.column,
        commandId: it.commandId,
        matchLength
      });
    }

    function bindContext(el, it) {
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!it.filePath) return;
        ctxItem = it;
        ctx.style.left = e.clientX + "px";
        ctx.style.top = e.clientY + "px";
        ctx.style.display = "block";
      });
    }

    function matchRow(it) {
      const row = document.createElement("div");
      row.className = "match";
      row.dataset.key = itemKey(it);
      const hit = highlightLine(it.detail, q.value.trim(), it.column);
      row.innerHTML =
        '<div class="ln">' + esc(String(it.lineNumber || "")) + '</div>' +
        '<div class="code">' + hit.html + '</div>';
      row.addEventListener("click", () => previewItem(it));
      row.addEventListener("dblclick", () => openItem(it));
      bindContext(row, it);
      return row;
    }

    function fileGroup(filePath, matches) {
      const { name } = splitPath(filePath);
      const root = document.createElement("div");
      root.className = "file";
      root.dataset.file = filePath;
      if (collapsedFiles.has(filePath)) root.classList.add("collapsed");

      const head = document.createElement("div");
      head.className = "file-head";
      const count = matches.length;
      const countLabel = count === 1 ? "${L.match}" : "${L.matches}";
      head.innerHTML =
        '<span class="chev">▸</span>' +
        '<div class="file-name">' + esc(name) + '</div>' +
        '<span class="badge" title="' + count + ' ' + countLabel + '">' + count + '</span>';
      head.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = !root.classList.contains("collapsed");
        root.classList.toggle("collapsed", next);
        if (next) collapsedFiles.add(filePath);
        else collapsedFiles.delete(filePath);
      });
      head.addEventListener("dblclick", () => {
        if (matches[0]) openItem(matches[0]);
      });
      bindContext(head, matches[0] || { filePath });

      const body = document.createElement("div");
      body.className = "file-body";
      for (const it of matches) body.appendChild(matchRow(it));

      root.appendChild(head);
      root.appendChild(body);
      return root;
    }

    /**
     * Nested path tree: project → folder → file → matches
     */
    function createDirNode(name, pathKey) {
      return {
        name,
        path: pathKey,
        dirs: new Map(),
        files: new Map(),
        matchCount: 0,
        fileCount: 0
      };
    }

    function buildPathTree(items) {
      const root = createDirNode("", "");
      for (const it of items) {
        if (!it.filePath) continue;
        const fp = String(it.filePath).replaceAll("\\\\", "/").replace(/^\\/+/, "");
        const parts = fp.split("/").filter(Boolean);
        if (!parts.length) continue;
        let node = root;
        for (let i = 0; i < parts.length - 1; i += 1) {
          const seg = parts[i];
          const nextPath = node.path ? node.path + "/" + seg : seg;
          if (!node.dirs.has(seg)) node.dirs.set(seg, createDirNode(seg, nextPath));
          node = node.dirs.get(seg);
        }
        const fileName = parts[parts.length - 1];
        const fullPath = fp;
        if (!node.files.has(fullPath)) node.files.set(fullPath, []);
        node.files.get(fullPath).push(it);
      }
      function tally(node) {
        let matches = 0;
        let files = node.files.size;
        for (const list of node.files.values()) matches += list.length;
        for (const child of node.dirs.values()) {
          const t = tally(child);
          matches += t.matches;
          files += t.files;
        }
        node.matchCount = matches;
        node.fileCount = files;
        return { matches, files };
      }
      tally(root);
      return root;
    }

    function renderDirNode(node) {
      const root = document.createElement("div");
      root.className = "folder";
      root.dataset.folder = node.path;
      const isExpanded = expandedFolders.has(node.path);
      if (!isExpanded) root.classList.add("collapsed");

      const head = document.createElement("div");
      head.className = "folder-head";
      const countLabel = node.matchCount === 1 ? "${L.match}" : "${L.matches}";
      head.innerHTML =
        '<span class="chev">▸</span>' +
        '<div class="folder-name">' + esc(node.name) +
          '<span class="file-path">' + node.fileCount + " · " + node.matchCount + " " + countLabel + "</span>" +
        "</div>" +
        '<span class="badge">' + node.matchCount + "</span>";
      head.addEventListener("click", (e) => {
        e.stopPropagation();
        const willCollapse = !root.classList.contains("collapsed");
        root.classList.toggle("collapsed", willCollapse);
        if (willCollapse) expandedFolders.delete(node.path);
        else expandedFolders.add(node.path);
      });

      const body = document.createElement("div");
      body.className = "folder-body";
      const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
      for (const name of dirNames) body.appendChild(renderDirNode(node.dirs.get(name)));
      const filePaths = [...node.files.keys()].sort((a, b) => a.localeCompare(b));
      for (const fp of filePaths) body.appendChild(fileGroup(fp, node.files.get(fp)));

      root.appendChild(head);
      root.appendChild(body);
      return root;
    }

    function listRow(it) {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.key = itemKey(it);
      const primary = stripIcon(it.label) || it.filePath || it.description || "";
      const secondary = it.description || it.filePath || it.detail || "";
      row.innerHTML =
        '<div class="primary">' + esc(primary) + '</div>' +
        (secondary && secondary !== primary ? '<div class="secondary">' + esc(secondary) + '</div>' : '');
      row.addEventListener("click", () => previewItem(it));
      row.addEventListener("dblclick", () => openItem(it));
      bindContext(row, it);
      return row;
    }

    function setStatus(items, tab, opts) {
      const partial = !!(opts && opts.partial);
      const stopped = !!(opts && opts.stopped);
      const tabNames = {
        files: "${L.files}",
        folders: "${L.folders}",
        text: "${L.text}",
        symbols: "${L.symbols}",
        commands: "${L.commands}"
      };
      const tabName = tabNames[tab] || tab;
      const scopePart = scopePath ? " · ${L.scope}: " + scopePath : "";
      let text;
      if (partial) {
        text = paused
          ? (tabName + ": ${L.foundSoFar} " + items.length + " — ${L.paused}" + scopePart)
          : (tabName + ": ${L.foundSoFar} " + items.length + "…" + scopePart);
      } else if (stopped) {
        text = tabName + ": " + items.length + " ${L.results} (${L.stopped})" + scopePart;
      } else {
        text = tabName + ": " + items.length + " ${L.results}" + scopePart;
      }
      summary.textContent = text;
      if (!searching) titleMeta.textContent = items.length ? (items.length + " ${L.results}") : "";
    }

    function render(items, tab, opts) {
      const partial = !!(opts && opts.partial);
      out.innerHTML = "";
      setStatus(items, tab, opts);
      if (!items.length) {
        if (!partial) out.innerHTML = '<div class="empty">${L.noResults}</div>';
        return;
      }

      if (tab === "text") {
        const tree = buildPathTree(items);
        const topDirs = [...tree.dirs.keys()].sort((a, b) => a.localeCompare(b));
        for (const name of topDirs) out.appendChild(renderDirNode(tree.dirs.get(name)));
        // Files at workspace root (no folder prefix)
        const rootFiles = [...tree.files.keys()].sort((a, b) => a.localeCompare(b));
        for (const fp of rootFiles) out.appendChild(fileGroup(fp, tree.files.get(fp)));
        applySelectionToRows();
        return;
      }

      const label = document.createElement("div");
      label.className = "section-label";
      label.textContent = tab;
      out.appendChild(label);
      for (const it of items) out.appendChild(listRow(it));
      applySelectionToRows();
    }

    tabsWrap.addEventListener("click", (e) => {
      const b = e.target.closest(".tab");
      if (!b) return;
      activeTab = b.getAttribute("data-tab");
      for (const x of tabsWrap.querySelectorAll(".tab")) x.classList.remove("active");
      b.classList.add("active");
      run(true);
    });

    ctxReveal.addEventListener("click", () => {
      if (!ctxItem || !ctxItem.filePath) return;
      vscode.postMessage({ type: "revealInExplorer", filePath: ctxItem.filePath });
      ctx.style.display = "none";
    });
    window.addEventListener("click", () => { ctx.style.display = "none"; });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") ctx.style.display = "none";
      if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const idx = tabOrder.indexOf(activeTab);
        const next = e.shiftKey ? (idx - 1 + tabOrder.length) % tabOrder.length : (idx + 1) % tabOrder.length;
        const target = tabOrder[next];
        const btn = tabsWrap.querySelector('[data-tab="' + target + '"]');
        if (btn) btn.click();
        return;
      }
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const k = String(e.key || "").toLowerCase();
        const map = { c: matchCase, w: wholeWord, r: useRegex, f: fuzzy, g: excludeGitIgnored, s: excludeSearchIgnored };
        if (map[k]) { map[k].checked = !map[k].checked; run(true); }
      }
    });

    function esc(s){
      return String(s)
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;");
    }
    refreshScopeInfo();
    refreshQueryPlaceholder();
    out.innerHTML = '<div class="empty">' + emptyHintText() + '</div>';
    summary.textContent = "";
    if (replaceOpen) replaceEl.focus();
    if (q.value.trim()) run(true);
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

module.exports = {
  openFullscreenSearch,
  pushFullscreenConfig() {
    if (!fullscreenPanel) return;
    fullscreenPanel.webview.postMessage({
      type: "config",
      searchOnType: getConfig().searchOnType !== false,
      modernUi: isModernUiEnabled()
    });
  }
};

