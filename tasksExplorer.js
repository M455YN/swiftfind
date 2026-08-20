const vscode = require("vscode");

class TaskRunnerNode extends vscode.TreeItem {
  /**
   * @param {vscode.Task} task
   * @param {string | undefined} tasksFilePath
   */
  constructor(task, tasksFilePath) {
    super(task.name, vscode.TreeItemCollapsibleState.None);
    this.taskName = task.name;
    this.taskScope = task.scope;
    this.tasksFilePath = tasksFilePath;
    this.contextValue = "swiftFind.taskNode";
    this.iconPath = new vscode.ThemeIcon("play-circle");
    const source = String(task.source || "tasks.json");
    this.description = source;
    this.tooltip = `${task.name}\n${source}${tasksFilePath ? `\n${tasksFilePath}` : ""}`;
    this.command = {
      command: "swiftFind.tasks.openTask",
      title: "Run Task",
      arguments: [this]
    };
  }
}

class TasksExplorerProvider {
  /**
   * @param {string} rootPath
   */
  constructor(rootPath) {
    this.rootPath = rootPath;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    /** @type {TaskRunnerNode[]} */
    this._cached = [];
  }

  refresh() {
    this._cached = [];
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * @param {TaskRunnerNode | undefined} element
   */
  async getChildren(element) {
    if (!this.rootPath) {
      const info = new vscode.TreeItem(
        "Open a folder/workspace to show Tasks",
        vscode.TreeItemCollapsibleState.None
      );
      info.contextValue = "swiftFind.infoNode";
      return [info];
    }

    if (element) return [];
    if (!this._cached.length) {
      this._cached = await this.scanTasks();
    }
    if (!this._cached.length) {
      const info = new vscode.TreeItem(
        "No runnable tasks found in .vscode/tasks.json",
        vscode.TreeItemCollapsibleState.None
      );
      info.contextValue = "swiftFind.infoNode";
      return [info];
    }
    return this._cached;
  }

  /**
   * @param {TaskRunnerNode} element
   */
  getTreeItem(element) {
    return element;
  }

  async scanTasks() {
    const taskUris = await vscode.workspace.findFiles("**/.vscode/tasks.json", "**/{node_modules,.git}/**", 20);
    /** @type {Set<string>} */
    const labelsFromConfig = new Set();
    /** @type {Map<string, string>} */
    const labelToFile = new Map();
    for (const uri of taskUris) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const raw = doc.getText();
        const parsed = parseTasksJson(raw);
        const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        for (const task of tasks) {
          const label = String(task?.label || "").trim();
          if (label) {
            labelsFromConfig.add(label);
            if (!labelToFile.has(label)) labelToFile.set(label, uri.fsPath);
          }
        }
      } catch {
        // Ignore invalid tasks.json files silently.
      }
    }

    const allTasks = await vscode.tasks.fetchTasks();
    const runnable = allTasks.filter((task) => {
      if (!task?.name) return false;
      const scope = task.scope;
      if (scope === vscode.TaskScope.Global || scope === vscode.TaskScope.Workspace) {
        return labelsFromConfig.has(task.name);
      }
      if (scope && typeof scope === "object" && "uri" in scope) {
        const fsPath = scope.uri?.fsPath || "";
        return fsPath.startsWith(this.rootPath) && labelsFromConfig.has(task.name);
      }
      return labelsFromConfig.has(task.name);
    });

    return runnable
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((task) => new TaskRunnerNode(task, labelToFile.get(task.name)));
  }
}

function parseTasksJson(text) {
  const noBlockComments = String(text).replace(/\/\*[\s\S]*?\*\//g, "");
  const noLineComments = noBlockComments.replace(/(^|[^:])\/\/.*$/gm, "$1");
  const withoutTrailingCommas = noLineComments.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

module.exports = { TasksExplorerProvider };
