const vscode = require("vscode");
const { previewReplace, replaceAllInScope } = require("./searchEngine");
const { isPolish } = require("./i18n");
const { markDirty } = require("./quickPickUi");

/**
 * @param {{ find?: string; replace?: string; options?: Record<string, unknown> } | undefined} payload
 */
function openReplacePanel(payload) {
  const pl = isPolish();
  const find = String(payload?.find ?? payload?.query ?? "").trim();
  const replace = String(payload?.replace ?? "");
  const initialOptions = {
    matchCase: Boolean(payload?.options?.matchCase),
    wholeWord: Boolean(payload?.options?.wholeWord),
    useRegex: Boolean(payload?.options?.useRegex),
    fuzzy: Boolean(payload?.options?.fuzzy),
    excludeGitIgnored: payload?.options?.excludeGitIgnored !== false,
    excludeSearchIgnored: payload?.options?.excludeSearchIgnored !== false,
    scopePath: String(payload?.options?.scopePath || "")
  };

  const panel = vscode.window.createWebviewPanel(
    "swiftFindReplace",
    pl ? "SwiftFind — Znajdź i zamień" : "SwiftFind — Find and Replace",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = getHtml(find, replace, initialOptions, pl);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || !msg.type) return;
    const opts = {
      matchCase: Boolean(msg.matchCase),
      wholeWord: Boolean(msg.wholeWord),
      useRegex: Boolean(msg.useRegex),
      fuzzy: Boolean(msg.fuzzy),
      excludeGitIgnored: Boolean(msg.excludeGitIgnored),
      excludeSearchIgnored: Boolean(msg.excludeSearchIgnored),
      scopePath: String(msg.scopePath || "")
    };

    if (msg.type === "preview") {
      const r = await previewReplace(String(msg.find || ""), String(msg.replace || ""), opts);
      panel.webview.postMessage({ type: "previewResult", ...r });
      return;
    }

    if (msg.type === "replaceAll") {
      const findStr = String(msg.find || "").trim();
      const prev = await previewReplace(findStr, String(msg.replace || ""), opts);
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
          message: pl ? "Brak dopasowan." : "No matches."
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
      if (r.ok && r.changedFiles) {
        markDirty();
      }
      panel.webview.postMessage({ type: "replaceResult", ...r });
    }
  });
}

/**
 * @param {boolean} pl
 */
function getHtml(initialFind, initialReplace, initialOptions, pl) {
  const L = {
    title: pl ? "Znajdź i zamień w plikach" : "Find and replace in files",
    find: pl ? "Znajdź" : "Find",
    replace: pl ? "Zamień na" : "Replace with",
    preview: pl ? "Podgląd" : "Preview",
    replaceAll: pl ? "Zamień wszystko" : "Replace all",
    scope: pl ? "Zakres" : "Scope",
    clearScope: pl ? "Wyczyść zakres" : "Clear scope",
    matchCase: pl ? "Uwzględnij wielkość liter" : "Match case",
    wholeWord: pl ? "Całe słowo" : "Whole word",
    regex: "Regex",
    fuzzy: "Fuzzy",
    exclGit: pl ? "Pomiń Git ignored" : "Exclude Git ignored",
    exclSearch: pl ? "Pomiń .searchignore" : "Exclude .searchignore",
    summary: pl ? "Podsumowanie" : "Summary"
  };

  const esc = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px; }
    h1 { font-size: 13px; font-weight: 600; margin: 0 0 10px; }
    .row { display: grid; grid-template-columns: 120px 1fr; gap: 8px; align-items: center; margin-bottom: 8px; }
    label { font-size: 12px; opacity: 0.9; }
    input[type="text"] { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    .opts { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 6px; font-size: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; margin: 10px 0; }
    .opts label { display: flex; align-items: center; gap: 6px; }
    .scopebar { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; margin-bottom: 10px; }
    .scopebtn { padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
    .scopebtn:hover { background: var(--vscode-list-hoverBackground); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    button.primary { padding: 6px 12px; border-radius: 4px; border: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { padding: 6px 12px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
    #summary { margin-top: 12px; font-size: 12px; opacity: 0.9; min-height: 1.2em; }
    .err { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <h1>${L.title}</h1>
  <div class="row"><label for="find">${L.find}</label><input id="find" type="text" value="${esc(initialFind)}" /></div>
  <div class="row"><label for="replace">${L.replace}</label><input id="replace" type="text" value="${esc(initialReplace)}" /></div>
  <div class="opts">
    <label><input id="matchCase" type="checkbox" ${initialOptions.matchCase ? "checked" : ""} /> ${L.matchCase}</label>
    <label><input id="wholeWord" type="checkbox" ${initialOptions.wholeWord ? "checked" : ""} /> ${L.wholeWord}</label>
    <label><input id="useRegex" type="checkbox" ${initialOptions.useRegex ? "checked" : ""} /> ${L.regex}</label>
    <label><input id="fuzzy" type="checkbox" ${initialOptions.fuzzy ? "checked" : ""} /> ${L.fuzzy}</label>
    <label><input id="excludeGitIgnored" type="checkbox" ${initialOptions.excludeGitIgnored ? "checked" : ""} /> ${L.exclGit}</label>
    <label><input id="excludeSearchIgnored" type="checkbox" ${initialOptions.excludeSearchIgnored ? "checked" : ""} /> ${L.exclSearch}</label>
  </div>
  <div class="scopebar">
    <div id="scopeInfo"></div>
    <button type="button" id="clearScope" class="scopebtn">${L.clearScope}</button>
  </div>
  <div class="actions">
    <button type="button" class="secondary" id="btnPreview">${L.preview}</button>
    <button type="button" class="primary" id="btnReplaceAll">${L.replaceAll}</button>
  </div>
  <div id="summary"></div>
  <script>
    const isPl = ${pl ? "true" : "false"};
    const vscode = acquireVsCodeApi();
    const findEl = document.getElementById("find");
    const replaceEl = document.getElementById("replace");
    const summary = document.getElementById("summary");
    const scopeInfo = document.getElementById("scopeInfo");
    let scopePath = ${JSON.stringify(initialOptions.scopePath || "")};

    function opts() {
      return {
        matchCase: document.getElementById("matchCase").checked,
        wholeWord: document.getElementById("wholeWord").checked,
        useRegex: document.getElementById("useRegex").checked,
        fuzzy: document.getElementById("fuzzy").checked,
        excludeGitIgnored: document.getElementById("excludeGitIgnored").checked,
        excludeSearchIgnored: document.getElementById("excludeSearchIgnored").checked,
        scopePath
      };
    }

    function refreshScope() {
      scopeInfo.textContent = scopePath ? "${L.scope}: " + scopePath : "";
    }

    document.getElementById("clearScope").addEventListener("click", () => {
      scopePath = "";
      refreshScope();
    });

    document.getElementById("btnPreview").addEventListener("click", () => {
      summary.textContent = "";
      summary.className = "";
      vscode.postMessage({ type: "preview", find: findEl.value, replace: replaceEl.value, ...opts() });
    });

    document.getElementById("btnReplaceAll").addEventListener("click", () => {
      summary.textContent = "";
      summary.className = "";
      vscode.postMessage({ type: "replaceAll", find: findEl.value, replace: replaceEl.value, ...opts() });
    });

    window.addEventListener("message", (e) => {
      const msg = e.data || {};
      if (msg.type === "previewResult") {
        if (!msg.ok) {
          summary.className = "err";
          summary.textContent = msg.message || "Error";
          return;
        }
        summary.className = "";
        summary.textContent = isPl
          ? ("Podsumowanie: " + msg.files + " plikow, " + msg.occurrences + " wystapien.")
          : ("Summary: " + msg.files + " file(s), " + msg.occurrences + " match(es).");
      }
      if (msg.type === "replaceResult") {
        if (msg.cancelled) {
          summary.textContent = isPl ? "Anulowano." : "Cancelled.";
          return;
        }
        if (!msg.ok) {
          summary.className = "err";
          summary.textContent = msg.message || "Error";
          return;
        }
        summary.className = "";
        summary.textContent = isPl
          ? ("Zamieniono: " + msg.occurrences + " w " + msg.changedFiles + " plikach.")
          : ("Replaced " + msg.occurrences + " in " + msg.changedFiles + " file(s).");
      }
    });

    refreshScope();
  </script>
</body>
</html>`;
}

module.exports = { openReplacePanel };
