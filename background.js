// Open Side Panel on Action Click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// ── QA Lambda Version ────────────────────────────────────────────────────────
// Periodically checks which version of one specific lambda pipeline is
// currently deployed to QA and surfaces it in the side panel.

const QA_BASE_URL = 'https://app.harness.io';
const QA_TARGET = {
  accountIdentifier: 'x9vTEK0gRkadO7XKkBzdTw',
  organizationIdentifier: 'pay_to_card',
  projectIdentifier: 'pay_to_card_services',
  pipelineIdentifier: 'ptc_payout_authorize_v2_pipeline',
  // Master builds are bare semver (e.g. "1.853.0"). Branch builds embed the
  // branch name in the version (e.g. "1.853.0-unstable-improvement-<branchName>.commit1").
  // Set this to whichever branch this lambda's QA env deploys from.
  branchName: 'auto-deploy-qa',
};

const QA_HISTORY_DAYS = 180;
const QA_MAX_PAGES = 10;
const QA_PAGE_SIZE = 25;
const QA_ENV_RE = /^qa$/i;
const QA_SEMVER_PREFIX_RE = /^\d+\.\d+\.\d+/;
const QA_ALARM_NAME = 'hrv-qa-poll';
const QA_POLL_MINUTES = 5;
const QA_STORAGE_KEY = 'hrvQaStatus';

const qaEscapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const qaBranchNameRe = (branchName) => new RegExp(qaEscapeRe(branchName), 'i');

// "1.853.0-unstable-improvement-auto-deploy-qa.commit1" -> "1.853.0 auto-deploy-qa"
function qaFormatDisplayVersion(version, branchName) {
  const semverMatch = QA_SEMVER_PREFIX_RE.exec(version);
  if (!semverMatch || !qaBranchNameRe(branchName).test(version)) return version;
  return `${semverMatch[0]} ${branchName}`;
}

function qaBuildQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function qaApiGet(path, params) {
  const res = await fetch(`${QA_BASE_URL}${path}?${qaBuildQuery(params)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return res.json();
}

async function qaApiPost(path, params, body) {
  const res = await fetch(`${QA_BASE_URL}${path}?${qaBuildQuery(params)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return res.json();
}

const QA_HARNESS_EXPR_RE = /^<\+.+>$/;
const QA_RELEASE_VERSION_RE = /release_version\s*[:=]\s*["']?(?<ver>[^"'\r\n]+?)["']?(?:\s|$)/i;
const QA_VAR_NAME_RE = /^(?<indent>\s*)-\s*name\s*:\s*["']?(?<name>[^"'\r\n]+)["']?\s*$/i;
const QA_VAR_VALUE_RE = /^\s*value\s*:\s*["']?(?<ver>[^"'\r\n]+)["']?\s*$/i;
const QA_YAML_FIELDS = ['inputSetYaml', 'resolvedYaml', 'inputSetTemplateYaml', 'inputYaml', 'pipelineYaml', 'executionYaml', 'input'];

function qaIsConcrete(v) {
  return typeof v === 'string' && v.trim() !== '' && !QA_HARNESS_EXPR_RE.test(v.trim());
}

function qaDeepFindString(obj, name) {
  if (!obj || typeof obj !== 'object') return '';
  if (Array.isArray(obj)) {
    for (const item of obj) { const r = qaDeepFindString(item, name); if (r) return r; }
    return '';
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === name && typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object') { const r = qaDeepFindString(value, name); if (r) return r; }
  }
  return '';
}

function qaFindVersionInYaml(yaml) {
  if (!yaml) return '';
  const m = QA_RELEASE_VERSION_RE.exec(yaml);
  if (m && qaIsConcrete(m.groups.ver)) return m.groups.ver.trim();
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const nm = QA_VAR_NAME_RE.exec(lines[i]);
    if (!nm || nm.groups.name.trim().toLowerCase() !== 'release_version') continue;
    const indent = nm.groups.indent.length;
    for (let j = i + 1; j < lines.length; j++) {
      const nm2 = QA_VAR_NAME_RE.exec(lines[j]);
      if (nm2 && nm2.groups.indent.length <= indent) break;
      const vm = QA_VAR_VALUE_RE.exec(lines[j]);
      if (vm && vm.groups.ver.trim()) return vm.groups.ver.trim();
    }
  }
  return '';
}

function qaFindReleaseVersion(execution) {
  const direct = qaDeepFindString(execution, 'release_version');
  if (qaIsConcrete(direct)) return direct;
  for (const field of QA_YAML_FIELDS) {
    const v = qaFindVersionInYaml(qaDeepFindString(execution, field));
    if (qaIsConcrete(v)) return v;
  }
  return '';
}

const QA_TIME_KEYS = ['startTs', 'startTime', 'executionStartTs', 'createdAt'];
const QA_EXEC_KEYS = ['planExecutionId', 'executionId', 'uuid'];

function qaFirstString(obj, keys) {
  for (const k of keys) { if (obj && typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim(); }
  return '';
}

function qaBuildExecUrl(info, execId) {
  return `${QA_BASE_URL}/ng/account/${encodeURIComponent(info.accountIdentifier)}/all/orgs/${encodeURIComponent(info.organizationIdentifier)}/projects/${encodeURIComponent(info.projectIdentifier)}/pipelines/${encodeURIComponent(info.pipelineIdentifier)}/deployments/${encodeURIComponent(execId)}/pipeline`;
}

async function qaFetchPipelineDefinition(info) {
  return qaApiGet(`/pipeline/api/pipelines/${encodeURIComponent(info.pipelineIdentifier)}`, {
    accountIdentifier: info.accountIdentifier,
    orgIdentifier: info.organizationIdentifier,
    projectIdentifier: info.projectIdentifier,
    getTemplatesResolvedPipeline: 'true',
  });
}

const QA_STAGE_START_RE = /^(\s*)-\s*stage\s*:\s*$/;
const QA_YAML_KV_RE = /^(\s*)(?:-\s+)?([A-Za-z_][\w-]*)\s*:\s*(?:["']?([^"'\r\n]+?)["']?)?\s*$/;
const QA_NON_EMPTY_RE = /^(\s*)\S/;

function qaExtractStagesFromYaml(yaml) {
  if (!yaml) return [];
  const lines = yaml.split(/\r?\n/);
  const stages = [];
  let current = null;
  let stageBlockIndent = -1;

  for (const line of lines) {
    const stageStart = QA_STAGE_START_RE.exec(line);
    if (stageStart) {
      stageBlockIndent = stageStart[1].length;
      current = { name: '', identifier: '', environmentRef: '', environment: '' };
      stages.push(current);
      continue;
    }
    if (!current) continue;

    const leading = QA_NON_EMPTY_RE.exec(line);
    if (leading && leading[1].length <= stageBlockIndent) { current = null; continue; }

    const kv = QA_YAML_KV_RE.exec(line);
    if (!kv) continue;
    const [, , key, value] = kv;
    if (!value) continue;
    if (key === 'name' && !current.name) current.name = value.trim();
    else if (key === 'identifier' && !current.identifier) current.identifier = value.trim();
    else if (key === 'environmentRef' && !current.environmentRef) {
      current.environmentRef = value.trim();
      const parts = current.environmentRef.split('.');
      current.environment = parts[parts.length - 1];
    }
  }
  return stages;
}

function qaBuildStageIdToEnv(stages) {
  const stageIdToEnv = {};
  for (const s of stages) {
    if (s.environment && s.identifier) stageIdToEnv[s.identifier.toLowerCase()] = s.environment;
  }
  return stageIdToEnv;
}

function qaIsSuccessful(status) {
  const s = (status || '').toLowerCase();
  return s === 'succeeded' || s === 'success';
}

async function qaFetchExecutionPage(info, page, timeRange) {
  return qaApiPost(
    '/pipeline/api/pipelines/execution/summary',
    {
      accountIdentifier: info.accountIdentifier,
      orgIdentifier: info.organizationIdentifier,
      projectIdentifier: info.projectIdentifier,
      pipelineIdentifier: info.pipelineIdentifier,
      page,
      size: QA_PAGE_SIZE,
    },
    { filterType: 'PipelineExecution', timeRange },
  );
}

async function qaFetchInputSet(info, planExecutionId) {
  try {
    return await qaApiGet(
      `/pipeline/api/pipelines/execution/${encodeURIComponent(planExecutionId)}/inputsetV2`,
      {
        accountIdentifier: info.accountIdentifier,
        orgIdentifier: info.organizationIdentifier,
        projectIdentifier: info.projectIdentifier,
        resolveExpressions: 'true',
        resolveExpressionsType: 'RESOLVE_ALL_EXPRESSIONS',
      },
    );
  } catch {
    return null;
  }
}

// Finds the QA stage's identifier from pipeline YAML, then walks execution
// history newest-first until it finds the latest successful deploy to it
// whose version was cut from info.branchName.
async function qaFetchQaVersion(info) {
  const pipelineResp = await qaFetchPipelineDefinition(info);
  const yaml = pipelineResp?.data?.resolvedTemplatesPipelineYaml
    || pipelineResp?.data?.yamlPipeline
    || '';
  const stages = qaExtractStagesFromYaml(yaml);
  const stageIdToEnv = qaBuildStageIdToEnv(stages);
  const qaStageIds = Object.entries(stageIdToEnv)
    .filter(([, env]) => QA_ENV_RE.test(env))
    .map(([id]) => id);
  if (qaStageIds.length === 0) return { found: false, reason: 'No QA stage found for this pipeline.' };

  const now = Date.now();
  const timeRange = { startTime: now - QA_HISTORY_DAYS * 24 * 60 * 60 * 1000, endTime: now };

  for (let page = 0; page < QA_MAX_PAGES; page++) {
    const resp = await qaFetchExecutionPage(info, page, timeRange);
    const executions = resp?.data?.content ?? (Array.isArray(resp?.data) ? resp.data : []);
    if (executions.length === 0) break;

    for (const exec of executions) {
      const layoutNodeMap = exec?.layoutNodeMap ?? {};
      const qaNode = Object.values(layoutNodeMap).find((node) => {
        if (node?.nodeGroup !== 'STAGE' && node?.nodeGroup !== 'STRATEGY') return false;
        return qaStageIds.includes((node.nodeIdentifier || '').toLowerCase()) && qaIsSuccessful(node.status);
      });
      if (!qaNode) continue;

      const execId = qaFirstString(exec, QA_EXEC_KEYS);
      let version = qaFindReleaseVersion(exec);
      if (!qaIsConcrete(version) && execId) {
        const inputSet = await qaFetchInputSet(info, execId);
        if (inputSet) version = qaFindReleaseVersion({ ...exec, _inputSet: inputSet });
      }
      if (!qaIsConcrete(version)) continue;
      if (!qaBranchNameRe(info.branchName).test(version)) continue;

      return {
        found: true,
        version,
        executionUrl: execId ? qaBuildExecUrl(info, execId) : '',
      };
    }

    if (executions.length < QA_PAGE_SIZE) break;
  }

  return { found: false, reason: `No successful "${info.branchName}" deployment found in the last 180 days.` };
}

async function qaRefresh() {
  try {
    const result = await qaFetchQaVersion(QA_TARGET);
    const status = result.found
      ? {
          state: 'ok',
          version: qaFormatDisplayVersion(result.version, QA_TARGET.branchName),
          rawVersion: result.version,
          executionUrl: result.executionUrl,
          updatedAt: Date.now(),
        }
      : { state: 'empty', reason: result.reason, updatedAt: Date.now() };
    await chrome.storage.local.set({ [QA_STORAGE_KEY]: status });
  } catch (err) {
    const status = { state: 'error', message: err instanceof Error ? err.message : String(err), updatedAt: Date.now() };
    await chrome.storage.local.set({ [QA_STORAGE_KEY]: status });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(QA_ALARM_NAME, { periodInMinutes: QA_POLL_MINUTES });
  qaRefresh();
});

chrome.runtime.onStartup.addListener(() => {
  qaRefresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QA_ALARM_NAME) qaRefresh();
});

chrome.storage.local.get(QA_STORAGE_KEY).then((data) => {
  if (!data[QA_STORAGE_KEY]) qaRefresh();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'hrv:refresh-qa') {
    qaRefresh().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── End QA Lambda Version ────────────────────────────────────────────────────



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


// ── Bookmark Spotlight ──────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'bookmark-spotlight') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['spotlight.js'] });
  } catch (e) {
    console.error('Spotlight injection error:', e);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BOOKMARK_SEARCH') {
    handleBookmarkSearch(message.query).then(sendResponse);
    return true;
  }
  if (message.type === 'BOOKMARK_OPEN') {
    handleBookmarkOpen(message.bookmarkId, sender.tab.id);
    sendResponse({ success: true });
  }
});

async function handleBookmarkSearch(query) {
  const tree = await chrome.bookmarks.getTree();
  const lowerQuery = query.toLowerCase();
  const results = [];

  function traverse(node) {
    if (node.url) {
      const titleMatch = node.title.toLowerCase().includes(lowerQuery);
      const urlMatch = node.url.toLowerCase().includes(lowerQuery);
      if (titleMatch || urlMatch) results.push({ id: node.id, title: node.title, url: node.url, titleMatch });
    }
    node.children?.forEach(traverse);
  }
  traverse(tree[0]);

  const { bookmarkHistory = [] } = await chrome.storage.local.get('bookmarkHistory');
  const histMap = new Map(bookmarkHistory.map(h => [h.id, h]));

  results.sort((a, b) => {
    if (a.titleMatch && !b.titleMatch) return -1;
    if (!a.titleMatch && b.titleMatch) return 1;
    const aC = histMap.get(a.id)?.count || 0, bC = histMap.get(b.id)?.count || 0;
    if (aC !== bC) return bC - aC;
    const aT = histMap.get(a.id)?.lastOpened || 0, bT = histMap.get(b.id)?.lastOpened || 0;
    if (aT !== bT) return bT - aT;
    return a.title.localeCompare(b.title);
  });

  return results.slice(0, 20);
}

async function handleBookmarkOpen(bookmarkId, tabId) {
  const [bookmark] = await chrome.bookmarks.get(bookmarkId);
  if (!bookmark?.url) return;

  const { bookmarkHistory = [] } = await chrome.storage.local.get('bookmarkHistory');
  const existing = bookmarkHistory.find(h => h.id === bookmarkId);
  if (existing) {
    existing.count++;
    existing.lastOpened = Date.now();
  } else {
    bookmarkHistory.push({ id: bookmarkId, title: bookmark.title, url: bookmark.url, count: 1, lastOpened: Date.now() });
  }
  await chrome.storage.local.set({ bookmarkHistory });

  chrome.tabs.update(tabId, { url: bookmark.url });
}

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