const vscode = require("vscode");
const path = require("path");
const { searchByTab, openResult } = require("./searchEngine");
const { isPolish } = require("./i18n");
const { itemKey, setLastSelection, getLastSelection } = require("./uiSelectionState");

/** @type {SwiftFindSidebarProvider | null} */
let sidebarProviderInstance = null;

class SwiftFindSidebarProvider {
  /**
   * @param {vscode.Uri} extensionUri
   */
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    /** @type {vscode.WebviewView | null} */
    this._view = null;
    sidebarProviderInstance = this;
  }

  pushSelectionHighlight() {
    const sel = getLastSelection();
    if (!sel?.item || !this._view) return;
    this._view.webview.postMessage({
      type: "syncSelection",
      tab: sel.tab,
      query: sel.query,
      options: sel.options,
      key: itemKey(sel.item),
      item: sel.item
    });
  }

  /**
   * @param {vscode.WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getHtml();
    if (getLastSelection()) {
      queueMicrotask(() => {
        if (webviewView.visible) this.pushSelectionHighlight();
      });
    }

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.pushSelectionHighlight();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || !msg.type) return;

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
            excludeSearchIgnored: Boolean(msg.excludeSearchIgnored)
          },
          item: {
            filePath: msg.filePath,
            lineNumber: Number(msg.lineNumber || 0),
            column: Number(msg.column || 1),
            commandId: msg.commandId
          }
        });
        return;
      }

      if (msg.type === "openQuick") {
        await vscode.commands.executeCommand("swiftFind.open");
        return;
      }

      if (msg.type === "openFullscreen") {
        await vscode.commands.executeCommand("swiftFind.openFullscreen", {
          query: String(msg.query || "").trim(),
          options: {
            matchCase: Boolean(msg.matchCase),
            wholeWord: Boolean(msg.wholeWord),
            useRegex: Boolean(msg.useRegex),
            fuzzy: Boolean(msg.fuzzy),
            excludeGitIgnored: Boolean(msg.excludeGitIgnored),
            excludeSearchIgnored: Boolean(msg.excludeSearchIgnored)
          }
        });
        return;
      }

      if (msg.type === "search") {
        const tab = String(msg.tab || "text");
        const query = String(msg.query || "").trim();
        const items = await searchByTab(tab, query, {
          matchCase: Boolean(msg.matchCase),
          wholeWord: Boolean(msg.wholeWord),
          useRegex: Boolean(msg.useRegex),
          fuzzy: Boolean(msg.fuzzy),
          excludeGitIgnored: Boolean(msg.excludeGitIgnored),
          excludeSearchIgnored: Boolean(msg.excludeSearchIgnored)
        });
        webviewView.webview.postMessage({ type: "results", items });
        return;
      }

      if (msg.type === "openResult") {
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
      }
    });
  }

  getHtml() {
    const pl = isPolish();
    const L = {
      files: pl ? "Pliki" : "Files",
      folders: pl ? "Foldery" : "Folders",
      text: pl ? "Tekst" : "Text",
      symbols: pl ? "Symbole" : "Symbols",
      commands: pl ? "Polecenia" : "Commands",
      query: pl ? "Fraza wyszukiwania..." : "Search query...",
      openFloating: pl ? "Otworz wyszukiwanie plywajace" : "Open Floating Search",
      openFullscreen: pl ? "Otworz pelnoekranowe wyniki" : "Open Fullscreen Results",
      matchCase: pl ? "Uwzgledniaj wielkosc liter" : "Match Case",
      wholeWord: pl ? "Dopasuj cale slowo" : "Whole Word",
      regex: "Regex",
      fuzzy: "Fuzzy",
      exclGit: pl ? "Pomin Git Ignored" : "Exclude Git Ignored",
      exclSearch: pl ? "Pomin .searchignore" : "Exclude Search Ignored",
      helper: pl ? "Wpisz fraze, aby wyszukac wyniki w panelu bocznym." : "Type query to search sidebar results.",
      searching: pl ? "Wyszukiwanie..." : "Searching...",
      results: pl ? "wynikow" : "results"
    };
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 8px;
      margin: 0;
      background: var(--vscode-sideBar-background);
    }
    .wrap { display: grid; gap: 8px; }
    .tabs { display: flex; flex-wrap: wrap; gap: 4px; }
    .tab {
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .tab.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-color: var(--vscode-list-activeSelectionBackground);
    }
    #q, button {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    #q::placeholder { color: var(--vscode-input-placeholderForeground); }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .opts {
      display: grid;
      gap: 4px;
      font-size: 11px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px;
    }
    .opts label {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: start;
      gap: 6px;
      line-height: 1.3;
      cursor: pointer;
    }
    .opts input[type="checkbox"] {
      width: 13px;
      height: 13px;
      margin: 1px 0 0;
      padding: 0;
      border-radius: 2px;
      accent-color: var(--vscode-checkbox-selectBackground);
      flex: 0 0 auto;
    }
    .results {
      margin-top: 2px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 6px;
      max-height: 52vh;
      overflow: auto;
    }
    .section {
      margin: 8px 0 4px;
      font-size: 11px;
      font-weight: 600;
      opacity: 0.9;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 3px;
    }
    .row {
      padding: 5px 6px;
      border-radius: 4px;
      cursor: pointer;
      margin-bottom: 2px;
      border: 1px solid transparent;
    }
    .row:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-list-hoverBackground);
    }
    .row.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-color: var(--vscode-list-activeSelectionBackground);
    }
    .row.selected .d,
    .row.selected .t {
      color: inherit;
      opacity: 0.92;
    }
    .row .l { font-size: 12px; display: flex; gap: 6px; align-items: center; }
    .row .d { font-size: 11px; opacity: 0.75; }
    .row .t { font-size: 11px; opacity: 0.9; font-family: var(--vscode-editor-font-family); }
    .ico {
      width: 14px;
      height: 14px;
      flex: 0 0 14px;
      opacity: 0.9;
      display: inline-block;
    }
    .ico svg {
      width: 14px;
      height: 14px;
      display: block;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    mark {
      background: var(--vscode-editor-findMatchBackground);
      color: inherit;
      border-radius: 3px;
      padding: 0 1px;
    }
    .muted { font-size: 11px; opacity: 0.75; }
    .ctx {
      position: fixed;
      z-index: 100;
      min-width: 175px;
      border: 1px solid var(--vscode-menu-border);
      background: var(--vscode-menu-background);
      color: var(--vscode-menu-foreground);
      border-radius: 4px;
      box-shadow: 0 8px 18px rgba(0,0,0,.28);
      display: none;
      overflow: hidden;
    }
    .ctx button {
      width: 100%;
      border: 0;
      border-radius: 0;
      text-align: left;
      background: transparent;
      color: inherit;
      padding: 8px 10px;
      cursor: pointer;
    }
    .ctx button:hover { background: var(--vscode-list-hoverBackground); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="tabs" id="tabs">
      <button class="tab" data-tab="files">${L.files}</button>
      <button class="tab" data-tab="folders">${L.folders}</button>
      <button class="tab active" data-tab="text">${L.text}</button>
      <button class="tab" data-tab="symbols">${L.symbols}</button>
      <button class="tab" data-tab="commands">${L.commands}</button>
    </div>
    <input id="q" placeholder="${L.query}" />
    <div class="actions">
      <button id="quick">${L.openFloating}</button>
      <button id="full">${L.openFullscreen}</button>
    </div>
    <div class="opts">
      <label><input id="matchCase" type="checkbox" /> ${L.matchCase}</label>
      <label><input id="wholeWord" type="checkbox" /> ${L.wholeWord}</label>
      <label><input id="useRegex" type="checkbox" /> Regex</label>
      <label><input id="fuzzy" type="checkbox" /> Fuzzy</label>
      <label><input id="excludeGitIgnored" type="checkbox" checked /> ${L.exclGit}</label>
      <label><input id="excludeSearchIgnored" type="checkbox" checked /> ${L.exclSearch}</label>
    </div>
    <div class="muted" id="meta">${L.helper}</div>
    <div id="results" class="results"></div>
  </div>
  <div id="ctx" class="ctx"><button id="ctxReveal">${pl ? "Pokaż w Eksploratorze Windows" : "Show in Windows Explorer"}</button></div>
  <script>
    const vscode = acquireVsCodeApi();
    const q = document.getElementById("q");
    const quick = document.getElementById("quick");
    const full = document.getElementById("full");
    const tabs = document.getElementById("tabs");
    const meta = document.getElementById("meta");
    const resultsEl = document.getElementById("results");
    const ctx = document.getElementById("ctx");
    const ctxReveal = document.getElementById("ctxReveal");
    let activeTab = "text";
    let timer;
    let ctxItem = null;
    let lastSelectedKey = "";

    function itemKey(item) {
      if (!item) return "";
      if (item.commandId) return "cmd:" + item.commandId;
      const fp = String(item.filePath || "");
      if (!fp) return "";
      return fp + ":" + Number(item.lineNumber || 0) + ":" + Number(item.column || 1);
    }

    function applySelectionToRows() {
      if (!lastSelectedKey) return;
      for (const row of resultsEl.querySelectorAll(".row")) {
        row.classList.toggle("selected", row.dataset.key === lastSelectedKey);
      }
      const sel = resultsEl.querySelector(".row.selected");
      if (sel) sel.scrollIntoView({ block: "nearest" });
    }

    function rememberSelection(item) {
      lastSelectedKey = itemKey(item);
      vscode.postMessage({
        type: "select",
        tab: activeTab,
        query: q.value.trim(),
        filePath: item.filePath,
        lineNumber: item.lineNumber,
        column: item.column,
        commandId: item.commandId,
        matchCase: document.getElementById("matchCase").checked,
        wholeWord: document.getElementById("wholeWord").checked,
        useRegex: document.getElementById("useRegex").checked,
        fuzzy: document.getElementById("fuzzy").checked,
        excludeGitIgnored: document.getElementById("excludeGitIgnored").checked,
        excludeSearchIgnored: document.getElementById("excludeSearchIgnored").checked
      });
    }

    function syncFromHost(msg) {
      if (msg.tab) {
        activeTab = String(msg.tab);
        for (const x of tabs.querySelectorAll(".tab")) {
          x.classList.toggle("active", x.getAttribute("data-tab") === activeTab);
        }
      }
      const opts = msg.options || {};
      if (typeof opts.matchCase === "boolean") document.getElementById("matchCase").checked = opts.matchCase;
      if (typeof opts.wholeWord === "boolean") document.getElementById("wholeWord").checked = opts.wholeWord;
      if (typeof opts.useRegex === "boolean") document.getElementById("useRegex").checked = opts.useRegex;
      if (typeof opts.fuzzy === "boolean") document.getElementById("fuzzy").checked = opts.fuzzy;
      if (typeof opts.excludeGitIgnored === "boolean") {
        document.getElementById("excludeGitIgnored").checked = opts.excludeGitIgnored;
      }
      if (typeof opts.excludeSearchIgnored === "boolean") {
        document.getElementById("excludeSearchIgnored").checked = opts.excludeSearchIgnored;
      }
      if (msg.key) {
        lastSelectedKey = String(msg.key);
      }
      const nextQuery = String(msg.query || "").trim();
      if (nextQuery && q.value.trim() !== nextQuery) {
        q.value = nextQuery;
        searchNow();
        return;
      }
      applySelectionToRows();
    }

    function payload(type) {
      return {
        type,
        tab: activeTab,
        query: q.value.trim(),
        matchCase: document.getElementById("matchCase").checked,
        wholeWord: document.getElementById("wholeWord").checked,
        useRegex: document.getElementById("useRegex").checked,
        fuzzy: document.getElementById("fuzzy").checked,
        excludeGitIgnored: document.getElementById("excludeGitIgnored").checked,
        excludeSearchIgnored: document.getElementById("excludeSearchIgnored").checked
      };
    }

    function searchNow() {
      const v = q.value.trim();
      if (!v) {
        resultsEl.innerHTML = "";
        meta.textContent = "${L.helper}";
        return;
      }
      meta.textContent = "${L.searching}";
      vscode.postMessage(payload("search"));
    }

    function scheduleSearch() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(searchNow, 140);
    }

    function row(item) {
      const div = document.createElement("div");
      div.className = "row";
      div.dataset.key = itemKey(item);
      const lRaw = item.label || item.description || item.filePath || "";
      const l = cleanLabel(lRaw);
      const d = item.description || "";
      const t = item.detail || "";
      const icon = iconFor(item);
      div.innerHTML =
        '<div class="l"><span class="ico">' + icon + '</span><span>' + highlight(l) + '</span></div>' +
        '<div class="d">' + highlight(d) + '</div>' +
        '<div class="t">' + highlight(t) + '</div>';
      div.addEventListener("click", () => {
        rememberSelection(item);
        for (const r of resultsEl.querySelectorAll(".row")) r.classList.remove("selected");
        div.classList.add("selected");
        vscode.postMessage({
          type: "openResult",
          filePath: item.filePath,
          lineNumber: item.lineNumber,
          column: item.column,
          commandId: item.commandId
        });
      });
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!item.filePath) return;
        ctxItem = item;
        ctx.style.left = e.clientX + "px";
        ctx.style.top = e.clientY + "px";
        ctx.style.display = "block";
      });
      return div;
    }

    function section(title) {
      const h = document.createElement("div");
      h.className = "section";
      h.textContent = title;
      return h;
    }

    window.addEventListener("message", (e) => {
      const msg = e.data || {};
      if (msg.type === "syncSelection") {
        syncFromHost(msg);
        return;
      }
      if (msg.type !== "results") return;
      const items = Array.isArray(msg.items) ? msg.items : [];
      resultsEl.innerHTML = "";
      const tabNames = {
        files: "${L.files}",
        folders: "${L.folders}",
        text: "${L.text}",
        symbols: "${L.symbols}",
        commands: "${L.commands}"
      };
      const tabName = tabNames[activeTab] || activeTab;
      meta.textContent = tabName + ": " + items.length + " ${L.results}";

      const renderItems = items;
      if (activeTab === "text") {
        const grouped = new Map();
        for (const item of renderItems) {
          const fp = String(item.filePath || "").replaceAll("\\\\", "/");
          const i = fp.lastIndexOf("/");
          const folder = i >= 0 ? fp.slice(0, i) : ".";
          if (!grouped.has(folder)) grouped.set(folder, []);
          grouped.get(folder).push(item);
        }
        const folders = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
        for (const folder of folders) {
          resultsEl.appendChild(section(folder));
          for (const item of grouped.get(folder)) resultsEl.appendChild(row(item));
        }
        applySelectionToRows();
        return;
      }

      for (const item of renderItems) {
        resultsEl.appendChild(row(item));
      }
      applySelectionToRows();
    });

    tabs.addEventListener("click", (e) => {
      const b = e.target.closest(".tab");
      if (!b) return;
      activeTab = b.getAttribute("data-tab");
      for (const x of tabs.querySelectorAll(".tab")) x.classList.remove("active");
      b.classList.add("active");
      searchNow();
    });

    ctxReveal.addEventListener("click", () => {
      if (!ctxItem || !ctxItem.filePath) return;
      vscode.postMessage({ type: "revealInExplorer", filePath: ctxItem.filePath });
      ctx.style.display = "none";
    });
    window.addEventListener("click", () => { ctx.style.display = "none"; });
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") ctx.style.display = "none"; });

    quick.addEventListener("click", () => vscode.postMessage(payload("openQuick")));
    full.addEventListener("click", () => vscode.postMessage(payload("openFullscreen")));
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") searchNow(); });
    q.addEventListener("input", scheduleSearch);
    ["matchCase","wholeWord","useRegex","fuzzy","excludeGitIgnored","excludeSearchIgnored"].forEach((id) => {
      document.getElementById(id).addEventListener("change", searchNow);
    });

    function esc(s) { return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }

    function cleanLabel(text) {
      return String(text || "").replace(/^\$\([^)]+\)\s*/, "");
    }

    function iconFor(item) {
      if (item.commandId) return iconCmd();
      const fp = String(item.filePath || "");
      if (!fp) return iconDot();
      const p = fp.toLowerCase();
      if (activeTab === "folders") return iconFolder();
      if (activeTab === "symbols") return iconSymbol();
      if (activeTab === "commands") return iconCmd();
      if (activeTab === "text") return iconText();
      if (p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js") || p.endsWith(".jsx")) return iconCode();
      if (p.endsWith(".json") || p.endsWith(".yml") || p.endsWith(".yaml") || p.endsWith(".xml")) return iconGear();
      return iconFile();
    }

    function iconFile() {
      return '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>';
    }
    function iconFolder() {
      return '<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3z"/></svg>';
    }
    function iconText() {
      return '<svg viewBox="0 0 24 24"><path d="M6 7h12"/><path d="M6 12h12"/><path d="M6 17h9"/></svg>';
    }
    function iconSymbol() {
      return '<svg viewBox="0 0 24 24"><path d="M8 5h8l-6 7 6 7H8"/></svg>';
    }
    function iconCmd() {
      return '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/><path d="M12 7v10"/><path d="M7 12h10"/></svg>';
    }
    function iconCode() {
      return '<svg viewBox="0 0 24 24"><path d="M9 8 5 12l4 4"/><path d="M15 8l4 4-4 4"/></svg>';
    }
    function iconGear() {
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12h2M3 12h2M12 3v2M12 19v2M17 7l1.4-1.4M5.6 18.4 7 17M17 17l1.4 1.4M5.6 5.6 7 7"/></svg>';
    }
    function iconDot() {
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/></svg>';
    }

    function highlight(text) {
      const s = String(text || "");
      const qv = q.value.trim();
      if (!qv) return esc(s);
      if (document.getElementById("useRegex").checked) {
        try {
          const r = new RegExp(qv, document.getElementById("matchCase").checked ? "g" : "gi");
          return esc(s).replace(r, (m) => "<mark>" + m + "</mark>");
        } catch {
          return esc(s);
        }
      }
      const src = document.getElementById("matchCase").checked ? s : s.toLowerCase();
      const needle = document.getElementById("matchCase").checked ? qv : qv.toLowerCase();
      if (!needle) return esc(s);
      let out = "";
      let i = 0;
      while (i < s.length) {
        const at = src.indexOf(needle, i);
        if (at < 0) {
          out += esc(s.slice(i));
          break;
        }
        out += esc(s.slice(i, at));
        out += "<mark>" + esc(s.slice(at, at + qv.length)) + "</mark>";
        i = at + qv.length;
      }
      return out;
    }
  </script>
</body>
</html>`;
  }
}

function getSidebarProvider() {
  return sidebarProviderInstance;
}

module.exports = { SwiftFindSidebarProvider, getSidebarProvider };

