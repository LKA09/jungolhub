(() => {
  'use strict';

  const DEBUG_KEY = 'jungolhubDebugLogs';

  async function debug(stage, data = {}) {
    const entry = { at: new Date().toISOString(), stage, url: location.href, data };
    console.info('[JungolHub]', stage, data);
    try {
      const stored = await chrome.storage.local.get({ [DEBUG_KEY]: [] });
      const logs = [...(stored[DEBUG_KEY] || []), entry].slice(-100);
      await chrome.storage.local.set({ [DEBUG_KEY]: logs });
    } catch {}
  }

  function showBadge() {
    const render = () => {
      if (!document.documentElement || document.getElementById('jungolhub-active-badge')) return;
      const badge = document.createElement('div');
      badge.id = 'jungolhub-active-badge';
      badge.textContent = 'JungolHub active';
      Object.assign(badge.style, {
        position: 'fixed',
        right: '14px',
        bottom: '14px',
        zIndex: '2147483647',
        padding: '7px 10px',
        borderRadius: '999px',
        background: '#16794b',
        color: '#fff',
        font: '600 12px system-ui,sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,.18)',
        pointerEvents: 'none'
      });
      document.documentElement.appendChild(badge);
      setTimeout(() => badge.remove(), 3500);
    };

    if (document.documentElement) render();
    else document.addEventListener('DOMContentLoaded', render, { once: true });
  }

  debug('probe-injected', { host: location.host, path: location.pathname });
  showBadge();
})();
