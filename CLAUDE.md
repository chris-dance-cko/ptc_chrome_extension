# CLAUDE.md

## Overview

A vanilla Manifest V3 Chrome extension with no build system, no package manager, and no external dependencies. Load it directly in Chrome via `chrome://extensions/` → "Developer mode" → "Load unpacked".

## Architecture

### Service Worker (`background.js`)
- **Bookmarks Bar auto-move**: newly created bookmarks are moved into the Bookmarks Bar.
- **Auto Tab Grouping**: rules (`tabGroupRules` in `chrome.storage.sync`) match tabs by case-insensitive URL substring. On tab events each window is reclassified, duplicate-titled groups are merged, groups are ordered by rule order, and the "Other" catch-all group is kept rightmost. Rule-to-group mapping lives in `chrome.storage.session`.
- **Auto-Close Tabs**: rules (`autoCloseRules` in `chrome.storage.sync`) match by URL substring; matching tabs are timestamped and a 30-second alarm closes them once their delay elapses.

### Side Panel (`sidepanel.html` + `sidepanel.js`)
Opened by clicking the extension icon. Provides:
- **Retool PTC DLQ → Datadog**: paste a Retool DLQ response JSON and get Datadog log search links per correlation ID (±24h around `processed_on`, scoped by card scheme application name).
- **Tab Grouping** rule editor, with drag-and-drop reordering.
- **Auto-Close Tabs** rule editor.
