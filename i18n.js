const vscode = require("vscode");

function isPolish() {
  return String(vscode.env.language || "").toLowerCase().startsWith("pl");
}

function t(en, pl) {
  return isPolish() ? pl : en;
}

module.exports = { isPolish, t };

