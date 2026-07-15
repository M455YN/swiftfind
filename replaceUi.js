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

module.exports = { openReplacePanel };
