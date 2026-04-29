# SwiftFind

A fast, unified search for VS Code inspired by JetBrains IDEs.

Default shortcut is `Ctrl+Shift+Space` (you can rebind it in Keyboard Shortcuts).  
Open from status bar with `Search+` as well.

## Tabs

| Tab | What it searches |
| --- | --- |
| Files | Filenames across your workspace |
| Folders | Folder paths in your workspace |
| Text | File contents (powered by bundled ripgrep with fallbacks) |
| Symbols | Functions, classes, variables via VS Code language providers |
| Commands | All VS Code commands (built-in and from extensions) |

## Features

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

