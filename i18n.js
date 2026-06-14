/**
 * i18n.js — CryptoNova lightweight internationalisation loader
 * Supports: en, fr, es, pt, de, tr
 * Usage: <script src="/i18n.js" defer></script>
 * Keys: data-i18n="section.key"  data-i18n-placeholder="section.key"
 */
(function () {
  'use strict';

  const SUPPORTED = ['en', 'fr', 'es', 'pt', 'de', 'tr'];
  const FLAGS = { en: '🇬🇧 EN', fr: '🇫🇷 FR', es: '🇪🇸 ES', pt: '🇧🇷 PT', de: '🇩🇪 DE', tr: '🇹🇷 TR' };
  let _t = {};

  /* ── Language resolution ─────────────────────────────────── */
  function getLang() {
    const params = new URLSearchParams(window.location.search);
    const urlLang = params.get('lang');
    if (urlLang && SUPPORTED.includes(urlLang)) return urlLang;
    try {
      const stored = localStorage.getItem('cnova_lang');
      if (stored && SUPPORTED.includes(stored)) return stored;
    } catch (_) {}
    const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED.includes(browser) ? browser : 'en';
  }

  /* ── Key lookup ──────────────────────────────────────────── */
  function get(key, fallback) {
    const parts = key.split('.');
    let val = _t;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') return fallback !== undefined ? fallback : key;
      val = val[p];
    }
    return (val != null && val !== '') ? val : (fallback !== undefined ? fallback : key);
  }

  /* ── Apply translations to DOM ───────────────────────────── */
  function applyAll() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.innerHTML = get(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = get(el.getAttribute('data-i18n-placeholder'));
    });
    // Meta description
    var descEl = document.querySelector('meta[name="description"][data-i18n-content]');
    if (descEl) descEl.content = get(descEl.getAttribute('data-i18n-content'));
    // Page title
    var titleEl = document.querySelector('title[data-i18n]');
    if (titleEl) document.title = get(titleEl.getAttribute('data-i18n'));
    // HTML lang attribute
    document.documentElement.lang = getLang();
  }

  /* ── Fetch and apply a locale file ──────────────────────── */
  async function load(lang) {
    try {
      var r = await fetch('/locales/' + lang + '.json?v=811');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _t = await r.json();
    } catch (_) {
      // Fallback to English
      if (lang !== 'en') {
        try {
          var r2 = await fetch('/locales/en.json?v=811');
          _t = await r2.json();
        } catch (_2) {}
      }
    }
    applyAll();
  }

  /* ── Language switcher widget ────────────────────────────── */
  function buildSwitcher() {
    var wrap = document.getElementById('lang-switcher');
    if (!wrap) return;
    var lang = getLang();
    var sel = document.createElement('select');
    sel.title = 'Language / Langue / Idioma';
    sel.setAttribute('aria-label', 'Language');
    sel.className = 'lang-select';
    SUPPORTED.forEach(function (code) {
      var o = document.createElement('option');
      o.value = code;
      o.textContent = FLAGS[code];
      if (code === lang) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function (e) {
      var chosen = e.target.value;
      try { localStorage.setItem('cnova_lang', chosen); } catch (_) {}
      var u = new URL(window.location.href);
      u.searchParams.set('lang', chosen);
      window.location.href = u.toString();
    });
    wrap.appendChild(sel);
  }

  /* ── Public API ──────────────────────────────────────────── */
  window.t = get;
  window.i18nApply = applyAll; // call after dynamic DOM changes

  /* ── Boot ────────────────────────────────────────────────── */
  function boot() {
    buildSwitcher();
    load(getLang());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
