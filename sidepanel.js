const logDiv = document.getElementById('log');

// ── QA Lambda Version ────────────────────────────────────────────────────────

const QA_STORAGE_KEY = 'hrvQaStatus';

function renderQaStatus(status) {
  const versionEl = document.getElementById('qaVersion');
  const updatedEl = document.getElementById('qaUpdated');

  if (!status) {
    versionEl.textContent = 'No data yet.';
    updatedEl.textContent = '';
    return;
  }

  if (status.state === 'ok') {
    versionEl.innerHTML = status.executionUrl
      ? `<a href="${status.executionUrl}" target="_blank" rel="noopener noreferrer">${status.version}</a>`
      : status.version;
  } else if (status.state === 'error') {
    versionEl.textContent = `Error: ${status.message}`;
  } else {
    versionEl.textContent = status.reason || 'No QA deployment found.';
  }

  updatedEl.textContent = status.updatedAt
    ? `Updated ${new Date(status.updatedAt).toLocaleTimeString()}`
    : '';
}

chrome.storage.local.get(QA_STORAGE_KEY).then((data) => renderQaStatus(data[QA_STORAGE_KEY]));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[QA_STORAGE_KEY]) renderQaStatus(changes[QA_STORAGE_KEY].newValue);
});

document.getElementById('qaRefresh').addEventListener('click', async () => {
  const btn = document.getElementById('qaRefresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  await chrome.runtime.sendMessage({ type: 'hrv:refresh-qa' });
  btn.disabled = false;
  btn.textContent = 'Refresh';
});

// ── End QA Lambda Version ────────────────────────────────────────────────────

// ── Prompts ──────────────────────────────────────────────────────────────────

const PROMPTS_KEY = 'saved_prompts';

function loadPrompts() {
  try { return JSON.parse(localStorage.getItem(PROMPTS_KEY)) || []; }
  catch { return []; }
}

function savePrompts(prompts) {
  localStorage.setItem(PROMPTS_KEY, JSON.stringify(prompts));
}

function renderPrompts() {
  const list = document.getElementById('promptList');
  list.innerHTML = '';
  const prompts = loadPrompts();
  prompts.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'prompt-item';

    const header = document.createElement('div');
    header.className = 'prompt-item-header';

    const name = document.createElement('div');
    name.className = 'prompt-item-name';
    name.textContent = p.name || `Prompt ${i + 1}`;

    const actions = document.createElement('div');
    actions.className = 'prompt-item-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(p.text).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      const all = loadPrompts();
      all.splice(i, 1);
      savePrompts(all);
      renderPrompts();
    });

    actions.appendChild(copyBtn);
    actions.appendChild(delBtn);
    header.appendChild(name);
    header.appendChild(actions);

    const ta = document.createElement('textarea');
    ta.value = p.text;
    ta.addEventListener('change', () => {
      const all = loadPrompts();
      all[i].text = ta.value;
      savePrompts(all);
    });

    item.appendChild(header);
    item.appendChild(ta);
    list.appendChild(item);
  });
}

document.getElementById('promptsToggle').addEventListener('click', () => {
  const panel = document.getElementById('promptsPanel');
  const btn = document.getElementById('promptsToggle');
  const open = panel.classList.toggle('open');
  btn.textContent = open ? 'Hide Prompts' : 'Show Prompts';
  if (open) renderPrompts();
});

document.getElementById('savePrompt').addEventListener('click', () => {
  const name = document.getElementById('newPromptName').value.trim();
  const text = document.getElementById('newPromptText').value;
  if (!text) return;
  const prompts = loadPrompts();
  prompts.push({ name: name || `Prompt ${prompts.length + 1}`, text });
  savePrompts(prompts);
  document.getElementById('newPromptName').value = '';
  document.getElementById('newPromptText').value = '';
  renderPrompts();
});

// ── End Prompts ──────────────────────────────────────────────────────────────


// ── Tab Grouping ─────────────────────────────────────────────────────────────

const TAB_GROUP_RULES_KEY = 'tabGroupRules';

async function loadTabGroupRules() {
  const { [TAB_GROUP_RULES_KEY]: rules = [] } = await chrome.storage.sync.get(TAB_GROUP_RULES_KEY);
  return rules;
}

async function saveTabGroupRules(rules) {
  await chrome.storage.sync.set({ [TAB_GROUP_RULES_KEY]: rules });
}

// Drag-and-drop reordering of rules. The rule order dictates the left-to-right
// position of the matching tab groups in the browser (see background.js),
// so dragging a rule here re-orders the actual tab groups too.
let tabGroupDragSrcIndex = null;

async function renderTabGroupRules() {
  const list = document.getElementById('tabGroupList');
  list.innerHTML = '';
  const rules = await loadTabGroupRules();

  rules.forEach((rule, i) => {
    const item = document.createElement('div');
    item.className = 'prompt-item tab-group-item';
    item.style.opacity = rule.enabled === false ? '0.5' : '1';
    item.draggable = true;

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder';

    const body = document.createElement('div');
    body.className = 'tab-group-item-body';

    const header = document.createElement('div');
    header.className = 'prompt-item-header';

    const name = document.createElement('div');
    name.className = 'prompt-item-name';
    name.textContent = `${rule.title || rule.pattern} — "${rule.pattern}"`;

    const actions = document.createElement('div');
    actions.className = 'prompt-item-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = rule.enabled === false ? 'Enable' : 'Disable';
    toggleBtn.addEventListener('click', async () => {
      const all = await loadTabGroupRules();
      all[i].enabled = all[i].enabled === false;
      await saveTabGroupRules(all);
      renderTabGroupRules();
    });

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      const all = await loadTabGroupRules();
      all.splice(i, 1);
      await saveTabGroupRules(all);
      renderTabGroupRules();
    });

    actions.appendChild(toggleBtn);
    actions.appendChild(delBtn);
    header.appendChild(name);
    header.appendChild(actions);
    body.appendChild(header);
    item.appendChild(handle);
    item.appendChild(body);

    item.addEventListener('dragstart', (e) => {
      tabGroupDragSrcIndex = i;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.tab-group-item').forEach((el) => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      tabGroupDragSrcIndex = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (tabGroupDragSrcIndex === null) return;
      const before = (e.clientY - item.getBoundingClientRect().top) < item.offsetHeight / 2;
      item.classList.toggle('drag-over-top', before);
      item.classList.toggle('drag-over-bottom', !before);
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      const before = item.classList.contains('drag-over-top');
      item.classList.remove('drag-over-top', 'drag-over-bottom');

      const srcIndex = tabGroupDragSrcIndex;
      tabGroupDragSrcIndex = null;
      if (srcIndex === null || srcIndex === i) return;

      const all = await loadTabGroupRules();
      const [moved] = all.splice(srcIndex, 1);
      let destIndex = i > srcIndex ? i - 1 : i;
      if (!before) destIndex += 1;
      all.splice(destIndex, 0, moved);
      await saveTabGroupRules(all);
      renderTabGroupRules();
    });

    list.appendChild(item);
  });
}

document.getElementById('tabGroupsToggle').addEventListener('click', () => {
  const panel = document.getElementById('tabGroupsPanel');
  const btn = document.getElementById('tabGroupsToggle');
  const open = panel.classList.toggle('open');
  btn.textContent = open ? 'Hide Tab Groups' : 'Show Tab Groups';
  if (open) renderTabGroupRules();
});

document.getElementById('addTabGroupRule').addEventListener('click', async () => {
  const patternInput = document.getElementById('newRulePattern');
  const titleInput = document.getElementById('newRuleTitle');
  const colorSelect = document.getElementById('newRuleColor');

  const pattern = patternInput.value.trim();
  if (!pattern) return;

  const rules = await loadTabGroupRules();
  rules.push({
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    pattern,
    title: titleInput.value.trim(),
    color: colorSelect.value,
    enabled: true
  });
  await saveTabGroupRules(rules);

  patternInput.value = '';
  titleInput.value = '';
  renderTabGroupRules();
});

// ── End Tab Grouping ─────────────────────────────────────────────────────────


// ── LLM Lasso ──────────────────────────────────────────────────────────────

const lassoBtn = document.getElementById('lassoToggle');
const lassoStatus = document.getElementById('lassoStatus');
let lassoArmed = false;

async function armLasso() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    lassoStatus.textContent = 'No active tab.';
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['turndown.js', 'lasso.js'] });
    lassoArmed = true;
    lassoBtn.classList.add('active');
    lassoBtn.textContent = 'Cancel';
    lassoStatus.textContent = 'Hover over an element and click to capture.';
  } catch (e) {
    lassoStatus.textContent = `Error: ${e.message}`;
  }
}

async function disarmLasso() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    // Tell the injected script to clean up
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { if (typeof window.__lassoCleanup === 'function') window.__lassoCleanup(); }
    }).catch(() => {});
  }
  lassoArmed = false;
  lassoBtn.classList.remove('active');
  lassoBtn.textContent = 'Select Element';
}

lassoBtn.addEventListener('click', () => {
  if (lassoArmed) {
    disarmLasso();
    lassoStatus.textContent = 'Cancelled.';
  } else {
    armLasso();
  }
});

// Receive result from lasso.js (conversion + copy happen in page context)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LASSO_CAPTURED') {
    lassoArmed = false;
    lassoBtn.classList.remove('active');
    lassoBtn.textContent = 'Select Element';
    lassoStatus.textContent = `Copied! (${msg.charCount} chars)`;
    log(`Lasso: copied ${msg.charCount} chars of Markdown.`);
  } else if (msg.type === 'LASSO_ERROR') {
    lassoArmed = false;
    lassoBtn.classList.remove('active');
    lassoBtn.textContent = 'Select Element';
    lassoStatus.textContent = `Error: ${msg.message}`;
  }
});

// ── End LLM Lasso ───────────────────────────────────────────────────────────


// ── Retool PTC DLQ → Datadog ──────────────────────────────────────────────

const dlqStatus = document.getElementById('dlqStatus');

// Maps raw DLQ items (from queryData.data.items) to the fields we render.
function mapDlqItems(rawItems) {
  return rawItems.map((item) => {
    const ma = item.message_attributes || {};
    let processedOn = null;
    try {
      if (ma.context?.string_value) {
        processedOn = JSON.parse(ma.context.string_value).processed_on || null;
      }
    } catch { /* context not JSON */ }
    return {
      correlationId: ma.correlation_id?.string_value || null,
      processedOn,
      paymentId: ma.payment_id?.string_value || null,
      errorMsg: ma.error_msg?.string_value || null,
      sopCode: ma.sop_code?.string_value || null,
      source: ma.source?.string_value || null,
    };
  });
}

// Derive the Datadog @ApplicationName facet from the card scheme, inferred from
// the entry's source / error message. Returns null for non-scheme entries.
function schemeAppName(entry) {
  const hay = `${entry.source || ''} ${entry.errorMsg || ''}`.toUpperCase();
  if (hay.includes('MASTERCARD')) return 'Mastercard PTC Api';
  if (hay.includes('VISA')) return 'Visa PTC Api';
  return null;
}

function buildDatadogUrl(entry) {
  const { correlationId, processedOn } = entry;
  if (!correlationId || !processedOn) return null;
  // Trim over-precise fractional seconds (e.g. 7 digits) to milliseconds.
  const normalized = String(processedOn).replace(/(\.\d{3})\d+/, '$1');
  const ts = Date.parse(normalized);
  if (Number.isNaN(ts)) return null;
  const from = ts - 86400000; // 24h before processed_on
  const to = ts + 86400000;   // 24h after processed_on

  const appName = schemeAppName(entry);
  let query = `env:prod @CorrelationId:${correlationId}`;
  if (appName) query += ` @ApplicationName:"${appName}"`;

  const q = encodeURIComponent(query);
  return `https://app.datadoghq.eu/logs?query=${q}&from_ts=${from}&to_ts=${to}&live=false`;
}

function renderDlqResults(items) {
  const container = document.getElementById('dlqResults');
  container.innerHTML = '';

  let rendered = 0;
  let skipped = 0;

  items.forEach((entry) => {
    const url = buildDatadogUrl(entry);
    if (!url) { skipped++; return; }

    const item = document.createElement('div');
    item.className = 'dlq-item';

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = entry.correlationId;

    const meta = document.createElement('div');
    meta.className = 'dlq-item-meta';
    meta.textContent = [entry.paymentId, entry.sopCode, entry.source, entry.errorMsg]
      .filter(Boolean).join(' · ');

    item.appendChild(link);
    item.appendChild(meta);
    container.appendChild(item);
    rendered++;
  });

  const parts = [`Captured ${rendered} entr${rendered === 1 ? 'y' : 'ies'}.`];
  if (skipped) parts.push(`${skipped} skipped (missing correlation id / timestamp).`);
  dlqStatus.textContent = parts.join(' ');
  log(`DLQ: ${parts.join(' ')}`);
}

// Parse a raw Retool DLQ response pasted into the textarea.
document.getElementById('dlqParse').addEventListener('click', () => {
  const raw = document.getElementById('dlqPaste').value.trim();
  if (!raw) { dlqStatus.textContent = 'Paste the Retool response JSON first.'; return; }
  try {
    const parsed = JSON.parse(raw);
    // Accept either the full wrapped response or a bare { items: [...] } / [...].
    const items = parsed?.queryData?.data?.items
      || parsed?.data?.items
      || parsed?.items
      || (Array.isArray(parsed) ? parsed : null);
    if (!Array.isArray(items)) {
      dlqStatus.textContent = 'Could not find queryData.data.items in the pasted JSON.';
      return;
    }
    renderDlqResults(mapDlqItems(items));
  } catch (e) {
    dlqStatus.textContent = `Invalid JSON: ${e.message}`;
  }
});

// ── End Retool PTC DLQ → Datadog ──────────────────────────────────────────


function log(msg) {
  const entry = document.createElement('div');
  entry.textContent = `> ${msg}`;
  logDiv.appendChild(entry);
  logDiv.scrollTop = logDiv.scrollHeight;
}

// Refresh All Tabs
document.getElementById('refreshAll').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({});
  tabs.forEach(tab => chrome.tabs.reload(tab.id));
  log(`Refreshed ${tabs.length} tabs.`);
});

// Scrape logic across all tabs
document.getElementById('scrapeTitles').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  
  for (const tab of tabs) {
    try {
      const [{result}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.title
      });
      log(`Title: ${result}`);
    } catch (e) {
      log(`Error on tab ${tab.id}: ${e.message}`);
    }
  }
});
document.getElementById('harnessOpen').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes("harness.io")) {
    setStatus("Error: Not on a Harness page.");
    return;
  }
  const FILTERED_NAMES = [
 
  "ptc-event-broker",
 
];

  try {
    const [{result}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [FILTERED_NAMES],
      func: (excludedNames) => {
        // 1. Find all execution links on the page
        const allLinks = Array.from(document.querySelectorAll('a[aria-label^="Execution"]'));
        
        // 2. Group them by their "Row"
        // We find the closest 'tr' (table row) or a div that looks like a row
        const latestByRow = new Map();

        allLinks.forEach(link => {
          // Harness usually wraps a pipeline in a <tr> or a specific <div> row
          const row = link.closest('tr') || link.closest('[class*="card"]') || link.parentElement;
          
          // Only add the link if we haven't seen this row/container yet
          // (This assumes the first link found in the DOM for a row is the latest one)
          if (row && !latestByRow.has(row)) {
            const rowText = row.innerText.toLowerCase();
            console.log("Row Text:", rowText);
            const isExcluded = excludedNames.some(name => 
              rowText.includes(name.toLowerCase())
            );

            if (!isExcluded) {
              latestByRow.set(row, link.href);
            }

          }
        });

        // 3. Convert Map values to array and enforce a strict 10-tab limit
        return Array.from(latestByRow.values()).slice(0, 10);
      }
    });

    if (result && result.length > 0) {

      
      result.forEach(url => {
        chrome.tabs.create({ url, active: false });
      });
      setStatus(`Opened ${result.length} tabs (capped at 10).`);
    } else {
      setStatus("No executions found.");
    }
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
});