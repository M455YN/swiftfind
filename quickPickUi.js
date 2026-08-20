const vscode = require("vscode");
const { getConfig, searchByTab, openResult } = require("./searchEngine");
const { t } = require("./i18n");

/** @typedef {import("./searchEngine").SearchItem} SearchItem */

let cacheValue = "";
/** @type {SearchItem[]} */ let cacheItems = [];
/** @type {SearchItem[]} */ let cacheActiveItems = [];
let documentUpdated = true;
let searchOptions = {
  matchCase: false,
  wholeWord: false,
  useRegex: false,
  fuzzy: false,
  excludeGitIgnored: true,
  excludeSearchIgnored: true
};
let activeTab = "text";
let activeQuickPick = null;
let lastUpdateFn = null;
let searchSeq = 0;

const TABS = ["files", "folders", "text", "symbols", "commands"];
const TAB_LABELS = {
  files: () => t("Files", "Pliki"),
  folders: () => t("Folders", "Foldery"),
  text: () => t("Text", "Tekst"),
  symbols: () => t("Symbols", "Symbole"),
  commands: () => t("Commands", "Polecenia")
};
const OPTIONS = [
  {
    id: "matchCase",
    buttonKey: "case-sensitive",
    icon: "case-sensitive",
    label: () => t("Match Case", "Uwzgledniaj wielkosc liter"),
    shortcut: "Alt+C",
    aliases: ["matchCase"]
  },
  {
    id: "wholeWord",
    buttonKey: "whole-word",
    icon: "whole-word",
    label: () => t("Match Whole Word", "Dopasuj cale slowo"),
    shortcut: "Alt+W",
    aliases: ["wholeWord"]
  },
  {
    id: "useRegex",
    buttonKey: "regex",
    icon: "regex",
    label: () => t("Use Regular Expression", "Uzyj wyrazenia regularnego"),
    shortcut: "Alt+R",
    aliases: ["regex"]
  },
  {
    id: "fuzzy",
    buttonKey: "fuzzy",
    icon: "sparkle",
    label: () => t("Fuzzy Search", "Wyszukiwanie fuzzy"),
    shortcut: "Alt+F",
    aliases: ["fuzzy"]
  },
  {
    id: "excludeGitIgnored",
    buttonKey: "exclude-git",
    icon: "repo",
    label: () => t("Exclude Git Ignored", "Pomin pliki ignorowane przez Git"),
    shortcut: "Alt+G",
    aliases: ["excludeGit"]
  },
  {
    id: "excludeSearchIgnored",
    buttonKey: "exclude-searchignore",
    icon: "filter",
    label: () => t("Exclude Search Ignored", "Pomin pliki z .searchignore"),
    shortcut: "Alt+S",
    aliases: ["excludeSearchIgnore"]
  }
];
const OPTION_BY_BUTTON = Object.fromEntries(OPTIONS.map((o) => [o.buttonKey, o.id]));
const OPTION_BY_ALIAS = Object.fromEntries(
  OPTIONS.flatMap((o) => [...o.aliases, o.id].map((alias) => [alias, o.id]))
);

function markDirty() {
  documentUpdated = true;
}

function debounce(getMs, callback) {
  let timer;
  return (value) =>
    new Promise((resolve) => {
      if (timer) clearTimeout(timer);
      const ms = typeof getMs === "function" ? getMs() : getMs;
      timer = setTimeout(async () => resolve(await callback(value)), ms);
    });
}

function debounceMsForTab(tab) {
  if (tab === "files" || tab === "folders") return 60;
  if (tab === "symbols" || tab === "commands") return 120;
  return 180;
}

async function openFullscreenResults(query) {
  await vscode.commands.executeCommand("swiftFind.openFullscreen", {
    query: String(query || "").trim(),
    options: { ...searchOptions }
  });
}

function buildButtons() {
  const activeColor = new vscode.ThemeColor("textLink.foreground");
  const titleLocation = vscode.QuickInputButtonLocation?.Title;
  const inlineLocation = vscode.QuickInputButtonLocation?.Inline;
  const btn = (key, icon, tooltip, location, checked) => ({
    key,
    iconPath: new vscode.ThemeIcon(icon, checked ? activeColor : undefined),
    tooltip,
    location,
    toggle: checked !== undefined ? { checked } : undefined
  });

  const tabButtons = TABS.map((tab) =>
    btn(`tab-${tab}`, tab === "files" ? "file" : tab === "folders" ? "folder" : tab === "text" ? "symbol-text" : tab === "symbols" ? "symbol-class" : "terminal", TAB_LABELS[tab](), titleLocation, activeTab === tab)
  );
  const optionButtons = OPTIONS.map((opt) =>
    btn(
      opt.buttonKey,
      opt.icon,
      `${opt.label()} (${opt.shortcut}): ${searchOptions[opt.id] ? "ON" : "OFF"}`,
      inlineLocation,
      searchOptions[opt.id]
    )
  );
  return [
    ...tabButtons,
    ...optionButtons,
    btn("screen-full", "screen-full", t("Open fullscreen results", "Otworz pelnoekranowe wyniki"), titleLocation)
  ];
}

function setQuickPickTitle(quickPick, count) {
  const tabName = TAB_LABELS[activeTab]?.() || activeTab;
  const resultsPart = typeof count === "number" ? `: ${count} ${t("results", "wynikow")}` : "";
  quickPick.title = `${tabName}${resultsPart}`;
}

async function refreshSearch(quickPick, updateItems, value) {
  documentUpdated = true;
  searchSeq += 1;
  if (value) await updateItems(value);
  else setQuickPickTitle(quickPick);
}

/**
 * Run QuickPick search; ignore stale completions (same pattern as fullscreen requestId).
 * @param {vscode.QuickPick<vscode.QuickPickItem>} quickPick
 * @param {string} value
 */
async function runQuickPickSearch(quickPick, value) {
  const q = String(value || "").trim();
  if (!q) {
    searchSeq += 1;
    quickPick.busy = false;
    quickPick.items = [];
    cacheValue = "";
    cacheItems = [];
    setQuickPickTitle(quickPick, 0);
    return;
  }

  if (!documentUpdated && cacheValue === q) return;

  const reqId = ++searchSeq;
  const tab = activeTab;
  documentUpdated = false;
  quickPick.busy = true;
  quickPick.items = [{ label: t("Loading...", "Ladowanie..."), alwaysShow: true }];

  try {
    const items = await searchByTab(tab, q, searchOptions);
    if (reqId !== searchSeq) return;
    if (activeQuickPick !== quickPick) return;
    if (activeTab !== tab) return;
    if (String(quickPick.value || "").trim() !== q) return;

    cacheValue = q;
    cacheItems = items;
    quickPick.items = items;
    setQuickPickTitle(quickPick, items.length);
  } catch (error) {
    if (reqId !== searchSeq || activeQuickPick !== quickPick) return;
    quickPick.items = [];
    setQuickPickTitle(quickPick, 0);
    vscode.window.showErrorMessage(
      error instanceof Error ? error.message : t("Search failed", "Wyszukiwanie nie powiodlo sie")
    );
  } finally {
    if (reqId === searchSeq && activeQuickPick === quickPick) {
      quickPick.busy = false;
    }
  }
}

function openQuickSearch() {
  const quickPick = vscode.window.createQuickPick();
  activeQuickPick = quickPick;
  quickPick.matchOnDescription = false;
  quickPick.matchOnDetail = false;
  quickPick.keepScrollPosition = true;
  quickPick.placeholder = t("Search in files", "Szukaj w plikach");
  setQuickPickTitle(quickPick);
  quickPick.buttons = buildButtons();

  if (cacheValue) {
    quickPick.value = cacheValue;
    quickPick.items = cacheItems;
    quickPick.activeItems = cacheActiveItems;
  }

  const selected = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection);
  if (selected) quickPick.value = selected;

  const updateItems = debounce(() => debounceMsForTab(activeTab), (value) =>
    runQuickPickSearch(quickPick, value)
  );
  lastUpdateFn = updateItems;

  quickPick.onDidChangeValue((value) => {
    if (!getConfig().searchOnType) {
      searchSeq += 1;
      quickPick.busy = false;
      quickPick.items = [
        {
          label: t("Press Enter to search…", "Nacisnij Enter, aby szukac…"),
          alwaysShow: true,
          _sfPendingSearch: true
        }
      ];
      quickPick.activeItems = quickPick.items;
      return;
    }
    updateItems(value).catch(() => {});
  });

  quickPick.onDidAccept(async () => {
    const item = quickPick.selectedItems[0];
    if (!item || item._sfPendingSearch) {
      await updateItems(quickPick.value);
      return;
    }
    if (item.commandId) {
      await vscode.commands.executeCommand(String(item.commandId));
    } else if (item.filePath) {
      await openResult(item, false);
    } else {
      return;
    }
    quickPick.hide();
  });

  quickPick.onDidChangeActive(async (items) => {
    cacheActiveItems = items;
    if (getConfig().preview && items[0]?.filePath) await openResult(items[0], true);
  });

  quickPick.onDidTriggerButton(async (button) => {
    const key = button?.key;
    if (key?.startsWith("tab-")) {
      activeTab = key.slice(4);
      quickPick.buttons = buildButtons();
      await refreshSearch(quickPick, updateItems, quickPick.value);
      return;
    }
    const optId = OPTION_BY_BUTTON[key];
    if (optId) {
      searchOptions[optId] = !searchOptions[optId];
      quickPick.buttons = buildButtons();
      await refreshSearch(quickPick, updateItems, quickPick.value);
      return;
    }
    if (key === "screen-full") await openFullscreenResults(quickPick.value);
  });

  quickPick.show();
  quickPick.onDidHide(() => {
    if (activeQuickPick === quickPick) {
      activeQuickPick = null;
      lastUpdateFn = null;
    }
  });
}

async function refreshActiveQuickPick() {
  if (!activeQuickPick || !lastUpdateFn) return;
  activeQuickPick.buttons = buildButtons();
  await refreshSearch(activeQuickPick, lastUpdateFn, activeQuickPick.value || "");
}

function shiftTab(step) {
  activeTab = TABS[(TABS.indexOf(activeTab) + step + TABS.length) % TABS.length];
  if (activeQuickPick) setQuickPickTitle(activeQuickPick);
  refreshActiveQuickPick();
}

function toggleOption(key) {
  const opt = OPTION_BY_ALIAS[key];
  if (opt) searchOptions[opt] = !searchOptions[opt];
  refreshActiveQuickPick();
}

module.exports = {
  openQuickSearch,
  markDirty,
  toggleOption,
  nextTab: () => shiftTab(1),
  prevTab: () => shiftTab(-1)
};
