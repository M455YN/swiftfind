const vscode = require("vscode");
const { t } = require("./i18n");
const { modernUiBodyClass, modernUiSharedCss } = require("./modernUi");

let view;

function registerSidebarActions(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("swiftFind.sidebarActions", {
      resolveWebviewView(wv) {
        view = wv;
        wv.webview.options = { enableScripts: true };
        wv.webview.html = sidebarHtml(wv.webview);
        wv.onDidDispose(() => {
          if (view === wv) view = undefined;
        });
        wv.webview.onDidReceiveMessage((m) => {
          if (m?.type === "fullscreenSearch") {
            vscode.commands.executeCommand("swiftFind.openFullscreen");
          } else if (m?.type === "fullscreenReplace") {
            vscode.commands.executeCommand("swiftFind.openReplace");
          }
        });
      }
    }, { webviewOptions: { retainContextWhenHidden: true } })
  );
}

function pushSidebarModernUi(enabled) {
  view?.webview.postMessage({ type: "modernUi", enabled });
}

function sidebarHtml(webview) {
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'`;
  const searchHint = t("Search in project — Find in Files", "Szukaj w projekcie — Find in Files");
  const replaceHint = t("Find and replace across workspace files", "Znajdź i zamień w plikach workspace");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
  :root {
    --tile-bg: var(--vscode-welcomePage-tileBackground, var(--vscode-sideBar-background));
    --tile-hover: var(--vscode-welcomePage-tileHoverBackground, var(--vscode-list-hoverBackground));
    --tile-border: var(--vscode-welcomePage-tileBorder, var(--vscode-widget-border, var(--vscode-panel-border)));
  }
  html, body {
    margin: 0;
    color: var(--vscode-foreground);
    font: 13px/1.5 var(--vscode-font-family);
    background: transparent;
  }
  .wrap { padding: 8px 10px 6px; }
  .tile {
    display: block;
    width: 100%;
    margin: 0 0 8px;
    padding: 12px;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
    border: 1px solid var(--tile-border);
    background: var(--tile-bg);
    border-radius: 6px;
  }
  .tile:last-child { margin-bottom: 0; }
  .tile:hover { background: var(--tile-hover); }
  .tile:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .tile b { display: block; margin-bottom: 4px; }
  .tile span { color: var(--vscode-descriptionForeground); font-size: 12px; }
  ${modernUiSharedCss()}
  body.modern-ui {
    --tile-bg: var(--vscode-surface-background, var(--tile-bg));
    --tile-border: var(--sf-border, var(--tile-border));
  }
  body.modern-ui .wrap { padding: 10px; }
  body.modern-ui .tile { border-radius: var(--sf-r-surface, 8px); }
</style>
</head>
<body class="${modernUiBodyClass()}">
  <div class="wrap">
    <button class="tile" id="search" type="button">
      <b>Fullscreen Search</b>
      <span>${searchHint}</span>
    </button>
    <button class="tile" id="replace" type="button">
      <b>Fullscreen Replace</b>
      <span>${replaceHint}</span>
    </button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById("search").onclick = () => vscode.postMessage({ type: "fullscreenSearch" });
  document.getElementById("replace").onclick = () => vscode.postMessage({ type: "fullscreenReplace" });
  window.addEventListener("message", (e) => {
    if (e.data?.type === "modernUi") document.body.classList.toggle("modern-ui", !!e.data.enabled);
  });
</script>
</body>
</html>`;
}

module.exports = { registerSidebarActions, pushSidebarModernUi };
