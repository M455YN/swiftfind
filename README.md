# SwiftFind

A fast, unified search for VS Code inspired by JetBrains IDEs.

Default shortcuts:
- Floating search: `Ctrl+Alt+Shift+Space`
- Fullscreen results: `Ctrl+Alt+Shift+F`
- Find and replace: `Ctrl+Alt+Shift+H`

Polish / AltGr-safe fallback (chord):
- `Ctrl+Shift+J`, then `Space` / `F` / `H`

You can rebind everything in Keyboard Shortcuts.  
Open from status bar with `SwiftFind` as well.

## Tabs

| Tab | What it searches |
| --- | --- |
| Files | Filenames across your workspace |
| Folders | Folder paths in your workspace |
| Text | File contents (powered by bundled ripgrep with fallbacks) |
| Symbols | Functions, classes, variables via VS Code language providers |
| Commands | All VS Code commands (built-in and from extensions) |

## Features

### File index cache

SwiftFind keeps a workspace file list in `.vscode/swiftfind-path-index.cache` (always respects `.gitignore`, plus common folders like `bin` / `obj`). **Text** search runs only over that list, so it matches the Files tab.

Rebuild anytime via Command Palette: **SwiftFind: Rebuild File Index Cache**.

### Search Options (while modal is open)

| Toggle | Shortcut | Description |
| --- | --- | --- |
| Case Sensitive | `Alt+C` | Match exact case |
| Regex | `Alt+R` | Use regular expressions |
| Match Whole Word | `Alt+W` | Only match complete words |
| Fuzzy Search | `Alt+F` | Fuzzy matching |
| Exclude Git Ignored | `Alt+G` | Hide files excluded by `.gitignore` |
| Exclude Search Ignored | `Alt+S` | Hide files excluded by `.searchignore` |

Tab navigation:
- `Tab` -> next tab
- `Shift+Tab` -> previous tab

