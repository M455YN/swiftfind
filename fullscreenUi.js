const vscode = require("vscode");
const path = require("path");
const { searchByTabStreaming, openResult, createSearchController } = require("./searchEngine");
const { isPolish } = require("./i18n");
const { openReplacePanel } = require("./replaceUi");
const { setLastSelection } = require("./uiSelectionState");
const { getSidebarProvider } = require("./sidebarView");

/** @type {vscode.WebviewPanel | null} */
let fullscreenPanel = null;
let searchSeq = 0;
/** @type {ReturnType<typeof createSearchController> | null} */
let activeSearchController = null;

function normalizePayload(payload) {
  if (typeof payload === "string") {
    return {
      query: payload,
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
    query: payload?.query || "",
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
        const opts = {
          matchCase: Boolean(msg.matchCase),
          wholeWord: Boolean(msg.wholeWord),
          useRegex: Boolean(msg.useRegex),
          fuzzy: Boolean(msg.fuzzy),
          excludeGitIgnored: Boolean(msg.excludeGitIgnored),
          excludeSearchIgnored: Boolean(msg.excludeSearchIgnored),
          scopePath: String(msg.scopePath || "")
        };
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
      setLastSelection({
        tab: String(msg.tab || "text"),
        query: String(msg.query || ""),
        options: {
          matchCase: Boolean(msg.matchCase),
          wholeWord: Boolean(msg.wholeWord),
          useRegex: Boolean(msg.useRegex),
          fuzzy: Boolean(msg.fuzzy),
          excludeGitIgnored: Boolean(msg.excludeGitIgnored),
          excludeSearchIgnored: Boolean(msg.excludeSearchIgnored),
          scopePath: String(msg.scopePath || "")
        },
        item: {
          filePath: msg.filePath,
          lineNumber: Number(msg.lineNumber || 0),
          column: Number(msg.column || 1),
          commandId: msg.commandId
        }
      });
      getSidebarProvider()?.pushSelectionHighlight();
      return;
    }

    if (msg.type === "open") {
      if (msg.commandId) {
        await vscode.commands.executeCommand(String(msg.commandId));
        return;
      }
      await openResult(
        {
          filePath: msg.filePath,
          lineNumber: Number(msg.lineNumber || 1),
          column: Number(msg.column || 1)
        },
        false
      );
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

    if (msg.type === "openReplace") {
      openReplacePanel({
        find: String(msg.find || ""),
        replace: String(msg.replace || ""),
        options: {
          matchCase: Boolean(msg.matchCase),
          wholeWord: Boolean(msg.wholeWord),
          useRegex: Boolean(msg.useRegex),
          fuzzy: Boolean(msg.fuzzy),
          excludeGitIgnored: Boolean(msg.excludeGitIgnored),
          excludeSearchIgnored: Boolean(msg.excludeSearchIgnored),
          scopePath: String(msg.scopePath || "")
        }
      });
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
 * @param {{query?:string, options?:{matchCase?:boolean, wholeWord?:boolean, useRegex?:boolean}} | string | undefined} payload
 */
async function openFullscreenSearch(payload) {
  const { query, options } = normalizePayload(payload);
  const title = isPolish() ? "Wyniki SwiftFind" : "SwiftFind Results";

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
      options
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
  panel.webview.html = getHtml(query || "", options);
  wireFullscreenMessages(panel);

  panel.onDidDispose(() => {
    if (fullscreenPanel === panel) {
      activeSearchController?.cancel();
      activeSearchController = null;
      fullscreenPanel = null;
      searchSeq = 0;
    }
  });

  // Let the editor tab register, then park it as the first tab in the group.
  setTimeout(() => {
    if (fullscreenPanel === panel) {
      void moveFullscreenTabToFirst();
    }
  }, 30);
}

function getHtml(initialQuery, initialOptions) {
  const pl = isPolish();
  const L = {
    resultsTitle: pl ? "Wyniki SwiftFind" : "SwiftFind Results",
    files: pl ? "Pliki" : "Files",
    folders: pl ? "Foldery" : "Folders",
    text: pl ? "Tekst" : "Text",
    symbols: pl ? "Symbole" : "Symbols",
    commands: pl ? "Polecenia" : "Commands",
    search: pl ? "Szukaj" : "Search",
    query: pl ? "Fraza wyszukiwania" : "Search query",
    noResults: pl ? "Brak wynikow" : "No results found",
    matchCase: pl ? "Uwzgledniaj wielkosc liter" : "Match Case",
    wholeWord: pl ? "Dopasuj cale slowo" : "Match Whole Word",
    regex: pl ? "Regex" : "Regex",
    fuzzy: pl ? "Fuzzy" : "Fuzzy",
    exclGit: pl ? "Pomin Git Ignored" : "Exclude Git Ignored",
    exclSearch: pl ? "Pomin .searchignore" : "Exclude Search Ignored",
    results: pl ? "wynikow" : "results",
    scope: pl ? "Zakres" : "Scope",
    clearScope: pl ? "Wyczyść zakres" : "Clear Scope",
    findReplace: pl ? "Znajdź i zamień…" : "Find and replace…",
    searching: pl ? "Wyszukiwanie…" : "Searching…",
    typeToSearch: pl ? "Zacznij pisać, wyniki pojawią się na żywo." : "Start typing — results update live.",
    foundSoFar: pl ? "znaleziono" : "found",
    pause: pl ? "Wstrzymaj" : "Pause",
    resume: pl ? "Wznów" : "Resume",
    stop: pl ? "Zatrzymaj" : "Stop",
    paused: pl ? "Wstrzymane…" : "Paused…",
    stopped: pl ? "zatrzymano" : "stopped"
  };
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; }
    .top { position: sticky; top: 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); padding: 10px 12px 0; display: grid; grid-template-columns: 1fr; gap: 8px; z-index: 5; }
    .headline { font-size: 12px; font-weight: 600; opacity: .9; letter-spacing: .2px; }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .tab { padding: 4px 9px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 12px; }
    .tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-list-activeSelectionBackground); }
    .searchbar { display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; }
    .searchbar button:disabled { opacity: 0.45; cursor: default; }
    .opts { display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: 4px 10px; font-size: 12px; opacity: 0.95; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 8px; }
    .scopebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 0 8px;
      font-size: 12px;
      opacity: 0.9;
    }
    .scopebtn {
      padding: 4px 8px;
      font-size: 11px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .scopebtn:hover { background: var(--vscode-list-hoverBackground); }
    .opts label { display: inline-flex; gap: 6px; align-items: center; line-height: 1.3; }
    #q, #go, #btnPause, #btnStop { padding: 7px 9px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    #go, #btnPause, #btnStop { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
    #go:hover:not(:disabled), #btnPause:hover:not(:disabled), #btnStop:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .progress {
      height: 2px;
      width: 100%;
      margin: 0 -12px;
      width: calc(100% + 24px);
      background: transparent;
      overflow: hidden;
      opacity: 0;
      transition: opacity .15s ease;
    }
    .progress.active { opacity: 1; }
    .progress.paused > span { animation-play-state: paused; opacity: 0.55; }
    .progress > span {
      display: block;
      height: 100%;
      width: 35%;
      background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      animation: sf-indeterminate 1.1s ease-in-out infinite;
    }
    @keyframes sf-indeterminate {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(320%); }
    }
    .content { padding: 10px 12px; }
    .folder { margin-top: 12px; font-weight: 600; opacity: 0.9; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .row { padding: 7px 8px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; }
    .row:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-list-hoverBackground); }
    .row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-list-activeSelectionBackground); }
    .row.selected .meta, .row.selected .detail { color: inherit; opacity: 0.92; }
    .meta { opacity: 0.8; font-size: 12px; }
    .detail { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: 0.9; }
    #summary { position: sticky; top: 0; z-index: 3; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
    #summary.busy { opacity: 1; }
    .ctx {
      position: fixed;
      z-index: 100;
      min-width: 190px;
      border: 1px solid var(--vscode-menu-border);
      background: var(--vscode-menu-background);
      color: var(--vscode-menu-foreground);
      border-radius: 8px;
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
      padding: 8px 10px;
      cursor: pointer;
    }
    .ctx button:hover { background: var(--vscode-list-hoverBackground); }
  </style>
</head>
<body>
  <div class="top">
    <div class="headline">${L.resultsTitle}</div>
    <div class="tabs" id="tabs">
      <button class="tab" data-tab="files">${L.files}</button>
      <button class="tab" data-tab="folders">${L.folders}</button>
      <button class="tab active" data-tab="text">${L.text}</button>
      <button class="tab" data-tab="symbols">${L.symbols}</button>
      <button class="tab" data-tab="commands">${L.commands}</button>
    </div>
    <div class="searchbar">
      <input id="q" placeholder="${L.query}" value="${escapeHtml(initialQuery)}" />
      <button id="go">${L.search}</button>
      <button id="btnPause" type="button" disabled>${L.pause}</button>
      <button id="btnStop" type="button" disabled>${L.stop}</button>
    </div>
    <div style="margin-top:4px;">
      <button type="button" id="btnReplace" class="scopebtn">${L.findReplace}</button>
    </div>
    <div class="opts">
      <label><input id="matchCase" type="checkbox" ${initialOptions.matchCase ? "checked" : ""} /> ${L.matchCase} (Alt+C)</label>
      <label><input id="wholeWord" type="checkbox" ${initialOptions.wholeWord ? "checked" : ""} /> ${L.wholeWord} (Alt+W)</label>
      <label><input id="useRegex" type="checkbox" ${initialOptions.useRegex ? "checked" : ""} /> Regex (Alt+R)</label>
      <label><input id="fuzzy" type="checkbox" ${initialOptions.fuzzy ? "checked" : ""} /> ${L.fuzzy} (Alt+F)</label>
      <label><input id="excludeGitIgnored" type="checkbox" ${initialOptions.excludeGitIgnored ? "checked" : ""} /> ${L.exclGit} (Alt+G)</label>
      <label><input id="excludeSearchIgnored" type="checkbox" ${initialOptions.excludeSearchIgnored ? "checked" : ""} /> ${L.exclSearch} (Alt+S)</label>
    </div>
    <div class="scopebar">
      <div id="scopeInfo"></div>
      <button id="clearScope" class="scopebtn">${L.clearScope}</button>
    </div>
    <div class="progress" id="progress" aria-hidden="true"><span></span></div>
  </div>
  <div class="content" id="summary" style="padding-top:8px; opacity:.85; font-size:12px;"></div>
  <div class="content" id="out"></div>
  <div id="ctx" class="ctx"><button id="ctxReveal">${pl ? "Pokaż w Eksploratorze Windows" : "Show in Windows Explorer"}</button></div>
  <script>
    const vscode = acquireVsCodeApi();
    const q = document.getElementById("q");
    const go = document.getElementById("go");
    const btnPause = document.getElementById("btnPause");
    const btnStop = document.getElementById("btnStop");
    const out = document.getElementById("out");
    const summary = document.getElementById("summary");
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
    const clearScopeBtn = document.getElementById("clearScope");
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

    function updateControlButtons() {
      btnPause.disabled = !searching;
      btnStop.disabled = !searching;
      btnPause.textContent = paused ? "${L.resume}" : "${L.pause}";
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
      }
      updateControlButtons();
    }

    function rememberSelection(it) {
      lastSelectedKey = itemKey(it);
      vscode.postMessage({
        type: "select",
        tab: activeTab,
        query: q.value.trim(),
        filePath: it.filePath,
        lineNumber: it.lineNumber,
        column: it.column,
        commandId: it.commandId,
        ...searchOptionsPayload()
      });
    }

    function applySelectionToRows() {
      if (!lastSelectedKey) return;
      for (const row of out.querySelectorAll(".row")) {
        row.classList.toggle("selected", row.dataset.key === lastSelectedKey);
      }
      const sel = out.querySelector(".row.selected");
      if (sel) sel.scrollIntoView({ block: "nearest" });
    }

    function refreshScopeInfo() {
      scopeInfo.textContent = scopePath ? "${L.scope}: " + scopePath : "";
    }

    function run(immediate) {
      const query = q.value.trim();
      if (!query) {
        if (debounceTimer) clearTimeout(debounceTimer);
        setBusy(false);
        out.innerHTML = "";
        summary.textContent = "${L.typeToSearch}";
        return;
      }
      const launch = () => {
        refreshScopeInfo();
        activeRequestId = ++requestId;
        paused = false;
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
        vscode.postMessage({ type: "resumeSearch" });
      } else {
        paused = true;
        updateControlButtons();
        summary.textContent = "${L.paused}";
        vscode.postMessage({ type: "pauseSearch" });
      }
    });
    btnStop.addEventListener("click", () => {
      if (!searching) return;
      vscode.postMessage({ type: "stopSearch" });
    });
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") run(true); });
    q.addEventListener("input", () => run(false));
    matchCase.addEventListener("change", () => run(true));
    wholeWord.addEventListener("change", () => run(true));
    useRegex.addEventListener("change", () => run(true));
    fuzzy.addEventListener("change", () => run(true));
    excludeGitIgnored.addEventListener("change", () => run(true));
    excludeSearchIgnored.addEventListener("change", () => run(true));
    clearScopeBtn.addEventListener("click", () => {
      scopePath = "";
      refreshScopeInfo();
      if (q.value.trim()) run(true);
    });

    document.getElementById("btnReplace").addEventListener("click", () => {
      vscode.postMessage({
        type: "openReplace",
        find: q.value,
        replace: "",
        ...searchOptionsPayload()
      });
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === "hydrate") {
        const opts = msg.options || {};
        q.value = String(msg.query || "");
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
          out.innerHTML = "";
          summary.textContent = "${L.typeToSearch}";
          setBusy(false);
        }
        return;
      }

      if (msg.requestId && Number(msg.requestId) !== activeRequestId) return;

      if (msg.type === "searchStarted") {
        paused = false;
        setBusy(true, "${L.searching}");
        out.innerHTML = "";
        return;
      }
      if (msg.type === "searchError") {
        setBusy(false);
        summary.textContent = msg.message || "Error";
        return;
      }
      if (msg.type === "resultsPartial") {
        const items = Array.isArray(msg.items) ? msg.items : [];
        if (!paused) setBusy(true, "${L.searching}");
        requestAnimationFrame(() => {
          if (Number(msg.requestId) !== activeRequestId) return;
          render(items, msg.tab || activeTab, { partial: true, stopped: false });
        });
        return;
      }
      if (msg.type !== "results") return;
      const items = Array.isArray(msg.items) ? msg.items : [];
      const stopped = !!msg.stopped;
      setBusy(false);
      requestAnimationFrame(() => {
        if (msg.requestId && Number(msg.requestId) !== activeRequestId) return;
        render(items, msg.tab || activeTab, { partial: false, stopped });
      });
    });

    function render(items, tab, opts) {
      const partial = !!(opts && opts.partial);
      const stopped = !!(opts && opts.stopped);
      out.innerHTML = "";
      const tabNames = {
        files: "${L.files}",
        folders: "${L.folders}",
        text: "${L.text}",
        symbols: "${L.symbols}",
        commands: "${L.commands}",
        everything: "Everything"
      };
      const tabName = tabNames[tab] || tab;
      const scopePart = scopePath ? " | ${L.scope}: " + scopePath : "";
      if (partial) {
        summary.textContent = paused
          ? (tabName + ": ${L.foundSoFar} " + items.length + " — ${L.paused}" + scopePart)
          : (tabName + ": ${L.foundSoFar} " + items.length + "…" + scopePart);
      } else if (stopped) {
        summary.textContent = tabName + ": " + items.length + " ${L.results} (${L.stopped})" + scopePart;
      } else {
        summary.textContent = tabName + ": " + items.length + " ${L.results}" + scopePart;
      }
      if (!items.length) {
        if (!partial) out.textContent = "${L.noResults}";
        return;
      }
      if (tab === "text") {
        const grouped = new Map();
        for (const it of items) {
          if (!it.filePath) continue;
          const p = String(it.filePath).replaceAll("\\\\","/");
          const i = p.lastIndexOf("/");
          const folder = i >= 0 ? p.slice(0, i) : ".";
          if (!grouped.has(folder)) grouped.set(folder, []);
          grouped.get(folder).push(it);
        }
        const folders = [...grouped.keys()].sort((a,b)=>a.localeCompare(b));
        for (const folder of folders) {
          const h = document.createElement("div");
          h.className = "folder";
          h.textContent = folder;
          out.appendChild(h);
          for (const it of grouped.get(folder)) out.appendChild(rowFor(it));
        }
        applySelectionToRows();
        return;
      }

      const h = document.createElement("div");
      h.className = "folder";
      h.textContent = tab[0].toUpperCase() + tab.slice(1) + " (" + items.length + ")";
      out.appendChild(h);
      for (const it of items) {
        out.appendChild(rowFor(it));
      }
      applySelectionToRows();
    }

    function rowFor(it) {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.key = itemKey(it);
      const left = it.label || it.description || it.filePath || "";
      const right = it.description || it.filePath || "";
      row.innerHTML = '<div>' + esc(left) + '</div><div class="meta">' + esc(right) + '</div><div class="detail">' + esc(it.detail || "") + '</div>';
      row.addEventListener("click", () => {
        rememberSelection(it);
        for (const r of out.querySelectorAll(".row")) r.classList.remove("selected");
        row.classList.add("selected");
        vscode.postMessage({
          type: "open",
          filePath: it.filePath,
          lineNumber: it.lineNumber,
          column: it.column,
          commandId: it.commandId
        });
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!it.filePath) return;
        ctxItem = it;
        ctx.style.left = e.clientX + "px";
        ctx.style.top = e.clientY + "px";
        ctx.style.display = "block";
      });
      return row;
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
      if (e.key === "Tab") {
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
        if (k === "c") { matchCase.checked = !matchCase.checked; run(true); }
        if (k === "w") { wholeWord.checked = !wholeWord.checked; run(true); }
        if (k === "r") { useRegex.checked = !useRegex.checked; run(true); }
        if (k === "f") { fuzzy.checked = !fuzzy.checked; run(true); }
        if (k === "g") { excludeGitIgnored.checked = !excludeGitIgnored.checked; run(true); }
        if (k === "s") { excludeSearchIgnored.checked = !excludeSearchIgnored.checked; run(true); }
      }
    });

    function esc(s){ return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
    refreshScopeInfo();
    summary.textContent = "${L.typeToSearch}";
    if (q.value.trim()) run(true);
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

module.exports = { openFullscreenSearch };

