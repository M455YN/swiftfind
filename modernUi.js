const vscode = require("vscode");

const MODERN_UI_SETTING = "workbench.experimental.modernUI";
const LEGACY_FLOATING = "workbench.experimental.floatingPanels";

function isModernUiEnabled() {
  const cfg = vscode.workspace.getConfiguration();
  return cfg.get(MODERN_UI_SETTING) === true || cfg.get(LEGACY_FLOATING) === true;
}

function modernUiBodyClass() {
  return isModernUiEnabled() ? "modern-ui" : "";
}

function modernUiSharedCss() {
  return `
    body.modern-ui {
      --sf-border: var(--vscode-surface-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(127,127,127,.35))));
      --sf-r-ctrl: var(--vscode-cornerRadius-small, 4px);
      --sf-r-surface: var(--vscode-cornerRadius-large, 8px);
      --sf-r-badge: var(--vscode-cornerRadius-circle, 9999px);
      --sf-gap: var(--vscode-spacing-size80, 8px);
      --sf-pad-x: var(--vscode-spacing-size160, 16px);
      --sf-pad-y: var(--vscode-spacing-size120, 12px);
      --sf-stroke: var(--vscode-strokeThickness, 1px);
      --sf-row-radius: var(--vscode-cornerRadius-medium, 6px);
    }
  `;
}

function watchModernUi(onChange) {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(MODERN_UI_SETTING) && !e.affectsConfiguration(LEGACY_FLOATING)) return;
    onChange(isModernUiEnabled());
  });
}

module.exports = {
  isModernUiEnabled,
  modernUiBodyClass,
  modernUiSharedCss,
  watchModernUi
};
