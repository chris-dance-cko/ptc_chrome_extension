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


// ── Auto-Close Tabs ──────────────────────────────────────────────────────────
// Rules are matched (case-insensitive substring against the tab's URL) and
// enforced by background.js, which timestamps matching tabs on open/navigate
// and closes them once their rule's delay has elapsed.

const AUTO_CLOSE_RULES_KEY = 'autoCloseRules';

async function loadAutoCloseRules() {
  const { [AUTO_CLOSE_RULES_KEY]: rules = [] } = await chrome.storage.sync.get(AUTO_CLOSE_RULES_KEY);
  return rules;
}

async function saveAutoCloseRules(rules) {
  await chrome.storage.sync.set({ [AUTO_CLOSE_RULES_KEY]: rules });
}

async function renderAutoCloseRules() {
  const list = document.getElementById('autoCloseList');
  list.innerHTML = '';
  const rules = await loadAutoCloseRules();

  rules.forEach((rule, i) => {
    const item = document.createElement('div');
    item.className = 'prompt-item';
    item.style.opacity = rule.enabled === false ? '0.5' : '1';

    const header = document.createElement('div');
    header.className = 'prompt-item-header';

    const name = document.createElement('div');
    name.className = 'prompt-item-name';
    name.textContent = `"${rule.pattern}"`;

    const actions = document.createElement('div');
    actions.className = 'prompt-item-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = rule.enabled === false ? 'Enable' : 'Disable';
    toggleBtn.addEventListener('click', async () => {
      const all = await loadAutoCloseRules();
      all[i].enabled = all[i].enabled === false;
      await saveAutoCloseRules(all);
      renderAutoCloseRules();
    });

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      const all = await loadAutoCloseRules();
      all.splice(i, 1);
      await saveAutoCloseRules(all);
      renderAutoCloseRules();
    });

    actions.appendChild(toggleBtn);
    actions.appendChild(delBtn);
    header.appendChild(name);
    header.appendChild(actions);

    const meta = document.createElement('div');
    meta.className = 'auto-close-item-meta';
    meta.textContent = `Closes ${rule.delaySeconds}s after a matching tab opens.`;

    item.appendChild(header);
    item.appendChild(meta);
    list.appendChild(item);
  });
}

document.getElementById('autoCloseToggle').addEventListener('click', () => {
  const panel = document.getElementById('autoClosePanel');
  const btn = document.getElementById('autoCloseToggle');
  const open = panel.classList.toggle('open');
  btn.textContent = open ? 'Hide Auto-Close Rules' : 'Show Auto-Close Rules';
  if (open) renderAutoCloseRules();
});

document.getElementById('addAutoCloseRule').addEventListener('click', async () => {
  const patternInput = document.getElementById('newCloseRulePattern');
  const delayInput = document.getElementById('newCloseRuleDelay');

  const pattern = patternInput.value.trim();
  const delaySeconds = parseInt(delayInput.value, 10);
  if (!pattern || !Number.isFinite(delaySeconds) || delaySeconds <= 0) return;

  const rules = await loadAutoCloseRules();
  rules.push({
    id: `close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    pattern,
    delaySeconds,
    enabled: true
  });
  await saveAutoCloseRules(rules);

  patternInput.value = '';
  delayInput.value = '';
  renderAutoCloseRules();
});

// ── End Auto-Close Tabs ──────────────────────────────────────────────────────

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
