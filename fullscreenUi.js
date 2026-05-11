const vscode = require("vscode");
const path = require("path");
const { searchByTab, openResult } = require("./searchEngine");
const { isPolish } = require("./i18n");
const { openReplacePanel } = require("./replaceUi");

/**
 * @param {{query?:string, options?:{matchCase?:boolean, wholeWord?:boolean, useRegex?:boolean}} | string | undefined} payload
 */
function openFullscreenSearch(payload) {
  const initialQuery = typeof payload === "string" ? payload : payload?.query || "";
  const initialOptions =
    typeof payload === "string"
      ? { matchCase: false, wholeWord: false, useRegex: false }
      : {
          matchCase: Boolean(payload?.options?.matchCase),
          wholeWord: Boolean(payload?.options?.wholeWord),
          useRegex: Boolean(payload?.options?.useRegex),
          fuzzy: Boolean(payload?.options?.fuzzy),
          excludeGitIgnored: payload?.options?.excludeGitIgnored !== false,
          excludeSearchIgnored: payload?.options?.excludeSearchIgnored !== false,
          scopePath: String(payload?.options?.scopePath || "")
        };
  const panel = vscode.window.createWebviewPanel(
    "swiftFindFullscreen",
    isPolish() ? "Wyniki SwiftFind" : "SwiftFind Results",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = getHtml(initialQuery || "", initialOptions);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === "search") {
      const q = String(msg.query || "").trim();
      const tab = String(msg.tab || "text");
      const items = await searchByTab(tab, q, {
        matchCase: Boolean(msg.matchCase),
        wholeWord: Boolean(msg.wholeWord),
        useRegex: Boolean(msg.useRegex),
        fuzzy: Boolean(msg.fuzzy),
        excludeGitIgnored: Boolean(msg.excludeGitIgnored),
        excludeSearchIgnored: Boolean(msg.excludeSearchIgnored),
        scopePath: String(msg.scopePath || "")
      });
      panel.webview.postMessage({ type: "results", items, tab });
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
    findReplace: pl ? "Znajdź i zamień…" : "Find and replace…"
  };
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; }
    .top { position: sticky; top: 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); padding: 10px 12px; display: grid; grid-template-columns: 1fr; gap: 8px; z-index: 5; }
    .headline { font-size: 12px; font-weight: 600; opacity: .9; letter-spacing: .2px; }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .tab { padding: 4px 9px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 12px; }
    .tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-list-activeSelectionBackground); }
    .searchbar { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .opts { display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: 4px 10px; font-size: 12px; opacity: 0.95; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 8px; }
    .scopebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 0 0;
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
    #q, #go { padding: 7px 9px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    #go { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
    #go:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .content { padding: 10px 12px; }
    .folder { margin-top: 12px; font-weight: 600; opacity: 0.9; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .row { padding: 7px 8px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; }
    .row:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-list-hoverBackground); }
    .meta { opacity: 0.8; font-size: 12px; }
    .detail { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: 0.9; }
    #summary { position: sticky; top: 142px; z-index: 3; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
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
  </div>
  <div class="content" id="summary" style="padding-top:0; opacity:.85; font-size:12px;"></div>
  <div class="content" id="out"></div>
  <div id="ctx" class="ctx"><button id="ctxReveal">${pl ? "Pokaż w Eksploratorze Windows" : "Show in Windows Explorer"}</button></div>
  <script>
    const vscode = acquireVsCodeApi();
    const q = document.getElementById("q");
    const go = document.getElementById("go");
    const out = document.getElementById("out");
    const summary = document.getElementById("summary");
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

    function refreshScopeInfo() {
      scopeInfo.textContent = scopePath ? "${L.scope}: " + scopePath : "";
    }

    function run() {
      const query = q.value.trim();
      if (!query) { out.innerHTML = ""; return; }
      out.textContent = "Loading...";
      refreshScopeInfo();
      vscode.postMessage({
        type: "search",
        query,
        tab: activeTab,
        matchCase: !!matchCase.checked,
        wholeWord: !!wholeWord.checked,
        useRegex: !!useRegex.checked,
        fuzzy: !!fuzzy.checked,
        excludeGitIgnored: !!excludeGitIgnored.checked,
        excludeSearchIgnored: !!excludeSearchIgnored.checked,
        scopePath
      });
    }

    go.addEventListener("click", run);
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    matchCase.addEventListener("change", run);
    wholeWord.addEventListener("change", run);
    useRegex.addEventListener("change", run);
    fuzzy.addEventListener("change", run);
    excludeGitIgnored.addEventListener("change", run);
    excludeSearchIgnored.addEventListener("change", run);
    clearScopeBtn.addEventListener("click", () => {
      scopePath = "";
      refreshScopeInfo();
      if (q.value.trim()) {
        run();
      }
    });

    document.getElementById("btnReplace").addEventListener("click", () => {
      vscode.postMessage({
        type: "openReplace",
        find: q.value,
        replace: "",
        matchCase: !!matchCase.checked,
        wholeWord: !!wholeWord.checked,
        useRegex: !!useRegex.checked,
        fuzzy: !!fuzzy.checked,
        excludeGitIgnored: !!excludeGitIgnored.checked,
        excludeSearchIgnored: !!excludeSearchIgnored.checked,
        scopePath
      });
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "results") return;
      const items = Array.isArray(msg.items) ? msg.items : [];
      render(items, msg.tab || activeTab);
    });

    function render(items, tab) {
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
      summary.textContent = tabName + ": " + items.length + " ${L.results}" + (scopePath ? " | ${L.scope}: " + scopePath : "");
      if (!items.length) { out.textContent = "${L.noResults}"; return; }
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
        return;
      }

      const h = document.createElement("div");
      h.className = "folder";
      h.textContent = tab[0].toUpperCase() + tab.slice(1) + " (" + items.length + ")";
      out.appendChild(h);
      for (const it of items) {
        out.appendChild(rowFor(it));
      }
    }

    function rowFor(it) {
      const row = document.createElement("div");
      row.className = "row";
      const left = it.label || it.description || it.filePath || "";
      const right = it.description || it.filePath || "";
      row.innerHTML = '<div>' + esc(left) + '</div><div class="meta">' + esc(right) + '</div><div class="detail">' + esc(it.detail || "") + '</div>';
      row.addEventListener("click", () => {
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
      run();
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
        if (k === "c") { matchCase.checked = !matchCase.checked; run(); }
        if (k === "w") { wholeWord.checked = !wholeWord.checked; run(); }
        if (k === "r") { useRegex.checked = !useRegex.checked; run(); }
        if (k === "f") { fuzzy.checked = !fuzzy.checked; run(); }
        if (k === "g") { excludeGitIgnored.checked = !excludeGitIgnored.checked; run(); }
        if (k === "s") { excludeSearchIgnored.checked = !excludeSearchIgnored.checked; run(); }
      }
    });

    function esc(s){ return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
    refreshScopeInfo();
    if (q.value.trim()) run();
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

module.exports = { openFullscreenSearch };

