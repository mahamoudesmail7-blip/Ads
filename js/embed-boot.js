/* embed-boot.js — tiny CLASSIC script (loaded synchronously in every page's <head>) that marks the page as «embedded» when it runs inside the app shell (app.html)
   BEFORE first paint, so the page's own sidebar never flashes. A page opened on its own is untouched. */
(function () {
  try {
    var embedded = window.self !== window.top || /[?&]embed=1(&|$)/.test(location.search);
    if (embedded) {
      document.documentElement.classList.add('is-embedded');
      // keep the theme in sync with the shell (the shell owns the toggle)
      var t = localStorage.getItem('theme');
      if (t) document.documentElement.dataset.theme = t;
    }
  } catch (e) { /* a locked-down browser must never break page load */ }
})();
