(function () {
  'use strict';

  let currentConfigs    = [];
  let lastHovered       = null;
  let lastHoveredOutline= '';
  let highlightedEl     = null;
  let highlightedOutline= '';
  let observer          = null;
  let debounceTimer     = null;
  let pickMode          = null; // 'target' | 'placeholder' | null
  let pickRepeatSelector= null; // set when picking placeholder in repeat mode

  // ─── Extension context guard ──────────────────────────────────────────────

  function contextValid() {
    try { return !!chrome.runtime.id; } catch (_) { return false; }
  }

  function teardown() {
    stopObserver();
    removeAllButtons();
    exitPickMode();
  }

  function safeSend(msg) {
    if (!contextValid()) { teardown(); return; }
    try { chrome.runtime.sendMessage(msg); } catch (_) { teardown(); }
  }

  // ─── Selector generation ──────────────────────────────────────────────────

  // Classes that are styling utilities, not semantic identifiers
  const IGNORED_CLS = /^(d-|m[trblxy]?-|p[trblxy]?-|text-|font-|bg-|border-|flex|grid|row|col-?|container|wrapper|inner|outer|active|selected|disabled|focus|hover|visible|hidden|show|hide|is-|has-|js-|clearfix|float-|align-|justify-|w-|h-|sr-only|fw-|fs-|gap-|rounded|shadow|overflow)/;
  const STABLE_ATTRS = ['data-testid', 'data-cy', 'data-test', 'data-id', 'name', 'aria-label'];

  function meaningfulClasses(el) {
    return Array.from(el.classList).filter(c => !IGNORED_CLS.test(c));
  }

  // Returns shortest unique selector for el within the given qs function, or null
  function uniqueShortSelector(el, qs) {
    if (el.id) {
      const s = '#' + CSS.escape(el.id);
      if (qs(s).length === 1) return s;
    }
    for (const attr of STABLE_ATTRS) {
      const val = el.getAttribute(attr);
      if (val) {
        const s = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
        if (qs(s).length === 1) return s;
      }
    }
    const tag = el.tagName.toLowerCase();
    const cls = meaningfulClasses(el);
    // Try single and paired class combinations
    for (let i = 0; i < Math.min(cls.length, 4); i++) {
      for (let j = i; j < Math.min(cls.length, 5); j++) {
        const s = i === j
          ? `${tag}.${CSS.escape(cls[i])}`
          : `${tag}.${CSS.escape(cls[i])}.${CSS.escape(cls[j])}`;
        if (qs(s).length === 1) return s;
      }
    }
    return null;
  }

  // Generate best selector for el, optionally scoped to a container element
  function generateSelector(el, scope) {
    const root     = scope || document;
    const qs       = s => root.querySelectorAll(s);
    const boundary = scope || document.documentElement;

    // 1. Direct unique short selector
    const direct = uniqueShortSelector(el, qs);
    if (direct) return direct;

    // 2. Stable ancestor + descendant (avoid > and nth where possible)
    const tag = el.tagName.toLowerCase();
    const cls = meaningfulClasses(el);
    let anc = el.parentElement;
    for (let d = 0; d < 8 && anc && anc !== boundary; d++, anc = anc.parentElement) {
      const ancSel = uniqueShortSelector(anc, qs);
      if (!ancSel) continue;
      const descs = [
        cls.length > 1 ? `${tag}.${CSS.escape(cls[0])}.${CSS.escape(cls[1])}` : null,
        cls.length > 0 ? `${tag}.${CSS.escape(cls[0])}` : null,
        tag,
      ].filter(Boolean);
      for (const desc of descs) {
        try {
          const ms = qs(`${ancSel} ${desc}`);
          if (ms.length === 1 && ms[0] === el) return `${ancSel} ${desc}`;
        } catch (_) {}
      }
    }

    // 3. Fallback: structural nth path (stops at nearest ID ancestor)
    return buildNthPath(el, scope);
  }

  function buildNthPath(el, scope) {
    const root     = scope || document;
    const boundary = scope || document.documentElement;
    const parts    = [];
    let cur        = el;
    while (cur && cur !== boundary && cur.tagName) {
      const tag = cur.tagName.toLowerCase();
      const par = cur.parentElement;
      let seg   = tag;
      if (par && par !== boundary) {
        const siblings = Array.from(par.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) seg = `${tag}:nth-of-type(${siblings.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = par;
      if (cur && cur !== boundary && cur.id) {
        const idSel = '#' + CSS.escape(cur.id);
        if (root.querySelectorAll(idSel).length === 1) { parts.unshift(idSel); break; }
      }
    }
    return parts.join(' > ');
  }

  // Returns { selector, count } for a generalised selector matching multiple siblings, or null
  function generateRepeatableSelector(el) {
    const tag = el.tagName.toLowerCase();
    const cls = meaningfulClasses(el);
    const qs  = s => document.querySelectorAll(s);

    for (const c of cls) {
      for (const s of [`${tag}.${CSS.escape(c)}`, `.${CSS.escape(c)}`]) {
        const count = qs(s).length;
        if (count > 1) return { selector: s, count };
      }
    }
    // Tag within nearest stable parent
    const par = el.parentElement;
    if (par) {
      const siblings = Array.from(par.children).filter(c => c.tagName === el.tagName);
      if (siblings.length > 1) {
        const parSel = uniqueShortSelector(par, qs);
        if (parSel) {
          const s = `${parSel} > ${tag}`;
          const count = qs(s).length;
          if (count > 1) return { selector: s, count };
        }
      }
    }
    return null;
  }

  // ─── Element text extraction ──────────────────────────────────────────────

  function getElementText(el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return el.value.trim();
    return el.textContent.trim();
  }

  // ─── Placeholder name suggestion ──────────────────────────────────────────

  function suggestPlaceholderName(el) {
    const ignoredClasses = /^(container|wrapper|inner|outer|flex|grid|row|col|d-|m-|p-|text-|bg-|is-|has-|js-)/;
    const classes = Array.from(el.classList).filter(c => !ignoredClasses.test(c));
    if (classes.length > 0) return classes[0].replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '');

    const tagMap = { h1: 'title', h2: 'subtitle', h3: 'heading', h4: 'heading',
                     p: 'content', span: 'text', a: 'link', img: 'image',
                     time: 'date', code: 'code', pre: 'code', li: 'item',
                     td: 'cell', th: 'header', label: 'label', input: 'value',
                     textarea: 'text', select: 'value' };
    const tag = el.tagName.toLowerCase();
    if (tagMap[tag]) return tagMap[tag];

    if (el.id) return el.id.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '');

    return 'value';
  }

  // ─── Pick mode ────────────────────────────────────────────────────────────

  function onMouseMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);

    if (!el || el.closest?.('#ocwc-banner')) {
      if (lastHovered) {
        lastHovered.style.outline = lastHoveredOutline;
        lastHovered = null;
      }
      return;
    }

    if (el === lastHovered) return;

    if (lastHovered) lastHovered.style.outline = lastHoveredOutline;
    lastHovered = el;
    lastHoveredOutline = el.style.outline;
    el.style.outline = '2px solid #DE7356';
  }

  function pickElement(el) {
    let selector, relative = false;
    if (pickMode === 'placeholder' && pickRepeatSelector) {
      const container = el.closest(pickRepeatSelector);
      if (container) {
        selector = generateSelector(el, container);
        relative = true;
      } else {
        selector = generateSelector(el);
      }
    } else {
      selector = generateSelector(el);
    }
    const name = suggestPlaceholderName(el);
    const text = getElementText(el).slice(0, 200);
    const mode = pickMode;
    exitPickMode();

    if (mode === 'target') {
      const repeatInfo = generateRepeatableSelector(el);
      safeSend({
        type: 'ELEMENT_PICKED',
        selector, name, text,
        repeatSelector: repeatInfo?.selector ?? null,
        repeatCount:    repeatInfo?.count    ?? 1,
      });
    } else {
      safeSend({ type: 'PLACEHOLDER_PICKED', selector, name, text, relative });
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      const mode = pickMode;
      exitPickMode();
      safeSend({ type: 'CANCEL_PICK', mode });
      return;
    }

    if (e.key === 's' || e.key === 'S') {
      if (!lastHovered) return;
      e.preventDefault();
      e.stopPropagation();
      pickElement(lastHovered);
    }
  }

  function enterPickMode(mode, repeatSelector) {
    if (pickMode) exitPickMode();
    pickMode           = mode;
    pickRepeatSelector = repeatSelector || null;

    const banner = document.createElement('div');
    banner.id = 'ocwc-banner';

    const instructions = document.createElement('span');
    instructions.textContent = mode === 'target'
      ? 'Hover the element where the button should appear, then press'
      : 'Hover the element whose text you want in the prompt, then press';

    const sKey = document.createElement('kbd');
    sKey.textContent = 'S';
    instructions.appendChild(sKey);
    instructions.appendChild(document.createTextNode(' to select  ·  '));
    const esc = document.createElement('kbd');
    esc.textContent = 'Esc';
    instructions.appendChild(esc);
    instructions.appendChild(document.createTextNode(' to cancel'));

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'ocwc-banner-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      const mode = pickMode;
      exitPickMode();
      safeSend({ type: 'CANCEL_PICK', mode });
    });

    banner.appendChild(instructions);
    banner.appendChild(cancelBtn);
    document.body.appendChild(banner);

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('keydown', onKeyDown, true);
  }

  function exitPickMode() {
    pickMode           = null;
    pickRepeatSelector = null;

    const banner = document.getElementById('ocwc-banner');
    if (banner) banner.remove();

    if (lastHovered) {
      lastHovered.style.outline = lastHoveredOutline;
      lastHovered = null;
    }

    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('keydown', onKeyDown, true);
  }

  // ─── Button injection ─────────────────────────────────────────────────────

  const CLAUDE_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill-rule="nonzero"/></svg>`;

  function injectButton(config) {
    const modeLabels = { chat: 'Chat', code: 'Code', cowork: 'Cowork' };
    const modeLabel  = modeLabels[config.claudeMode] ?? 'Chat';
    const targets    = config.repeat
      ? Array.from(document.querySelectorAll(config.targetSelector))
      : (() => { const t = document.querySelector(config.targetSelector); return t ? [t] : []; })();

    for (const target of targets) {
      if (target.querySelector('[data-ocwc-btn]')) continue;
      const btn = document.createElement('button');
      btn.dataset.ocwcBtn = '1';
      btn.innerHTML = CLAUDE_ICON_SVG + 'Open in Claude ' + modeLabel;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        buildPromptAndOpen(config, config.repeat ? target : null);
      });

      let tooltipEl = null;
      btn.addEventListener('mouseenter', () => {
        const text = resolvePrompt(config, config.repeat ? target : null);
        if (!text) return;
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'ocwc-tooltip';
        tooltipEl.textContent = text;
        tooltipEl.style.visibility = 'hidden';
        document.body.appendChild(tooltipEl);
        const br = btn.getBoundingClientRect();
        const tr = tooltipEl.getBoundingClientRect();
        const top  = (br.top - tr.height - 10 < 8)
          ? Math.min(br.bottom + 10, window.innerHeight - tr.height - 8)
          : br.top - tr.height - 10;
        const left = Math.min(Math.max(8, br.left), window.innerWidth - tr.width - 8);
        tooltipEl.style.top  = top  + 'px';
        tooltipEl.style.left = left + 'px';
        tooltipEl.style.visibility = '';
      });
      btn.addEventListener('mouseleave', () => {
        if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
      });

      target.appendChild(btn);
    }
  }

  function resolvePrompt(config, containerEl) {
    let prompt = config.promptTemplate || '';
    for (const placeholder of (config.placeholders || [])) {
      const scope = containerEl && placeholder.relative ? containerEl : document;
      const el    = scope.querySelector(placeholder.selector);
      prompt = prompt.replaceAll(`{{${placeholder.name}}}`, el ? getElementText(el) : '');
    }
    return prompt;
  }

  function buildPromptAndOpen(config, containerEl) {
    const q      = encodeURIComponent(resolvePrompt(config, containerEl).replace(/\n/g, ' '));
    const folder = config.folder ? '&folder=' + encodeURIComponent(config.folder) : '';
    let url;
    switch (config.claudeMode) {
      case 'code':   url = `claude://code/new?q=${q}${folder}`;   break;
      case 'cowork': url = `claude://cowork/new?q=${q}${folder}`; break;
      default:       url = `claude://claude.ai/new?q=${q}`;       break;
    }

    window.location.href = url;
  }

  // ─── MutationObserver ─────────────────────────────────────────────────────

  function injectAllButtons(configs) {
    configs.forEach(injectButton);
  }

  function startObserver(configs) {
    stopObserver();
    observer = new MutationObserver(() => {
      if (!contextValid()) { teardown(); return; }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => injectAllButtons(configs), 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(debounceTimer);
  }

  function removeAllButtons() {
    document.querySelectorAll('[data-ocwc-btn]').forEach(b => b.remove());
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'START_ELEMENT_PICK':
        enterPickMode('target');
        sendResponse({ ok: true });
        break;

      case 'START_PLACEHOLDER_PICK':
        enterPickMode('placeholder', msg.repeatSelector || null);
        sendResponse({ ok: true });
        break;

      case 'CANCEL_PICK':
        exitPickMode();
        sendResponse({ ok: true });
        break;

      case 'SELECT_HOVERED': {
        if (!pickMode || !lastHovered) {
          sendResponse({ ok: false, reason: 'not in pick mode or nothing hovered' });
          break;
        }
        pickElement(lastHovered);
        sendResponse({ ok: true });
        break;
      }

      case 'INJECT_BUTTON':
        currentConfigs = msg.configs;
        stopObserver();
        removeAllButtons();
        injectAllButtons(currentConfigs);
        startObserver(currentConfigs);
        sendResponse({ ok: true });
        break;

      case 'REMOVE_BUTTON':
        currentConfigs = [];
        stopObserver();
        removeAllButtons();
        sendResponse({ ok: true });
        break;

      case 'GET_STATUS':
        sendResponse({ injected: !!document.querySelector('[data-ocwc-btn]') });
        break;

      case 'HIGHLIGHT_ELEMENT': {
        if (highlightedEl) {
          highlightedEl.style.outline = highlightedOutline;
        }
        const hEl = document.querySelector(msg.selector);
        if (hEl) {
          highlightedEl     = hEl;
          highlightedOutline= hEl.style.outline;
          hEl.style.outline = '2px solid #DE7356';
          hEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'UNHIGHLIGHT_ELEMENT': {
        if (highlightedEl) {
          highlightedEl.style.outline = highlightedOutline;
          highlightedEl = null;
        }
        sendResponse({ ok: true });
        break;
      }

      case 'GET_ELEMENT_TEXT': {
        let tEl;
        if (msg.relative && msg.containerSelector) {
          const container = document.querySelector(msg.containerSelector);
          tEl = container ? container.querySelector(msg.selector) : null;
        } else {
          tEl = document.querySelector(msg.selector);
        }
        sendResponse({ text: tEl ? getElementText(tEl).slice(0, 200) : null });
        break;
      }

      case 'GET_BUTTON_STATUS': {
        const btargets = msg.repeat
          ? Array.from(document.querySelectorAll(msg.selector))
          : [document.querySelector(msg.selector)].filter(Boolean);
        sendResponse({ injected: btargets.length > 0 && btargets.some(t => t.querySelector('[data-ocwc-btn]')) });
        break;
      }

      case 'SCROLL_TO_BUTTON': {
        const stargets = msg.repeat
          ? Array.from(document.querySelectorAll(msg.selector))
          : [document.querySelector(msg.selector)].filter(Boolean);
        const btn = stargets.map(t => t.querySelector('[data-ocwc-btn]')).find(Boolean);
        const anchor = btn || stargets[0];
        if (anchor) {
          anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const prev = anchor.style.outline;
          anchor.style.outline = '3px solid #DE7356';
          setTimeout(() => { anchor.style.outline = prev; }, 1500);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'GET_ELEMENT_COUNT': {
        try {
          sendResponse({ count: document.querySelectorAll(msg.selector).length });
        } catch (_) {
          sendResponse({ count: 0 });
        }
        break;
      }
    }
    return false;
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  (async function init() {
    if (!contextValid()) return;
    try {
      const { sites = {} } = await chrome.storage.local.get('sites');
      const hostname = location.hostname;
      let configs = sites[hostname];
      if (configs) {
        if (!Array.isArray(configs)) configs = [configs]; // migrate old format
        currentConfigs = configs;
        injectAllButtons(configs);
        startObserver(configs);
      }
    } catch (_) {}
  })();
})();
