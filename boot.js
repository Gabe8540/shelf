/* Shelf web version: keep the list in step with GitHub while the page is open. */
(function () {
  'use strict';
  const kick = function () { if (!document.hidden && typeof self.ghSync === 'function') self.ghSync(); };
  setTimeout(kick, 200);
  setInterval(kick, 60000);
  document.addEventListener('visibilitychange', kick); // coming back to the tab or the Home Screen app
})();
