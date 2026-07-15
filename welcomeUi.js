const vscode = require("vscode");
const { isPolish } = require("./i18n");

/** @type {vscode.WebviewPanel | null} */
let welcomePanel = null;

const WELCOME_STATE_KEY = "swiftFind.hasShownWelcome";

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ force?: boolean }=} opts
 */
async function openWelcomePage(context, opts = {}) {
  const title = isPolish() ? "Witaj w SwiftFind" : "Welcome to SwiftFind";

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
  panel.webview.html = getWelcomeHtml(panel.webview, context.extensionUri);

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
      await context.globalState.update(WELCOME_STATE_KEY, true);
      panel.dispose();
    }
  });

  panel.onDidDispose(() => {
    if (welcomePanel === panel) welcomePanel = null;
    // First close counts as "seen" so startup won't reopen forever.
    void context.globalState.update(WELCOME_STATE_KEY, true);
  });
}

/**
 * Show welcome once per install/profile unless already seen.
 * @param {vscode.ExtensionContext} context
 */
async function maybeShowWelcomeOnStartup(context) {
  if (context.globalState.get(WELCOME_STATE_KEY)) return;
  await openWelcomePage(context);
}

/**
 * @param {vscode.Webview} webview
 * @param {vscode.Uri} extensionUri
 */
function getWelcomeHtml(webview, extensionUri) {
  const pl = isPolish();
  const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "icon.png"));
  const L = pl
    ? {
        brand: "SwiftFind",
        tagline: "Szybkie, zunifikowane wyszukiwanie w stylu JetBrains — pliki, foldery, tekst, symbole i polecenia.",
        openSearch: "Otwórz wyszukiwanie",
        openFullscreen: "Wyniki pełnoekranowe",
        openReplace: "Znajdź i zamień",
        openSettings: "Ustawienia SwiftFind",
        startTitle: "Jak zacząć",
        startItems: [
          ["Ctrl+Alt+Shift+Space", "Otwiera pływające wyszukiwanie (QuickPick)"],
          ["Ctrl+Alt+Shift+F", "Wyniki pełnoekranowe"],
          ["Ctrl+Alt+Shift+H", "Znajdź i zamień w plikach"],
          ["Ctrl+Shift+J, potem Space / F / H", "Alternatywa (działa przy polskiej klawiaturze / AltGr)"],
          ["Pasek statusu", "Kliknij „SwiftFind” na dole okna"],
          ["Panel boczny", "Widok SwiftFind → Search Panel"]
        ],
        tabsTitle: "Karty wyszukiwania",
        tabs: [
          ["Pliki", "Nazwy plików w workspace"],
          ["Foldery", "Ścieżki katalogów"],
          ["Tekst", "Treść plików (ripgrep + fallbacki)"],
          ["Symbole", "Klasy, funkcje, zmienne"],
          ["Polecenia", "Komendy VS Code / VSCodium"]
        ],
        keysTitle: "Skróty w oknie wyszukiwania",
        keys: [
          ["Alt+C", "Wielkość liter"],
          ["Alt+W", "Całe słowo"],
          ["Alt+R", "Regex"],
          ["Alt+F", "Fuzzy"],
          ["Alt+G", "Pomiń Git ignored"],
          ["Alt+S", "Pomiń .searchignore"],
          ["Tab / Shift+Tab", "Następna / poprzednia karta"]
        ],
        moreTitle: "Ważne zachowania",
        more: [
          "Wyniki pełnoekranowe to zawsze jeden tab — ponowne otwarcie go tylko odświeża, nie mnoży okien.",
          "Indeks plików buduje się w tle przy starcie, zmianie brancha i zmianie folderu (z krótkim toastem i licznikiem).",
          "Domyślnie pomijane są binarki i cache (np. *.bin, *.dtbcache, *.dll) — lista w Settings → SwiftFind: Exclude Globs.",
          "Dodatkowe pomijanie: plik .searchignore w rootcie workspace oraz ignorowanie Gita (przełączniki w UI).",
          "Limit wyników: ustawienie SwiftFind: Max Results (domyślnie 5000)."
        ],
        tip: "Możesz wrócić tu kiedy chcesz: Command Palette → „SwiftFind: Welcome”.",
        dontShow: "Nie pokazuj przy starcie"
      }
    : {
        brand: "SwiftFind",
        tagline: "Fast unified search inspired by JetBrains — files, folders, text, symbols, and commands.",
        openSearch: "Open search",
        openFullscreen: "Fullscreen results",
        openReplace: "Find and replace",
        openSettings: "SwiftFind settings",
        startTitle: "Getting started",
        startItems: [
          ["Ctrl+Alt+Shift+Space", "Opens floating search (QuickPick)"],
          ["Ctrl+Alt+Shift+F", "Fullscreen results"],
          ["Ctrl+Alt+Shift+H", "Find and replace in files"],
          ["Ctrl+Shift+J, then Space / F / H", "Fallback (works with Polish keyboard / AltGr)"],
          ["Status bar", "Click “SwiftFind” at the bottom"],
          ["Sidebar", "SwiftFind view → Search Panel"]
        ],
        tabsTitle: "Search tabs",
        tabs: [
          ["Files", "Workspace filenames"],
          ["Folders", "Directory paths"],
          ["Text", "File contents (ripgrep + fallbacks)"],
          ["Symbols", "Classes, functions, variables"],
          ["Commands", "VS Code / VSCodium commands"]
        ],
        keysTitle: "Shortcuts while searching",
        keys: [
          ["Alt+C", "Match case"],
          ["Alt+W", "Whole word"],
          ["Alt+R", "Regex"],
          ["Alt+F", "Fuzzy"],
          ["Alt+G", "Exclude Git ignored"],
          ["Alt+S", "Exclude .searchignore"],
          ["Tab / Shift+Tab", "Next / previous tab"]
        ],
        moreTitle: "Things worth knowing",
        more: [
          "Fullscreen results always reuse one tab — opening again refreshes it instead of spawning duplicates.",
          "A file index builds in the background on startup, branch switch, and folder change (short toast with count).",
          "Binaries/caches are skipped by default (e.g. *.bin, *.dtbcache, *.dll) — edit Settings → SwiftFind: Exclude Globs.",
          "Extra ignores: workspace .searchignore and Git ignore toggles in the UI.",
          "Result limit: SwiftFind: Max Results (default 5000)."
        ],
        tip: "Reopen anytime: Command Palette → “SwiftFind: Welcome”.",
        dontShow: "Don’t show on startup"
      };

  const startRows = L.startItems
    .map(
      ([k, v]) =>
        `<div class="row"><kbd>${escapeHtml(k)}</kbd><span>${escapeHtml(v)}</span></div>`
    )
    .join("");
  const tabRows = L.tabs
    .map(
      ([k, v]) =>
        `<div class="row"><strong>${escapeHtml(k)}</strong><span>${escapeHtml(v)}</span></div>`
    )
    .join("");
  const keyRows = L.keys
    .map(
      ([k, v]) =>
        `<div class="row"><kbd>${escapeHtml(k)}</kbd><span>${escapeHtml(v)}</span></div>`
    )
    .join("");
  const moreItems = L.more.map((m) => `<li>${escapeHtml(m)}</li>`).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background:
        radial-gradient(1200px 420px at 10% -10%, color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent), transparent 60%),
        var(--vscode-editor-background);
      line-height: 1.45;
    }
    .wrap {
      max-width: 860px;
      margin: 0 auto;
      padding: 28px 22px 40px;
    }
    .hero {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 16px;
      align-items: center;
      margin-bottom: 22px;
    }
    .hero img {
      width: 64px;
      height: 64px;
      border-radius: 14px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 28px;
      letter-spacing: -0.02em;
      font-weight: 700;
    }
    .tagline {
      margin: 0;
      opacity: 0.9;
      font-size: 14px;
      max-width: 58ch;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 18px 0 8px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      padding: 8px 12px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.linkish {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border-color: transparent;
      padding-left: 4px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    @media (max-width: 720px) {
      .hero { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
    }
    section {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      padding: 12px 14px;
      background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 4%);
    }
    section.wide { grid-column: 1 / -1; }
    h2 {
      margin: 0 0 10px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.8;
      font-weight: 650;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(120px, 150px) 1fr;
      gap: 10px;
      padding: 6px 0;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
      font-size: 13px;
    }
    .row:first-of-type { border-top: 0; }
    kbd {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      justify-self: start;
      white-space: nowrap;
    }
    ul {
      margin: 0;
      padding-left: 18px;
      font-size: 13px;
    }
    li { margin: 6px 0; }
    .tip {
      margin-top: 16px;
      font-size: 12px;
      opacity: 0.8;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <img src="${iconUri}" alt="" />
      <div>
        <h1>${escapeHtml(L.brand)}</h1>
        <p class="tagline">${escapeHtml(L.tagline)}</p>
      </div>
    </div>

    <div class="actions">
      <button class="primary" data-cmd="swiftFind.open">${escapeHtml(L.openSearch)}</button>
      <button class="secondary" data-cmd="swiftFind.openFullscreen">${escapeHtml(L.openFullscreen)}</button>
      <button class="secondary" data-cmd="swiftFind.openReplace">${escapeHtml(L.openReplace)}</button>
      <button class="secondary" id="btnSettings">${escapeHtml(L.openSettings)}</button>
    </div>

    <div class="grid">
      <section>
        <h2>${escapeHtml(L.startTitle)}</h2>
        ${startRows}
      </section>
      <section>
        <h2>${escapeHtml(L.tabsTitle)}</h2>
        ${tabRows}
      </section>
      <section>
        <h2>${escapeHtml(L.keysTitle)}</h2>
        ${keyRows}
      </section>
      <section class="wide">
        <h2>${escapeHtml(L.moreTitle)}</h2>
        <ul>${moreItems}</ul>
      </section>
    </div>

    <div class="tip">
      <span>${escapeHtml(L.tip)}</span>
      <button class="linkish" id="btnDismiss">${escapeHtml(L.dontShow)}</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    for (const b of document.querySelectorAll("[data-cmd]")) {
      b.addEventListener("click", () => {
        vscode.postMessage({ type: "run", command: b.getAttribute("data-cmd") });
      });
    }
    document.getElementById("btnSettings").addEventListener("click", () => {
      vscode.postMessage({ type: "openSettings" });
    });
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
  WELCOME_STATE_KEY
};
