// Open Side Panel on Action Click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Cache the bookmarks bar ID so we don't look it up on every event
let bookmarksBarId = null;

async function getBookmarksBarId() {
  if (bookmarksBarId) return bookmarksBarId;

  const tree = await chrome.bookmarks.getTree();
  // The bookmarks bar is always the first child of the root
  const root = tree[0];
  const bar = root.children.find(
    (node) => node.id === "1" || node.title === "Bookmarks bar" || node.title === "Bookmarks Bar"
  );
  if (bar) {
    bookmarksBarId = bar.id;
  }
  return bookmarksBarId;
}

// Track recently created bookmark IDs so we can act on their first onChanged
const pendingBookmarks = new Set();

chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  // If it has no URL it's a folder — skip it
  // If it was created directly in the bar, skip it
  if (!bookmark.url) return;


  const barId = await getBookmarksBarId();
  await chrome.bookmarks.move(id, { parentId: barId });

  // Mark this bookmark as pending so onChanged knows to move it
  pendingBookmarks.add(id);
});

chrome.bookmarks.onMoved.addListener(async (id, changeInfo) => {
  if (!pendingBookmarks.has(id)) return;
  pendingBookmarks.delete(id);

  const barId = await getBookmarksBarId();
  if (!barId) return;

  // Get the current node to check if it's already in the bar
  const [node] = await chrome.bookmarks.get(id);
  if (node.parentId === barId) return; // already there

  await chrome.bookmarks.move(id, { parentId: barId });
});

// Clean up if a bookmark is removed before onChanged fires (e.g. user cancels)
chrome.bookmarks.onRemoved.addListener((id) => {
  pendingBookmarks.delete(id);
});


// ── Auto Tab Grouping ────────────────────────────────────────────────────────
// Rules are configured in the side panel and stored as:
//   { id, pattern, title, color, enabled }
// Matching is a case-insensitive substring test against the tab's URL.

const TAB_GROUP_RULES_KEY = 'tabGroupRules';
const TAB_GROUP_MAPPING_KEY = 'tabGroupMapping';

async function getTabGroupRules() {
  const { [TAB_GROUP_RULES_KEY]: rules = [] } = await chrome.storage.sync.get(TAB_GROUP_RULES_KEY);
  return rules;
}

function matchTabGroupRule(url, rules) {
  if (!url) return null;
  const lowerUrl = url.toLowerCase();
  return rules.find(r => r.enabled !== false && r.pattern && lowerUrl.includes(r.pattern.toLowerCase())) || null;
}

// Catch-all for tabs that don't match any configured rule.
const OTHER_TAB_GROUP_RULE = { id: '__other__', title: 'Other', color: 'grey' };

// Session storage survives service worker restarts but clears on browser
// restart, which is fine since tab groups don't survive that either.
async function getTabGroupMapping() {
  const { [TAB_GROUP_MAPPING_KEY]: mapping = {} } = await chrome.storage.session.get(TAB_GROUP_MAPPING_KEY);
  return mapping;
}

async function setTabGroupMapping(mapping) {
  await chrome.storage.session.set({ [TAB_GROUP_MAPPING_KEY]: mapping });
}

// onCreated and onUpdated can both fire for the same tab almost
// simultaneously (e.g. a tab created with an initial URL immediately
// navigates, firing an url-change update too). Without serializing per
// mapKey, both calls can read the mapping before either writes, each
// concluding no group exists yet and creating its own — producing
// duplicate groups for the same rule.
const groupingLocks = new Map();

function withGroupingLock(key, fn) {
  const prev = groupingLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (groupingLocks.get(key) === next) groupingLocks.delete(key);
  });
  groupingLocks.set(key, next);
  return next;
}

// Reclassifies every in-scope tab in a window against the current rules.
// A tab already sitting in the group its rule says it belongs to is left
// untouched; anything else (ungrouped, manually grouped, or grouped under a
// stale/removed group id) is moved into the correct group, creating it if
// needed. Tabs with no http(s) URL are out of scope and never touched.
async function reclassifyAllTabsInWindow(windowId) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;

  const [tabs, rules, mapping] = await Promise.all([
    chrome.tabs.query({ windowId }).catch(() => []),
    getTabGroupRules(),
    getTabGroupMapping(),
  ]);

  const buckets = new Map(); // mapKey -> { rule, tabs: [] }
  for (const tab of tabs) {
    // New Tab pages have no http(s) URL but are still in scope, so they land
    // in the "Other" catch-all like anything else that matches no rule.
    const isNewTabPage = tab.url === 'chrome://newtab/' || tab.pendingUrl === 'chrome://newtab/';
    if (!isNewTabPage && (!tab.url || !/^https?:\/\//i.test(tab.url))) continue;
    // Tabs paired in a Chrome Split View are left alone — pulling one side
    // into a tab group breaks the split, so they're excluded from grouping.
    if (tab.splitViewId != null && tab.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE) continue;
    const rule = matchTabGroupRule(tab.url, rules) || OTHER_TAB_GROUP_RULE;
    const mapKey = `${windowId}:${rule.id}`;
    if (!buckets.has(mapKey)) buckets.set(mapKey, { rule, tabs: [] });
    buckets.get(mapKey).tabs.push(tab);
  }

  let mappingChanged = false;

  for (const [mapKey, { rule, tabs: bucketTabs }] of buckets) {
    await withGroupingLock(mapKey, async () => {
      let groupId = mapping[mapKey];
      if (groupId != null) {
        try {
          await chrome.tabGroups.get(groupId);
        } catch {
          groupId = null; // group was closed/removed; recreate it below
        }
      }

      const misplaced = bucketTabs.filter((t) => t.groupId !== groupId);
      if (misplaced.length === 0) return; // already correctly grouped, don't touch

      try {
        if (groupId != null) {
          await chrome.tabs.group({ groupId, tabIds: misplaced.map((t) => t.id) });
        } else {
          groupId = await chrome.tabs.group({ tabIds: misplaced.map((t) => t.id) });
          await chrome.tabGroups.update(groupId, {
            title: rule.title || rule.pattern,
            color: rule.color || 'grey'
          });
          mapping[mapKey] = groupId;
          mappingChanged = true;
        }
      } catch (e) {
        console.error('Tab reclassify error:', e);
      }
    });
  }

  if (mappingChanged) await setTabGroupMapping(mapping);
}

chrome.tabs.onCreated.addListener((tab) => {
  scheduleGroupMaintenance(tab.windowId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.groupId !== undefined) {
    scheduleGroupMaintenance(tab.windowId);
  }
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  scheduleGroupMaintenance(moveInfo.windowId);
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  scheduleGroupMaintenance(attachInfo.newWindowId);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  scheduleGroupMaintenance(detachInfo.oldWindowId);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (!removeInfo.isWindowClosing) scheduleGroupMaintenance(removeInfo.windowId);
});

// Dragging a rule in the side panel changes only its stored order; there's
// no tab event to react to, so re-run maintenance on every open window
// whenever the rules themselves change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[TAB_GROUP_RULES_KEY]) return;
  chrome.windows.getAll().then((wins) => {
    wins.forEach((w) => scheduleGroupMaintenance(w.id));
  });
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const mapping = await getTabGroupMapping();
  let changed = false;
  for (const key of Object.keys(mapping)) {
    if (mapping[key] === group.id) {
      delete mapping[key];
      changed = true;
    }
  }
  if (changed) await setTabGroupMapping(mapping);
});

// ── Group Maintenance (reclassify + merge) ──────────────────────────────────
// On every structural tab event (create/url-change/regroup/move/attach/
// detach/remove) we rescan the affected window: first reclassify every tab
// against the current rules, then merge any tab groups left sharing a
// (trimmed, case-insensitive) title into one.

const maintenanceTimers = new Map(); // windowId -> timeout handle
const MAINTENANCE_DEBOUNCE_MS = 200;

function scheduleGroupMaintenance(windowId) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;
  clearTimeout(maintenanceTimers.get(windowId));
  maintenanceTimers.set(windowId, setTimeout(() => {
    maintenanceTimers.delete(windowId);
    runGroupMaintenance(windowId).catch((e) => console.error('Group maintenance error:', e));
  }, MAINTENANCE_DEBOUNCE_MS));
}

async function runGroupMaintenance(windowId) {
  await reclassifyAllTabsInWindow(windowId);
  await mergeGroupsByName(windowId);
  await reorderGroupsByRuleOrder(windowId);
  await moveOtherGroupToEnd(windowId);
}

// Arranges tab groups left-to-right in the tab strip to match the order of
// their rules in the (user-reorderable) rules list. Moving each mapped group
// to the end, in rule order, leaves them in that relative order once done —
// same trick moveOtherGroupToEnd uses to stay rightmost.
//
// Critically, this is a no-op when the groups are already correctly ordered.
// Every chrome.tabGroups.move fires onMoved, which reschedules maintenance;
// without this guard the groups would be reordered on every pass, endlessly
// re-triggering themselves (the tabs visibly "jiggle").
async function reorderGroupsByRuleOrder(windowId) {
  await withGroupingLock(`reorder:${windowId}`, async () => {
    const [rules, mapping, tabs] = await Promise.all([
      getTabGroupRules(),
      getTabGroupMapping(),
      chrome.tabs.query({ windowId }).catch(() => []),
    ]);

    // Desired left-to-right order of group ids: enabled rules in stored order,
    // limited to groups that actually exist (have tabs) in this window. The
    // "Other" catch-all is intentionally excluded — moveOtherGroupToEnd keeps
    // it pinned rightmost after this runs.
    const desired = [];
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      const groupId = mapping[`${windowId}:${rule.id}`];
      if (groupId == null) continue;
      if (tabs.some((t) => t.groupId === groupId)) desired.push(groupId);
    }
    if (desired.length < 2) return; // nothing meaningful to order

    // Current left-to-right order of those same groups, by each group's
    // lowest tab index (Chrome keeps a group's tabs contiguous).
    const desiredSet = new Set(desired);
    const minIndex = new Map();
    for (const t of tabs) {
      if (!desiredSet.has(t.groupId)) continue;
      const cur = minIndex.get(t.groupId);
      if (cur === undefined || t.index < cur) minIndex.set(t.groupId, t.index);
    }
    const current = [...desired].sort((a, b) => minIndex.get(a) - minIndex.get(b));

    // Already in the right relative order — don't touch anything.
    if (current.every((id, i) => id === desired[i])) return;

    for (const groupId of desired) {
      try {
        await chrome.tabGroups.move(groupId, { index: -1 });
      } catch {
        // Group no longer exists (closed/merged away); nothing to reorder.
      }
    }
  });
}

// Keeps the catch-all "Other" group pinned to the rightmost position in the
// tab strip. Chrome keeps a group's tabs contiguous, so if the tab with the
// highest index already belongs to the Other group, it's already rightmost
// and there's nothing to do (avoids a redundant move/onMoved event loop).
async function moveOtherGroupToEnd(windowId) {
  await withGroupingLock(`other-move:${windowId}`, async () => {
    const mapping = await getTabGroupMapping();
    const groupId = mapping[`${windowId}:${OTHER_TAB_GROUP_RULE.id}`];
    if (groupId == null) return;

    const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
    if (tabs.length === 0) return;
    const lastTab = tabs.reduce((a, b) => (b.index > a.index ? b : a));
    if (lastTab.groupId === groupId) return; // already rightmost

    try {
      await chrome.tabGroups.move(groupId, { index: -1 });
    } catch (e) {
      console.error('Move Other group error:', e);
    }
  });
}

// ── Auto-Close Tabs ──────────────────────────────────────────────────────────
// Rules are configured in the side panel and stored as:
//   { id, pattern, delaySeconds, enabled }
// Matching is a case-insensitive substring test against the tab's URL, same
// as tab grouping. A matching tab is timestamped when it's first seen (or
// first starts matching); a recurring alarm then closes any tracked tab once
// its rule's delay has elapsed.

const AUTO_CLOSE_RULES_KEY = 'autoCloseRules';
const AUTO_CLOSE_TRACKING_KEY = 'autoCloseTracking';
const AUTO_CLOSE_ALARM_NAME = 'auto-close-check';
const AUTO_CLOSE_CHECK_MINUTES = 0.5; // 30 seconds

async function getAutoCloseRules() {
  const { [AUTO_CLOSE_RULES_KEY]: rules = [] } = await chrome.storage.sync.get(AUTO_CLOSE_RULES_KEY);
  return rules;
}

function matchAutoCloseRule(url, rules) {
  if (!url) return null;
  const lowerUrl = url.toLowerCase();
  return rules.find(r => r.enabled !== false && r.pattern && lowerUrl.includes(r.pattern.toLowerCase())) || null;
}

// Session storage survives service worker restarts but clears on browser
// restart, which is fine — tabs from a previous session are gone too.
async function getAutoCloseTracking() {
  const { [AUTO_CLOSE_TRACKING_KEY]: tracking = {} } = await chrome.storage.session.get(AUTO_CLOSE_TRACKING_KEY);
  return tracking;
}

async function setAutoCloseTracking(tracking) {
  await chrome.storage.session.set({ [AUTO_CLOSE_TRACKING_KEY]: tracking });
}

// Called on tab creation and on URL changes. Starts tracking a tab against
// whichever rule (if any) currently matches its URL, resetting the timer if
// the matching rule changed, and untracks it if nothing matches anymore.
async function trackTabForAutoClose(tab) {
  if (!tab?.id || !tab.url) return;

  const rules = await getAutoCloseRules();
  const rule = matchAutoCloseRule(tab.url, rules);
  const tracking = await getAutoCloseTracking();
  const key = String(tab.id);
  const existing = tracking[key];

  if (!rule) {
    if (existing) {
      delete tracking[key];
      await setAutoCloseTracking(tracking);
    }
    return;
  }

  if (existing && existing.ruleId === rule.id) return; // already tracked for this rule

  tracking[key] = { ruleId: rule.id, addedAt: Date.now() };
  await setAutoCloseTracking(tracking);
}

async function untrackTabForAutoClose(tabId) {
  const tracking = await getAutoCloseTracking();
  const key = String(tabId);
  if (!(key in tracking)) return;
  delete tracking[key];
  await setAutoCloseTracking(tracking);
}

async function checkAutoCloseTabs() {
  const tracking = await getAutoCloseTracking();
  const keys = Object.keys(tracking);
  if (keys.length === 0) return;

  const rules = await getAutoCloseRules();
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  const now = Date.now();
  let changed = false;

  for (const key of keys) {
    const entry = tracking[key];
    const rule = rulesById.get(entry.ruleId);
    // Rule was deleted or disabled since — stop tracking without closing.
    if (!rule || rule.enabled === false) {
      delete tracking[key];
      changed = true;
      continue;
    }
    if (now - entry.addedAt < rule.delaySeconds * 1000) continue;

    delete tracking[key];
    changed = true;
    try {
      await chrome.tabs.remove(Number(key));
    } catch {
      // Tab already closed; nothing to do.
    }
  }

  if (changed) await setAutoCloseTracking(tracking);
}

chrome.tabs.onCreated.addListener((tab) => {
  trackTabForAutoClose(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) trackTabForAutoClose(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  untrackTabForAutoClose(tabId);
});

chrome.alarms.create(AUTO_CLOSE_ALARM_NAME, { periodInMinutes: AUTO_CLOSE_CHECK_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_CLOSE_ALARM_NAME) checkAutoCloseTabs();
});

// ── End Auto-Close Tabs ──────────────────────────────────────────────────────


async function mergeGroupsByName(windowId) {
  await withGroupingLock(`merge:${windowId}`, async () => {
    const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);

    const byTitle = new Map();
    for (const g of groups) {
      const key = (g.title || '').trim().toLowerCase();
      if (!key) continue; // don't merge untitled groups together
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(g);
    }

    const mapping = await getTabGroupMapping();
    const mappedIds = new Set(Object.values(mapping));
    let mappingChanged = false;

    for (const dupes of byTitle.values()) {
      if (dupes.length < 2) continue;

      // Prefer a group already tracked in the rule mapping as the survivor,
      // then fall back to the lowest (oldest) group id.
      dupes.sort((a, b) => {
        const aMapped = mappedIds.has(a.id) ? 0 : 1;
        const bMapped = mappedIds.has(b.id) ? 0 : 1;
        if (aMapped !== bMapped) return aMapped - bMapped;
        return a.id - b.id;
      });
      const [survivor, ...rest] = dupes;

      for (const dupe of rest) {
        const tabsInDupe = await chrome.tabs.query({ windowId, groupId: dupe.id }).catch(() => []);
        if (tabsInDupe.length === 0) continue;

        try {
          await chrome.tabs.group({ groupId: survivor.id, tabIds: tabsInDupe.map((t) => t.id) });
        } catch (e) {
          console.error('Group merge move error:', e);
          continue;
        }

        for (const key of Object.keys(mapping)) {
          if (mapping[key] === dupe.id) {
            mapping[key] = survivor.id;
            mappingChanged = true;
          }
        }
      }
    }

    if (mappingChanged) await setTabGroupMapping(mapping);
  });
}