# SwiftFind

A fast, unified search for VS Code inspired by JetBrains IDEs.

Install from the Extensions view (search **SwiftFind**), or grab the `.vsix` from [GitHub Releases](https://github.com/M455YN/swiftfind/releases) and use **Install from VSIX…**.

Default shortcuts:

- Floating search: `Ctrl+Alt+Shift+Space`
- Fullscreen search: `Ctrl+Alt+Shift+F`
- Find and replace: `Ctrl+Alt+Shift+H`
- Replace in editor: `Ctrl+Alt+Shift+R`

Polish / AltGr-safe fallback (chord):

- `Ctrl+Shift+J`, then `Space` / `F` / `H` / `R`

Rebind everything in Keyboard Shortcuts. The status bar `SwiftFind` item opens search as well.

## Tabs

| Tab | What it searches |
| --- | --- |
| Files | Filenames across your workspace |
| Folders | Folder paths in your workspace |
| Text | File contents (bundled ripgrep, with fallbacks) |
| Symbols | Functions, classes, variables via VS Code language providers |
| Commands | All VS Code commands (built-in and from extensions) |

## Fullscreen search and replace

`Ctrl+Alt+Shift+F` opens the fullscreen panel. Find is primary; expand the Replace row (or use `Ctrl+Alt+Shift+H`) to run find-and-replace across workspace files.

- **Text** results group as folder → file → match, with inline highlight preview (`swiftFind.preview`).
- **Pause / Resume / Stop** control a running ripgrep scan.
- **Folder…** limits the search to a directory inside the workspace.
- Live search vs Enter-only is `swiftFind.searchOnType`.

Replace in the current editor uses VS Code’s own Find/Replace widget (`Ctrl+Alt+Shift+R`).

## Sidebar and Explorer

The SwiftFind activity bar has **Fullscreen Search** and **Fullscreen Replace** tiles, with **Task Runner** below.

In Explorer, **Search Here** and **Replace Here** scope fullscreen search or replace to the selected file or folder.

## File index cache

SwiftFind keeps a workspace file list in `.vscode/swiftfind-path-index.cache`. It always honors `.gitignore`, plus common folders such as `bin` / `obj`. **Text** search and replace scan only that list, so they stay in sync with the Files tab.

Rebuild anytime from the Command Palette: **SwiftFind: Rebuild File Index Cache**.

## Search options (while the modal is open)

| Toggle | Shortcut | Description |
| --- | --- | --- |
| Case Sensitive | `Alt+C` | Match exact case |
| Regex | `Alt+R` | Use regular expressions |
| Match Whole Word | `Alt+W` | Only match complete words |
| Fuzzy Search | `Alt+F` | Fuzzy matching |
| Exclude Git Ignored | `Alt+G` | Hide files excluded by `.gitignore` |
| Exclude Search Ignored | `Alt+S` | Hide files excluded by `.searchignore` |

Tab navigation in QuickPick:

- `Tab` — next tab
- `Shift+Tab` — previous tab
