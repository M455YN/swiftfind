const vscode = require("vscode");
const { isPolish } = require("./i18n");

/**
 * Left sidebar: VS Code-style action tiles above Task Runner.
 * @param {vscode.ExtensionContext} context
 */
function registerSidebarActions(context) {
  const provider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = getHtml(webviewView.webview);
      webviewView.webview.onDidReceiveMessage(async (msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "fullscreenSearch") {
          await vscode.commands.executeCommand("swiftFind.openFullscreen");
          return;
        }
        if (msg.type === "fullscreenReplace") {
          await vscode.commands.executeCommand("swiftFind.openReplace");
        }
      });
    }
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("swiftFind.sidebarActions", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}

/**
 * @param {vscode.Webview} webview
 */
function getHtml(webview) {
  const pl = isPolish();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`
  ].join("; ");

  const L = pl
    ? {
        search: "Fullscreen Search",
        searchDesc: "Szukaj w projekcie — Find in Files",
        replace: "Fullscreen Replace",
        replaceDesc: "Znajdź i zamień w plikach workspace"
      }
    : {
        search: "Fullscreen Search",
        searchDesc: "Search in project — Find in Files",
        replace: "Fullscreen Replace",
        replaceDesc: "Find and replace across workspace files"
      };

  return `<!DOCTYPE html>
<html lang="${pl ? "pl" : "en"}">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  :root {
    --tile-bg: var(--vscode-welcomePage-tileBackground, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
    --tile-hover: var(--vscode-welcomePage-tileHoverBackground, var(--vscode-list-hoverBackground));
    --tile-border: var(--vscode-welcomePage-tileBorder, var(--vscode-widget-border, var(--vscode-panel-border)));
    --muted: var(--vscode-descriptionForeground, color-mix(in srgb, var(--vscode-foreground) 65%, transparent));
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: transparent;
    line-height: 1.5;
  }
  .wrap {
    padding: 8px 10px 6px;
  }
  .tiles {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tile {
    appearance: none;
    width: 100%;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
    border: 1px solid var(--tile-border);
    background: var(--tile-bg);
    border-radius: 6px;
    padding: 12px 12px 13px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: background .12s ease, border-color .12s ease;
  }
  .tile:hover {
    background: var(--tile-hover);
    border-color: var(--vscode-focusBorder, var(--tile-border));
  }
  .tile:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  .tile-title {
    font-weight: 600;
    font-size: 13px;
    line-height: 1.3;
  }
  .tile-desc {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.4;
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="tiles">
      <button class="tile" id="btnSearch" type="button">
        <div class="tile-title">${L.search}</div>
        <div class="tile-desc">${L.searchDesc}</div>
      </button>
      <button class="tile" id="btnReplace" type="button">
        <div class="tile-title">${L.replace}</div>
        <div class="tile-desc">${L.replaceDesc}</div>
      </button>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById("btnSearch").addEventListener("click", () => {
    vscode.postMessage({ type: "fullscreenSearch" });
  });
  document.getElementById("btnReplace").addEventListener("click", () => {
    vscode.postMessage({ type: "fullscreenReplace" });
  });
</script>
</body>
</html>`;
}

module.exports = { registerSidebarActions };
