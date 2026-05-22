/** @typedef {{ filePath?: string, lineNumber?: number, column?: number, commandId?: string }} SearchResultItem */

/** @type {{ tab: string, query: string, options: Record<string, unknown>, item: SearchResultItem } | null} */
let lastSelection = null;

/**
 * @param {SearchResultItem | null | undefined} item
 */
function itemKey(item) {
  if (!item) return "";
  if (item.commandId) return `cmd:${item.commandId}`;
  const fp = String(item.filePath || "");
  if (!fp) return "";
  const ln = Number(item.lineNumber || 0);
  const col = Number(item.column || 1);
  return `${fp}:${ln}:${col}`;
}

/**
 * @param {{ tab?: string, query?: string, options?: Record<string, unknown>, item: SearchResultItem }} selection
 */
function setLastSelection(selection) {
  if (!selection?.item) {
    lastSelection = null;
    return;
  }
  lastSelection = {
    tab: String(selection.tab || "text"),
    query: String(selection.query || ""),
    options: selection.options && typeof selection.options === "object" ? { ...selection.options } : {},
    item: { ...selection.item }
  };
}

function getLastSelection() {
  return lastSelection;
}

module.exports = { itemKey, setLastSelection, getLastSelection };
