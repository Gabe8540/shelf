/* Shelf GitHub sync: the list lives as one JSON file (shelf.json) in a private GitHub repo, and every device
   (Chrome extension or the web version) pulls it, merges, and pushes it back.
   Merge rules, per series:
   - what you change (progress, status, score, site, log, ...) goes by updatedAt: newer wins
   - what new-chapter checks find (next, up to date, release rhythm, ...) goes by ct: newer wins
   - covers and episode lengths are filled in when missing
   - a deleted series leaves a tombstone, so an old copy cannot bring it back */
(function (root) {
  'use strict';
  const TL = root.TL;
  const GH = {};

  GH.CHECK = ['next', 'upTo', 'cad', 'seen', 'chk', 'est', 'seriesUrl', 'nextUrl', 'rel'];
  const LOCAL = ['_hit'];            // never leaves the device
  const FILL = ['image', 'dur'];     // filled in, never overwritten
  GH.CFG = ['auto', 'delay', 'notify', 'covers', 'quiet', 'mutedSites', 'sites', 'malUser', 'siteNames'];
  const KEEP_GONE = 180 * 864e5;

  // Same series, same key on every device: MAL number when known (MAL imports get a different local id on each device), else the id.
  GH.key = function (e) { return e.malId ? (e.kind === 'anime' ? 'A' : 'M') + e.malId : e.id; };

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  GH.canon = canon;
  GH.checkSig = function (e) { const o = {}; GH.CHECK.forEach(function (f) { if (e[f] !== undefined) o[f] = e[f]; }); return canon(o); };
  GH.row = function (e) { const r = {}; for (const k in e) if (LOCAL.indexOf(k) < 0 && e[k] !== undefined) r[k] = e[k]; return r; };

  // The settings that travel with the list. Everything else (mute, focus sessions, tokens, notices) stays on the device.
  GH.cfgOf = function (s) {
    const v = {};
    GH.CFG.forEach(function (k) { if (s[k] !== undefined) v[k] = s[k]; });
    if (s.focus) v.focus = { quiet: s.focus.quiet, tracked: s.focus.tracked, sites: s.focus.sites || [] };
    if (s.mal) v.mal = { clientId: s.mal.clientId || '', manga: !!s.mal.manga, on: s.mal.on !== false };
    return v;
  };
  GH.cfgPatch = function (s, v) {
    const p = {};
    GH.CFG.forEach(function (k) { if (v[k] !== undefined) p[k] = v[k]; });
    if (v.focus) p.focus = Object.assign({}, s.focus, { quiet: v.focus.quiet, tracked: v.focus.tracked, sites: v.focus.sites || [] });
    if (v.mal) p.mal = Object.assign({}, s.mal, v.mal);
    return p;
  };

  /* local: this device's entries; doc: the file as last read (or null); gone: { key: time } deleted here since the last push.
     Returns { put: entries to write here, del: ids to remove here, doc: the file to write back (without c, u, by). } */
  GH.merge = function (local, doc, gone, now) {
    now = now || Date.now();
    doc = doc || {};
    const rows = doc.e || {}, byId = new Map(), byMal = new Map(), put = new Map(), del = new Set();
    const index = function (e) { byId.set(e.id, e); if (e.malId) byMal.set(e.kind + ':' + e.malId, e); };
    local.forEach(index);
    const find = function (k) { const m = /^([AM])(\d+)$/.exec(k); return m ? byMal.get((m[1] === 'A' ? 'anime' : 'manga') + ':' + m[2]) : byId.get(k); };
    const cur = function (e) { return put.get(e.id) || e; };

    const tomb = {};
    [doc.g || {}, gone || {}].forEach(function (g) { for (const k in g) if (!(tomb[k] >= g[k])) tomb[k] = g[k]; });

    for (const k in rows) {
      const r = rows[k];
      if (!r || typeof r !== 'object' || !r.title || (r.kind !== 'manga' && r.kind !== 'anime')) continue;
      const rt = Number(r.updatedAt) || 0, l = find(k);
      if (!l) {
        if (tomb[k] != null && tomb[k] >= rt) continue; // deleted after this copy was made
        let id = typeof r.id === 'string' && r.id ? r.id : '';
        if (!id || byId.has(id)) id = TL.newId(r.kind); // that id is taken by a different series here
        const n = Object.assign({}, r, { id: id });
        put.set(id, n); index(n);
        continue;
      }
      const c = cur(l);
      let n = null;
      if (rt > (Number(c.updatedAt) || 0)) { // what you changed elsewhere is newer
        n = Object.assign({}, r, { id: c.id });
        GH.CHECK.concat(LOCAL, ['ct']).forEach(function (f) { if (c[f] !== undefined) n[f] = c[f]; else delete n[f]; });
        FILL.forEach(function (f) { if (n[f] == null && c[f] != null) n[f] = c[f]; });
      }
      if ((Number(r.ct) || 0) > (Number(c.ct) || 0)) { // a newer check result from elsewhere
        n = n || Object.assign({}, c);
        GH.CHECK.forEach(function (f) { if (r[f] !== undefined) n[f] = r[f]; else delete n[f]; });
        n.ct = r.ct;
      }
      FILL.forEach(function (f) { if (r[f] != null && (n || c)[f] == null) { n = n || Object.assign({}, c); n[f] = r[f]; } });
      if (n && canon(n) !== canon(c)) put.set(c.id, n);
    }
    // deletions made elsewhere: only if the series was not changed here after the deletion
    for (const k in tomb) {
      const l = find(k);
      if (!l || (gone && gone[k])) continue;
      if (tomb[k] >= (Number(cur(l).updatedAt) || 0)) { del.add(l.id); put.delete(l.id); }
    }
    // the file to write back: every series this device ends up with
    const final = new Map();
    local.forEach(function (e) { final.set(e.id, e); });
    put.forEach(function (e, id) { final.set(id, e); });
    del.forEach(function (id) { final.delete(id); });
    const e = {};
    final.forEach(function (x) { e[GH.key(x)] = GH.row(x); });
    const g = {};
    for (const k in tomb) if (now - tomb[k] < KEEP_GONE && !e[k]) g[k] = tomb[k];
    return { put: Array.from(put.values()), del: Array.from(del), doc: { v: 1, e: e, g: g } };
  };
  // Same content? (ignores who wrote it and when)
  GH.same = function (a, b) {
    if (!a || !b) return false;
    return canon({ e: a.e || {}, g: a.g || {}, c: a.c || null }) === canon({ e: b.e || {}, g: b.g || {}, c: b.c || null });
  };

  /* ---------- talking to GitHub ---------- */

  const b64e = function (s) {
    const b = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64d = function (s) { return new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\s/g, '')), function (c) { return c.charCodeAt(0); })); };

  GH.parseRepo = function (s) {
    s = String(s || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
    const m = /(?:github\.com[/:])?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
    return m ? { owner: m[1], repo: m[2] } : null;
  };
  function fail(msg, extra) { const e = new Error(msg); Object.assign(e, extra || {}); return e; }
  async function call(cfg, token, path, opts) {
    opts = opts || {};
    const url = 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + path;
    let r;
    try {
      r = await fetch(url, { method: opts.method || 'GET', cache: 'no-store', credentials: 'omit',
        headers: Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined });
    } catch (e) { throw fail('Could not reach GitHub. Check your connection.', { net: true }); }
    return r;
  }
  async function why(r, what) {
    let j = null;
    try { j = await r.json(); } catch (e) { /* not JSON */ }
    const m = (j && j.message) || '';
    if (r.status === 401) return fail('GitHub did not accept the token. It may have expired: make a new one.', { auth: true });
    if (r.status === 403 && /rate limit/i.test(m)) return fail('GitHub is limiting requests right now. It will try again later.');
    if (r.status === 403) return fail('The token is not allowed to ' + what + '. Give it Contents: Read and write on this repo.', { auth: true });
    if (r.status === 404) return fail('No repo called ' + what + ', or the token cannot see it.', { missing: true });
    return fail('GitHub returned an error (' + r.status + (m ? ': ' + m : '') + ').');
  }

  // Can this token read and write that repo?
  GH.check = async function (cfg, token) {
    const r = await call(cfg, token, '');
    if (!r.ok) throw await why(r, cfg.owner + '/' + cfg.repo);
    const j = await r.json();
    if (j.permissions && j.permissions.push === false) throw fail('The token can read ' + cfg.owner + '/' + cfg.repo + ' but not write to it. Give it Contents: Read and write.', { auth: true });
    return { private: !!j.private, branch: j.default_branch || 'main' };
  };
  // -> { doc, sha } ; doc is null when the file does not exist yet
  GH.read = async function (cfg, token) {
    const path = '/contents/' + encodeURIComponent(cfg.path || 'shelf.json') + (cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '');
    const r = await call(cfg, token, path);
    if (r.status === 404) {
      await GH.check(cfg, token); // tells a missing repo apart from a missing file
      return { doc: null, sha: null };
    }
    if (!r.ok) throw await why(r, 'read ' + cfg.owner + '/' + cfg.repo);
    const j = await r.json();
    let text = j.content && j.encoding === 'base64' ? b64d(j.content) : '';
    if (!text && j.size > 0) { // over 1 MB: ask for the raw file
      const raw = await call(cfg, token, path, { headers: { Accept: 'application/vnd.github.raw+json' } });
      if (!raw.ok) throw await why(raw, 'read ' + cfg.owner + '/' + cfg.repo);
      text = await raw.text();
    }
    let doc = null;
    try { doc = text ? JSON.parse(text) : null; } catch (e) { throw fail('shelf.json in ' + cfg.owner + '/' + cfg.repo + ' is not valid JSON. Fix or delete it on GitHub.'); }
    return { doc: doc && typeof doc === 'object' ? doc : null, sha: j.sha };
  };
  // -> new sha; throws { conflict: true } when someone else wrote first
  GH.write = async function (cfg, token, doc, sha, message) {
    const body = { message: message || 'Shelf sync', content: b64e(JSON.stringify(doc)) };
    if (sha) body.sha = sha;
    if (cfg.branch) body.branch = cfg.branch;
    const r = await call(cfg, token, '/contents/' + encodeURIComponent(cfg.path || 'shelf.json'), { method: 'PUT', body: body });
    if (r.status === 409 || (r.status === 422 && !sha) || (r.status === 422 && /sha/i.test(await r.clone().text()))) throw fail('Changed on GitHub meanwhile.', { conflict: true });
    if (!r.ok) throw await why(r, 'write to ' + cfg.owner + '/' + cfg.repo);
    const j = await r.json();
    return j.content && j.content.sha;
  };

  GH.device = function () {
    const ua = (root.navigator && root.navigator.userAgent) || '';
    const web = !!root.SHELF_WEB ? 'web' : 'Chrome';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && root.navigator && root.navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) return 'Android ' + web;
    if (/CrOS/.test(ua)) return 'Chromebook';
    if (/Windows/.test(ua)) return (web === 'web' ? 'web' : 'Chrome') + ' on Windows';
    if (/Mac OS X/.test(ua)) return (web === 'web' ? 'web' : 'Chrome') + ' on Mac';
    return web;
  };

  TL.GH = GH;
  root.GH = GH;
  if (typeof module !== 'undefined' && module.exports) module.exports = GH;
})(typeof self !== 'undefined' ? self : globalThis);
