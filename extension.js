const vscode = require("vscode");
const { openQuickSearch, markDirty, toggleOption, nextTab, prevTab } = require("./quickPickUi");
const { openFullscreenSearch } = require("./fullscreenUi");
const { SwiftFindSidebarProvider } = require("./sidebarView");
const { SolutionExplorerProvider } = require("./solutionExplorer");

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

  const solutionProvider = new SolutionExplorerProvider(rootPath || "", context.extensionUri);

  context.subscriptions.push(
    statusBarItem,
    vscode.window.registerWebviewViewProvider(
      "swiftFind.sidebar",
      new SwiftFindSidebarProvider(context.extensionUri)
    ),
    vscode.workspace.onDidSaveTextDocument(markDirty),
    vscode.workspace.onDidDeleteFiles(markDirty),
    vscode.workspace.onDidCreateFiles(markDirty),
    vscode.workspace.onDidRenameFiles(markDirty),
    vscode.window.registerTreeDataProvider("swiftFind.solutionExplorer", solutionProvider),
    vscode.commands.registerCommand("swiftFind.solutionExplorer.refresh", () => solutionProvider.refresh()),
    vscode.commands.registerCommand("swiftFind.solutionExplorer.openNode", async (node) => {
      if (!node?.absPath || node.isDirectory) return;
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(node.absPath));
    }),
    vscode.commands.registerCommand("swiftFind.solutionExplorer.revealInOS", async (node) => {
      if (!node?.absPath) return;
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.absPath));
    }),
    vscode.commands.registerCommand("swiftFind.solutionExplorer.copyPath", async (node) => {
      if (!node?.absPath) return;
      await vscode.env.clipboard.writeText(String(node.absPath));
      vscode.window.showInformationMessage("Path copied");
    }),
    vscode.commands.registerCommand("swiftFind.solutionExplorer.searchHere", async (node) => {
      if (!node?.relPath) return;
      await vscode.commands.executeCommand("swiftFind.openFullscreen", {
        query: "",
        options: {
          scopePath: node.relPath
        }
      });
    }),
    vscode.commands.registerCommand("swiftFind.focusSolutionExplorer", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.swiftFind");
      await vscode.commands.executeCommand("swiftFind.solutionExplorer.focus");
    }),
    vscode.commands.registerCommand("swiftFind.open", () => {
      openQuickSearch();
    }),
    vscode.commands.registerCommand("swiftFind.openFullscreen", (payload) => {
      openFullscreenSearch(payload);
    }),
    vscode.commands.registerCommand("swiftFind.focusSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.swiftFind");
      await vscode.commands.executeCommand("swiftFind.sidebar.focus");
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

function deactivate() {}

module.exports = { activate, deactivate };
