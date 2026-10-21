/* embed-boot.js — tiny CLASSIC script (loaded synchronously in every page's <head>).
   1) Inside the app shell (app.html) it marks the page «embedded» BEFORE first paint, so the page's own sidebar never flashes.
   2) Opened on its own (a bookmark / a typed address / an old link) a PLAIN page URL is sent into the shell: index.html → app.html#/index.html.
      It stays standalone when: the URL carries a query (product.html?id=…, manager.html?openAdd=1 …), or ?standalone=1, or localStorage.noShell = '1' (the UI tests drive pages directly). */
(function () {
  try {
    var inFrame = window.self !== window.top;
    var embedded = inFrame || /[?&]embed=1(&|$)/.test(location.search);
    if (embedded) {
      document.documentElement.classList.add('is-embedded');
      var t = localStorage.getItem('theme'); // keep the theme in sync with the shell (the shell owns the toggle)
      if (t) document.documentElement.dataset.theme = t;
      return;
    }
    var m = /\/([a-z0-9-]+\.html)$/i.exec(location.pathname);
    var PAGES = ['index', 'alerts', 'tasks', 'entry', 'easy-orders', 'lost-orders', 'store-connections', 'customers', 'products', 'inventory', 'compare', 'ranking', 'product-research', 'ai-media-buyer', 'ai-intelligence', 'product-marketing-center', 'creative-factory', 'work', 'manager', 'users', 'settings', 'backup-recovery', 'ai-usage', 'easyorders-catalog-sync'];
    if (m && PAGES.indexOf(m[1].replace(/\.html$/i, '').toLowerCase()) >= 0 && !location.search && localStorage.getItem('noShell') !== '1') {
      location.replace('app.html#/' + m[1].toLowerCase() + location.hash);
    }
  } catch (e) { /* a locked-down browser must never break page load */ }
})();
