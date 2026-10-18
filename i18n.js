const vscode = require("vscode");

function isPolish() {
  return String(vscode.env.language || "").toLowerCase().startsWith("pl");
}

function t(en, pl) {
  return isPolish() ? pl : en;
}

// Also inlined into the fullscreen webview (via toString), so keep it free of outer references.
function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

module.exports = { isPolish, t, escapeHtml };

