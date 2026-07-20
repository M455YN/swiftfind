const vscode = require("vscode");
const { isPolish } = require("./i18n");

/** @type {vscode.WebviewPanel | null} */
let welcomePanel = null;

const WELCOME_VERSION_KEY = "swiftFind.lastWelcomeVersion";
/** @deprecated legacy flag — migrated to version-based welcome */
const WELCOME_STATE_KEY = "swiftFind.hasShownWelcome";

function getExtensionVersion(context) {
  return String(context.extension?.packageJSON?.version || "0.0.0");
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function markWelcomeSeen(context) {
  await context.globalState.update(WELCOME_VERSION_KEY, getExtensionVersion(context));
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ force?: boolean, isUpdate?: boolean }=} opts
 */
async function openWelcomePage(context, opts = {}) {
  const title = isPolish() ? "Witaj w SwiftFind" : "Welcome to SwiftFind";
  const version = getExtensionVersion(context);
  const isUpdate = Boolean(opts.isUpdate);

  if (welcomePanel) {
    welcomePanel.title = title;
    welcomePanel.reveal(vscode.ViewColumn.Active, false);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "swiftFindWelcome",
    title,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] }
  );
  welcomePanel = panel;
  panel.webview.html = getWelcomeHtml(panel.webview, context.extensionUri, { version, isUpdate });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "run") {
      const cmd = String(msg.command || "");
      if (!cmd) return;
      await vscode.commands.executeCommand(cmd);
      return;
    }
    if (msg.type === "openSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "swiftFind");
      return;
    }
    if (msg.type === "dontShowAgain") {
      await markWelcomeSeen(context);
      panel.dispose();
    }
  });

  panel.onDidDispose(() => {
    if (welcomePanel === panel) welcomePanel = null;
    void markWelcomeSeen(context);
  });
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function maybeShowWelcomeOnStartup(context) {
  const current = getExtensionVersion(context);
  const last = context.globalState.get(WELCOME_VERSION_KEY);

  // Migrate users who dismissed welcome before version tracking existed.
  if (!last && context.globalState.get(WELCOME_STATE_KEY)) {
    await markWelcomeSeen(context);
    return;
  }

  if (last === current) return;
  await openWelcomePage(context, { isUpdate: Boolean(last) });
}

/**
 * @param {vscode.Webview} webview
 * @param {vscode.Uri} extensionUri
 * @param {{ version?: string, isUpdate?: boolean }=} meta
 */
function getWelcomeHtml(webview, extensionUri, meta = {}) {
  const pl = isPolish();
  const version = String(meta.version || "");
  const isUpdate = Boolean(meta.isUpdate);
  const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "icon.png"));
  const csp = webview.cspSource;

  const L = pl
    ? {
        getStarted: isUpdate ? `SwiftFind ${version}` : "Witaj w SwiftFind",
        tagline: isUpdate
          ? `Zaktualizowano do wersji ${version}. Szybkie wyszukiwanie plików, folderów, tekstu, symboli i poleceń — w jednym miejscu.`
          : "Szybkie wyszukiwanie plików, folderów, tekstu, symboli i poleceń — w jednym miejscu.",
        start: "Start",
        openSearch: "Otwórz wyszukiwanie",
        openSearchDesc: "Pływające okno QuickPick",
        openFullscreen: "Wyniki pełnoekranowe",
        openFullscreenDesc: "Find in Files w stylu Rider",
        openReplace: "Znajdź i zamień",
        openReplaceDesc: "Zamień w zakresie workspace",
        openSettings: "Ustawienia",
        openSettingsDesc: "Max results, exclude globs, search on type",
        rebuildIndex: "Odbuduj indeks",
        rebuildIndexDesc: "Usuń cache i zbuduj listę plików od nowa",
        walkthrough: "Pierwsze kroki",
        steps: [
          ["Otwórz wyszukiwanie", "Ctrl+Alt+Shift+Space", "swiftFind.open"],
          ["Pełny ekran wyników", "Ctrl+Alt+Shift+F", "swiftFind.openFullscreen"],
          ["Znajdź i zamień", "Ctrl+Alt+Shift+H", "swiftFind.openReplace"],
          ["Task Runner", "Widok SwiftFind → Task Runner", "swiftFind.focusTasks"]
        ],
        chordNote: "Na polskiej klawiaturze: Ctrl+Shift+J, potem Space / F / H",
        learn: "Warto wiedzieć",
        learnItems: [
          ["Karty", "Pliki · Foldery · Tekst · Symbole · Polecenia"],
          ["Cache indeksu", ".vscode/swiftfind-path-index.cache — bez .gitignore / bin / obj"],
          ["Szukanie tekstu", "Tylko w plikach z cache (spójne z kartą Pliki)"],
          ["Odbudowa cache", "Command Palette → „SwiftFind: Odbuduj cache indeksu plików”"],
          ["PPM w Explorerze", "Szukaj tutaj / Zamień tutaj na pliku lub folderze"],
          ["Wyniki", "Jeden tab fullscreen — ponowne otwarcie tylko odświeża"]
        ],
        tip: "Ponownie: Command Palette → „SwiftFind: Witaj”.",
        dontShow: "Nie pokazuj dla tej wersji"
      }
    : {
        getStarted: isUpdate ? `SwiftFind ${version}` : "Welcome to SwiftFind",
        tagline: isUpdate
          ? `Updated to version ${version}. Fast search for files, folders, text, symbols, and commands — in one place.`
          : "Fast search for files, folders, text, symbols, and commands — in one place.",
        start: "Start",
        openSearch: "Open search",
        openSearchDesc: "Floating QuickPick window",
        openFullscreen: "Fullscreen results",
        openFullscreenDesc: "Rider-style Find in Files",
        openReplace: "Find and replace",
        openReplaceDesc: "Replace across the workspace scope",
        openSettings: "Settings",
        openSettingsDesc: "Max results, exclude globs, search on type",
        rebuildIndex: "Rebuild index",
        rebuildIndexDesc: "Delete cache and rebuild the file list",
        walkthrough: "Walkthrough",
        steps: [
          ["Open search", "Ctrl+Alt+Shift+Space", "swiftFind.open"],
          ["Fullscreen results", "Ctrl+Alt+Shift+F", "swiftFind.openFullscreen"],
          ["Find and replace", "Ctrl+Alt+Shift+H", "swiftFind.openReplace"],
          ["Task Runner", "SwiftFind view → Task Runner", "swiftFind.focusTasks"]
        ],
        chordNote: "Polish / AltGr fallback: Ctrl+Shift+J, then Space / F / H",
        learn: "Learn",
        learnItems: [
          ["Tabs", "Files · Folders · Text · Symbols · Commands"],
          ["Index cache", ".vscode/swiftfind-path-index.cache — skips .gitignore / bin / obj"],
          ["Text search", "Only files from the cache (same set as the Files tab)"],
          ["Rebuild cache", "Command Palette → “SwiftFind: Rebuild File Index Cache”"],
          ["Explorer context menu", "Search Here / Replace Here on a file or folder"],
          ["Results", "One fullscreen tab — reopen refreshes instead of duplicating"]
        ],
        tip: "Reopen anytime: Command Palette → “SwiftFind: Welcome”.",
        dontShow: "Don't show for this version"
      };

  const tiles = [
    ["swiftFind.open", L.openSearch, L.openSearchDesc],
    ["swiftFind.openFullscreen", L.openFullscreen, L.openFullscreenDesc],
    ["swiftFind.openReplace", L.openReplace, L.openReplaceDesc],
    ["swiftFind.rebuildIndex", L.rebuildIndex, L.rebuildIndexDesc],
    ["settings", L.openSettings, L.openSettingsDesc]
  ]
    .map(
      ([id, title, desc]) => `
      <button class="tile" type="button" data-cmd="${escapeHtml(id)}">
        <div class="tile-title">${escapeHtml(title)}</div>
        <div class="tile-desc">${escapeHtml(desc)}</div>
      </button>`
    )
    .join("");

  const steps = L.steps
    .map(
      ([title, binding, cmd], i) => `
      <button class="step" type="button" data-cmd="${escapeHtml(cmd)}">
        <span class="step-num">${i + 1}</span>
        <span class="step-body">
          <span class="step-title">${escapeHtml(title)}</span>
          <span class="step-bind">${escapeHtml(binding)}</span>
        </span>
      </button>`
    )
    .join("");

  const learn = L.learnItems
    .map(
      ([title, desc]) => `
      <div class="learn-row">
        <div class="learn-title">${escapeHtml(title)}</div>
        <div class="learn-desc">${escapeHtml(desc)}</div>
      </div>`
    )
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root {
      --tile-bg: var(--vscode-welcomePage-tileBackground, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      --tile-hover: var(--vscode-welcomePage-tileHoverBackground, var(--vscode-list-hoverBackground));
      --tile-border: var(--vscode-welcomePage-tileBorder, var(--vscode-widget-border, var(--vscode-panel-border)));
      --muted: var(--vscode-descriptionForeground, color-mix(in srgb, var(--vscode-foreground) 65%, transparent));
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }
    .page {
      max-width: 920px;
      margin: 0 auto;
      padding: 32px 28px 48px;
    }
    .header {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 28px;
    }
    .header img {
      width: 48px;
      height: 48px;
      border-radius: 8px;
      flex: 0 0 auto;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 26px;
      font-weight: 400;
      letter-spacing: -0.01em;
      line-height: 1.25;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      max-width: 62ch;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 600;
    }
    .section { margin-top: 28px; }
    .tiles {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 840px) {
      .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 480px) {
      .tiles { grid-template-columns: 1fr; }
      .page { padding: 20px 16px 36px; }
    }
    .tile, .step {
      appearance: none;
      text-align: left;
      font: inherit;
      color: inherit;
      cursor: pointer;
      border: 1px solid var(--tile-border);
      background: var(--tile-bg);
      border-radius: 6px;
      transition: background .12s ease, border-color .12s ease;
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 14px 14px 16px;
      min-height: 88px;
    }
    .tile:hover, .step:hover {
      background: var(--tile-hover);
      border-color: var(--vscode-focusBorder, var(--tile-border));
    }
    .tile:focus-visible, .step:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .tile-title { font-weight: 600; font-size: 13px; }
    .tile-desc { color: var(--muted); font-size: 12px; line-height: 1.4; }
    .steps {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 640px;
    }
    .step {
      display: grid;
      grid-template-columns: 28px 1fr;
      gap: 12px;
      align-items: center;
      padding: 10px 12px;
    }
    .step-num {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 600;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .step-body {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
    }
    .step-title { font-weight: 600; }
    .step-bind {
      color: var(--muted);
      font-family: var(--vscode-editor-font-family), Consolas, monospace;
      font-size: 12px;
      white-space: nowrap;
    }
    .note {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
    .learn {
      border: 1px solid var(--tile-border);
      background: var(--tile-bg);
      border-radius: 6px;
      overflow: hidden;
      max-width: 640px;
    }
    .learn-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 12px;
      padding: 10px 14px;
      border-top: 1px solid var(--tile-border);
    }
    .learn-row:first-child { border-top: 0; }
    .learn-title { font-weight: 600; }
    .learn-desc { color: var(--muted); }
    @media (max-width: 560px) {
      .learn-row { grid-template-columns: 1fr; gap: 2px; }
      .step-body { flex-direction: column; align-items: flex-start; gap: 2px; }
    }
    .footer {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid var(--tile-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
    }
    .link {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--vscode-textLink-foreground);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      padding: 0;
    }
    .link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <img src="${iconUri}" alt="" />
      <div>
        <h1>${escapeHtml(L.getStarted)}</h1>
        <p class="subtitle">${escapeHtml(L.tagline)}</p>
      </div>
    </div>

    <div class="section">
      <h2>${escapeHtml(L.start)}</h2>
      <div class="tiles">${tiles}</div>
    </div>

    <div class="section">
      <h2>${escapeHtml(L.walkthrough)}</h2>
      <div class="steps">${steps}</div>
      <p class="note">${escapeHtml(L.chordNote)}</p>
    </div>

    <div class="section">
      <h2>${escapeHtml(L.learn)}</h2>
      <div class="learn">${learn}</div>
    </div>

    <div class="footer">
      <span>${escapeHtml(L.tip)}</span>
      <button type="button" class="link" id="btnDismiss">${escapeHtml(L.dontShow)}</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    for (const el of document.querySelectorAll("[data-cmd]")) {
      el.addEventListener("click", () => {
        const cmd = el.getAttribute("data-cmd");
        if (cmd === "settings") {
          vscode.postMessage({ type: "openSettings" });
          return;
        }
        vscode.postMessage({ type: "run", command: cmd });
      });
    }
    document.getElementById("btnDismiss").addEventListener("click", () => {
      vscode.postMessage({ type: "dontShowAgain" });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

module.exports = {
  openWelcomePage,
  maybeShowWelcomeOnStartup,
  WELCOME_VERSION_KEY,
  WELCOME_STATE_KEY
};
