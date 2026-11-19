/* Shelf background worker: the single writer for the list. Decides what to do with a detected
   chapter/episode, applies updates, runs imports. */
if (typeof importScripts === 'function') importScripts('lib/core.js', 'lib/gh.js'); // the web version loads these itself
const WEB = !!self.SHELF_WEB;

let cache = null, index = null; // index: exact-title lookup, rebuilt lazily after any change to the list
async function db() {
  if (cache) return cache;
  const d = await chrome.storage.local.get(null);
  const entries = new Map();
  for (const k in d) if (k.startsWith('e:') && d[k] && d[k].id) entries.set(d[k].id, d[k]);
  const settings = Object.assign({}, TL.DEFAULTS, d.settings || {});
  settings.sites = Object.assign({}, settings.sites);
  settings.focus = Object.assign({}, TL.DEFAULTS.focus, settings.focus);
  settings.mal = Object.assign({}, TL.DEFAULTS.mal, settings.mal);
  cache = { entries: entries, settings: settings };
  return cache;
}
async function putMany(list) {
  if (!list.length) return;
  const c = await db(), o = {};
  const now = Date.now();
  for (const e of list) {
    const old = c.entries.get(e.id);
    if (!ghApplying && old && GH.checkSig(old) !== GH.checkSig(e)) e.ct = now; // a check result changed: newer than other devices' copies
    c.entries.set(e.id, e); o['e:' + e.id] = e;
  }
  index = null;
  await chrome.storage.local.set(o);
  ghSchedule();
}
async function saveSettings(patch) {
  const c = await db(), before = GH.canon(GH.cfgOf(c.settings));
  Object.assign(c.settings, patch);
  await chrome.storage.local.set({ settings: c.settings });
  if (!ghApplying && GH.canon(GH.cfgOf(c.settings)) !== before) { await chrome.storage.local.set({ ghCfgAt: Date.now() }); ghSchedule(); } // a setting that travels changed
}

/* ---------- GitHub sync ---------- */

let ghTimer = null, ghBusy = false, ghAgain = false, ghApplying = false;
function ghSchedule(ms) {
  if (ghApplying) return;
  clearTimeout(ghTimer);
  ghTimer = setTimeout(function () { later(ghSync); }, ms == null ? 15000 : ms);
  if (!WEB) chrome.alarms.create('gh', { delayInMinutes: 1 }); // in case the worker sleeps first
}
async function ghGone(e) { // deleted here: remember it until the next push
  const g = (await chrome.storage.local.get('ghGone')).ghGone || {};
  g[GH.key(e)] = Date.now();
  await chrome.storage.local.set({ ghGone: g });
  ghSchedule();
}
async function ghState(p) { const cur = (await chrome.storage.local.get('ghState')).ghState || {}; await chrome.storage.local.set({ ghState: Object.assign(cur, p) }); }
// Pull the file, merge it into this device, push the result if anything differs. Retries when another device wrote first.
async function ghSync() {
  const st = await chrome.storage.local.get('ghToken'), c0 = await db(), cfg = c0.settings.gh;
  if (!st.ghToken || !cfg || !cfg.owner || !cfg.repo) return { ok: false, off: true };
  if (ghBusy) { ghAgain = true; return { ok: true, busy: true }; }
  ghBusy = true;
  try {
    for (let tries = 0; tries < 4; tries++) {
      const remote = await GH.read(cfg, st.ghToken);
      const res = await enqueue(async function () {
        const c = await db(), loc = await chrome.storage.local.get(['ghGone', 'ghCfgAt']);
        const m = GH.merge(Array.from(c.entries.values()), remote.doc, loc.ghGone || {}, Date.now());
        ghApplying = true;
        try {
          await putMany(m.put);
          if (m.del.length) { m.del.forEach(function (id) { c.entries.delete(id); }); index = null; await chrome.storage.local.remove(m.del.map(function (id) { return 'e:' + id; })); }
          const rc = remote.doc && remote.doc.c, at = loc.ghCfgAt || 0;
          if (rc && rc.v && (rc.at || 0) >= at) { // settings: the device that changed them last wins
            if ((rc.at || 0) > at) { await saveSettings(GH.cfgPatch(c.settings, rc.v)); await chrome.storage.local.set({ ghCfgAt: rc.at }); await armUnmute(); }
            m.doc.c = rc;
          } else m.doc.c = { at: at || Date.now(), v: GH.cfgOf(c.settings) };
        } finally { ghApplying = false; }
        return { m: m, gone: Object.keys(loc.ghGone || {}) };
      });
      const got = res.m.put.length + res.m.del.length;
      if (remote.doc && GH.same(remote.doc, res.m.doc)) {
        if (res.gone.length) await chrome.storage.local.remove('ghGone');
        await ghState({ at: Date.now(), ok: true, error: '', got: got ? Date.now() : undefined, gotCount: got || undefined, count: Object.keys(res.m.doc.e).length, by: remote.doc.by || '', when: remote.doc.u || 0 });
        return { ok: true, got: got, sent: false };
      }
      res.m.doc.u = Date.now(); res.m.doc.by = GH.device();
      try {
        await GH.write(cfg, st.ghToken, res.m.doc, remote.sha, 'Shelf sync from ' + res.m.doc.by);
      } catch (e) { if (e.conflict) continue; throw e; }
      const left = (await chrome.storage.local.get('ghGone')).ghGone || {};
      res.gone.forEach(function (k) { delete left[k]; });
      await chrome.storage.local.set({ ghGone: left });
      await ghState({ at: Date.now(), ok: true, error: '', sent: Date.now(), got: got ? Date.now() : undefined, gotCount: got || undefined, count: Object.keys(res.m.doc.e).length, bytes: JSON.stringify(res.m.doc).length, by: res.m.doc.by, when: res.m.doc.u });
      return { ok: true, got: got, sent: true };
    }
    throw new Error('Other devices kept changing the list. It will try again shortly.');
  } catch (e) {
    await ghState({ at: Date.now(), ok: false, error: e.message || 'GitHub sync failed.', auth: !!e.auth });
    if (!e.auth) ghSchedule(5 * 60000);
    return { ok: false, error: e.message };
  } finally {
    ghBusy = false;
    if (ghAgain) { ghAgain = false; ghSchedule(2000); }
  }
}
function ghSyncSoon() { clearTimeout(ghTimer); return ghSync(); }
async function ghConnect(repoText, token, path) {
  const r = GH.parseRepo(repoText);
  token = String(token || '').trim();
  if (!r) throw new Error('Type the repo as owner/name, for example yourname/shelf-data.');
  if (!token) throw new Error('Paste the token first.');
  const cfg = { owner: r.owner, repo: r.repo, path: (path || 'shelf.json').replace(/^\/+/, '') };
  const info = await GH.check(cfg, token);
  cfg.branch = info.branch;
  await chrome.storage.local.set({ ghToken: token });
  await enqueue(function () { return saveSettings({ gh: cfg }); });
  const res = await ghSync();
  if (!res.ok) throw new Error(res.error);
  return { private: info.private, got: res.got };
}
async function setSite(host, value) {
  if (!host) return;
  const c = await db();
  if (c.settings.sites[host] === value) return;
  const sites = Object.assign({}, c.settings.sites);
  if (value) sites[host] = value; else delete sites[host];
  await saveSettings({ sites: sites });
}

/* ---------- deciding what a detected page means ---------- */

async function decide(det, host) {
  const c = await db();
  const site = TL.siteState(c.settings, host);
  if (!det || site === 'off') return { action: 'none', site: site };
  const known = site === 'on';
  const strong = det.count >= 2;
  if (!index) index = TL.makeIndex(c.entries.values());
  const m = TL.bestMatch(c.entries.values(), det.kind, det.candidates && det.candidates.length ? det.candidates : [det.title], index);
  if (m && m.score >= 0.85) {
    const e = m.entry, have = e.progress || 0;
    if (det.number <= have) return { action: 'uptodate', entry: e, site: site };
    const jump = det.number - have;
    const over = e.total && det.number > e.total;
    if (known && c.settings.auto && jump <= 5 && !over) return { action: 'auto', entry: e, delay: c.settings.delay, site: site };
    if (known || strong) return { action: 'confirm', entry: e, over: !!over, site: site };
    return { action: 'none', entry: e, site: site };
  }
  if (!known && !strong) return { action: 'none', site: site };
  if (m && m.score >= 0.62) return { action: 'maybe', entry: m.entry, site: site };
  return { action: 'add', site: site };
}

function sourceFor(c, host) {
  const named = (c.settings.siteNames || {})[host];
  if (named) return named; // a name you gave this site
  const labels = new Set();
  c.entries.forEach(function (e) { if (e.source) labels.add(e.source); });
  return TL.guessSource(host, Array.from(labels));
}

// The series page and the "next" link the page itself offered, kept only when they are on the same site.
function setLinks(n, ctx, number) {
  const host = TL.hostOf(ctx.url), L = ctx.links || {};
  const same = function (u) { return typeof u === 'string' && /^https?:\/\//.test(u) && TL.hostOf(u) === host; };
  if (same(L.series)) n.seriesUrl = L.series;
  else if (n.seriesUrl && TL.hostOf(n.seriesUrl) !== host) delete n.seriesUrl;
  if (same(L.next)) n.nextUrl = { from: number, url: L.next }; else delete n.nextUrl;
}

async function apply(id, number, ctx) {
  ctx = ctx || {};
  const c = await db(), e = c.entries.get(id);
  if (!e || !(number >= 0)) return { ok: false };
  const prev = Object.assign({}, e);
  const n = Object.assign({}, e, { progress: number, updatedAt: Date.now() });
  if (number > (e.progress || 0)) {
    n.lastRead = TL.today();
    n.status = n.total && number >= n.total ? 'completed' : 'current';
    // one page = that many chapters; a big jump is a correction, not reading, so it counts once
    const d = number - (e.progress || 0);
    n.log = TL.logRead(e.log, e.progress == null || d > 5 ? 1 : Math.round(d * 10) / 10);
  }
  if (ctx.url) { n.lastUrl = ctx.url; n.site = ctx.host || TL.hostOf(ctx.url); if (!n.source) n.source = sourceFor(c, n.site); setLinks(n, ctx, number); }
  if (n.next && number >= n.next.number) delete n.next;
  if (ctx.altTitle) {
    const k = TL.norm(ctx.altTitle);
    if (k && [n.title].concat(n.alt || []).every(function (t) { return TL.norm(t) !== k; })) n.alt = (n.alt || []).concat([ctx.altTitle]);
  }
  await putMany([n]);
  if (ctx.host) await setSite(ctx.host, 'on');
  await malMark(n, e);
  return { ok: true, prev: prev, entry: n };
}

async function addNew(f, ctx) {
  ctx = ctx || {};
  const title = String(f.title || '').trim();
  if (!title) return { ok: false };
  const kind = f.kind === 'anime' ? 'anime' : 'manga';
  const num = f.number != null && !isNaN(f.number) ? Number(f.number) : null;
  const e = {
    id: TL.newId(kind), kind: kind, title: title, alt: [], progress: num, total: f.total || null,
    status: f.status || 'current', score: 0, origin: f.origin || '', lastRead: num ? TL.today() : null, updatedAt: Date.now()
  };
  if (num && ctx.url) e.log = TL.logRead(null, 1);
  if (ctx.url) { e.lastUrl = ctx.url; e.site = ctx.host || TL.hostOf(ctx.url); e.source = sourceFor(await db(), e.site); if (num != null) setLinks(e, ctx, num); }
  await putMany([e]);
  if (ctx.host) await setSite(ctx.host, 'on');
  return { ok: true, entry: e };
}

/* ---------- imports ---------- */

// Key-order-independent fingerprint, so an identical row is never counted (or written) as a change.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// Merge incoming rows into the list. Rows match an existing entry by MAL id, then by exact title.
async function mergeItems(items, opts) {
  opts = opts || {};
  const c = await db();
  const byMal = new Map(), byTitle = new Map();
  c.entries.forEach(function (e) {
    if (e.malId) byMal.set(e.kind + ':' + e.malId, e);
    byTitle.set(e.kind + ':' + TL.norm(e.title), e);
  });
  const out = []; let added = 0, updated = 0;
  for (const it of items) {
    if (!it || !it.title) continue;
    const kt = it.kind + ':' + TL.norm(it.title);
    const ex = (it.id && c.entries.get(it.id)) || (it.malId && byMal.get(it.kind + ':' + it.malId)) || byTitle.get(kt);
    if (!ex) {
      const e = Object.assign({ alt: [], progress: null, total: null, status: 'current', score: 0, origin: '', lastRead: null }, it);
      if (!e.id || c.entries.has(e.id)) e.id = TL.newId(e.kind);
      if (!e.updatedAt) e.updatedAt = e.lastRead ? Date.parse(e.lastRead) || 0 : 0;
      out.push(e); byTitle.set(kt, e); if (e.malId) byMal.set(e.kind + ':' + e.malId, e); added++;
      continue;
    }
    const n = Object.assign({}, ex);
    const have = new Set([n.title].concat(n.alt || []).map(TL.norm));
    const extra = [it.title].concat(it.alt || []).filter(function (t) { const k = TL.norm(t); if (!k || have.has(k)) return false; have.add(k); return true; });
    if (extra.length) n.alt = (n.alt || []).concat(extra);
    ['malId', 'total', 'image', 'origin', 'source'].forEach(function (f) { if (it[f] && !n[f]) n[f] = it[f]; });
    if (opts.mal && it.total) n.total = it.total;
    if (it.links) n.links = Object.assign({}, it.links, n.links || {});
    const localTs = n.updatedAt || (n.lastRead ? Date.parse(n.lastRead) || 0 : 0);
    if ((it.updatedAt || 0) > localTs || opts.overwrite) {
      if (it.progress != null) n.progress = it.progress;
      n.status = it.status || n.status;
      if (it.score) n.score = it.score;
      if (it.lastRead) n.lastRead = it.lastRead;
      n.updatedAt = it.updatedAt != null ? it.updatedAt : Date.now();
    }
    if (canon(n) !== canon(ex)) { out.push(n); updated++; }
  }
  await putMany(out);
  return { added: added, updated: updated, total: items.length };
}

async function malImport(user, kind) {
  user = String(user || '').trim();
  if (!user) throw new Error('Enter a MyAnimeList username first.');
  const rows = [];
  for (let off = 0; off < 9000; off += 300) {
    let r;
    try {
      r = await fetch('https://myanimelist.net/' + kind + 'list/' + encodeURIComponent(user) + '/load.json?offset=' + off + '&status=7', { credentials: 'omit' });
    } catch (e) { throw new Error('Could not reach MyAnimeList. Check your connection and try again.'); }
    if (!r.ok) throw new Error(r.status === 400 || r.status === 403 || r.status === 404
      ? 'MyAnimeList would not share that list. Check the username and that the list is public.'
      : 'MyAnimeList returned an error (' + r.status + '). Try again in a minute.');
    let page;
    try { page = await r.json(); } catch (e) { page = null; }
    if (!Array.isArray(page)) throw new Error('MyAnimeList would not share that list. Check the username and that the list is public.');
    rows.push.apply(rows, page);
    if (page.length < 300) break;
  }
  const items = rows.map(function (it) { return TL.malToEntry(it, kind); }).filter(Boolean);
  const res = await mergeItems(items, { mal: true });
  await saveSettings({ malUser: user });
  return res;
}

async function firstRun() {
  const c = await db();
  const notice = { at: Date.now(), lines: [] };
  if (!c.entries.size) {
    try {
      const seed = await (await fetch(chrome.runtime.getURL('seed/manga.json'))).json();
      const res = await mergeItems(seed);
      notice.lines.push('Loaded ' + res.added + ' series from your manga tracker.');
    } catch (e) { notice.lines.push('Connect your GitHub list in Settings to bring in your series.'); }
  }
  if (!c.settings.malUser) { await saveSettings({ notice: notice }); return; }
  try {
    const res = await malImport(c.settings.malUser, 'anime');
    notice.lines.push('Imported ' + res.total + ' anime from MyAnimeList (' + c.settings.malUser + ').');
  } catch (e) {
    notice.lines.push('Anime import from MyAnimeList did not finish: ' + e.message + ' You can retry it in Settings.');
    notice.error = true;
  }
  await saveSettings({ notice: notice });
}

/* ---------- new chapter / episode check ---------- */

function textOf(html, re) {
  const m = re.exec(html);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim() : '';
}
async function getPage(url) {
  try {
    const r = await fetch(url, { credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { status: r.status };
    return { url: r.url, html: (await r.text()).slice(0, 800000) };
  } catch (err) { return null; }
}
const metaImage = function (html) {
  const u = textOf(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || textOf(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return /^https:\/\//.test(u) ? u : '';
};

// Is something newer out? First reads the series page's chapter list; if that tells nothing, asks for the
// next chapter's own page. Returns { found: true, number, url, latest } / { found: false } / null (cannot tell).
const probe = function (e) { return TL.probe(e, getPage); };

// Records what a check found. Returns the entry when there is something new to tell the user about.
async function markNext(id, res) {
  const c = await db(), e = c.entries.get(id);
  if (!e) return null;
  const n = Object.assign({}, e);
  let isNew = false;
  if (res.unknown) { // could not tell: keep what is known, note why
    n.chk = { at: Date.now(), why: String(res.why || '').slice(0, 60) };
    await putMany([n]);
    return null;
  }
  delete n.chk;
  if (res.found && (e.progress || 0) < res.number) {
    const nx = { number: res.number, url: res.url, latest: res.latest || res.number, at: Date.now() };
    if (res.locked) { nx.locked = true; if (res.freeAt) nx.freeAt = res.freeAt; } // out, but paid or on a timer: wait for it
    const was = e.next && e.next.number === nx.number ? e.next : null;
    // News only if it appeared after you were caught up, or the site's latest chapter went up since the last look,
    // or it was locked. Otherwise it was already out and you are simply catching up: a link, but no alert.
    const fresh = !!res.locked || (was ? !!was.locked || !was.backlog : (e.upTo && e.upTo.n === (e.progress || 0)) || (e.seen != null && nx.latest > e.seen));
    if (!fresh) nx.backlog = true;
    n.next = nx; delete n.upTo;
    n.seen = Math.max(e.seen || 0, nx.latest);
    isNew = !res.locked && fresh && (!was || !!was.locked); // newly out, or just became free
  }
  else if (!res.found) { // checked: nothing newer yet
    n.upTo = { n: e.progress || 0, at: Date.now() }; n.seen = Math.max(e.seen || 0, e.progress || 0);
    if (e.lastRead === TL.today()) { const day = TL.dayNum(); n.rel = (e.rel || []).filter(function (d) { return d !== day; }).concat([day]).slice(-8); } // read today and caught up: a point on its release rhythm
  }
  if (res.cad && res.cad.iv > 0) n.cad = { iv: Number(res.cad.iv), last: Number(res.cad.last), upTo: Number(res.cad.upTo) };
  if (res.image && !n.image && c.settings.covers !== false) n.image = res.image;
  if (canon(n) === canon(e)) return null;
  await putMany([n]);
  return isNew ? n : null;
}

const dueNow = function (e) { return (e.cad || e.rel || e.log) ? TL.newState(e) === 'due' : false; };
// The site could not be checked, but a series' usual gap has passed: say so once per chapter.
async function notifyDue(ids) {
  if (!ids.length || !chrome.notifications) return;
  const c = await db(), quietSites = new Set(c.settings.mutedSites || []), out = [];
  for (const id of ids) {
    const e = c.entries.get(id), x = e && TL.expect(e);
    if (!e || !x || !x.due || (e.est && e.est.told === x.number)) continue;
    out.push(Object.assign({}, e, { est: { told: x.number, at: Date.now() } }));
    if (c.settings.notify === false || e.muted || quietSites.has(TL.siteLabel(e)) || TL.isMuted(c.settings)) continue; // tagged in the list, no pop-up
    try {
      chrome.notifications.create('due:' + e.id, { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Probably out: ' + e.title,
        message: (e.kind === 'anime' ? 'Ep ' : 'Ch ') + x.number + ' is due. It usually comes every ' + x.iv + ' day' + (x.iv === 1 ? '' : 's') + '. Click to open the series and check.', buttons: [{ title: 'Open series' }] });
    } catch (err) { /* notifications blocked */ }
  }
  await enqueue(async function () { const cc = await db(), w = []; out.forEach(function (n) { const cur = cc.entries.get(n.id); if (cur) w.push(Object.assign({}, cur, { est: n.est })); }); await putMany(w); });
}
async function notify(found) {
  if (!found.length || !chrome.notifications) return;
  const c = await db();
  if (c.settings.notify === false) return;
  const quietSites = new Set(c.settings.mutedSites || []);
  found = found.filter(function (f) { return !f.muted && !quietSites.has(TL.siteLabel(f)); }); // still tagged New, just no pop-up
  if (!found.length) return;
  if (TL.isMuted(c.settings)) { // muted: stay quiet now, mention them once when the mute ends
    await enqueue(function () { return saveSettings({ missed: (c.settings.missed || 0) + found.length }); });
    await armUnmute();
    return;
  }
  const u = function (k) { return k === 'anime' ? 'Ep' : 'Ch'; };
  try {
    if (found.length <= 3) { // one alert each, so a click goes straight to that chapter
      for (const f of found) chrome.notifications.create('new:' + f.id, { type: 'basic', iconUrl: 'icons/icon128.png',
        title: 'New ' + (f.kind === 'anime' ? 'episode' : 'chapter') + ': ' + f.title,
        message: u(f.kind) + ' ' + f.next.number + ' is out on ' + (TL.siteLabel(f) || TL.hostOf(f.next.url)) + '. Click to read it.',
        buttons: [{ title: 'Read now' }] });
    } else {
      chrome.notifications.create('new:many', { type: 'basic', iconUrl: 'icons/icon128.png',
        title: found.length + ' new releases on your list',
        message: found.slice(0, 4).map(function (f) { return f.title + ' ' + u(f.kind) + ' ' + f.next.number; }).join(' · ') + (found.length > 4 ? ' …' : '') });
    }
  } catch (e) { /* notifications blocked */ }
}

// Right after a chapter is saved from a site: find out whether the one after it is out, so the list never links to a chapter that does not exist.
async function checkOne(id) {
  if (WEB) return; // the web version cannot reach other sites
  const c = await db(), e = c.entries.get(id);
  if (!e || !e.lastUrl || (e.next && e.next.number > (e.progress || 0)) || (e.total && (e.progress || 0) >= e.total)) return;
  const res = await probe(e);
  const n = await enqueue(function () { return markNext(id, res); });
  if (n) await notify([n]);
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let checking = false;
// Checks the series you are reading, least recently checked first. Only series saved from a site at least once can be checked.
async function runCheck(limit, manual) {
  if (checking || WEB) return;
  checking = true;
  try {
    const c = await db();
    if (c.settings.notify === false && !manual) return;
    const checks = (await chrome.storage.local.get('checks')).checks || {}, now = Date.now();
    const list = Array.from(c.entries.values()).filter(function (e) {
      const waiting = e.next && e.next.number > (e.progress || 0);
      // one that is out but locked gets looked at again: once its timer is up, or twice a day when the site gave no time
      const recheck = waiting && e.next.locked && (e.next.freeAt ? now >= e.next.freeAt : now - (e.next.at || 0) > 12 * 36e5 || manual);
      return e.status === 'current' && e.lastUrl && (!waiting || recheck) &&
        !(e.total && (e.progress || 0) >= e.total) && (e.seriesUrl || e.nextUrl || TL.seriesUrl(e.lastUrl) || TL.nextUrl(e.lastUrl, 1));
    }).sort(function (a, b) { return (b.next && b.next.locked ? 1 : 0) - (a.next && a.next.locked ? 1 : 0) || (dueNow(b) ? 1 : 0) - (dueNow(a) ? 1 : 0) || (checks[a.id] || 0) - (checks[b.id] || 0) || (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, limit); // locked first, then least recently checked, then most recently read
    const found = [], guess = [];
    let failed = 0;
    for (const e of list) {
      const res = await probe(e);
      checks[e.id] = Date.now();
      if (res.unknown) { failed++; if (dueNow(e)) guess.push(e.id); } // cannot look, but its usual gap has passed
      const n = await enqueue(function () { return markNext(e.id, res); });
      if (n) found.push(n);
      await chrome.storage.local.set({ checks: checks }); // also keeps the worker awake between requests
      await sleep(700);
    }
    Object.keys(checks).forEach(function (id) { if (!c.entries.has(id)) delete checks[id]; });
    await chrome.storage.local.set({ checks: checks });
    await enqueue(function () { return saveSettings({ lastCheck: { at: Date.now(), checked: list.length, found: found.length, failed: failed } }); });
    await notify(found);
    await notifyDue(guess);
    // come back when the next timed chapter turns free, or the next expected release is due
    let due = 0;
    c.entries.forEach(function (e) {
      let f = e.next && e.next.locked && e.next.number > (e.progress || 0) ? e.next.freeAt : 0;
      if (!f && (e.cad || e.rel || e.log) && e.lastUrl) { const x = TL.expect(e); if (x && !x.due) f = x.at; }
      if (f && (!due || f < due)) due = f;
    });
    if (due) chrome.alarms.create('free', { when: Math.max(due, Date.now()) + 60000 }); else chrome.alarms.clear('free');
  } finally { checking = false; }
}

/* ---------- focus blocker ---------- */

function blockUrl(url) { return chrome.runtime.getURL('blocked.html') + '?u=' + encodeURIComponent(url); }
chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  const url = info.url || (info.status === 'loading' ? tab.url : '');
  if (!url || url.indexOf('http') !== 0) return;
  db().then(function (c) { if (TL.blocked(c.settings, url)) chrome.tabs.update(tabId, { url: blockUrl(url) }).catch(function () {}); });
});
// A focus session just started: move tabs that are already on a blocked site.
async function sweepTabs() {
  const c = await db();
  for (const t of await chrome.tabs.query({})) if (t.url && TL.blocked(c.settings, t.url)) chrome.tabs.update(t.id, { url: blockUrl(t.url) }).catch(function () {});
}

/* ---------- weekly recap ---------- */

function nextSunday(now) { // Sunday 6 pm, local time
  const d = new Date(now); d.setHours(18, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  if (d.getTime() <= now) d.setDate(d.getDate() + 7);
  return d.getTime();
}
async function maybeRecap() {
  const c = await db(), now = Date.now();
  let at = c.settings.recapAt || 0;
  if (!at) { at = nextSunday(now); await saveSettings({ recapAt: at }); }
  if (now >= at) {
    if (TL.isMuted(c.settings)) return; // hold it until the mute or quiet hours end; the next check tries again
    const to = TL.dayNum(at), r = TL.recap(Array.from(c.entries.values()), to - 6, to);
    if (c.settings.notify !== false && chrome.notifications && (r.manga || r.anime || r.behind.length)) {
      const parts = [];
      if (r.manga) parts.push(r.manga + ' chapter' + (r.manga === 1 ? '' : 's'));
      if (r.anime) parts.push(r.anime + ' episode' + (r.anime === 1 ? '' : 's'));
      try {
        chrome.notifications.create('recap', { type: 'basic', iconUrl: 'icons/icon128.png',
          title: 'Your week: ' + (parts.join(' and ') || 'nothing logged'),
          message: (r.top[0] ? 'Most read: ' + r.top[0].title + '. ' : '') + (r.behind.length ? r.behind.length + ' series have new releases waiting.' : 'You are caught up.') });
      } catch (e) { /* notifications blocked */ }
    }
    at = nextSunday(now);
    await saveSettings({ recapAt: at });
  }
  chrome.alarms.create('recap', { when: at + 1000 });
}

/* ---------- MyAnimeList write-back ---------- */

// Uses MAL's official API with the user's own API client id (PKCE, no secret). Tokens stay in this browser.
const MAL_STATUS = { anime: { current: 'watching', completed: 'completed', on_hold: 'on_hold', dropped: 'dropped', planning: 'plan_to_watch' },
  manga: { current: 'reading', completed: 'completed', on_hold: 'on_hold', dropped: 'dropped', planning: 'plan_to_read' } };
async function malToken(body) {
  const r = await fetch('https://myanimelist.net/v1/oauth2/token', { method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  let j = null;
  try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok || !j || !j.access_token) throw new Error('MyAnimeList did not accept the sign-in' + (j && (j.message || j.error) ? ' (' + (j.message || j.error) + ')' : '') + '. Check the Client ID and the redirect address.');
  const auth = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  await chrome.storage.local.set({ malAuth: auth });
  return auth;
}
async function malConnect(clientId) {
  clientId = String(clientId || '').trim();
  if (!clientId) throw new Error('Paste your MAL Client ID first.');
  if (!chrome.identity) throw new Error('This browser does not allow the sign-in window.');
  const redirect = chrome.identity.getRedirectURL();
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(48))).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  const state = verifier.slice(0, 16);
  let back;
  try {
    back = await chrome.identity.launchWebAuthFlow({ interactive: true, url: 'https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id=' + encodeURIComponent(clientId) +
      '&state=' + state + '&redirect_uri=' + encodeURIComponent(redirect) + '&code_challenge=' + verifier + '&code_challenge_method=plain' });
  } catch (e) { throw new Error('The sign-in window was closed or MyAnimeList refused it. Check the Client ID and the redirect address.'); }
  const q = new URL(back).searchParams;
  if (!q.get('code') || q.get('state') !== state) throw new Error('MyAnimeList did not finish the sign-in.');
  await malToken({ client_id: clientId, grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirect, code_verifier: verifier });
  await enqueue(async function () { const c = await db(); await saveSettings({ mal: Object.assign({}, c.settings.mal, { clientId: clientId, on: true }), malState: { at: Date.now(), ok: true, pending: 0, error: '' } }); });
}
// Note that this series needs sending to MAL (only when something MAL keeps has changed).
async function malMark(n, was) {
  const c = await db(), m = c.settings.mal || {};
  if (!n || !n.malId || m.on === false || !m.clientId || (n.kind !== 'anime' && !m.manga)) return;
  if (was && was.progress === n.progress && was.status === n.status && (was.score || 0) === (n.score || 0)) return;
  if (!(await chrome.storage.local.get('malAuth')).malAuth) return;
  const q = (await chrome.storage.local.get('malQueue')).malQueue || {};
  q[n.id] = Date.now();
  await chrome.storage.local.set({ malQueue: q });
  later(flushMal);
}
let malBusy = false;
async function flushMal() {
  if (malBusy) return;
  malBusy = true;
  let error = '', sent = 0;
  try {
    const st = await chrome.storage.local.get(['malAuth', 'malQueue']), q = st.malQueue || {};
    let auth = st.malAuth;
    const ids = Object.keys(q);
    if (!auth || !ids.length) return;
    const c = await db(), clientId = (c.settings.mal || {}).clientId;
    const put = function (e) {
      const body = { status: MAL_STATUS[e.kind][e.status] || MAL_STATUS[e.kind].current };
      body[e.kind === 'anime' ? 'num_watched_episodes' : 'num_chapters_read'] = String(Math.floor(e.progress || 0));
      if (e.score) body.score = String(e.score);
      return fetch('https://api.myanimelist.net/v2/' + e.kind + '/' + e.malId + '/my_list_status', { method: 'PUT', credentials: 'omit',
        headers: { Authorization: 'Bearer ' + auth.access, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20000) });
    };
    for (const id of ids) {
      const e = c.entries.get(id);
      if (!e || !e.malId) { delete q[id]; continue; }
      if (auth.exp - Date.now() < 60000) auth = await malToken({ client_id: clientId, grant_type: 'refresh_token', refresh_token: auth.refresh });
      let r = await put(e);
      if (r.status === 401) { auth = await malToken({ client_id: clientId, grant_type: 'refresh_token', refresh_token: auth.refresh }); r = await put(e); }
      if (r.ok) { delete q[id]; sent++; }
      else if (r.status === 404) { delete q[id]; } // MAL has no such title
      else { error = 'MyAnimeList returned an error (' + r.status + '). It will be tried again.'; break; }
      await chrome.storage.local.set({ malQueue: q });
      await sleep(600);
    }
    await chrome.storage.local.set({ malQueue: q });
    await enqueue(function () { return saveSettings({ malState: { at: Date.now(), ok: !error, sent: sent, pending: Object.keys(q).length, error: error } }); });
  } catch (e) {
    await enqueue(function () { return saveSettings({ malState: { at: Date.now(), ok: false, sent: sent, pending: -1, error: /sign-in/.test(e.message) ? 'MyAnimeList sign-in expired. Connect again in Settings.' : 'Could not reach MyAnimeList. It will be tried again.' } }); });
  } finally { malBusy = false; }
}

/* ---------- cover art ---------- */

// Covers come from AniList's public catalogue by the AniList or MAL number a series already carries; then
// from Comick by title (confirmed by the series' Comick id when it has one); then an AniList title search.
// A title match must be close. Only the image address is stored.
let coverGap = 2200, covering = false;
const later = function (fn) { setTimeout(function () { Promise.resolve().then(fn).catch(function (e) { console.error('Shelf:', e); }); }, 0); };
async function anilist(query, variables) {
  const r = await fetch('https://graphql.anilist.co', { method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query: query, variables: variables }),
    signal: AbortSignal.timeout(20000) });
  if (r.status === 429) throw new Error('busy');
  if (!r.ok) throw new Error('AniList ' + r.status);
  return (await r.json()).data || {};
}
const coverOf = function (m) { const c = m && m.coverImage; const u = c && (c.medium || c.large); return /^https:\/\//.test(u || '') ? u : ''; };
// Comick: search by title, accept the result with this series' Comick id, else one whose name matches closely.
async function comickCover(e) {
  const r = await fetch('https://api.comick.dev/v1.0/search?q=' + encodeURIComponent(e.title) + '&limit=8&tachiyomi=true',
    { credentials: 'omit', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Comick ' + r.status);
  const j = await r.json();
  const list = Array.isArray(j) ? j : (j && (j.data || j.results)) || [];
  const hid = e.id.slice(1), mine = [e.title].concat(e.alt || []).map(TL.norm).filter(Boolean);
  const names = function (it) { return [it.title].concat((it.md_titles || []).map(function (t) { return t && t.title; })).map(TL.norm).filter(Boolean); };
  const hit = list.find(function (it) { return it && it.hid === hid; }) || list.find(function (it) {
    return it && names(it).some(function (t) { return mine.some(function (x) { return TL.simNorm(x, t) >= 0.9; }); });
  });
  if (!hit) return '';
  const key = hit.md_covers && hit.md_covers[0] && hit.md_covers[0].b2key;
  const u = key ? 'https://meo.comick.pictures/' + String(key).replace(/^\/+/, '') : (hit.cover_url || hit.default_thumbnail || '');
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '';
}
// Episode lengths for the anime watch-time total, from AniList by MAL number, 50 titles per request.
let timing = false;
async function fetchDurations() {
  if (timing) return;
  timing = true;
  try {
    const c = await db(), tried = (await chrome.storage.local.get('durTried')).durTried || {}, now = Date.now();
    const need = Array.from(c.entries.values()).filter(function (e) { return e.kind === 'anime' && e.malId && !(e.dur > 0) && !(tried[e.id] && now - tried[e.id] < 30 * 864e5); });
    for (let i = 0; i < need.length; i += 50) {
      const part = need.slice(i, i + 50), byMal = new Map(part.map(function (e) { return [Number(e.malId), e.id]; }));
      const d = await anilist('query($ids:[Int]){Page(perPage:50){media(idMal_in:$ids,type:ANIME){idMal duration}}}', { ids: Array.from(byMal.keys()) });
      const got = new Map();
      ((d.Page && d.Page.media) || []).forEach(function (m) { if (m && m.duration > 0 && byMal.has(m.idMal)) got.set(byMal.get(m.idMal), m.duration); });
      await enqueue(async function () {
        const cc = await db(), out = [];
        got.forEach(function (dur, id) { const e = cc.entries.get(id); if (e && !(e.dur > 0)) out.push(Object.assign({}, e, { dur: dur })); });
        await putMany(out);
      });
      part.forEach(function (e) { if (!got.has(e.id)) tried[e.id] = now; });
      await chrome.storage.local.set({ durTried: tried });
      await sleep(coverGap);
    }
  } catch (e) { /* AniList busy or offline: the next check tries again */ }
  finally { timing = false; }
}
async function setImages(pairs) { // [[id, url], ...]
  const c = await db(), out = [];
  for (const p of pairs) { const e = c.entries.get(p[0]); if (e && !e.image && p[1]) out.push(Object.assign({}, e, { image: p[1] })); }
  await putMany(out);
}

async function fetchCovers(manual) {
  if (covering) return;
  covering = true;
  let got = 0, error = '';
  try {
    const c = await db();
    if (c.settings.covers === false) return;
    const miss = (await chrome.storage.local.get('coverMiss')).coverMiss || {};
    const now = Date.now(), again = manual ? 0 : 30 * 864e5;
    const need = Array.from(c.entries.values()).filter(function (e) { return !e.image && !(miss[e.id] && now - miss[e.id] < again); });
    if (!need.length) return;
    const save = async function (pairs, tried) {
      if (pairs.length) { await enqueue(function () { return setImages(pairs); }); got += pairs.length; }
      const hit = new Set(pairs.map(function (p) { return p[0]; }));
      tried.forEach(function (e) { if (hit.has(e.id)) delete miss[e.id]; });
      await chrome.storage.local.set({ coverMiss: miss }); // also keeps the worker awake between requests
      await sleep(coverGap);
    };
    const left = [];
    for (const kind of ['manga', 'anime']) {
      const type = kind === 'anime' ? 'ANIME' : 'MANGA';
      const byAni = new Map(), byMal = new Map();
      for (const e of need) {
        if (e.kind !== kind) continue;
        const m = /anilist\.co\/(?:manga|anime)\/(\d+)/.exec((e.links && e.links.anilist) || '');
        if (m) byAni.set(Number(m[1]), e); else if (e.malId) byMal.set(Number(e.malId), e); else left.push(e);
      }
      for (const src of [[byAni, 'id_in', 'id'], [byMal, 'idMal_in', 'idMal']]) {
        const ids = Array.from(src[0].keys());
        for (let i = 0; i < ids.length; i += 50) {
          const part = ids.slice(i, i + 50);
          const d = await anilist('query($ids:[Int],$type:MediaType){Page(perPage:50){media(' + src[1] + ':$ids,type:$type){id idMal coverImage{medium large}}}}', { ids: part, type: type });
          const pairs = [];
          ((d.Page && d.Page.media) || []).forEach(function (m) { const e = src[0].get(m[src[2]]); const u = coverOf(m); if (e && u) pairs.push([e.id, u]); });
          const hit = new Set(pairs.map(function (p) { return p[0]; }));
          part.forEach(function (id) { const e = src[0].get(id); if (!hit.has(e.id)) left.push(e); }); // not found by number: try the title
          await save(pairs, []);
        }
      }
    }
    // Comick, one series per request, at most one a second; stops for this run if Comick refuses
    const rest = [];
    let comickOff = false;
    for (let i = 0; i < left.length; i++) {
      const e = left[i];
      if (e.kind !== 'manga' || comickOff || i >= 300) { rest.push(e); continue; }
      let u = '';
      try { u = await comickCover(e); } catch (err) { comickOff = true; error = 'Comick did not answer, so the rest came from AniList only.'; }
      if (u) { await enqueue(function () { return setImages([[e.id, u]]); }); got++; delete miss[e.id]; } else rest.push(e);
      await chrome.storage.local.set({ coverMiss: miss });
      await sleep(Math.min(coverGap, 1000));
    }
    // AniList title search, five series per request
    for (let i = 0; i < rest.length && i < 150; i += 5) {
      const part = rest.slice(i, i + 5), vars = {};
      const q = 'query(' + part.map(function (e, k) { return '$q' + k + ':String,$t' + k + ':MediaType'; }).join(',') + '){' +
        part.map(function (e, k) { vars['q' + k] = e.title; vars['t' + k] = e.kind === 'anime' ? 'ANIME' : 'MANGA';
          return 'a' + k + ':Page(perPage:4){media(search:$q' + k + ',type:$t' + k + '){coverImage{medium large} title{romaji english native} synonyms}}'; }).join(' ') + '}';
      const d = await anilist(q, vars);
      const pairs = [];
      part.forEach(function (e, k) {
        const mine = [e.title].concat(e.alt || []).map(TL.norm).filter(Boolean);
        const hit = ((d['a' + k] && d['a' + k].media) || []).find(function (m) {
          const theirs = [m.title && m.title.romaji, m.title && m.title.english, m.title && m.title.native].concat(m.synonyms || []).map(TL.norm).filter(Boolean);
          return coverOf(m) && theirs.some(function (t) { return mine.some(function (x) { return TL.simNorm(x, t) >= 0.9; }); });
        });
        if (hit) pairs.push([e.id, coverOf(hit)]); else miss[e.id] = now; // no confident match: leave the placeholder
      });
      await save(pairs, part);
    }
  } catch (e) { error = (error ? error + ' ' : '') + (e.message === 'busy' ? 'AniList is busy; the rest will be picked up later.' : 'Could not reach AniList for covers.'); }
  finally {
    covering = false;
    later(fetchDurations);
    if (manual || got) await enqueue(function () { return saveSettings({ lastCovers: { at: Date.now(), got: got, error: error } }); });
  }
}

/* ---------- messages ---------- */

function badge(tabId, text, ok) {
  if (tabId == null) return;
  try {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: ok ? '#1E8A4F' : '#0E7C80' });
    chrome.action.setBadgeText({ tabId: tabId, text: text });
  } catch (e) { /* tab closed */ }
}

async function handle(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  switch (msg.type) {
    case 'page': {
      const res = await decide(msg.det, msg.host);
      badge(tabId, msg.det && res.site !== 'off' ? String(msg.det.number).slice(0, 4) : '', res.action === 'uptodate');
      return res;
    }
    case 'match': return decide(msg.det, msg.host);
    case 'apply': {
      const res = await apply(msg.id, msg.number, { url: msg.url, host: msg.host, altTitle: msg.altTitle, links: msg.links });
      if (res.ok && msg.url) badge(tabId != null ? tabId : msg.tabId, '✓', true);
      if (res.ok && !msg.probes) later(function () { return checkOne(res.entry.id); }); // a + in the list; a chapter page checks from the page itself
      return res;
    }
    case 'add': {
      const res = await addNew(msg.fields, { url: msg.url, host: msg.host, links: msg.links });
      if (res.ok && msg.url) { badge(tabId != null ? tabId : msg.tabId, '✓', true); if (!msg.probes) later(function () { return checkOne(res.entry.id); }); }
      if (res.ok) later(fetchCovers);
      return res;
    }
    case 'undo': {
      const c = await db();
      if (msg.created) { const e = c.entries.get(msg.id); if (e) await ghGone(e); c.entries.delete(msg.id); index = null; await chrome.storage.local.remove('e:' + msg.id); }
      else if (msg.prev && msg.prev.id) { // restored with a fresh time stamp so the undo also reaches MAL and other devices
        const was = c.entries.get(msg.prev.id), back = Object.assign({}, msg.prev, { updatedAt: Date.now() });
        await putMany([back]); await malMark(back, was);
      }
      badge(tabId, '', false);
      return { ok: true };
    }
    case 'patch': {
      const c = await db(), e = c.entries.get(msg.id);
      if (!e) return { ok: false };
      const n = Object.assign({}, e, msg.patch, msg.touch === false ? {} : { updatedAt: Date.now() });
      if (n.next && (n.progress || 0) >= n.next.number) delete n.next;
      await putMany([n]);
      await malMark(n, e);
      return { ok: true };
    }
    case 'delete': {
      const c = await db(), e = c.entries.get(msg.id);
      if (e) await ghGone(e);
      c.entries.delete(msg.id); index = null;
      await chrome.storage.local.remove('e:' + msg.id);
      return { ok: true };
    }
    case 'site': await setSite(msg.host, msg.value); return { ok: true };
    case 'settings':
      await saveSettings(msg.patch);
      if ('quiet' in msg.patch) await armUnmute();
      if (msg.patch.covers === true) later(fetchCovers);
      return { ok: true };
    case 'covers': later(function () { return fetchCovers(true); }); return { ok: true };
    case 'bulk': { const res = await mergeItems(msg.items, { overwrite: !!msg.overwrite }); later(fetchCovers); return Object.assign({ ok: true }, res); }
    case 'malImport':
      try { const res = await malImport(msg.user, msg.kind === 'manga' ? 'manga' : 'anime'); later(fetchDurations); return Object.assign({ ok: true }, res); }
      catch (e) { return { ok: false, error: e.message }; }
    case 'probed': { // a chapter page looked for the next chapter from inside the site
      const r = msg.res || {}, c = await db(), e = c.entries.get(msg.id);
      if (!e || (e.next && e.next.number > (e.progress || 0))) return { ok: false };
      const host = TL.hostOf(e.lastUrl || '');
      const cad = r.cad && r.cad.iv > 0 && r.cad.iv <= 60 && r.cad.last <= Date.now() + 864e5 ? { iv: Number(r.cad.iv), last: Number(r.cad.last), upTo: Number(r.cad.upTo) } : null;
      const clean = r.unknown ? { unknown: true, why: r.why } : r.found
        ? { found: true, number: Number(r.number), url: typeof r.url === 'string' && TL.hostOf(r.url) === host ? r.url : e.lastUrl, latest: Number(r.latest) || Number(r.number), locked: !!r.locked, freeAt: Number(r.freeAt) || 0, image: /^https:\/\//.test(r.image || '') ? r.image : '' }
        : { found: false, image: /^https:\/\//.test(r.image || '') ? r.image : '' };
      if (clean.found && !(clean.number > (e.progress || 0))) return { ok: false };
      if (cad && !clean.unknown) clean.cad = cad;
      const n = await markNext(msg.id, clean);
      if (n) later(function () { return notify([n]); });
      return { ok: true };
    }
    case 'checkNow': runCheck(40, true); return { ok: true };
    case 'renameSite': { // every series filed under a site name, and the sites behind it, get the new name
      const from = String(msg.from || ''), to = String(msg.to || '').trim().slice(0, 40), c = await db();
      if (!from || from === to) return { ok: true, n: 0 };
      const out = [], hosts = new Set(), names = Object.assign({}, c.settings.siteNames);
      c.entries.forEach(function (e) {
        if (TL.siteLabel(e) !== from) return;
        if (e.site) hosts.add(e.site);
        const n = Object.assign({}, e, { updatedAt: Date.now() });
        if (to) n.source = to; else delete n.source;
        out.push(n);
      });
      Object.keys(names).forEach(function (h) { if (names[h] === from) hosts.add(h); });
      if (/\./.test(from) && !/\s/.test(from)) hosts.add(from); // the label was a bare site address
      hosts.forEach(function (h) { if (to) names[h] = to; else delete names[h]; });
      await putMany(out);
      await saveSettings({ siteNames: names, mutedSites: (c.settings.mutedSites || []).map(function (s) { return s === from ? to : s; }).filter(Boolean) });
      return { ok: true, n: out.length };
    }
    case 'ghSync': { const r = await ghSyncSoon(); return r; }
    case 'ghDisconnect': await chrome.storage.local.remove(['ghToken', 'ghState', 'ghGone', 'ghCfgAt']); await saveSettings({ gh: null }); return { ok: true };
    case 'latest': { // is a newer version of the extension on GitHub?
      try {
        const home = (chrome.runtime.getManifest().homepage_url || ''), m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(home);
        if (!m) return { ok: false };
        const url = 'https://api.github.com/repos/' + m[1] + '/' + m[2] + '/releases/latest';
        let r = await fetch(url, { cache: 'no-store', credentials: 'omit' }), priv = false;
        if (!r.ok) { // a private repo: ask with the GitHub sync token (Contents: read covers releases)
          const t = (await chrome.storage.local.get('ghToken')).ghToken;
          if (!t) return { ok: false };
          r = await fetch(url, { cache: 'no-store', credentials: 'omit', headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' } });
          if (!r.ok) return { ok: false };
          priv = true;
        }
        const j = await r.json(), asset = (j.assets || []).find(function (a) { return /\.zip$/.test(a.name); });
        // files in a private repo download from the release page while you are signed in to GitHub
        return { ok: true, version: String(j.tag_name || '').replace(/^v/, ''), url: asset && !priv ? asset.browser_download_url : j.html_url, page: j.html_url };
      } catch (e) { return { ok: false }; }
    }
    case 'seriesAt': { // a page on a tracked site asks: is this the series page of something on the list?
      const norm = function (u) { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ''); } catch (e) { return ''; } };
      const here = norm(msg.url), c = await db();
      if (!here) return {};
      for (const e of c.entries.values()) {
        if (!e.lastUrl || e.status !== 'current' || (e.next && e.next.number > (e.progress || 0) && !e.next.locked)) continue;
        if (norm(e.seriesUrl || '') === here || norm(TL.seriesUrl(e.lastUrl) || '') === here) return { entry: e };
      }
      return {};
    }
    case 'focus': { // start (until = time) or stop (until = 0) a focus session
      const c = await db();
      await saveSettings({ focus: Object.assign({}, c.settings.focus, { until: Math.max(0, Number(msg.until) || 0), pass: 0 }, msg.patch || {}) });
      if (msg.until) later(sweepTabs);
      return { ok: true };
    }
    case 'pass': { // a short break from the blocker
      const c = await db();
      await saveSettings({ focus: Object.assign({}, c.settings.focus, { pass: Date.now() + 5 * 6e4 }) });
      return { ok: true };
    }
    case 'malDisconnect': await chrome.storage.local.remove(['malAuth', 'malQueue']); await saveSettings({ malState: null }); return { ok: true };
    case 'malSync': later(flushMal); return { ok: true };
    case 'mute': {
      const until = msg.until === -1 ? -1 : Math.max(0, Number(msg.until) || 0);
      const p = { muteUntil: until };
      if (!until) { p.quietSkip = TL.quietEnd((await db()).settings) || 0; p.missed = 0; } // "unmute now" also ends the current quiet hours
      await saveSettings(p);
      await armUnmute();
      return { ok: true };
    }
    case 'reset': {
      await chrome.storage.local.clear();
      cache = null; index = null;
      await firstRun(); // back to the bundled manga list plus a fresh MAL import
      await saveSettings({ syncInit: Date.now() });
      return { ok: true };
    }
  }
  return { ok: false };
}

// One message at a time, so two tabs can never interleave a read-modify-write.
let queue = Promise.resolve();
function enqueue(fn) { const p = queue.then(fn); queue = p.catch(function () {}); return p; }
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;
  if (msg.type === 'ghConnect') { // talks to GitHub first, so it must not hold up the queue
    ghConnect(msg.repo, msg.token, msg.path).then(function (r) { sendResponse(Object.assign({ ok: true }, r)); }, function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
    if (msg.type === 'malConnect') { // waits on a sign-in window, so it must not hold up the queue
    malConnect(msg.clientId).then(function () { sendResponse({ ok: true }); }, function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
  queue = queue.then(function () { return handle(msg, sender); })
    .then(sendResponse, function (err) { console.error('Shelf:', err); sendResponse({ ok: false, error: String(err && err.message || err) }); });
  return true;
});

function ensureAlarm() {
  chrome.alarms.get('check', function (a) { if (!a) chrome.alarms.create('check', { delayInMinutes: 5, periodInMinutes: 180 }); });
  chrome.alarms.get('ghPoll', function (a) { if (!a) chrome.alarms.create('ghPoll', { delayInMinutes: 1, periodInMinutes: 5 }); }); // pick up changes from other devices
}
chrome.runtime.onStartup.addListener(function () { ensureAlarm(); later(ghSync); });
// Wake up when the current mute or quiet hours end, to pass on anything that was held back.
async function armUnmute() {
  const end = TL.muteEnd((await db()).settings);
  if (end > 0) chrome.alarms.create('unmute', { when: end + 1000 }); else chrome.alarms.clear('unmute');
}
async function unmute() {
  const c = await db(), missed = c.settings.missed || 0;
  if (TL.isMuted(c.settings)) { await armUnmute(); return; } // muted again in the meantime
  if (!missed && !(c.settings.muteUntil > 0)) return;
  await saveSettings({ muteUntil: 0, missed: 0 });
  if (missed && c.settings.notify !== false && chrome.notifications) {
    try {
      chrome.notifications.create('new:many', { type: 'basic', iconUrl: 'icons/icon128.png',
        title: missed + ' new release' + (missed === 1 ? '' : 's') + ' while you were muted', message: 'Open Shelf to see what is new.' });
    } catch (e) { /* notifications blocked */ }
  }
}
chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === 'gh' || a.name === 'ghPoll') { later(ghSync); return; }
  if (a.name === 'check') {
    enqueue(unmute); // catches a mute that ended while Chrome was closed
    runCheck(25, false).catch(function (e) { console.error('Shelf check:', e); }).then(function () { return fetchCovers(); });
    later(flushMal); enqueue(maybeRecap);
  }
  else if (a.name === 'free') runCheck(25, false).catch(function (e) { console.error('Shelf check:', e); });
  else if (a.name === 'recap') enqueue(maybeRecap);
  else if (a.name === 'unmute') enqueue(unmute);
});
// Clicking an alert (or its "Read now" button) opens the new chapter on its site.
async function openNotice(nid) {
  chrome.notifications.clear(nid);
  const c = await db(), e = nid.indexOf('new:') === 0 ? c.entries.get(nid.slice(4)) : null;
  if (nid.indexOf('due:') === 0) { // an estimate: open the series page, where Shelf confirms it
    const d = c.entries.get(nid.slice(4)), u = d && (d.seriesUrl || TL.seriesUrl(d.lastUrl) || d.lastUrl);
    return chrome.tabs.create({ url: /^https?:\/\//.test(u || '') ? u : chrome.runtime.getURL('app.html#new') });
  }
  const ok = e && e.next && /^https?:\/\//.test(e.next.url || '');
  return chrome.tabs.create({ url: nid === 'recap' ? chrome.runtime.getURL('app.html#recap') : ok ? e.next.url : chrome.runtime.getURL('app.html#new') });
}
if (chrome.notifications) {
  chrome.notifications.onClicked.addListener(openNotice);
  chrome.notifications.onButtonClicked.addListener(openNotice);
}
ensureAlarm();
enqueue(maybeRecap);

chrome.runtime.onInstalled.addListener(function (info) {
  if (!WEB && chrome.storage.sync) chrome.storage.sync.clear().catch(function () {}); // the list is no longer kept in Google sync: erase the old copy there
  if (info.reason !== 'install') { armUnmute(); later(fetchCovers); later(ghSync); later(function () { return runCheck(40, true); }); return; } // reloaded or updated: pick up covers, catch up on sync
  queue = queue.then(firstRun).then(function () {
    db().then(function (c) { chrome.tabs.create({ url: chrome.runtime.getURL(c.entries.size ? 'app.html' : 'app.html#settings') }); }); // nothing loaded yet: start at Connect GitHub
    later(fetchCovers);
  }, function (err) { console.error('Shelf setup:', err); });
});
