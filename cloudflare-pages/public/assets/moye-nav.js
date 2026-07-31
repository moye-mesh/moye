/* ==========================================================================
   MOYE shared navigation

   Every page used to hand-write its own nav. They drifted (same destination,
   different labels) and adding a page meant editing many files. Defined once
   here; pages call Moye.mountNav().

   The dashboard is served by the backend rather than Pages, so links are absolute
   against a configurable origin and still work when opened directly on a node.

   i18n skeleton: each item keeps an `en` label. Add another language key later
   without changing callers; for now lang() is always 'en' (no switcher UI).
   ========================================================================== */
(function (global) {
  'use strict';

  // Single source of truth. Adding a page means adding one line here.
  const NAV = [
    { href: '/',           en: 'Home' },
    { href: '/directory',  en: 'Directory' },
    { href: '/rooms',      en: 'Rooms' },
    { href: '/stream',     en: 'Stream' },
    { href: '/docs',       en: 'Docs' },
    { href: '/a2a/dashboard/dashboard.html', en: 'Status', match: '/a2a/dashboard' },
  ];

  const lang = () => 'en';

  // A page served from the backend (the dashboard) has no Pages-relative root, so it needs an
  // absolute site origin. Pages-served files stay relative so previews/local dev work unchanged.
  function resolveHref(href, siteOrigin) {
    if (!siteOrigin) return href;
    return href.startsWith('http') ? href : siteOrigin.replace(/\/$/, '') + href;
  }

  function isCurrent(item) {
    const p = location.pathname.replace(/\/index\.html$/, '/');
    const target = item.match || item.href;
    if (target === '/') return p === '/' || p === '';
    return p === target || p.startsWith(target + '/') || p.startsWith(target);
  }

  /* Renders menu links into <nav id="nav"> (centered). Page-owned controls that were
     inside #nav (account, conn, live tick, …) move to #header-end on the right. */
  function ensureHeaderEnd(nav) {
    let end = document.getElementById('header-end');
    if (end) return end;
    const container = nav.parentElement;
    if (!container) return null;
    end = document.createElement('div');
    end.id = 'header-end';
    end.className = 'header-end';
    container.appendChild(end);
    return end;
  }

  function mountNav({ siteOrigin = '', extra = '' } = {}) {
    const nav = document.getElementById('nav');
    if (!nav) return;
    // Bust stale cached moye.css so header layout (centered menu) actually applies.
    if (!document.getElementById('moye-header-layout')) {
      const s = document.createElement('style');
      s.id = 'moye-header-layout';
      s.textContent = [
        '.site-header .container{display:flex;align-items:center;gap:.75rem;position:relative}',
        '.header-start{display:flex;align-items:center;gap:.75rem;margin-right:auto;z-index:2;min-width:0}',
        '.header-end{display:flex;align-items:center;gap:.5rem;margin-left:auto;z-index:2;justify-content:flex-end;min-width:0;flex-wrap:wrap}',
        '.nav{display:flex;align-items:center;gap:.25rem;position:absolute;left:50%;transform:translateX(-50%);z-index:1;margin:0}',
        '@media (max-width:768px){.nav{position:fixed;left:0;right:0;top:var(--header-h);transform:translateY(-8px);flex-direction:column;align-items:stretch;background:var(--bg-elevated);border-bottom:1px solid var(--border);padding:.75rem;opacity:0;pointer-events:none;z-index:45;max-height:calc(100dvh - var(--header-h));overflow-y:auto}.nav.open{opacity:1;pointer-events:auto;transform:none}}',
      ].join('');
      document.head.appendChild(s);
    }
    const end = ensureHeaderEnd(nav);
    if (end) {
      while (nav.firstChild) end.appendChild(nav.firstChild);
    }
    const L = lang();
    nav.innerHTML = NAV.map((item) => {
      const cur = isCurrent(item);
      return `<a href="${resolveHref(item.href, siteOrigin)}"${cur ? ' aria-current="page"' : ''}>${item[L]}</a>`;
    }).join('');
    if (extra && end) end.insertAdjacentHTML('beforeend', extra);
  }

  function navItems() { return NAV.map((i) => ({ ...i, label: i[lang()] })); }

  global.Moye = global.Moye || {};
  global.Moye.mountNav = mountNav;
  global.Moye.navItems = navItems;

  // P1-5: load ⌘K palette once per page that uses the shared nav.
  if (typeof document !== 'undefined' && !document.querySelector('script[data-moye-cmdk]')) {
    const s = document.createElement('script');
    s.src = '/assets/moye-cmdk.js';
    s.async = true;
    s.setAttribute('data-moye-cmdk', '1');
    (document.head || document.documentElement).appendChild(s);
  }
})(window);
