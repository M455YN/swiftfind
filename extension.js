const vscode = require("vscode");
const { openQuickSearch, markDirty, toggleOption, nextTab, prevTab } = require("./quickPickUi");
const { openFullscreenSearch, pushFullscreenConfig } = require("./fullscreenUi");
const { TasksExplorerProvider } = require("./tasksExplorer");
const { openReplacePanel, replaceInActiveEditor } = require("./replaceUi");
const { initPathIndexWatchers, patchPathIndexFromFs, flushPathIndexCache, rebuildPathIndexCache } = require("./searchEngine");
const { openWelcomePage, maybeShowWelcomeOnStartup, pushWelcomeModernUi } = require("./welcomeUi");
const { registerSidebarActions, pushSidebarModernUi } = require("./sidebarActionsUi");
const { watchModernUi } = require("./modernUi");

function onFilesMutated(e, kind) {
  const uris = Array.isArray(e?.files) ? e.files : [];
  if (kind === "deleted") {
    patchPathIndexFromFs({ deleted: uris });
    markDirty();
    return;
  }
  Promise.all(
    uris.map(async (uri) => {
      try {
        const st = await vscode.workspace.fs.stat(uri);
        return st.type & vscode.FileType.File ? uri : null;
      } catch {
        return null;
      }
    })
  ).then((list) => {
    const created = list.filter(Boolean);
    if (created.length) patchPathIndexFromFs({ created });
    markDirty();
  });
}

function onFilesRenamed(e) {
  patchPathIndexFromFs({ renamed: e?.files || [] });
  markDirty();
}

/** Relative workspace path for Explorer context menu URI. */
function scopePathFromExplorerArgs(uri, uris) {
  const target = uri || (Array.isArray(uris) ? uris[0] : undefined);
  if (!target || target.scheme === "untitled") return "";
  const rel = vscode.workspace.asRelativePath(target, false);
  if (!rel || rel === target.fsPath) return "";
  return String(rel).replaceAll("\\", "/");
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "swiftFind.open";
  statusBarItem.text = "$(search-view-icon) SwiftFind";
  statusBarItem.tooltip = "Open SwiftFind";
  statusBarItem.show();

  const tasksProvider = new TasksExplorerProvider(rootPath || "");

  initPathIndexWatchers(context, {
    onInvalidate: (reason) => {
      if (reason === "git-head" || reason === "workspace") {
        markDirty();
      }
    }
  });

  context.subscriptions.push({
    dispose: () => {
      flushPathIndexCache().catch(() => {});
    }
  });

  maybeShowWelcomeOnStartup(context).catch(() => {});
  registerSidebarActions(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("swiftFind.searchOnType")) {
        pushFullscreenConfig();
      }
    }),
    watchModernUi((enabled) => {
      pushFullscreenConfig();
      pushWelcomeModernUi(enabled);
      pushSidebarModernUi(enabled);
    })
  );

  context.subscriptions.push(
    statusBarItem,
    vscode.workspace.onDidSaveTextDocument((doc) => {
      markDirty();
      const p = String(doc?.uri?.fsPath || "").replaceAll("\\", "/").toLowerCase();
      if (p.endsWith("/.vscode/tasks.json")) {
        tasksProvider.refresh();
      }
    }),
    vscode.workspace.onDidDeleteFiles((e) => onFilesMutated(e, "deleted")),
    vscode.workspace.onDidCreateFiles((e) => onFilesMutated(e, "created")),
    vscode.workspace.onDidRenameFiles(onFilesRenamed),
    vscode.window.registerTreeDataProvider("swiftFind.tasksExplorer", tasksProvider),
    vscode.commands.registerCommand("swiftFind.tasks.refresh", () => tasksProvider.refresh()),
    vscode.commands.registerCommand("swiftFind.tasks.openTask", async (node) => {
      if (!node?.taskName) return;
      const tasks = await vscode.tasks.fetchTasks();
      const task = tasks.find((t) => {
        if (t.name !== node.taskName) return false;
        const scope = t.scope;
        if (!node.taskScope) return true;
        if (scope === node.taskScope) return true;
        if (
          scope &&
          typeof scope === "object" &&
          node.taskScope &&
          typeof node.taskScope === "object" &&
          "uri" in scope &&
          "uri" in node.taskScope
        ) {
          return scope.uri?.toString() === node.taskScope.uri?.toString();
        }
        return false;
      });
      if (!task) {
        vscode.window.showWarningMessage(`Task '${node.taskName}' not found.`);
        return;
      }
      await vscode.tasks.executeTask(task);
    }),
    vscode.commands.registerCommand("swiftFind.tasks.openDefinition", async (node) => {
      const filePath = String(node?.tasksFilePath || "");
      if (!filePath) {
        vscode.window.showWarningMessage("tasks.json path not found for this task.");
        return;
      }
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const taskName = String(node?.taskName || "").trim();
      if (!taskName) return;

      const escaped = taskName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`"label"\\s*:\\s*"${escaped}"`);
      let targetLine = 0;
      for (let i = 0; i < doc.lineCount; i += 1) {
        if (re.test(doc.lineAt(i).text)) {
          targetLine = i;
          break;
        }
      }

      const pos = new vscode.Position(targetLine, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }),
    vscode.commands.registerCommand("swiftFind.explorer.searchHere", async (uri, uris) => {
      const scopePath = scopePathFromExplorerArgs(uri, uris);
      if (!scopePath) {
        vscode.window.showWarningMessage(
          "SwiftFind: open a workspace folder to search from Explorer."
        );
        return;
      }
      await openFullscreenSearch({
        query: "",
        options: { scopePath }
      });
    }),
    vscode.commands.registerCommand("swiftFind.explorer.replaceHere", async (uri, uris) => {
      const scopePath = scopePathFromExplorerArgs(uri, uris);
      if (!scopePath) {
        vscode.window.showWarningMessage(
          "SwiftFind: open a workspace folder to replace from Explorer."
        );
        return;
      }
      openReplacePanel({
        find: "",
        replace: "",
        options: {
          scopePath,
          matchCase: false,
          wholeWord: false,
          useRegex: false,
          fuzzy: false,
          excludeGitIgnored: true,
          excludeSearchIgnored: true
        }
      });
    }),
    vscode.commands.registerCommand("swiftFind.open", () => {
      openQuickSearch();
    }),
    vscode.commands.registerCommand("swiftFind.openFullscreen", (payload) => {
      openFullscreenSearch(payload);
    }),
    vscode.commands.registerCommand("swiftFind.openReplace", (payload) => {
      openReplacePanel(payload && typeof payload === "object" ? payload : {});
    }),
    vscode.commands.registerCommand("swiftFind.replaceInEditor", () => replaceInActiveEditor()),
    vscode.commands.registerCommand("swiftFind.showWelcome", () => openWelcomePage(context)),
    vscode.commands.registerCommand("swiftFind.rebuildIndex", async () => {
      await rebuildPathIndexCache();
    }),
    vscode.commands.registerCommand("swiftFind.focusTasks", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.swiftFind");
      await vscode.commands.executeCommand("swiftFind.tasksExplorer.focus");
    }),
    vscode.commands.registerCommand("swiftFind.toggleCaseSensitive", () => toggleOption("matchCase")),
    vscode.commands.registerCommand("swiftFind.toggleRegex", () => toggleOption("regex")),
    vscode.commands.registerCommand("swiftFind.toggleWholeWord", () => toggleOption("wholeWord")),
    vscode.commands.registerCommand("swiftFind.toggleFuzzy", () => toggleOption("fuzzy")),
    vscode.commands.registerCommand("swiftFind.toggleExcludeGitIgnored", () => toggleOption("excludeGit")),
    vscode.commands.registerCommand("swiftFind.toggleExcludeSearchIgnored", () => toggleOption("excludeSearchIgnore")),
    vscode.commands.registerCommand("swiftFind.nextTab", () => nextTab()),
    vscode.commands.registerCommand("swiftFind.prevTab", () => prevTab())
  );
}

function deactivate() {
  flushPathIndexCache().catch(() => {});
}

module.exports = { activate, deactivate };
