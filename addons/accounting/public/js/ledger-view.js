'use strict';

/**
 * [{Ledger}] placeholders load their tables when the page opens, the way the
 * calendar loads its events: the page's cached HTML never holds the figures.
 * The server builds the tables (escaped) under the reader's own permissions.
 */
(function () {
  const PARAMS = ['view', 'month', 'from', 'to', 'max', 'fund', 'voided', 'export'];

  async function load(el) {
    if (el.dataset.ledgerLoaded) return;
    el.dataset.ledgerLoaded = '1';
    const query = new URLSearchParams();
    for (const key of PARAMS) if (el.dataset[key]) query.set(key, el.dataset[key]);
    try {
      const res = await fetch('/api/accounting/view?' + query.toString(), { credentials: 'same-origin' });
      const json = await res.json();
      if (json.ok) {
        el.innerHTML = json.result.html; // built and escaped by the server
      } else {
        el.textContent = json.error || 'The ledger could not be shown.';
      }
    } catch {
      el.textContent = 'The ledger could not be loaded. Reload the page to try again.';
    }
  }

  document.querySelectorAll('.ledger-view').forEach(load);
})();
