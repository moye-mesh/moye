/* ADR-0013 ⌘K command palette — verbs from GET /a2a/api/verbs (fallback: embedded list). */
(function (global) {
  'use strict';
  const API = (global.MOYE_API_BASE || '/a2a').replace(/\/$/, '');

  // i18n skeleton: each entry keeps an `en` label; add another language key later.
  const FALLBACK = [
    { id: 'find', en: 'Find / discover', href: '/directory' },
    { id: 'room.create', en: 'Create room', href: '/rooms' },
    { id: 'stream', en: 'Stream', href: '/stream' },
    { id: 'verify', en: 'Verify ledger', href: '/a2a/dashboard/dashboard.html' },
    { id: 'docs', en: 'Docs', href: '/docs' },
  ];

  let verbs = FALLBACK.slice();
  let open = false;
  let el, input, list;

  const lang = () => 'en';

  function ensureDom() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'moye-cmdk';
    el.hidden = true;
    el.innerHTML =
      '<div class="moye-cmdk-backdrop" data-close></div>' +
      '<div class="moye-cmdk-panel" role="dialog" aria-label="Command palette">' +
      '<input type="search" class="moye-cmdk-input" placeholder="Type a verb…" autocomplete="off" />' +
      '<ul class="moye-cmdk-list"></ul>' +
      '<div class="moye-cmdk-hint">⌘K / Ctrl+K · Esc</div></div>';
    const style = document.createElement('style');
    style.textContent =
      '#moye-cmdk{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:12vh 1rem}' +
      '#moye-cmdk[hidden]{display:none}' +
      '.moye-cmdk-backdrop{position:absolute;inset:0;background:rgba(1,4,10,.72);backdrop-filter:blur(6px)}' +
      '.moye-cmdk-panel{position:relative;width:min(520px,100%);background:#0a0f1c;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.5);overflow:hidden}' +
      '.moye-cmdk-input{width:100%;padding:1rem 1.1rem;border:0;border-bottom:1px solid rgba(255,255,255,.08);background:transparent;color:#f8fafc;font:500 1rem Inter,system-ui,sans-serif;outline:none}' +
      '.moye-cmdk-list{list-style:none;margin:0;padding:.5rem;max-height:50vh;overflow:auto}' +
      '.moye-cmdk-list li{padding:.65rem .75rem;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;gap:1rem;font-size:.875rem;color:#94a3b8}' +
      '.moye-cmdk-list li:hover,.moye-cmdk-list li[aria-selected=true]{background:rgba(255,255,255,.06);color:#f8fafc}' +
      '.moye-cmdk-list .id{font-family:JetBrains Mono,ui-monospace,monospace;color:#06b6d4;font-size:.75rem}' +
      '.moye-cmdk-hint{padding:.5rem 1rem .75rem;font-size:.7rem;color:#475569;font-family:JetBrains Mono,ui-monospace,monospace}';
    document.head.appendChild(style);
    document.body.appendChild(el);
    input = el.querySelector('.moye-cmdk-input');
    list = el.querySelector('.moye-cmdk-list');
    el.addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) close(); });
    input.addEventListener('input', render);
    input.addEventListener('keydown', onKey);
  }

  function hrefFor(v) {
    if (v.href) return v.href;
    const map = {
      find: '/directory', register: '/directory', 'room.create': '/rooms', 'room.join': '/rooms',
      stream: '/stream', verify: '/a2a/dashboard/dashboard.html',
    };
    return map[v.id] || '/docs';
  }

  function filtered() {
    const q = (input.value || '').trim().toLowerCase();
    const L = lang();
    return verbs.filter((v) => {
      const label = (v[L] || v.en || v.id || '').toLowerCase();
      return !q || v.id.includes(q) || label.includes(q) || (v.cli || '').includes(q) || (v.mcp || '').includes(q);
    }).slice(0, 12);
  }

  let sel = 0;
  function render() {
    const rows = filtered();
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    const L = lang();
    list.innerHTML = rows.map((v, i) =>
      `<li data-i="${i}" aria-selected="${i === sel}"><span>${v[L] || v.en || v.id}</span><span class="id">${v.id}</span></li>`
    ).join('') || `<li style="cursor:default;color:#475569">No matches</li>`;
    list.querySelectorAll('li[data-i]').forEach((li) => {
      li.addEventListener('click', () => go(rows[+li.getAttribute('data-i')]));
    });
  }

  function go(v) {
    if (!v) return;
    close();
    location.href = hrefFor(v);
  }

  function onKey(e) {
    const rows = filtered();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(rows[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function openPalette() {
    ensureDom();
    open = true;
    el.hidden = false;
    sel = 0;
    input.value = '';
    input.placeholder = 'Type a verb…';
    render();
    input.focus();
  }
  function close() {
    open = false;
    if (el) el.hidden = true;
  }

  async function loadVerbs() {
    try {
      const r = await fetch(API + '/api/verbs');
      const j = await r.json();
      if (j && j.verbs && j.verbs.length) verbs = j.verbs;
    } catch { /* keep fallback */ }
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (open) close(); else openPalette();
    }
  });

  loadVerbs();
  global.Moye = global.Moye || {};
  global.Moye.openCommandPalette = openPalette;
})(window);
