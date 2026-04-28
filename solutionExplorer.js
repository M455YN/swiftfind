const vscode = require("vscode");
const fs = require("fs/promises");
const path = require("path");

class SolutionNode extends vscode.TreeItem {
  /**
   * @param {string} absPath
   * @param {boolean} isDirectory
   * @param {string} rootPath
   * @param {string} iconDir
   */
  constructor(absPath, isDirectory, rootPath, iconDir, fallbackIconDir) {
    const rel = path.relative(rootPath, absPath).replaceAll("\\", "/");
    super(
      path.basename(absPath) || rel || absPath,
      isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.absPath = absPath;
    this.relPath = rel;
    this.isDirectory = isDirectory;
    this.contextValue = isDirectory ? "swiftFind.folderNode" : "swiftFind.fileNode";
    this.resourceUri = vscode.Uri.file(absPath);
    this.iconPath = getIconPath(absPath, isDirectory, iconDir, fallbackIconDir);
    this.description = rel && rel !== this.label ? rel : undefined;
    this.command = isDirectory
      ? undefined
      : {
          command: "swiftFind.solutionExplorer.openNode",
          title: "Open",
          arguments: [this]
        };
  }
}

class SolutionExplorerProvider {
  /**
   * @param {string} rootPath
   * @param {vscode.Uri} extensionUri
   */
  constructor(rootPath, extensionUri) {
    this.rootPath = rootPath;
    this.iconDir = path.join(extensionUri.fsPath, "media", "solution-icons");
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * @param {SolutionNode | undefined} element
   */
  async getChildren(element) {
    if (!this.rootPath) {
      const info = new vscode.TreeItem(
        "Open a folder/workspace to show Solution Explorer",
        vscode.TreeItemCollapsibleState.None
      );
      info.contextValue = "swiftFind.infoNode";
      return [info];
    }

    const target = element ? element.absPath : this.rootPath;
    const entries = await fs.readdir(target, { withFileTypes: true });
    const visible = entries
      .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
      .map((e) => ({
        name: e.name,
        absPath: path.join(target, e.name),
        isDirectory: e.isDirectory()
      }))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));

    return visible.map((x) => new SolutionNode(x.absPath, x.isDirectory, this.rootPath, this.iconDir));
  }

  /**
   * @param {SolutionNode} element
   */
  getTreeItem(element) {
    return element;
  }
}

function getIconPath(absPath, isDirectory, iconDir) {
  const name = path.basename(absPath).toLowerCase();
  const ext = path.extname(absPath).toLowerCase();
  const pick = (() => {
    if (isDirectory) return "FolderClosed.svg";
    if (name === "readme.md") return "MarkdownFile.svg";
    if (ext === ".sln") return "VisualStudioSolution.svg";
    if (ext === ".csproj" || ext === ".vbproj" || ext === ".fsproj") return "Project.svg";
    if (ext === ".cs" || ext === ".vb" || ext === ".fs") return "CSFileNode.svg";
    if (ext === ".xaml" || ext === ".xml") return "XmlFile.svg";
    if (ext === ".json") return "JsonFile.svg";
    if (ext === ".config" || ext === ".ini") return "ConfigurationFile.svg";
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") return "TSFileNode.svg";
    if (ext === ".md") return "MarkdownFile.svg";
    return "TextFile.svg";
  })();

  const p = path.join(iconDir, pick);
  return {
    light: vscode.Uri.file(p),
    dark: vscode.Uri.file(p)
  };
}

module.exports = { SolutionExplorerProvider };

