# CLAUDE.md



## Overview

A vanilla Manifest V3 Chrome extension with no build system, no package manager, and no external dependencies. Load it directly in Chrome via `chrome://extensions/` → "Developer mode" → "Load unpacked".
This is a developers "everything extension". It is designed to assist workflows in several distinct ways. 

## Architecture

Two runtime contexts communicate via the Chrome extension APIs:

### Service Worker (`background.js`)
Runs persistently in the background. Currently handles one concern: auto-moving newly created bookmarks to the Bookmarks Bar. Caches the Bookmarks Bar folder ID to avoid repeated lookups.

### Side Panel (`sidepanel.html` + `sidepanel.js`)
The main UI, opened when the extension icon is clicked (configured in `background.js` via `chrome.sidePanel.setPanelBehavior`). Provides three actions:
- **Refresh All Tabs** — reloads every open tab across all windows
- **Log All Tab Titles** — injects a content script into each tab to extract `document.title` and display results in the log panel
- **Open Recent Harness Executions** — the primary feature: injects a scraper into an open Harness.io page, finds execution links (via `aria-label^="Execution"`), groups by row/card container, filters excluded pipelines (hardcoded: `["ptc-event-broker"]`), and opens up to 10 results in new background tabs

### Key Patterns
- Script injection uses `chrome.scripting.executeScript` with `func:` (not `file:`) to pass inline functions into page context
- The log panel in `sidepanel.html` accumulates output via `logMessage()` helper in `sidepanel.js`
- Harness scraping assumes a specific DOM structure (rows with `aria-label^="Execution"` links grouped by `<tr>` or `[class*="card"]` ancestors)
- `popup.html` exists but is unused — the extension uses side panel mode instead
