'use strict';

// ─── State ────────────────────────────────────────────────────────────────

let tabId    = null;
let hostname = null;
let sites    = {};

let pendingSelector       = null;  // active targetSelector (unique or repeat)
let pendingUniqueSelector = null;  // unique selector from content script pick
let pendingRepeatSelector = null;  // generalised repeat selector from content script
let pendingPlaceholders   = [];
let cursorPos             = 0;
let editMode              = false;
let editIndex             = -1; // -1 = new button, >= 0 = editing existing

// ─── DOM refs ─────────────────────────────────────────────────────────────

const hostnameBar   = document.getElementById('hostname-bar');
const hostnameLabel = document.getElementById('hostname-label');
const modeSelect    = document.getElementById('mode-select');
const folderGroup   = document.getElementById('folder-group');
const folderInput   = document.getElementById('folder-input');

const views = {
  unconfigured: document.getElementById('view-unconfigured'),
  configured:   document.getElementById('view-configured'),
  step1:        document.getElementById('view-step1'),
  step2:        document.getElementById('view-step2'),
  error:        document.getElementById('view-error'),
};

// ─── View helpers ─────────────────────────────────────────────────────────

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function showError(message) {
  document.getElementById('error-message').textContent = message;
  showView('error');
}

function currentView() {
  return Object.keys(views).find(k => !views[k].classList.contains('hidden')) ?? null;
}

// ─── Storage helpers ──────────────────────────────────────────────────────

async function saveSetupState(updates) {
  const { setupState = {} } = await chrome.storage.local.get('setupState');
  await chrome.storage.local.set({
    setupState: { tabId, hostname, ...setupState, ...updates },
  });
}

async function clearSetupState() {
  await chrome.storage.local.remove('setupState');
}

// ─── Messaging ────────────────────────────────────────────────────────────

async function sendToContent(msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    showError('Cannot connect to this page. Please reload the page and try again.');
    return null;
  }
}

async function queryContent(msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    return null;
  }
}

// ─── S key: ask content script to select whatever is hovered ─────────────
// The popup retains keyboard focus while open, so we catch S here and
// forward a SELECT_HOVERED request to the content script instead of relying
// on keydown events inside the page.

document.addEventListener('keydown', async (e) => {
  if (e.key !== 's' && e.key !== 'S') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const view = currentView();
  if (view !== 'step1' && view !== 'step2') return;
  e.preventDefault();
  if (tabId) await sendToContent({ type: 'SELECT_HOVERED' });
});

// ─── Mode / folder show-hide ──────────────────────────────────────────────

modeSelect.addEventListener('change', updateFolderVisibility);
document.getElementById('repeat-toggle').addEventListener('change', applyRepeatToggle);

function updateFolderVisibility() {
  const needsFolder = modeSelect.value === 'code' || modeSelect.value === 'cowork';
  folderGroup.classList.toggle('hidden', !needsFolder);
}

// ─── Placeholder chips ────────────────────────────────────────────────────

function renderPlaceholderList() {
  const list = document.getElementById('placeholder-list');
  list.innerHTML = '';

  if (pendingPlaceholders.length === 0) {
    list.classList.add('hidden');
    return;
  }
  list.classList.remove('hidden');

  for (let i = 0; i < pendingPlaceholders.length; i++) {
    const ph   = pendingPlaceholders[i];
    const chip = document.createElement('div');
    chip.className = 'placeholder-chip';

    const nameInput = document.createElement('input');
    nameInput.className = 'chip-name';
    nameInput.value = ph.name;
    nameInput.addEventListener('input', () => {
      const oldName = ph.name;
      ph.name = nameInput.value.replace(/[^a-zA-Z0-9_]/g, '_') || 'value';
      nameInput.value = ph.name;
      const ta = document.getElementById('prompt-textarea');
      ta.value = ta.value.replaceAll(`{{${oldName}}}`, `{{${ph.name}}}`);
    });

    const arrow = document.createElement('span');
    arrow.textContent = '→';
    arrow.style.color = '#aaa';

    const valueSpan = document.createElement('span');
    valueSpan.className = 'chip-selector';
    valueSpan.title = ph.selector;
    const displayText = ph.text || '';
    valueSpan.textContent = displayText.length > 30
      ? displayText.slice(0, 30) + '…'
      : (displayText || (ph.selector.length > 28 ? '…' + ph.selector.slice(-28) : ph.selector));
    valueSpan.dataset.phIndex = String(i);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'chip-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      const ta = document.getElementById('prompt-textarea');
      ta.value = ta.value.replaceAll(`{{${ph.name}}}`, '');
      pendingPlaceholders.splice(i, 1);
      renderPlaceholderList();
    });

    if (ph.relative) {
      const badge = document.createElement('span');
      badge.className = 'chip-relative-badge';
      badge.title = 'Relative to each repeated element';
      badge.textContent = 'rel';
      chip.append(nameInput, arrow, valueSpan, badge, removeBtn);
    } else {
      chip.append(nameInput, arrow, valueSpan, removeBtn);
    }
    chip.addEventListener('mouseenter', () => {
      const containerSel = ph.relative ? pendingSelector : undefined;
      queryContent({ type: 'HIGHLIGHT_ELEMENT', selector: ph.selector, containerSelector: containerSel });
    });
    chip.addEventListener('mouseleave', () => queryContent({ type: 'UNHIGHLIGHT_ELEMENT' }));
    list.appendChild(chip);
  }

  // Async-update chips with live values from the page
  (async () => {
    for (let i = 0; i < pendingPlaceholders.length; i++) {
      const ph = pendingPlaceholders[i];
      const res = await queryContent({
        type: 'GET_ELEMENT_TEXT', selector: ph.selector,
        relative: ph.relative,
        containerSelector: ph.relative ? pendingSelector : undefined,
      });
      if (res && res.text !== null) {
        pendingPlaceholders[i].text = res.text;
        const span = list.querySelector(`[data-ph-index="${i}"]`);
        if (span) {
          span.textContent = res.text.length > 30 ? res.text.slice(0, 30) + '…' : res.text;
        }
      }
    }
  })();
}

// ─── Step 2 ───────────────────────────────────────────────────────────────

function showStep2({ selector, promptDraft, placeholders, claudeMode, folder, repeat, repeatSelector }) {
  pendingSelector       = selector;
  pendingUniqueSelector = selector;
  pendingRepeatSelector = repeatSelector || (repeat ? selector : null);
  pendingPlaceholders   = placeholders || [];

  const selectorDisplay = document.getElementById('pending-selector-display');
  selectorDisplay.textContent = selector || '';
  selectorDisplay.onmouseenter = () => {
    if (pendingSelector) queryContent({ type: 'HIGHLIGHT_ELEMENT', selector: pendingSelector });
  };
  selectorDisplay.onmouseleave = () => queryContent({ type: 'UNHIGHLIGHT_ELEMENT' });

  const repeatToggle = document.getElementById('repeat-toggle');
  repeatToggle.checked = !!repeat;

  document.getElementById('prompt-textarea').value = promptDraft || '';
  modeSelect.value = claudeMode || 'code';
  folderInput.value = folder || '';
  updateFolderVisibility();
  renderPlaceholderList();
  showView('step2');

  // Query live match count and auto-suggest repeat if multiple matches
  (async () => {
    if (!selector) return;
    const res = await queryContent({ type: 'GET_ELEMENT_COUNT', selector });
    const n = res?.count ?? 0;
    const countEl = document.getElementById('match-count');
    if (n > 0) {
      countEl.textContent = `${n} on page`;
      countEl.classList.remove('hidden');
    } else {
      countEl.classList.add('hidden');
    }
    // Auto-suggest repeat for new buttons when multiple elements found
    if (n > 1 && !editMode && !repeat && pendingRepeatSelector) {
      repeatToggle.checked = true;
      applyRepeatToggle();
    }
  })();
}

function applyRepeatToggle() {
  const on = document.getElementById('repeat-toggle').checked;
  pendingSelector = on ? (pendingRepeatSelector || pendingUniqueSelector) : pendingUniqueSelector;
  const selectorDisplay = document.getElementById('pending-selector-display');
  selectorDisplay.textContent = pendingSelector || '';
  selectorDisplay.onmouseenter = () => {
    if (pendingSelector) queryContent({ type: 'HIGHLIGHT_ELEMENT', selector: pendingSelector });
  };
  selectorDisplay.onmouseleave = () => queryContent({ type: 'UNHIGHLIGHT_ELEMENT' });
}

// ─── Cursor position ──────────────────────────────────────────────────────

function saveCursor() {
  cursorPos = document.getElementById('prompt-textarea').selectionStart ?? 0;
}

function insertAtCursor(text) {
  const ta  = document.getElementById('prompt-textarea');
  ta.value  = ta.value.slice(0, cursorPos) + text + ta.value.slice(cursorPos);
  cursorPos += text.length;
  ta.setSelectionRange(cursorPos, cursorPos);
  ta.focus();
}

function uniquePlaceholderName(base) {
  const existing = new Set(pendingPlaceholders.map(p => p.name));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

// ─── Save ─────────────────────────────────────────────────────────────────

async function saveConfig() {
  const promptTemplate = document.getElementById('prompt-textarea').value.trim();
  if (!promptTemplate) {
    document.getElementById('prompt-textarea').focus();
    return;
  }

  const repeat = document.getElementById('repeat-toggle').checked;
  const config = {
    targetSelector: pendingSelector,
    repeat,
    promptTemplate,
    placeholders:   pendingPlaceholders.map(({ name, selector, relative }) => ({ name, selector, ...(relative && { relative: true }) })),
    claudeMode:     modeSelect.value,
    folder:         folderInput.value.trim(),
  };

  const configs = Array.isArray(sites[hostname]) ? [...sites[hostname]] : [];
  if (editIndex >= 0) {
    configs[editIndex] = config;
  } else {
    configs.push(config);
  }
  sites[hostname] = configs;
  await chrome.storage.local.set({ sites });
  await clearSetupState();
  await sendToContent({ type: 'INJECT_BUTTON', configs });

  editIndex = -1;
  editMode  = false;
  renderConfiguredView();
  showView('configured');
}

// ─── Configured view ──────────────────────────────────────────────────────

function renderConfiguredView() {
  const configs    = sites[hostname] || [];
  const modeLabels = { chat: 'Chat', code: 'Code', cowork: 'Cowork' };
  const statusDot  = document.querySelector('.status-dot');
  const statusText = document.getElementById('configured-status-text');

  // Start with a neutral/pending state; async check will update
  statusDot.style.background = '#ccc';
  statusText.textContent = configs.length === 1 ? 'Checking…' : `0/${configs.length} active`;

  const list = document.getElementById('configured-buttons-list');
  list.innerHTML = '';

  const rowDots = [];

  configs.forEach((config, i) => {
    const row = document.createElement('div');
    row.className = 'config-btn-row';

    const dot = document.createElement('span');
    dot.className = 'config-row-dot';
    dot.dataset.configDot = String(i);
    rowDots.push(dot);

    const sel = document.createElement('code');
    sel.className = 'config-btn-selector';
    sel.textContent = config.targetSelector;
    sel.title = 'Click to jump to button on page';
    sel.style.cursor = 'pointer';
    sel.onmouseenter = () => queryContent({ type: 'HIGHLIGHT_ELEMENT', selector: config.targetSelector });
    sel.onmouseleave = () => queryContent({ type: 'UNHIGHLIGHT_ELEMENT' });
    sel.addEventListener('click', () =>
      queryContent({ type: 'SCROLL_TO_BUTTON', selector: config.targetSelector, repeat: config.repeat })
    );

    const mode = document.createElement('span');
    mode.className = 'config-btn-mode';
    mode.textContent = modeLabels[config.claudeMode] ?? 'Chat';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-secondary btn-xs';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', async () => {
      editIndex             = i;
      editMode              = true;
      pendingSelector       = config.targetSelector;
      pendingUniqueSelector = config.targetSelector;
      pendingRepeatSelector = config.repeat ? config.targetSelector : null;
      pendingPlaceholders   = config.placeholders.map(p => ({ ...p }));
      await saveSetupState({
        step: 'EDITING_PROMPT', editMode: true, editIndex: i,
        selector: config.targetSelector, promptDraft: config.promptTemplate,
        placeholders: pendingPlaceholders, claudeMode: config.claudeMode, folder: config.folder,
        repeat: config.repeat, repeatSelector: pendingRepeatSelector,
      });
      showStep2({ selector: config.targetSelector, promptDraft: config.promptTemplate,
                  placeholders: pendingPlaceholders, claudeMode: config.claudeMode, folder: config.folder,
                  repeat: config.repeat, repeatSelector: pendingRepeatSelector });
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-danger btn-xs';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const newConfigs = configs.filter((_, idx) => idx !== i);
      if (newConfigs.length > 0) {
        sites[hostname] = newConfigs;
        await chrome.storage.local.set({ sites });
        await sendToContent({ type: 'INJECT_BUTTON', configs: newConfigs });
        renderConfiguredView();
      } else {
        delete sites[hostname];
        await chrome.storage.local.set({ sites });
        await clearSetupState();
        await sendToContent({ type: 'REMOVE_BUTTON' });
        showView('unconfigured');
      }
    });

    row.append(dot, sel, mode, editBtn, removeBtn);
    list.appendChild(row);
  });

  // Async: check actual injection status per button
  (async () => {
    let activeCount = 0;
    for (let i = 0; i < configs.length; i++) {
      const res = await queryContent({
        type: 'GET_BUTTON_STATUS',
        selector: configs[i].targetSelector,
        repeat: configs[i].repeat,
      });
      const active = res?.injected ?? false;
      if (active) activeCount++;
      rowDots[i].style.background = active ? '#22c55e' : '#bbb';
      rowDots[i].title = active ? 'Injected' : 'Not found on page';
    }

    if (activeCount === 0) {
      statusDot.style.background = '#bbb';
      statusText.textContent = configs.length === 1 ? 'Inactive' : `0/${configs.length} active`;
    } else if (activeCount < configs.length) {
      statusDot.style.background = '#f59e0b';
      statusText.textContent = `${activeCount}/${configs.length} active`;
    } else {
      statusDot.style.background = '#22c55e';
      statusText.textContent = configs.length === 1 ? 'Button active' : `${configs.length} buttons active`;
    }
  })();
}

// ─── Cancel ───────────────────────────────────────────────────────────────

async function cancelSetup() {
  editMode            = false;
  editIndex           = -1;
  pendingSelector     = null;
  pendingPlaceholders = [];
  await clearSetupState();
  await sendToContent({ type: 'CANCEL_PICK' });
  const configs = sites[hostname];
  if (configs && configs.length > 0) {
    renderConfiguredView();
    showView('configured');
  } else {
    showView('unconfigured');
  }
}

// ─── Restore persisted setup state on popup open ──────────────────────────

async function restoreFromSetupState(state) {
  editMode              = state.editMode || false;
  editIndex             = typeof state.editIndex === 'number' ? state.editIndex : -1;
  pendingSelector       = state.selector || null;
  pendingUniqueSelector = state.selector || null;
  pendingRepeatSelector = state.repeatSelector || null;
  pendingPlaceholders = (state.placeholders || []).map(p => ({ ...p }));

  let step        = state.step;
  let promptDraft = state.promptDraft || '';

  if (state.latestPlaceholder) {
    const ph   = state.latestPlaceholder;
    const name = uniquePlaceholderName(ph.name);
    pendingPlaceholders.push({ name, selector: ph.selector, text: ph.text });
    const pos   = typeof state.cursorPos === 'number' ? state.cursorPos : promptDraft.length;
    promptDraft = promptDraft.slice(0, pos) + `{{${name}}}` + promptDraft.slice(pos);
    step = 'EDITING_PROMPT';
    await saveSetupState({ step, promptDraft, placeholders: pendingPlaceholders, latestPlaceholder: null });
  }

  if (step === 'PICKING_TARGET') {
    const ok = await sendToContent({ type: 'START_ELEMENT_PICK' });
    if (ok) showView('step1');
  } else if (step === 'EDITING_PROMPT') {
    showStep2({ selector: pendingSelector, promptDraft, placeholders: pendingPlaceholders,
                claudeMode: state.claudeMode, folder: state.folder,
                repeat: state.repeat, repeatSelector: state.repeatSelector });
  } else if (step === 'PICKING_PLACEHOLDER') {
    showStep2({ selector: pendingSelector, promptDraft, placeholders: pendingPlaceholders,
                claudeMode: state.claudeMode, folder: state.folder,
                repeat: state.repeat, repeatSelector: state.repeatSelector });
    await sendToContent({
      type: 'START_PLACEHOLDER_PICK',
      repeatSelector: state.repeat ? pendingSelector : null,
    });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────

async function startNewButtonSetup() {
  editIndex             = -1;
  editMode              = false;
  pendingSelector       = null;
  pendingUniqueSelector = null;
  pendingRepeatSelector = null;
  pendingPlaceholders   = [];
  await saveSetupState({ step: 'PICKING_TARGET', editMode: false, editIndex: -1, placeholders: [], promptDraft: '' });
  const ok = await sendToContent({ type: 'START_ELEMENT_PICK' });
  if (ok) showView('step1');
}

document.getElementById('btn-setup').addEventListener('click', startNewButtonSetup);
document.getElementById('btn-add-button').addEventListener('click', startNewButtonSetup);

document.getElementById('btn-cancel-step1').addEventListener('click', cancelSetup);

document.getElementById('btn-repick').addEventListener('click', async () => {
  const promptDraft = document.getElementById('prompt-textarea').value;
  await saveSetupState({
    step: 'PICKING_TARGET', promptDraft, placeholders: pendingPlaceholders,
    claudeMode: modeSelect.value, folder: folderInput.value.trim(),
    editMode, editIndex,
  });
  const ok = await sendToContent({ type: 'START_ELEMENT_PICK' });
  if (ok) showView('step1');
});

document.getElementById('btn-add-placeholder').addEventListener('click', async () => {
  saveCursor();
  const promptDraft = document.getElementById('prompt-textarea').value;
  const repeat      = document.getElementById('repeat-toggle').checked;
  await saveSetupState({
    step: 'PICKING_PLACEHOLDER', promptDraft, cursorPos, placeholders: pendingPlaceholders,
    claudeMode: modeSelect.value, folder: folderInput.value.trim(),
    editMode, editIndex, repeat,
    repeatSelector: pendingRepeatSelector,
  });
  await sendToContent({
    type: 'START_PLACEHOLDER_PICK',
    repeatSelector: repeat ? pendingSelector : null,
  });
});

document.getElementById('prompt-textarea').addEventListener('keyup',   saveCursor);
document.getElementById('prompt-textarea').addEventListener('mouseup',  saveCursor);
document.getElementById('prompt-textarea').addEventListener('focus',    saveCursor);

document.getElementById('btn-save').addEventListener('click', saveConfig);
document.getElementById('btn-cancel-step2').addEventListener('click', cancelSetup);
document.getElementById('btn-error-ok').addEventListener('click', () => {
  const configs = sites[hostname];
  if (configs && configs.length > 0) { renderConfiguredView(); showView('configured'); }
  else                               { showView('unconfigured'); }
});

// ─── Messages from content script ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  (async () => {
    if (msg.type === 'ELEMENT_PICKED') {
      const { setupState = {} } = await chrome.storage.local.get('setupState');
      const promptDraft  = setupState.promptDraft || '';
      const placeholders = (setupState.placeholders || []).map(p => ({ ...p }));
      pendingRepeatSelector = msg.repeatSelector || null;
      await saveSetupState({ step: 'EDITING_PROMPT', selector: msg.selector, repeatSelector: msg.repeatSelector });
      pendingPlaceholders = placeholders;
      showStep2({ selector: msg.selector, promptDraft, placeholders,
                  claudeMode: setupState.claudeMode, folder: setupState.folder,
                  repeatSelector: msg.repeatSelector, repeatCount: msg.repeatCount });
    }

    if (msg.type === 'PLACEHOLDER_PICKED') {
      const name = uniquePlaceholderName(msg.name);
      pendingPlaceholders.push({ name, selector: msg.selector, text: msg.text });
      insertAtCursor(`{{${name}}}`);
      renderPlaceholderList();
      const promptDraft = document.getElementById('prompt-textarea').value;
      await saveSetupState({ step: 'EDITING_PROMPT', latestPlaceholder: null,
                             placeholders: pendingPlaceholders, promptDraft });
    }

    if (msg.type === 'CANCEL_PICK') {
      if (msg.mode === 'placeholder' && pendingSelector) {
        await saveSetupState({ step: 'EDITING_PROMPT' });
        showView('step2');
      } else {
        await clearSetupState();
        const configs = sites[hostname];
        if (configs && configs.length > 0) { renderConfiguredView(); showView('configured'); }
        else                               { showView('unconfigured'); }
      }
    }
  })();
  return false;
});

// ─── Init ─────────────────────────────────────────────────────────────────

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showError('No active tab found.'); return; }

  tabId = tab.id;

  try {
    hostname = new URL(tab.url).hostname;
  } catch (_) {
    showError('This page cannot be configured.');
    return;
  }

  hostnameLabel.textContent = hostname;
  hostnameBar.classList.remove('hidden');

  const data = await chrome.storage.local.get(['sites', 'setupState']);
  sites = data.sites ?? {};

  // Migrate old single-config format to array
  let migrated = false;
  for (const [host, val] of Object.entries(sites)) {
    if (val && !Array.isArray(val)) { sites[host] = [val]; migrated = true; }
  }
  if (migrated) await chrome.storage.local.set({ sites });

  const setupState = data.setupState;

  if (setupState && setupState.hostname === hostname) {
    await restoreFromSetupState(setupState);
  } else if (sites[hostname]?.length > 0) {
    renderConfiguredView();
    showView('configured');
  } else {
    showView('unconfigured');
  }
})();
