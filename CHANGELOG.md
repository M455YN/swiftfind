# Changelog

All notable changes to the "SwiftFind" extension are documented in this file.

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
