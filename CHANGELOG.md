# Changelog

All notable changes to the "SwiftFind" extension are documented in this file.

## [0.1.6] - 2026-05-22

- Added optional **Show Class** toggle for text search (sidebar, fullscreen, and QuickPick).
- When enabled, text results show the enclosing class, interface, struct, or enum from document symbols.
- Class names are rendered in bold next to the file path in fullscreen and sidebar result lists.
- Added Alt+K shortcut for the class context toggle in fullscreen search.

## [0.1.5] - 2026-05-22

- Synced last selected search result between fullscreen results and the SwiftFind sidebar panel.
- Highlighted the active result row in both fullscreen and sidebar lists using VS Code list selection styling.
- Restored sidebar query, tab, and filter options when returning from fullscreen with a prior selection.

## [0.1.4] - 2026-05-11

- Added `text replacement` functionality

## [0.1.3] - 2026-04-29

- Added `Task Runner` explorer view in the SwiftFind sidebar, powered by workspace `tasks.json`.
- Added task actions: `Run Task` and context menu `Show in tasks.json`.
- Improved task definition navigation to jump to the matching task label line in `tasks.json`.
- Removed local development launch instructions from README for Marketplace-ready docs.

## [0.1.2] - 2026-04-29

- Improved floating QuickPick modal UI with better button organization and toggle state behavior.
- Refined fullscreen search UI layout (header, tabs, options grid, and sticky summary).
- Updated result list styling in fullscreen mode for clearer scanability and a more native VS Code feel.

## [0.1.1] - 2026-04-29

- Refined Sidebar Search panel to a more VS Code-native look and spacing.
- Fixed sidebar options layout where checkboxes and labels were misaligned.
- Improved sidebar controls styling for better readability and consistency.

## [0.1.0] - 2026-04-28

- Prepared extension metadata for VS Code Marketplace (`publisher`, `repository`, `homepage`, `bugs`, `license`, keywords, icon).
- Added and integrated a SwiftFind extension icon (`media/icon.png`) for Marketplace listing.
- Added `.vscodeignore` and reduced package footprint for cleaner VSIX output.
- Added a dedicated SwiftFind activity bar container and sidebar search panel.
- Added `Solution Explorer` view with:
  - open file
  - search in selected scope
  - copy path
  - show in Windows Explorer
  - refresh action
- Added scoped search support propagated through fullscreen UI and search engine.
- Improved search handling and filtering flow across tabs and scoped results.
- Added/updated localization strings (EN/PL) for new commands and views.
- Added Visual Studio-style icon mapping for Solution Explorer file/folder nodes.

## [0.0.1] - 2026-04-28

- Initial public version of SwiftFind.
- Added floating QuickPick search experience with multi-tab search modes.
- Added fullscreen search view and sidebar search UI.
- Added search options: case sensitive, whole word, regex, fuzzy, git ignore, search ignore.
