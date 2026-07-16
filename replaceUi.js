const vscode = require("vscode");
const { isPolish } = require("./i18n");

/**
 * Replace opens the unified Find-in-Files panel with the replace row expanded.
 * Search stays the primary surface.
 */
function openReplacePanel(payload) {
  const { openFullscreenSearch } = require("./fullscreenUi");
  return openFullscreenSearch({
    query: String(payload?.find ?? payload?.query ?? ""),
    replace: String(payload?.replace ?? ""),
    showReplace: true,
    options: payload?.options
  });
}

/**
 * Opens VS Code's built-in Find + Replace widget (top-right of the editor).
 * - Multi-line / block selection → find in selection only
 * - Short single-line selection → seed Find with that text (whole file)
 * - No selection → whole file
 */
async function replaceInActiveEditor() {
  const pl = isPolish();
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage(
      pl ? "Otwórz plik, żeby zamienić tekst." : "Open a file to replace text."
    );
    return;
  }

  const sel = editor.selection;
  const useSelection = !sel.isEmpty;
  const selectedText = useSelection ? editor.document.getText(sel) : "";
  const seedFind =
    useSelection &&
    selectedText.length > 0 &&
    selectedText.length <= 120 &&
    !selectedText.includes("\n");
  // Block selection = scope; short word selection = seed Find (search file)
  const findInSelection = useSelection && !seedFind;

  await vscode.commands.executeCommand("editor.actions.findWithArgs", {
    searchString: seedFind ? selectedText : "",
    // Passing replaceString reveals the Replace row under Find
    replaceString: "",
    findInSelection,
    isRegex: false,
    matchWholeWord: false,
    isCaseSensitive: false,
    preserveCase: false
  });
}

module.exports = { openReplacePanel, replaceInActiveEditor };
