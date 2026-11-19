/* Shelf web version: stands in for the Chrome extension APIs, so the same tracker page and background
   logic run as an ordinary web page (GitHub Pages) on an iPhone, iPad or any browser.
   Storage lives in this browser (localStorage) and syncs through GitHub. */
(function () {
  'use strict';
  self.SHELF_WEB = true;
  const KEY = 'shelf-web-db';
  let data = {};
  try { data = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { data = {}; }
  let timer = null;
  const flush = function () { clearTimeout(timer); timer = null; try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { console.error('Shelf: browser storage is full', e); } };
  const persist = function () { if (!timer) timer = setTimeout(flush, 250); };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });

  const copy = function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
  const noop = function () {};
  const event = function () { const l = []; return { _l: l, addListener: function (f) { l.push(f); }, removeListener: function (f) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }, hasListener: function (f) { return l.indexOf(f) >= 0; } }; };
  const done = function (v, cb) { if (typeof cb === 'function') setTimeout(function () { cb(v); }, 0); return Promise.resolve(v); };
  const changed = event();
  const emit = function (ch) { if (Object.keys(ch).length) setTimeout(function () { changed._l.forEach(function (f) { try { f(ch, 'local'); } catch (e) { console.error(e); } }); }, 0); };

  const local = {
    get: function (keys, cb) {
      let out;
      if (keys == null) out = copy(data);
      else {
        out = {};
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        list.forEach(function (k) { if (k in data) out[k] = copy(data[k]); else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k]; });
      }
      return done(out, cb);
    },
    set: function (o, cb) {
      const ch = {};
      for (const k in o) { const v = copy(o[k]); ch[k] = { oldValue: data[k], newValue: v }; data[k] = v; }
      persist(); emit(ch); return done(undefined, cb);
    },
    remove: function (keys, cb) {
      const ch = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { if (k in data) { ch[k] = { oldValue: data[k] }; delete data[k]; } });
      persist(); emit(ch); return done(undefined, cb);
    },
    clear: function (cb) { const ch = {}; for (const k in data) ch[k] = { oldValue: data[k] }; data = {}; persist(); emit(ch); return done(undefined, cb); },
    getBytesInUse: function (k, cb) { return done(JSON.stringify(data).length, cb); }
  };
  const onMessage = event();
  self.chrome = {
    storage: { local: local, onChanged: changed },
    runtime: {
      id: 'web', lastError: undefined, onMessage: onMessage, onInstalled: event(), onStartup: event(),
      getURL: function (p) { return new URL(p, location.href).href; },
      getManifest: function () { return { version: self.SHELF_VERSION || '' }; },
      // the background logic runs in this same page: hand the message straight to it
      sendMessage: function (msg, cb) {
        return new Promise(function (res) {
          let over = false, wait = false;
          const reply = function (v) { if (over) return; over = true; res(v); if (typeof cb === 'function') cb(v); };
          onMessage._l.forEach(function (f) { try { if (f(msg, { id: 'web' }, reply) === true) wait = true; } catch (e) { console.error(e); } });
          if (!wait) reply(undefined);
        });
      }
    },
    alarms: { create: noop, clear: function (n, cb) { return done(true, cb); }, get: function (n, cb) { return done(undefined, cb); }, getAll: function (cb) { return done([], cb); }, onAlarm: event() },
    notifications: { create: noop, clear: noop, onClicked: event(), onButtonClicked: event() },
    tabs: {
      create: function (o) { window.open(o.url, '_blank', 'noopener'); return Promise.resolve({}); },
      query: function () { return Promise.resolve([]); }, sendMessage: function () { return Promise.resolve(); },
      update: function () { return Promise.resolve(); }, onUpdated: event()
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    windows: { update: noop }
  };
})();
