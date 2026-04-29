const vscode = require("vscode");
const { getConfig, searchByTab, openResult } = require("./searchEngine");
const { t } = require("./i18n");

/**
 * @typedef {import("./searchEngine").SearchItem} SearchItem
 */

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

function markDirty() {
  documentUpdated = true;
}

function debounce(ms, callback) {
  let timer;
  return (value) =>
    new Promise((resolve) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => resolve(await callback(value)), ms);
    });
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
  const toggle = (checked) => ({ checked });
  return [
    {
      key: "tab-files",
      iconPath: new vscode.ThemeIcon("file", activeTab === "files" ? activeColor : undefined),
      tooltip: t("Files", "Pliki"),
      location: titleLocation,
      toggle: toggle(activeTab === "files")
    },
    {
      key: "tab-folders",
      iconPath: new vscode.ThemeIcon("folder", activeTab === "folders" ? activeColor : undefined),
      tooltip: t("Folders", "Foldery"),
      location: titleLocation,
      toggle: toggle(activeTab === "folders")
    },
    {
      key: "tab-text",
      iconPath: new vscode.ThemeIcon("symbol-text", activeTab === "text" ? activeColor : undefined),
      tooltip: t("Text", "Tekst"),
      location: titleLocation,
      toggle: toggle(activeTab === "text")
    },
    {
      key: "tab-symbols",
      iconPath: new vscode.ThemeIcon("symbol-class", activeTab === "symbols" ? activeColor : undefined),
      tooltip: t("Symbols", "Symbole"),
      location: titleLocation,
      toggle: toggle(activeTab === "symbols")
    },
    {
      key: "tab-commands",
      iconPath: new vscode.ThemeIcon("terminal", activeTab === "commands" ? activeColor : undefined),
      tooltip: t("Commands", "Polecenia"),
      location: titleLocation,
      toggle: toggle(activeTab === "commands")
    },
    {
      key: "case-sensitive",
      iconPath: new vscode.ThemeIcon("case-sensitive", searchOptions.matchCase ? activeColor : undefined),
      tooltip: t("Match Case", "Uwzgledniaj wielkosc liter") + ` (Alt+C): ${searchOptions.matchCase ? "ON" : "OFF"}`,
      location: inlineLocation,
      toggle: toggle(searchOptions.matchCase)
    },
    {
      key: "whole-word",
      iconPath: new vscode.ThemeIcon("whole-word", searchOptions.wholeWord ? activeColor : undefined),
      tooltip: t("Match Whole Word", "Dopasuj cale slowo") + ` (Alt+W): ${searchOptions.wholeWord ? "ON" : "OFF"}`,
      location: inlineLocation,
      toggle: toggle(searchOptions.wholeWord)
    },
    {
      key: "regex",
      iconPath: new vscode.ThemeIcon("regex", searchOptions.useRegex ? activeColor : undefined),
      tooltip: t("Use Regular Expression", "Uzyj wyrazenia regularnego") + ` (Alt+R): ${searchOptions.useRegex ? "ON" : "OFF"}`,
      location: inlineLocation,
      toggle: toggle(searchOptions.useRegex)
    },
    {
      key: "fuzzy",
      iconPath: new vscode.ThemeIcon("sparkle", searchOptions.fuzzy ? activeColor : undefined),
      tooltip: t("Fuzzy Search", "Wyszukiwanie fuzzy") + ` (Alt+F): ${searchOptions.fuzzy ? "ON" : "OFF"}`,
      location: inlineLocation,
      toggle: toggle(searchOptions.fuzzy)
    },
    {
      key: "exclude-git",
      iconPath: new vscode.ThemeIcon("repo", searchOptions.excludeGitIgnored ? activeColor : undefined),
      tooltip: t("Exclude Git Ignored", "Pomin pliki ignorowane przez Git") + ` (Alt+G): ${searchOptions.excludeGitIgnored ? "ON" : "OFF"}`,
      location: inlineLocation,
      toggle: toggle(searchOptions.excludeGitIgnored)
    },
    {
      key: "exclude-searchignore",
      iconPath: new vscode.ThemeIcon("filter", searchOptions.excludeSearchIgnored ? activeColor : undefined),
      tooltip: t("Exclude Search Ignored", "Pomin pliki z .searchignore") + ` (Alt+S): ${searchOptions.excludeSearchIgnored ? "ON" : "OFF"}`,
      location: inlineLocation,
      toggle: toggle(searchOptions.excludeSearchIgnored)
    },
    {
      key: "screen-full",
      iconPath: new vscode.ThemeIcon("screen-full"),
      tooltip: t("Open fullscreen results", "Otworz pelnoekranowe wyniki"),
      location: titleLocation
    }
  ];
}

function setQuickPickTitle(quickPick, count) {
  const tabName = {
    files: t("Files", "Pliki"),
    folders: t("Folders", "Foldery"),
    text: t("Text", "Tekst"),
    symbols: t("Symbols", "Symbole"),
    commands: t("Commands", "Polecenia")
  }[activeTab] || activeTab;
  const resultsPart =
    typeof count === "number" ? `: ${count} ${t("results", "wynikow")}` : "";
  quickPick.title = `${tabName}${resultsPart}`;
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

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const selected = activeEditor.document.getText(activeEditor.selection);
    if (selected) quickPick.value = selected;
  }

  const updateItems = debounce(180, async (value) => {
    if (!documentUpdated && cacheValue === value) return;
    documentUpdated = false;
    quickPick.busy = true;
    quickPick.items = [{ label: t("Loading...", "Ladowanie..."), alwaysShow: true }];
    const items = await searchByTab(activeTab, value, searchOptions);
    const grouped = items;
    cacheValue = value;
    cacheItems = grouped;
    quickPick.items = grouped;
    setQuickPickTitle(quickPick, grouped.length);
    quickPick.busy = false;
  });
  lastUpdateFn = updateItems;

  quickPick.onDidChangeValue((value) => {
    updateItems(value).catch((error) => {
      quickPick.busy = false;
      quickPick.items = [];
      vscode.window.showErrorMessage(error instanceof Error ? error.message : t("Search failed", "Wyszukiwanie nie powiodlo sie"));
    });
  });

  quickPick.onDidAccept(async () => {
    const item = quickPick.selectedItems[0];
    if (!item) return;
    if (item.commandId) {
      await vscode.commands.executeCommand(String(item.commandId));
      quickPick.hide();
      return;
    }
    if (!item.filePath) return;
    await openResult(item, false);
    quickPick.hide();
  });

  quickPick.onDidChangeActive(async (items) => {
    cacheActiveItems = items;
    if (getConfig().preview && items.length && items[0].filePath) {
      await openResult(items[0], true);
    }
  });

  quickPick.onDidTriggerButton(async (button) => {
    const key = button?.key;
    if (key?.startsWith("tab-")) {
      activeTab = key.replace("tab-", "");
      quickPick.buttons = buildButtons();
      documentUpdated = true;
      if (quickPick.value) {
        await updateItems(quickPick.value);
      } else {
        setQuickPickTitle(quickPick);
      }
      return;
    }
    if (key === "case-sensitive") {
      searchOptions.matchCase = !searchOptions.matchCase;
      quickPick.buttons = buildButtons();
      documentUpdated = true;
      if (quickPick.value) {
        await updateItems(quickPick.value);
      }
      return;
    }
    if (key === "whole-word") {
      searchOptions.wholeWord = !searchOptions.wholeWord;
      quickPick.buttons = buildButtons();
      documentUpdated = true;
      if (quickPick.value) {
        await updateItems(quickPick.value);
      }
      return;
    }
    if (key === "regex") {
      searchOptions.useRegex = !searchOptions.useRegex;
      quickPick.buttons = buildButtons();
      documentUpdated = true;
      if (quickPick.value) {
        await updateItems(quickPick.value);
      }
      return;
    }
    if (key === "fuzzy") {
      searchOptions.fuzzy = !searchOptions.fuzzy;
      quickPick.buttons = buildButtons();
      documentUpdated = true;
      if (quickPick.value) await updateItems(quickPick.value);
      return;
    }
    if (key === "exclude-git") {
      searchOptions.excludeGitIgnored = !searchOptions.excludeGitIgnored;
      quickPick.buttons = buildButtons();
      documentUpdated = true;
      if (quickPick.value) await updateItems(quickPick.value);
      return;
    }
    if (key === "exclude-searchignore") {
      searchOptions.excludeSearchIgnored = !searchOptions.excludeSearchIgnored;
      quickPick.buttons = buildButtons();
      documentUpdated = true;
      if (quickPick.value) await updateItems(quickPick.value);
      return;
    }
    if (key === "screen-full") {
      await openFullscreenResults(quickPick.value);
    }
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
  const value = activeQuickPick.value || "";
  activeQuickPick.buttons = buildButtons();
  if (value) {
    documentUpdated = true;
    await lastUpdateFn(value);
  }
}

function shiftTab(step) {
  const tabs = ["files", "folders", "text", "symbols", "commands"];
  const i = tabs.indexOf(activeTab);
  const next = (i + step + tabs.length) % tabs.length;
  activeTab = tabs[next];
  if (activeQuickPick) {
    setQuickPickTitle(activeQuickPick);
  }
  refreshActiveQuickPick();
}

function toggleOption(key) {
  if (key === "matchCase") searchOptions.matchCase = !searchOptions.matchCase;
  if (key === "wholeWord") searchOptions.wholeWord = !searchOptions.wholeWord;
  if (key === "regex") searchOptions.useRegex = !searchOptions.useRegex;
  if (key === "fuzzy") searchOptions.fuzzy = !searchOptions.fuzzy;
  if (key === "excludeGit") searchOptions.excludeGitIgnored = !searchOptions.excludeGitIgnored;
  if (key === "excludeSearchIgnore") searchOptions.excludeSearchIgnored = !searchOptions.excludeSearchIgnored;
  refreshActiveQuickPick();
}

module.exports = {
  openQuickSearch,
  markDirty,
  toggleOption,
  nextTab: () => shiftTab(1),
  prevTab: () => shiftTab(-1)
};
