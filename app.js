/* Shelf tracker page (used as both the toolbar popup and the full-page view). */
(function () {
  'use strict';
  const $ = function (s) { return document.querySelector(s); };
  const isPopup = document.body.classList.contains('popup');
  const IS_WEB = !!self.SHELF_WEB; // the GitHub Pages version (phones, tablets): no page tracking, checks or notifications
  const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const send = function (msg) { return chrome.runtime.sendMessage(msg).catch(function () { return { ok: false, error: 'The extension is restarting. Try again in a moment.' }; }); };

  const STATUSES = ['current', 'planning', 'on_hold', 'completed', 'dropped'];
  const WORD = {
    manga: { current: 'Reading', planning: 'Plan to read', unit: 'Ch.', units: 'chapters read', name: 'manga' },
    anime: { current: 'Watching', planning: 'Plan to watch', unit: 'Ep.', units: 'episodes watched', name: 'anime' }
  };
  const statusLabel = function (k, s) { return s === 'current' ? WORD[k].current : s === 'planning' ? WORD[k].planning : s === 'on_hold' ? 'On hold' : s === 'completed' ? 'Completed' : 'Dropped'; };
  const fmt = function (n) { return n == null ? '–' : String(n); };
  const r1 = function (n) { return Math.round(n * 10) / 10; };
  function ago(s) {
    if (!s) return 'Not started';
    const d = Math.round((new Date(TL.today()) - new Date(s)) / 864e5);
    if (d <= 0) return 'Today'; if (d === 1) return 'Yesterday'; if (d < 7) return d + ' days ago';
    if (d < 60) return Math.round(d / 7) + ' wk ago'; if (d < 730) return Math.round(d / 30) + ' mo ago';
    return Math.round(d / 365) + ' yr ago';
  }

  let all = [], settings = Object.assign({}, TL.DEFAULTS);
  const msgs = { mal: null, imp: null, malw: null, gh: null, retoken: false }; // { text, bad } shown under the import buttons
  const state = { view: 'manga', status: { manga: 'current', anime: 'current' }, site: { manga: 'all', anime: 'all' }, q: '', sort: 'interest', open: null, shown: 60 };
  try { Object.assign(state, JSON.parse(localStorage.getItem('shelf-view2') || '{}')); } catch (e) { /* first run */ }
  if (location.hash === '#settings') state.view = 'settings';
  const wantNew = location.hash === '#new';
  if (location.hash === '#recap') state.view = 'stats';
  state.q = ''; state.open = null; state.shown = 60;
  const saveView = function () { try { localStorage.setItem('shelf-view2', JSON.stringify({ view: state.view === 'settings' ? 'manga' : state.view, status: state.status, site: state.site, sort: state.sort })); } catch (e) { /* private mode */ } };

  let tt;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(function () { t.hidden = true; }, 2600); }

  /* ---------- data ---------- */

  let malOn = false; // signed in to MyAnimeList for write-back
  let ghSt = {}, ghOn = false; // GitHub sync: last result, and whether a token is saved
  let latest = null;           // newest release on GitHub, for the update notice
  function withDefaults(s) {
    const o = Object.assign({}, TL.DEFAULTS, s || {});
    o.focus = Object.assign({}, TL.DEFAULTS.focus, o.focus);
    o.mal = Object.assign({}, TL.DEFAULTS.mal, o.mal);
    return o;
  }
  async function load() {
    const d = await chrome.storage.local.get(null);
    all = Object.keys(d).filter(function (k) { return k.indexOf('e:') === 0; }).map(function (k) { return d[k]; });
    settings = withDefaults(d.settings);
    malOn = !!d.malAuth;
    ghSt = d.ghState || {}; ghOn = !!d.ghToken;
  }
  let rt;
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area !== 'local') return;
    for (const k in ch) {
      if (k.indexOf('e:') === 0) {
        const id = k.slice(2), i = all.findIndex(function (e) { return e.id === id; });
        if (ch[k].newValue) { if (i >= 0) all[i] = ch[k].newValue; else all.push(ch[k].newValue); }
        else if (i >= 0) all.splice(i, 1);
      } else if (k === 'settings') settings = withDefaults(ch[k].newValue);
      else if (k === 'malAuth') malOn = !!ch[k].newValue;
      else if (k === 'ghState') ghSt = ch[k].newValue || {};
      else if (k === 'ghToken') ghOn = !!ch[k].newValue;
    }
    clearTimeout(rt);
    rt = setTimeout(function () {
      const a = document.activeElement; // don't yank a field out from under the cursor
      if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT') && (a.closest('#main') || a.closest('#now')) && a.id !== 'q') { renderNotice(); return; }
      render();
    }, 150);
  });

  /* ---------- list view ---------- */

  // Search looks at every title of that type, ignoring the status and site filters.
  function filtered(kind) {
    const st = state.status[kind], site = state.site[kind], q = TL.norm(state.q.trim());
    const r = all.filter(q ? function (e) {
      return e.kind === kind && TL.searchKey(e).some(function (n) { return n.indexOf(q) >= 0; });
    } : function (e) {
      return e.kind === kind && (st === 'all' || (st === 'new' ? isNew(e) : e.status === st)) &&
        (site === 'all' || (site === '' ? !TL.siteLabel(e) : TL.siteLabel(e) === site));
    });
    const s = state.sort;
    if (s === 'title') return r.sort(function (a, b) { return a.title.localeCompare(b.title); });
    // work each row's sort value out once, not on every comparison
    const day = TL.dayNum();
    const key = s === 'interest' ? function (e) { return TL.interest(e, day); } : s === 'progress' ? function (e) { return e.progress || 0; } : function (e) { return e.updatedAt || 0; };
    return r.map(function (e) { return [key(e), e]; })
      .sort(function (a, b) { return b[0] - a[0] || String(b[1].lastRead || '').localeCompare(String(a[1].lastRead || '')) || a[1].title.localeCompare(b[1].title); })
      .map(function (x) { return x[1]; });
  }
  // Which alternative title made a search match, when it was not the main one
  function akaFor(e) {
    const q = TL.norm(state.q.trim());
    if (!q) return '';
    const n = TL.searchKey(e);
    if (n[0].indexOf(q) >= 0) return '';
    return (e.alt || []).find(function (a) { return TL.norm(a).indexOf(q) >= 0; }) || '';
  }

  const isNew = function (e) { const st = TL.newState(e); return st === 'new' || st === 'due'; }; // out and free to read, or probably out by its usual rhythm (locked ones wait)

  const siteMuted = function (e) { const l = TL.siteLabel(e); return !!l && (settings.mutedSites || []).indexOf(l) >= 0; };
  function coverHTML(e) {
    if (settings.covers === false) return '';
    if (e.image && /^https:\/\//.test(e.image)) return '<img class="cover" src="' + esc(e.image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
    return '<span class="cover ph" aria-hidden="true">' + esc(initials(e.title)) + '</span>';
  }
  const initials = function (t) { const w = String(t).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean); return ((w[0] || '?').charAt(0) + (w[1] ? w[1].charAt(0) : '')).toUpperCase(); };

  const chkWhy = function (w) { const m = /^status (\d+)$/.exec(w || ''); return m ? 'the site refused the request, code ' + m[1] : w === 'unreachable' ? 'the site did not answer' : w || 'no answer'; };

  function rowHTML(e) {
    const w = WORD[e.kind], open = state.open === e.id, aka = akaFor(e), lately = TL.readIn(e, 30), nx = TL.nextLink(e);
    const links = [['Last page', e.lastUrl], ['Series page', e.seriesUrl], ['MAL', e.links && e.links.mal], ['AniList', e.links && e.links.anilist], ['MangaUpdates', e.links && e.links.mu]]
      .filter(function (l) { return l[1] && /^https?:\/\//.test(l[1]); })
      .map(function (l) { return '<a href="' + esc(l[1]) + '" target="_blank" rel="noopener">' + l[0] + '</a>'; }).join('');
    let go = '', after = '';
    const eta = nx && nx.eta ? ' · ' + w.unit + ' ' + nx.eta.number + ' likely ' + TL.whenText(nx.eta.at) : '';
    if (nx && nx.type === 'none') go = '<span class="utd">Up to date' + eta + '</span>';
    else if (nx && nx.type === 'due') go = '<a class="duep" href="' + esc(nx.url) + '" target="_blank" rel="noopener" title="Estimated from its usual release gap. Opens the series page, where Shelf confirms it.">' + w.unit + ' ' + nx.number + ' probably out</a>';
    else if (nx) {
      const more = nx.type === 'new' && nx.latest > nx.number ? ' (+' + Math.round(nx.latest - nx.number) + ')' : '';
      const text = nx.type === 'new' ? 'New: ' + w.unit + ' ' + nx.number + more : nx.type === 'locked' ? w.unit + ' ' + nx.number + ' ' + TL.waitText(nx.freeAt) : nx.type === 'next' ? 'Next: ' + w.unit + ' ' + nx.number : 'Continue';
      if (nx.type === 'continue' && eta) after = '<span class="utd soon">' + eta.slice(3) + '</span>';
      go = '<a class="' + (nx.type === 'new' ? 'new' : nx.type === 'locked' ? 'lockp' : 'nxt') + '" href="' + esc(nx.url) + '" target="_blank" rel="noopener" title="' + (nx.type === 'locked' ? 'Out, but not free yet. You get the alert when it is.' : (nx.type === 'continue' ? 'Open the page you last read' : 'Open ' + w.unit + ' ' + nx.number + ' (confirmed out)')) + '">' + text + '</a>';
    }
    const quiet = e.muted || siteMuted(e);
    let h = '<div class="item" data-id="' + esc(e.id) + '" data-k="' + e.kind + '" data-o="' + esc(e.origin) + '"><span class="spine"></span>' + coverHTML(e) +
      '<div class="main"><button class="title" data-act="open" aria-expanded="' + open + '">' + esc(e.title) + '</button>' +
      '<div class="meta"><span class="pill ' + e.status + '">' + statusLabel(e.kind, e.status) + '</span>' + go +
      (e.origin ? '<span>' + esc(e.origin) + '</span>' : '') + (TL.siteLabel(e) ? '<span class="src">' + esc(TL.siteLabel(e)) + '</span>' : '') +
      after + '<span class="when">' + ago(e.lastRead) + '</span>' +
      (lately ? '<span>' + lately + ' in 30 days</span>' : '') + (quiet ? '<span class="mut">Alerts muted</span>' : '') + (aka ? '<span class="aka">aka ' + esc(aka) + '</span>' : '') + '</div></div>' +
      '<div class="ctr"><button data-act="dec" aria-label="One back">−</button>' +
      '<label class="ch"><small>' + w.unit + '</small><input data-act="set" value="' + fmt(e.progress) + '" inputmode="decimal" aria-label="Progress for ' + esc(e.title) + '">' +
      (e.total ? '<small>of ' + e.total + '</small>' : '') + '</label>' +
      '<button class="plus" data-act="inc" aria-label="Log the next one">+</button></div>';
    if (open) {
      h += '<div class="detail"><label>Status <select data-act="status">' + STATUSES.map(function (s) { return '<option value="' + s + '"' + (s === e.status ? ' selected' : '') + '>' + statusLabel(e.kind, s) + '</option>'; }).join('') + '</select></label>' +
        '<label>Score <select data-act="score"><option value="0">–</option>' + [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(function (n) { return '<option' + (n === e.score ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
        '<label>Total <input data-act="total" value="' + (e.total || '') + '" inputmode="numeric" placeholder="?"></label>' +
        '<label>Site <input class="wide" data-act="source" list="sources" value="' + esc(e.source || '') + '" placeholder="' + esc(e.site || 'e.g. Asura') + '"></label>' +
        '<button class="tog" data-act="mute" aria-pressed="' + !!e.muted + '">' + (e.muted ? 'Unmute alerts' : 'Mute alerts') + '</button>' +
        links + '<button class="del" data-act="del">Remove</button>' +
        (e.chk && !TL.newState(e) ? '<p class="chk">Shelf could not check this site for new chapters from the background (' + esc(chkWhy(e.chk.why)) + '). It checks from the chapter page each time you read here.</p>' : '') + '</div>';
    }
    return h + '</div>';
  }

  function renderList() {
    const kind = state.view, w = WORD[kind], mine = all.filter(function (e) { return e.kind === kind; });
    const cnt = function (s) { return s === 'all' ? mine.length : mine.filter(function (e) { return e.status === s; }).length; };
    const fresh = mine.filter(isNew).length;
    if (state.status[kind] === 'new' && !fresh) state.status[kind] = 'current';
    const chips = (fresh ? ['new'] : []).concat(STATUSES, ['all']).filter(function (s) { return s === 'all' || s === 'current' || s === 'new' || cnt(s); }).map(function (s) {
      return '<button class="chip' + (s === 'new' ? ' hot' : '') + '" data-status="' + s + '" aria-pressed="' + (state.status[kind] === s) + '">' + (s === 'all' ? 'All' : s === 'new' ? 'New' : statusLabel(kind, s)) + '<span class="n">' + (s === 'new' ? fresh : cnt(s)) + '</span></button>';
    }).join('');
    // Sites: your own labels (Asura, Gen Z) plus any site a series was last saved from
    const bySite = {};
    mine.forEach(function (e) { const l = TL.siteLabel(e); bySite[l] = (bySite[l] || 0) + 1; });
    const labels = Object.keys(bySite).filter(Boolean).sort(function (a, b) { return bySite[b] - bySite[a] || a.localeCompare(b); });
    if (state.site[kind] !== 'all' && !(state.site[kind] in bySite)) state.site[kind] = 'all';
    const quietSites = settings.mutedSites || [], sel = state.site[kind];
    const siteChip = function (v, label, n) { return '<button class="chip' + (quietSites.indexOf(v) >= 0 ? ' muted' : '') + '" data-site-f="' + esc(v) + '" aria-pressed="' + (sel === v) + '">' + esc(label) + '<span class="n">' + n + '</span></button>'; };
    const siteChips = labels.length ? '<div class="chips"><span class="lbl">Site</span>' + siteChip('all', 'Any', mine.length) +
      labels.map(function (l) { return siteChip(l, l, bySite[l]); }).join('') + (bySite[''] ? siteChip('', 'Unsorted', bySite['']) : '') +
      (sel !== 'all' && sel !== '' ? '<button class="tog" data-site-mute="' + esc(sel) + '" aria-pressed="' + (quietSites.indexOf(sel) >= 0) + '">' + (quietSites.indexOf(sel) >= 0 ? 'Unmute ' : 'Mute ') + esc(sel) + ' alerts</button><button class="tog" data-site-rename="' + esc(sel) + '">Rename</button>' : '') + '</div>' : '';
    $('#sources').innerHTML = Array.from(new Set(all.map(function (e) { return e.source; }).filter(Boolean))).sort().map(function (l) { return '<option value="' + esc(l) + '">'; }).join('');
    const r = filtered(kind);
    let body;
    if (!r.length) body = '<div class="empty">' + (mine.length ? 'Nothing matches. Try another filter or search.' : (kind === 'anime'
      ? 'No anime yet. Import your MyAnimeList in Settings, or add one with “+ Add”.' : 'No series yet. Add one with “+ Add”.')) + '</div>';
    else body = '<div class="list' + (settings.covers === false ? ' nc' : '') + '">' + r.slice(0, state.shown).map(rowHTML).join('') + '</div>' +
      (r.length > state.shown ? '<button class="btn ghost" id="more">Show more (' + (r.length - state.shown) + ' left)</button>' : '');
    const qEl = $('#q'), hadFocus = qEl && document.activeElement === qEl, pos = hadFocus ? qEl.selectionStart : 0;
    $('#main').innerHTML = '<div class="bar"><input id="q" type="search" placeholder="Search ' + mine.length + ' ' + w.name + ' titles" aria-label="Search" value="' + esc(state.q) + '"><button class="btn" id="addBtn">+ Add</button></div>' +
      '<div class="chips">' + chips + '<select id="sort" aria-label="Sort"><option value="interest">Reading most lately</option><option value="recent">Recently updated</option><option value="title">Title A–Z</option><option value="progress">Most progress</option></select></div>' + siteChips + body;
    $('#sort').value = state.sort;
    if (hadFocus) { const n = $('#q'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* search inputs */ } }
  }

  async function toggleSiteMute(label) {
    const cur = settings.mutedSites || [], on = cur.indexOf(label) >= 0;
    const next = on ? cur.filter(function (x) { return x !== label; }) : cur.concat([label]);
    settings.mutedSites = next;
    await send({ type: 'settings', patch: { mutedSites: next } });
    toast(on ? label + ' alerts are back on' : label + ' alerts muted');
    render();
  }
  // a cover that fails to load falls back to the initials tile
  $('#main').addEventListener('error', function (ev) {
    const im = ev.target;
    if (!im.classList || !im.classList.contains('cover') || im.tagName !== 'IMG') return;
    const row = im.closest('.item'), e = row && all.find(function (x) { return x.id === row.dataset.id; });
    const ph = document.createElement('span');
    ph.className = 'cover ph'; ph.setAttribute('aria-hidden', 'true'); ph.textContent = e ? initials(e.title) : '';
    im.replaceWith(ph);
  }, true);

  async function bump(id, d) {
    const e = all.find(function (x) { return x.id === id; });
    if (!e) return;
    const n = Math.max(0, r1((e.progress || 0) + d));
    const res = d > 0 ? await send({ type: 'apply', id: id, number: n }) : await send({ type: 'patch', id: id, patch: { progress: n } });
    if (!res.ok) { toast(res.error || 'That change was not saved. Try again.'); return; }
    const row = document.querySelector('.item[data-id="' + CSS.escape(id) + '"]');
    if (row) { row.querySelector('input[data-act=set]').value = fmt(n); row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  }

  $('#main').addEventListener('click', async function (ev) {
    const t = ev.target;
    const rc = t.closest('.chip[data-recap]');
    if (rc) { recapOff = Number(rc.dataset.recap); render(); return; }
    const chip = t.closest('.chip[data-status]');
    if (chip) { state.status[state.view] = chip.dataset.status; state.shown = 60; saveView(); render(); return; }
    const sr = t.closest('[data-site-rename]');
    if (sr) {
      const name = sr.dataset.siteRename;
      state.view = 'settings'; render();
      const box = document.querySelector('input[data-sitename="' + CSS.escape(name) + '"]');
      if (box) { box.scrollIntoView({ block: 'center' }); box.focus(); box.select(); }
      return;
    }
    const sm = t.closest('[data-site-mute]');
    if (sm) { await toggleSiteMute(sm.dataset.siteMute); return; }
    const sc = t.closest('.chip[data-site-f]');
    if (sc) { state.site[state.view] = sc.dataset.siteF; state.shown = 60; saveView(); render(); return; }
    if (t.id === 'more') { state.shown += 100; render(); return; }
    if (t.id === 'addBtn') { openAdd(); return; }
    const b = t.closest('[data-act]');
    const item = t.closest('.item');
    if (b && item) {
      const id = item.dataset.id, a = b.dataset.act;
      if (a === 'inc') bump(id, 1);
      else if (a === 'dec') bump(id, -1);
      else if (a === 'open') { state.open = state.open === id ? null : id; render(); }
      else if (a === 'mute') {
        const e = all.find(function (x) { return x.id === id; });
        if (e) { await send({ type: 'patch', id: id, patch: { muted: !e.muted }, touch: false }); toast(e.muted ? 'Alerts back on for this series' : 'Alerts muted for this series'); }
      }
      else if (a === 'del') {
        if (b.dataset.sure) { await send({ type: 'delete', id: id }); toast('Removed'); }
        else { b.dataset.sure = '1'; b.textContent = 'Click again to remove'; }
      }
      return;
    }
    settingsClick(t);
  });
  $('#main').addEventListener('change', async function (ev) {
    const el = ev.target;
    if (el.id === 'sort') { state.sort = el.value; saveView(); render(); return; }
    const item = el.closest('.item');
    if (!item) { settingsChange(el); return; }
    const id = item.dataset.id, e = all.find(function (x) { return x.id === id; }), a = el.dataset.act;
    if (!e) return;
    if (a === 'set') {
      const v = parseFloat(el.value);
      if (isNaN(v) || v < 0) { el.value = fmt(e.progress); return; }
      const res = v > (e.progress || 0) ? await send({ type: 'apply', id: id, number: v }) : await send({ type: 'patch', id: id, patch: { progress: v } });
      toast(res.ok ? WORD[e.kind].unit + ' ' + v + ' saved' : 'That change was not saved.');
    } else if (a === 'status') { await send({ type: 'patch', id: id, patch: { status: el.value } }); toast('Moved to ' + statusLabel(e.kind, el.value).toLowerCase()); }
    else if (a === 'score') await send({ type: 'patch', id: id, patch: { score: Number(el.value) || 0 } });
    else if (a === 'total') { const n = parseFloat(el.value); await send({ type: 'patch', id: id, patch: { total: isNaN(n) || n <= 0 ? null : n } }); }
    else if (a === 'source') { const v = el.value.trim(); await send({ type: 'patch', id: id, patch: { source: v } }); toast(v ? 'Filed under ' + v : 'Site label cleared'); }
    el.blur();
  });
  $('#main').addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.dataset.act) ev.target.blur(); });
  let qt;
  $('#main').addEventListener('input', function (ev) {
    if (ev.target.id !== 'q') return;
    clearTimeout(qt);
    qt = setTimeout(function () { state.q = ev.target.value; state.shown = 60; render(); }, 140);
  });

  /* ---------- add dialog ---------- */

  function fillStatus(kind, sel, val) {
    sel.innerHTML = STATUSES.map(function (s) { return '<option value="' + s + '">' + statusLabel(kind, s) + '</option>'; }).join('');
    sel.value = val || 'current';
  }
  function openAdd() {
    $('#addForm').reset();
    $('#fKind').value = state.view === 'anime' ? 'anime' : 'manga';
    fillStatus($('#fKind').value, $('#fStatus'));
    $('#dlg').showModal(); $('#fTitle').focus();
  }
  $('#fKind').addEventListener('change', function () { fillStatus($('#fKind').value, $('#fStatus'), $('#fStatus').value); });
  $('#fCancel').addEventListener('click', function () { $('#dlg').close(); });
  $('#addForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    const title = $('#fTitle').value.trim(); if (!title) return;
    const n = parseFloat($('#fNum').value), kind = $('#fKind').value;
    $('#dlg').close();
    const res = await send({ type: 'add', fields: { kind: kind, title: title, number: isNaN(n) ? null : n, status: $('#fStatus').value } });
    if (res.ok) { state.view = kind; state.status[kind] = res.entry.status; toast('Added ' + title); render(); }
    else toast('That series was not added. Try again.');
  });

  /* ---------- stats ---------- */

  function meters(rows, max) {
    return rows.filter(function (r) { return r[1]; }).map(function (r) {
      return '<div class="meter"><span>' + esc(r[0]) + '</span><span class="track"><i style="width:' + Math.max(1, 100 * r[1] / max) + '%"></i></span><span class="v">' + r[1] + '</span></div>';
    }).join('');
  }
  /* ---------- weekly recap ---------- */

  let recapOff = 0; // 0 = this week, -1 = last week
  const dayText = function (day) { return new Date(day * 864e5 + 432e5).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  function recapHTML() {
    const from = TL.weekStart() + 7 * recapOff, r = TL.recap(all, from, from + 6), total = r.manga + r.anime;
    const stat = function (v, l) { return '<div class="stat"><b>' + v + '</b><span>' + l + '</span></div>'; };
    const diff = Math.round((total - r.prev) * 10) / 10;
    const top = r.top.length ? r.top[0].n : 1;
    let h = '<h2>Weekly recap</h2><div class="chips"><button class="chip" data-recap="0" aria-pressed="' + (recapOff === 0) + '">This week</button><button class="chip" data-recap="-1" aria-pressed="' + (recapOff === -1) + '">Last week</button>' +
      '<span class="lbl" style="margin-left:6px">' + dayText(from) + ' to ' + dayText(from + 6) + '</span></div>' +
      '<div class="grid">' + stat(r.manga, 'chapters read') + stat(r.anime, 'episodes watched') + stat(r.series, 'series') + stat(r.days + ' of 7', 'days active') +
      stat((diff > 0 ? '+' : '') + diff, 'vs the week before') + '</div>';
    if (!total) h += '<p class="empty" style="padding:10px 0 18px">Nothing logged ' + (recapOff ? 'that week' : 'yet this week') + '. Chapters and episodes count once Shelf saves them, starting from version 1.2.</p>';
    else h += '<h3>Top series</h3>' + r.top.map(function (t) { return '<div class="meter wide"><span>' + esc(t.title) + '</span><span class="track"><i style="width:' + Math.max(2, 100 * t.n / top) + '%"></i></span><span class="v">' + t.n + '</span></div>'; }).join('');
    if (r.behind.length) h += '<h3>Fallen behind</h3>' + r.behind.map(function (b) {
      return '<div class="brow"><span>' + esc(b.title) + '</span>' + (/^https?:\/\//.test(b.url || '') ? '<a class="new" href="' + esc(b.url) + '" target="_blank" rel="noopener">' + b.gap + ' new</a>' : '<span class="mut">' + b.gap + ' new</span>') + '</div>'; }).join('');
    if (r.quiet.length) h += '<h3>Gone quiet</h3>' + r.quiet.map(function (b) { return '<div class="brow"><span>' + esc(b.title) + '</span><span class="lbl">' + Math.round(b.idle / 7) + ' weeks</span></div>'; }).join('');
    if (!r.behind.length && total) h += '<p class="lbl" style="margin-top:10px">No new releases waiting on the series Shelf can check.</p>';
    return h + '<p style="color:var(--muted);font-size:13px;margin:10px 0 0">You get this as a notification on Sunday at 6 pm.</p>';
  }

  function statsFor(kind) {
    const w = WORD[kind], mine = all.filter(function (e) { return e.kind === kind; });
    if (!mine.length) return '<h2>' + (kind === 'anime' ? 'Anime' : 'Manga') + '</h2><p class="empty">Nothing here yet.</p>';
    const c = function (s) { return mine.filter(function (e) { return e.status === s; }).length; };
    const units = Math.round(mine.reduce(function (a, e) { return a + (e.progress || 0); }, 0));
    const wt = TL.watchTime(mine);
    const scored = mine.filter(function (e) { return e.score > 0; });
    const mean = scored.length ? (scored.reduce(function (a, e) { return a + e.score; }, 0) / scored.length).toFixed(2) : '–';
    const wk = new Date(TL.today()); wk.setDate(wk.getDate() - 6);
    const since = wk.toISOString().slice(0, 10);
    const active = mine.filter(function (e) { return e.lastRead && e.lastRead >= since; }).length;
    const by = {};
    mine.forEach(function (e) { const o = e.origin || 'Other'; by[o] = (by[o] || 0) + 1; });
    const types = Object.keys(by).map(function (k) { return [k, by[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6);
    const stat = function (v, l) { return '<div class="stat"><b>' + v + '</b><span>' + l + '</span></div>'; };
    return '<h2>' + (kind === 'anime' ? 'Anime' : 'Manga') + '</h2><div class="grid">' +
      stat(mine.length, 'series') + stat(units.toLocaleString(), w.units) + (kind === 'anime' ? stat(wt.days, 'days watched (' + wt.hours.toLocaleString() + ' hours)') : '') + stat(Math.round(mine.reduce(function (a, e) { return a + TL.readIn(e, 30); }, 0)), 'logged in the last 30 days') + stat(c('completed'), 'completed') + stat(active, 'active this week') + stat(mean, 'mean score (' + scored.length + ' scored)') + '</div>' +
      (kind === 'anime' && wt.guessed ? '<p style="color:var(--muted);font-size:13px;margin:-6px 0 10px">Watch time uses each title\u2019s episode length. ' + wt.guessed + ' of ' + wt.titles + ' titles are still on a typical length (24 minutes, 100 for films) until the real one is looked up.</p>' : '') +
      '<h3>By status</h3>' + meters(STATUSES.map(function (s) { return [statusLabel(kind, s), c(s)]; }), mine.length) +
      '<h3>By type</h3>' + meters(types, mine.length);
  }

  /* ---------- settings ---------- */

  let busy = false;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  async function saveQuiet(q) { settings.quiet = q; await send({ type: 'settings', patch: { quiet: q } }); render(); }
  const timeText = function (ts) { const d = new Date(ts), same = d.toDateString() === new Date().toDateString(); return d.toLocaleString([], same ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
  const NEW_REPO = 'https://github.com/new?name=shelf-data&visibility=private&description=My+Shelf+reading+list';
  const NEW_TOKEN = 'https://github.com/settings/personal-access-tokens/new?name=Shelf&description=Reads+and+writes+my+Shelf+list';
  function githubHTML() {
    const g = settings.gh, on = ghOn && g && g.owner;
    let h = '<div class="card gh"><h2>GitHub sync</h2>';
    if (on) {
      h += '<p>Your list is saved in <a href="https://github.com/' + esc(g.owner) + '/' + esc(g.repo) + '/blob/' + esc(g.branch || 'main') + '/' + esc(g.path || 'shelf.json') + '" target="_blank" rel="noopener"><b>' + esc(g.owner + '/' + g.repo) + '</b></a> and kept the same on every device connected to it' + (IS_WEB ? ', including Shelf in Chrome on your computers.' : ', including the web version on your phone.') + '</p>' +
        '<p class="msg' + (ghSt.error ? ' bad' : '') + '" style="margin:0 0 8px">' + (ghSt.error ? esc(ghSt.error) : ghSt.at ? 'Synced ' + timeText(ghSt.at) + (ghSt.count ? ' · ' + ghSt.count + ' series' : '') + (ghSt.by ? ' · last change from ' + esc(ghSt.by) : '') + '.' : 'Not synced yet.') + '</p>' +
        '<div class="row"><button class="btn ghost" id="ghSync">Sync now</button>' + (ghSt.auth ? '<button class="btn" id="ghRetoken">Paste a new token</button>' : '') + '<button class="btn danger" id="ghOff">Disconnect</button></div>' +
        (msgs.retoken ? tokenRow() : '');
    } else {
      h += '<p>Keep your list in a private GitHub repo, so every device shows the same list: Shelf in Chrome on your computers, and the web version on your iPhone or iPad.</p>' +
        '<ol class="steps"><li>Make a <b>private</b> repo for the list: <a href="' + NEW_REPO + '" target="_blank" rel="noopener">create shelf-data</a> (leave it empty).</li>' +
        '<li>Make a token: <a href="' + NEW_TOKEN + '" target="_blank" rel="noopener">new fine-grained token</a>. Under <b>Repository access</b> pick <b>Only select repositories</b> and choose that repo. Under <b>Permissions</b>, set <b>Contents</b> to <b>Read and write</b>. Pick the longest expiration you are happy with, then copy the token.</li>' +
        '<li>Paste both here and press Connect.' + (IS_WEB ? '' : ' Connect the computer with your most up-to-date list first; it uploads its list.') + '</li></ol>' +
        '<div class="row"><input class="inline" id="ghRepo" value="' + esc(msgs.ghRepo != null ? msgs.ghRepo : g && g.owner ? g.owner + '/' + g.repo : '') + '" placeholder="yourname/shelf-data" aria-label="Repo for your list" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:200px"></div>' + tokenRow();
    }
    return h + '<div class="msg' + (msgs.gh && msgs.gh.bad ? ' bad' : '') + '">' + esc(msgs.gh ? msgs.gh.text : '') + '</div></div>';
  }
  function tokenRow() {
    return '<div class="row"><input class="inline" type="password" id="ghToken" placeholder="github_pat_…" aria-label="GitHub token" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:260px">' +
      '<button class="btn" id="ghConnect"' + (busy ? ' disabled' : '') + '>Connect</button></div>';
  }
  const verNum = function (v) { return String(v || '').split('.').map(function (x) { return parseInt(x, 10) || 0; }); };
  const newer = function (a, b) { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  function versionHTML() {
    const mine = chrome.runtime.getManifest().version;
    if (latest === null) { latest = false; send({ type: 'latest' }).then(function (r) { latest = r && r.ok ? r : false; if (state.view === 'settings') render(); }); }
    const up = latest && newer(latest.version, mine);
    return '<div class="card native"><h2>Updates</h2><p>Shelf ' + esc(mine) + (up ? '. <b style="color:var(--ink)">Version ' + esc(latest.version) + ' is out.</b> <a href="' + esc(latest.url) + '" target="_blank" rel="noopener">Download it</a>, unzip it over your Shelf folder (or run <code>git pull</code> there), then press the reload arrow on Shelf at chrome://extensions. Your list stays.' : latest ? ', the newest version.' : '.') + '</p></div>';
  }
  function bookmarklet() {
    const app = location.origin + location.pathname;
    return "javascript:(function(){var d=document,q=function(s){var e=d.querySelector(s);return e?String(e.content||e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200):''};" +
      "var a='" + app.replace(/'/g, "%27") + "#log&u='+encodeURIComponent(location.href)+'&t='+encodeURIComponent(d.title)+'&o='+encodeURIComponent(q('meta[property=\"og:title\"]'))+'&h='+encodeURIComponent(q('h1'));" +
      "var w=window.open(a,'_blank');if(!w)location.href=a;})()";
  }
  function safariHTML() {
    return '<div class="card"><h2>Log chapters from Safari</h2><p>Safari cannot run the Chrome extension, so logging is one tap on a bookmark instead.</p>' +
      '<ol class="steps"><li>Copy the code: <button class="tog" id="bmCopy">Copy</button></li>' +
      '<li>In Safari, bookmark any page (Share, then <b>Add Bookmark</b>).</li>' +
      '<li>Open Bookmarks, tap <b>Edit</b>, tap that bookmark, name it <b>Log to Shelf</b>, and replace its address with the code.</li>' +
      '<li>On a chapter page, open Bookmarks and tap <b>Log to Shelf</b>. Shelf opens with the series and chapter filled in.</li></ol>' +
      '<textarea id="bmCode" readonly rows="3" aria-label="Bookmark code">' + esc(bookmarklet()) + '</textarea>' +
      '<p style="margin-top:10px">Use Shelf in Safari, where the bookmark opens it. If you also add it to your Home Screen (Share, then <b>Add to Home Screen</b>), connect GitHub there once too: it keeps its own copy.</p></div>';
  }
  function siteNamesHTML() {
    const by = new Map();
    all.forEach(function (e) {
      const l = TL.siteLabel(e);
      if (!l) return;
      const x = by.get(l) || { n: 0, hosts: new Set() };
      x.n++; if (e.site && e.site !== l) x.hosts.add(e.site);
      by.set(l, x);
    });
    const labels = Array.from(by.keys()).sort(function (a, b) { return by.get(b).n - by.get(a).n || a.localeCompare(b); });
    return '<div class="card" id="siteNames"><h2>Site names</h2><p>The names in the Site filter. Rename one and every series under it moves to the new name; type an existing name to merge two. Leave a box empty to go back to the site’s address.</p>' +
      (labels.length ? labels.map(function (l) {
        const x = by.get(l);
        return '<div class="sn"><input class="inline" data-sitename="' + esc(l) + '" value="' + esc(l) + '" aria-label="Name for ' + esc(l) + '"><span class="lbl">' + x.n + ' series' + (x.hosts.size ? ' · ' + esc(Array.from(x.hosts).slice(0, 3).join(', ')) : '') + '</span></div>';
      }).join('') : '<p>No sites yet. Save a chapter from a site and it appears here.</p>') + '</div>';
  }
  function focusHTML() {
    const f = settings.focus, end = TL.focusEnd(settings), manual = f.until > Date.now();
    const tracked = Object.keys(settings.sites || {}).filter(function (h) { return settings.sites[h] === 'on'; });
    return '<div class="card native"><h2>Focus blocker</h2><p>Blocks the sites below so they cannot pull you away. A blocked page offers a 5-minute pass, and YouTube Music stays open.</p>' +
      '<p><b style="color:var(--ink)">' + (end ? 'Blocking until ' + timeText(end) + '.' : f.pass > Date.now() ? 'On a 5-minute pass.' : 'Not blocking right now.') + '</b></p>' +
      '<div class="row"><span class="lbl">Focus now</span>' + [[30, '30 min'], [60, '1 hour'], [120, '2 hours']].map(function (o) { return '<button class="btn ghost" data-focus="' + o[0] + '">' + o[1] + '</button>'; }).join('') +
      (manual ? '<button class="btn danger" data-focus="0">Stop</button>' : '') + '</div>' +
      '<div style="margin-top:12px"><label><input type="checkbox" id="focusQuiet" class="inline" style="width:auto"' + (f.quiet !== false ? ' checked' : '') + '> Block during my quiet hours' + ((settings.quiet || []).length ? '' : ' (none set yet)') + '</label></div>' +
      '<div style="margin-top:6px"><label><input type="checkbox" id="focusTracked" class="inline" style="width:auto"' + (f.tracked !== false ? ' checked' : '') + '> Block the manga and anime sites I track' + (tracked.length ? ' (' + tracked.length + ')' : ' (none yet)') + '</label></div>' +
      '<div class="row" style="margin-top:10px"><span class="lbl">Also block</span>' + (f.sites || []).map(function (s) { return '<button class="tog" data-focus-del="' + esc(s) + '" title="Remove">' + esc(s) + ' ×</button>'; }).join('') +
      '<input class="inline" id="focusAdd" placeholder="add a site, e.g. tiktok.com" style="width:210px" aria-label="Add a site to block"></div></div>';
  }
  async function setFocus(patch, until) {
    settings.focus = Object.assign({}, settings.focus, patch || {}, until != null ? { until: until } : {});
    await send({ type: 'focus', until: until != null ? until : settings.focus.until, patch: patch || {} });
    render();
  }
  function malWriteHTML() {
    const m = settings.mal, st = settings.malState;
    let h = '<h3 style="margin-top:16px">Write back to MAL</h3>';
    if (malOn && m.clientId) {
      return h + '<p>Connected. When you watch an episode, or change a status or score, Shelf updates your MAL list.' +
        (st ? ' ' + (st.error ? esc(st.error) : 'Last update ' + timeText(st.at) + (st.pending > 0 ? ', ' + st.pending + ' waiting.' : '.')) : '') + '</p>' +
        '<label><input type="checkbox" id="malManga" class="inline" style="width:auto"' + (m.manga ? ' checked' : '') + '> Also update manga chapters on MAL (adds series to your MAL manga list)</label>' +
        '<div class="row" style="margin-top:8px"><button class="btn ghost" id="malSync">Send pending now</button><button class="btn danger" id="malOff">Disconnect</button></div>';
    }
    let redirect = '';
    try { redirect = chrome.identity.getRedirectURL(); } catch (e) { /* identity unavailable */ }
    return h + '<p>MAL only lets an app change your list with your own free API key. One-time setup:</p>' +
      '<ol class="steps"><li>Open <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">myanimelist.net/apiconfig</a> and choose “Create ID”.</li>' +
      '<li>Set App Type to <b>other</b>. For App Redirect URL paste this: <code id="malRedirect">' + esc(redirect) + '</code> <button class="tog" id="malCopy">Copy</button></li>' +
      '<li>Fill the other boxes with anything reasonable, submit, then copy the <b>Client ID</b> it gives you.</li></ol>' +
      '<div class="row"><input class="inline" id="malClient" value="' + esc(m.clientId || '') + '" placeholder="MAL Client ID" aria-label="MAL Client ID" style="width:260px"><button class="btn" id="malConnect"' + (busy ? ' disabled' : '') + '>Connect</button></div>' +
      '<div class="msg' + (msgs.malw && msgs.malw.bad ? ' bad' : '') + '">' + esc(msgs.malw ? msgs.malw.text : '') + '</div>';
  }
  function mutedHTML() {
    const sites = settings.mutedSites || [], n = all.filter(function (e) { return e.muted; }).length;
    if (!sites.length && !n) return '';
    return '<div class="row" style="margin-bottom:10px"><span class="lbl">Muted</span>' +
      sites.map(function (l) { return '<button class="tog" aria-pressed="true" data-unmute-site="' + esc(l) + '" title="Unmute">' + esc(l) + ' ×</button>'; }).join('') +
      (n ? '<button class="tog" aria-pressed="true" id="unmuteSeries" title="Unmute all series">' + n + ' series ×</button>' : '') + '</div>';
  }
  function renderSettings() {
    const missing = all.filter(function (e) { return !e.image; }).length;
    const sites = Object.keys(settings.sites || {}).sort();
    $('#main').innerHTML = '<div class="set">' +
      githubHTML() + (IS_WEB ? safariHTML() : versionHTML()) + siteNamesHTML() +

      '<div class="card native"><h2>MyAnimeList</h2><p>Pulls a public list into Shelf. Anything you have updated here more recently than on MAL is kept.</p>' +
      '<div class="row"><input class="inline" id="malUser" value="' + esc(settings.malUser || '') + '" placeholder="MAL username" aria-label="MAL username" style="width:180px">' +
      '<button class="btn" data-mal="anime"' + (busy ? ' disabled' : '') + '>Import anime</button><button class="btn ghost" data-mal="manga"' + (busy ? ' disabled' : '') + '>Import manga</button></div><div class="msg' + (msgs.mal && msgs.mal.bad ? ' bad' : '') + '" id="malMsg">' + esc(msgs.mal ? msgs.mal.text : '') + '</div>' + malWriteHTML() + '</div>' +

      '<div class="card native"><h2>Auto-update</h2><p>On sites you track, Shelf saves the chapter or episode by itself after you have been on the page for a moment. Anywhere else it asks first.</p>' +
      '<label><input type="checkbox" id="auto" class="inline" style="width:auto"' + (settings.auto ? ' checked' : '') + '> Save automatically on tracked sites</label>' +
      '<div class="row" style="margin-top:8px"><label for="delay">Wait</label><input id="delay" class="inline" style="width:70px" inputmode="numeric" value="' + esc(settings.delay) + '"><span>seconds before saving</span></div></div>' +

      '<div class="card native"><h2>New chapters and episodes</h2><p>Every few hours, while Chrome is open, Shelf reads each series\u2019 page for chapters or episodes newer than yours, and sends a notification when one is out. Click the notification to open that chapter. Where a site will not let Shelf look, it goes by the series\u2019 usual release gap, learned from the site\u2019s chapter dates or from when you read it, and tells you when the next one is probably out. Chapters that are still paid or on a wait timer are held back until they are free. It can only check a series after you have saved it from a site at least once.</p>' +
      '<label><input type="checkbox" id="notify" class="inline" style="width:auto"' + (settings.notify !== false ? ' checked' : '') + '> Check for new releases and notify me</label>' +
      '<p style="margin-top:8px">' + (TL.isMuted(settings) ? muteText() + '. New releases are still tagged in your list.' : 'Use the bell at the top to mute notifications for a while, or set quiet hours below.') + '</p>' +
      mutedHTML() +
      '<div class="row" style="margin-top:8px"><button class="btn ghost" id="checkBtn">Check now</button><span class="msg" style="margin:0">' +
      (settings.lastCheck ? 'Last check ' + new Date(settings.lastCheck.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ': ' + settings.lastCheck.checked + ' checked, ' + settings.lastCheck.found + ' new' + (settings.lastCheck.failed ? ', ' + settings.lastCheck.failed + ' could not be read' : '') + '.' : 'Not checked yet.') + '</span></div></div>' +

      '<div class="card"><h2>Quiet hours</h2><p>Notifications mute themselves during these hours, for example school or a shift. Anything that comes out meanwhile is tagged New, and you get one summary afterwards.</p>' +
      (settings.quiet || []).map(function (q, i) {
        return '<div class="quiet"><div class="days" role="group" aria-label="Days">' + DAYS.map(function (d, k) {
          return '<button class="day" data-qd="' + i + ':' + k + '" aria-pressed="' + ((q.days || []).indexOf(k) >= 0) + '" aria-label="' + d + '">' + d.charAt(0) + '</button>'; }).join('') + '</div>' +
          '<input type="time" class="inline" data-qf="' + i + '" value="' + esc(q.from || '') + '" aria-label="From"><span>to</span><input type="time" class="inline" data-qt="' + i + '" value="' + esc(q.to || '') + '" aria-label="To">' +
          '<button class="del" data-qdel="' + i + '">Remove</button></div>';
      }).join('') +
      '<div class="row" style="margin-top:10px"><button class="btn ghost" id="quietAdd">+ Add quiet hours</button></div></div>' +

      focusHTML() +

      '<div class="card native"><h2>Cover art</h2><p>Covers are looked up on AniList, a public catalogue, by each series\u2019 AniList or MyAnimeList number. Anything still missing is searched by title on Comick, then on AniList. ' + missing + ' of ' + all.length + ' series have no cover yet.</p>' +
      '<label><input type="checkbox" id="covers" class="inline" style="width:auto"' + (settings.covers !== false ? ' checked' : '') + '> Show covers in the list</label>' +
      '<div class="row" style="margin-top:8px"><button class="btn ghost" id="coversBtn"' + (settings.covers === false ? ' disabled' : '') + '>Fetch missing covers</button><span class="msg" style="margin:0">' +
      (settings.lastCovers ? (settings.lastCovers.error ? esc(settings.lastCovers.error) + ' ' : '') + 'Last run added ' + settings.lastCovers.got + '.' : '') + '</span></div></div>' +

      '<div class="card native"><h2>Sites</h2><p>A site starts being tracked the first time you save something from it. Search engines, video and social sites are ignored unless you turn them on from the popup.</p>' +
      (sites.length ? '<div class="sites">' + sites.map(function (h) {
        return '<span>' + esc(h) + '</span><select data-site="' + esc(h) + '"><option value="on"' + (settings.sites[h] === 'on' ? ' selected' : '') + '>Track</option><option value="off"' + (settings.sites[h] === 'off' ? ' selected' : '') + '>Never</option><option value="">Forget</option></select>';
      }).join('') + '</div>' : '<p>No sites yet.</p>') + '</div>' +

      '<div class="card"><h2>Backup and import</h2><p>' + (ghOn ? 'Your list is also kept on GitHub. A backup file is a second copy you control.' : 'Your list lives in this browser only. Export a backup now and then.') + ' Import accepts a Shelf backup, a CSV or JSON export from another tracker, or a MyAnimeList XML export.</p>' +
      '<div class="row"><button class="btn" id="exportBtn">Export backup</button><select id="impKind" class="inline" aria-label="Treat imported rows as"><option value="manga">Import as manga</option><option value="anime">Import as anime</option></select>' +
      '<button class="btn ghost" id="importBtn">Import a file…</button><input type="file" id="file" accept=".json,.csv,.xml,.txt" hidden></div><div class="msg' + (msgs.imp && msgs.imp.bad ? ' bad' : '') + '" id="impMsg">' + esc(msgs.imp ? msgs.imp.text : '') + '</div>' +
      '<div class="row native" style="margin-top:14px"><button class="btn danger" id="resetBtn">Reset to the original lists</button></div></div></div>';
  }

  async function settingsClick(t) {
    if (t.dataset.mal) {
      const kind = t.dataset.mal, user = $('#malUser').value;
      msgs.mal = { text: 'Importing from MyAnimeList…' }; busy = true; render();
      const res = await send({ type: 'malImport', user: user, kind: kind });
      busy = false;
      msgs.mal = res.ok ? { text: 'Done: ' + res.total + ' ' + kind + ' on MAL, ' + res.added + ' added, ' + res.updated + ' updated.' }
        : { text: res.error || 'The import did not finish. Try again.', bad: true };
      if (state.view === 'settings') render();
    } else if (t.id === 'exportBtn') {
      const blob = new Blob([JSON.stringify({ app: 'shelf', version: 1, exportedAt: new Date().toISOString(), entries: all }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'shelf-backup-' + TL.today() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    } else if (t.id === 'importBtn') $('#file').click();
    else if (t.dataset.focus != null) { const m = Number(t.dataset.focus); await setFocus({}, m ? Date.now() + m * 6e4 : 0); toast(m ? 'Blocking until ' + timeText(settings.focus.until) : 'Focus session stopped'); }
    else if (t.dataset.focusDel != null) await setFocus({ sites: (settings.focus.sites || []).filter(function (s) { return s !== t.dataset.focusDel; }) });
    else if (t.id === 'malCopy') { try { await navigator.clipboard.writeText($('#malRedirect').textContent); toast('Copied'); } catch (e) { toast('Select the address and copy it by hand.'); } }
    else if (t.id === 'malConnect') {
      const id = $('#malClient').value.trim();
      msgs.malw = { text: 'Waiting for the MyAnimeList sign-in window…' }; busy = true; render();
      const res = await send({ type: 'malConnect', clientId: id });
      busy = false;
      msgs.malw = res.ok ? { text: '' } : { text: res.error || 'The sign-in did not finish.', bad: true };
      if (res.ok) toast('Connected to MyAnimeList');
      render();
    }
    else if (t.id === 'ghConnect') {
      const repo = $('#ghRepo') ? $('#ghRepo').value : (settings.gh ? settings.gh.owner + '/' + settings.gh.repo : ''), token = $('#ghToken').value;
      if ($('#ghRepo')) msgs.ghRepo = repo; // keep what was typed if this attempt fails
      msgs.gh = { text: 'Connecting to GitHub…' }; busy = true; render();
      const res = await send({ type: 'ghConnect', repo: repo, token: token });
      busy = false;
      if (res && res.ok) { msgs.gh = res.private ? null : { text: 'Connected, but that repo is public: anyone can see your list. Make it private in its Settings on GitHub.', bad: true }; msgs.retoken = false; toast('Connected to GitHub' + (res.got ? ': ' + res.got + ' series updated' : '')); }
      else msgs.gh = { text: (res && res.error) || 'Could not connect. Try again.', bad: true };
      render();
    }
    else if (t.id === 'ghSync') { t.disabled = true; const res = await send({ type: 'ghSync' }); toast(res && res.ok ? (res.got ? 'Synced: ' + res.got + ' series updated' : 'Synced') : (res && res.error) || 'Sync did not finish. Try again.'); render(); }
    else if (t.id === 'ghRetoken') { msgs.retoken = true; render(); }
    else if (t.id === 'ghOff') {
      if (!t.dataset.sure) { t.dataset.sure = '1'; t.textContent = 'Click again to disconnect'; return; }
      await send({ type: 'ghDisconnect' }); msgs.gh = null; toast('Disconnected. Your list stays on this device and on GitHub.'); render();
    }
    else if (t.id === 'bmCopy') { try { await navigator.clipboard.writeText(bookmarklet()); toast('Copied'); } catch (e) { const b = $('#bmCode'); b.focus(); b.select(); toast('Select the code and copy it.'); } }
    else if (t.id === 'malSync') { await send({ type: 'malSync' }); toast('Sending to MyAnimeList'); }
    else if (t.id === 'malOff') { await send({ type: 'malDisconnect' }); toast('Disconnected from MyAnimeList'); }
    else if (t.id === 'quietAdd') await saveQuiet((settings.quiet || []).concat([{ days: [1, 2, 3, 4, 5], from: '08:00', to: '15:30' }]));
    else if (t.dataset.qdel != null) await saveQuiet((settings.quiet || []).filter(function (q, i) { return i !== Number(t.dataset.qdel); }));
    else if (t.dataset.qd) {
      const p = t.dataset.qd.split(':').map(Number);
      await saveQuiet((settings.quiet || []).map(function (q, i) {
        if (i !== p[0]) return q;
        const d = q.days || [];
        return Object.assign({}, q, { days: d.indexOf(p[1]) >= 0 ? d.filter(function (x) { return x !== p[1]; }) : d.concat([p[1]]).sort() });
      }));
    }
    else if (t.dataset.unmuteSite != null) await toggleSiteMute(t.dataset.unmuteSite);
    else if (t.id === 'unmuteSeries') {
      for (const e of all.filter(function (x) { return x.muted; })) await send({ type: 'patch', id: e.id, patch: { muted: false }, touch: false });
      toast('All series alerts are back on');
    }
    else if (t.id === 'coversBtn') { await send({ type: 'covers' }); toast('Fetching covers in the background. They appear as they arrive.'); }
    else if (t.id === 'checkBtn') { await send({ type: 'checkNow' }); toast('Checking in the background. This can take a minute.'); }
    else if (t.id === 'resetBtn') {
      if (!t.dataset.sure) { t.dataset.sure = '1'; t.textContent = 'Click again: this replaces everything'; return; }
      t.disabled = true; t.textContent = 'Resetting…';
      await send({ type: 'reset' });
      await load(); render(); toast('Back to the original lists');
    }
  }

  function parseFile(name, text, kind) {
    const isXml = /\.xml$/i.test(name) || /^\s*<\?xml|^\s*<myanimelist/i.test(text);
    if (isXml) {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      const g = function (n, tag) { const x = n.getElementsByTagName(tag)[0]; return x ? x.textContent.trim() : ''; };
      const out = [];
      Array.prototype.forEach.call(doc.getElementsByTagName('anime'), function (n) {
        const id = Number(g(n, 'series_animedb_id'));
        out.push({ kind: 'anime', malId: id || null, title: g(n, 'series_title'), alt: [], progress: Number(g(n, 'my_watched_episodes')) || 0, total: Number(g(n, 'series_episodes')) || null,
          status: TL.statusFrom(g(n, 'my_status')), score: Number(g(n, 'my_score')) || 0, origin: g(n, 'series_type'), links: id ? { mal: 'https://myanimelist.net/anime/' + id } : {}, updatedAt: Date.now() });
      });
      Array.prototype.forEach.call(doc.getElementsByTagName('manga'), function (n) {
        const id = Number(g(n, 'manga_mangadb_id'));
        out.push({ kind: 'manga', malId: id || null, title: g(n, 'manga_title'), alt: [], progress: Number(g(n, 'my_read_chapters')) || 0, total: Number(g(n, 'manga_chapters')) || null,
          status: TL.statusFrom(g(n, 'my_status')), score: Number(g(n, 'my_score')) || 0, origin: 'Manga', links: id ? { mal: 'https://myanimelist.net/manga/' + id } : {}, updatedAt: Date.now() });
      });
      return { items: out.filter(function (e) { return e.title; }), backup: false };
    }
    let rows, backup = false;
    if (/^\s*[\[{]/.test(text)) {
      const j = JSON.parse(text);
      backup = !!(j && j.app === 'shelf');
      rows = Array.isArray(j) ? j : (j.entries || j.data || j.list || j.comics || []);
    } else rows = TL.parseCSV(text);
    return { items: rows.map(function (o) { return TL.rowToEntry(o, kind); }).filter(Boolean), backup: backup };
  }
  async function settingsChange(el) {
    if (el.id === 'ghRepo') { msgs.ghRepo = el.value; return; } // used by Connect
    if (el.id === 'ghToken') return;
    if (el.id === 'auto') await send({ type: 'settings', patch: { auto: el.checked } });
    else if (el.id === 'notify') await send({ type: 'settings', patch: { notify: el.checked } });
    else if (el.dataset.sitename != null) {
      const from = el.dataset.sitename, to = el.value.trim();
      if (from === to) return;
      const res = await send({ type: 'renameSite', from: from, to: to });
      ['manga', 'anime'].forEach(function (k) { if (state.site[k] === from) state.site[k] = to || 'all'; });
      toast(res && res.ok ? (to ? 'Renamed to ' + to : 'Name cleared') + ' (' + res.n + ' series)' : 'That did not save. Try again.');
      render();
    }
    else if (el.id === 'focusQuiet') await setFocus({ quiet: el.checked });
    else if (el.id === 'focusTracked') await setFocus({ tracked: el.checked });
    else if (el.id === 'focusAdd') {
      const h = TL.hostOf(/^https?:/.test(el.value.trim()) ? el.value.trim() : 'https://' + el.value.trim());
      el.blur();
      if (!h || h.indexOf('.') < 0) { toast('Type a site like tiktok.com'); return; }
      await setFocus({ sites: (settings.focus.sites || []).filter(function (s) { return s !== h; }).concat([h]) });
    }
    else if (el.id === 'malManga') await send({ type: 'settings', patch: { mal: Object.assign({}, settings.mal, { manga: el.checked }) } });
    else if (el.id === 'covers') { settings.covers = el.checked; await send({ type: 'settings', patch: { covers: el.checked } }); }
    else if (el.dataset.qf != null || el.dataset.qt != null) {
      const from = el.dataset.qf != null, idx = Number(from ? el.dataset.qf : el.dataset.qt);
      if (!/^\d{2}:\d{2}$/.test(el.value)) return;
      el.blur();
      await saveQuiet((settings.quiet || []).map(function (q, i) { return i === idx ? Object.assign({}, q, from ? { from: el.value } : { to: el.value }) : q; }));
    }
    else if (el.id === 'delay') { const n = Math.min(120, Math.max(3, parseInt(el.value, 10) || 15)); el.value = n; await send({ type: 'settings', patch: { delay: n } }); }
    else if (el.id === 'malUser') await send({ type: 'settings', patch: { malUser: el.value.trim() } });
    else if (el.dataset.site != null) await send({ type: 'site', host: el.dataset.site, value: el.value || null });
    else if (el.id === 'file' && el.files[0]) {
      const f = el.files[0], kind = $('#impKind').value;
      try {
        const p = parseFile(f.name, await f.text(), kind);
        if (!p.items.length) throw new Error('none');
        const res = await send({ type: 'bulk', items: p.items, overwrite: p.backup });
        if (!res.ok) throw new Error('save');
        msgs.imp = { text: 'Read ' + p.items.length + ' rows from ' + f.name + ': ' + res.added + ' added, ' + res.updated + ' updated.' };
      } catch (e) { msgs.imp = { text: 'That file could not be read as a list. It needs at least a title column.', bad: true }; }
      if (state.view === 'settings') render();
    }
  }

  /* ---------- this page (popup only) ---------- */

  let page = null; // { tabId, det, host, url, pageTitle }
  async function loadPage() {
    if (IS_WEB && /^#log&/.test(location.hash)) { // opened by the Safari bookmark on a chapter page
      const q = new URLSearchParams(location.hash.slice(5)), url = q.get('u') || '';
      if (!/^https?:\/\//.test(url)) return;
      const t = q.get('t') || '', det = TL.detect({ url: url, title: t, og: q.get('o') || '', h1: q.get('h') ? [q.get('h')] : [], dom: null, media: {} });
      page = { tabId: null, det: det, host: TL.hostOf(url), url: url, pageTitle: TL.clean(t.split(/\s+[|\-–—]\s+/)[0] || ''), manual: !det };
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* keep the hash */ }
      return;
    }
    if (!isPopup) return;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || tabs[0].id == null) return;
      const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'getDetection' });
      if (res) page = Object.assign({ tabId: tabs[0].id }, res);
    } catch (e) { page = null; } // browser pages and the web store cannot be read
  }
  function renderNow() {
    const box = $('#now');
    if (!page || !page.host) { box.hidden = true; return; }
    if (IS_WEB && page.back) { // saved from the Safari bookmark
      box.innerHTML = '<div class="lbl">Saved</div><div class="row" style="margin-top:8px"><a class="btn" href="' + esc(page.back) + '">Back to the chapter</a><button class="btn ghost" id="nowDone">Stay here</button></div>';
      box.hidden = false; return;
    }
    const det = page.det, site = TL.siteState(settings, page.host);
    const kind = (page.form && page.form.kind) || (det ? det.kind : (state.view === 'anime' ? 'anime' : 'manga'));
    const title = page.form ? page.form.title : (det ? det.title : page.pageTitle || '');
    const num = page.form ? page.form.num : (det ? det.number : '');
    const m = title ? TL.bestMatch(all, kind, det && !page.form ? det.candidates : [title]) : null;
    const hit = m && m.score >= 0.85 ? m.entry : null;
    const u = WORD[kind].unit;
    const showForm = det || page.manual;
    let h = '<div class="lbl">This page</div>';
    if (!showForm) h += '<div class="sub">No chapter or episode spotted here.</div><div class="row" style="margin-top:8px"><button class="btn ghost" id="manual">Log this page anyway</button></div>';
    else {
      h += '<div class="hit">' + (hit ? esc(hit.title) : esc(title || 'Untitled')) + '</div><div class="sub">' +
        (hit ? 'On your list at ' + u + ' ' + fmt(hit.progress) + (hit.total ? ' of ' + hit.total : '') : 'Not on your list yet') + '</div>' +
        '<form id="nowForm"><input id="nTitle" class="full" value="' + esc(title) + '" list="cands" aria-label="Title" placeholder="Title">' +
        '<datalist id="cands">' + ((det && det.candidates) || []).map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
        '<select id="nKind" aria-label="Type"><option value="manga"' + (kind === 'manga' ? ' selected' : '') + '>Manga / manhwa</option><option value="anime"' + (kind === 'anime' ? ' selected' : '') + '>Anime</option></select>' +
        '<input id="nNum" inputmode="decimal" value="' + esc(num) + '" aria-label="' + u + '" placeholder="' + u + '">' +
        (hit ? '' : '<input id="nLink" class="full" list="titles" placeholder="Or link to one already on your list…" aria-label="Link to an existing series">') +
        '<button class="btn full">' + (hit ? 'Set to ' + u + ' ' + (num === '' ? '…' : num) : 'Add to my list') + '</button></form>';
    }
    h += '<div class="site"><span>On ' + esc(page.host) + '</span><select id="nSite" aria-label="Tracking on this site">' +
      '<option value="on"' + (site === 'on' ? ' selected' : '') + '>Track automatically</option><option value=""' + (site === 'new' ? ' selected' : '') + '>Ask first</option><option value="off"' + (site === 'off' ? ' selected' : '') + '>Never</option></select></div>';
    box.innerHTML = h; box.hidden = false;
    const dl = $('#titles');
    if (!hit && showForm) dl.innerHTML = all.filter(function (e) { return e.kind === kind; }).map(function (e) { return '<option value="' + esc(e.title) + '">'; }).join('');
  }
  const readForm = function () { return { title: $('#nTitle').value, kind: $('#nKind').value, num: $('#nNum').value }; };
  $('#now').addEventListener('click', function (ev) { if (ev.target.id === 'nowDone') { page = null; renderNow(); return; } if (ev.target.id === 'manual') { page.manual = true; renderNow(); const t = $('#nTitle'); if (t) t.focus(); } });
  $('#now').addEventListener('change', async function (ev) {
    const el = ev.target;
    if (el.id === 'nSite') {
      await send({ type: 'site', host: page.host, value: el.value || null });
      chrome.tabs.sendMessage(page.tabId, { type: 'refresh' }).catch(function () {});
      toast(el.value === 'on' ? 'Tracking ' + page.host : el.value === 'off' ? 'Ignoring ' + page.host : 'Will ask on ' + page.host);
    } else if (el.id === 'nTitle' || el.id === 'nKind' || el.id === 'nNum') { page.form = readForm(); renderNow(); }
  });
  $('#now').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    const f = readForm(), title = f.title.trim(), n = parseFloat(f.num);
    if (!title) { toast('Give it a title first.'); return; }
    if (isNaN(n) || n < 0) { toast('Enter the ' + (f.kind === 'anime' ? 'episode' : 'chapter') + ' number.'); return; }
    const linkEl = $('#nLink'), linkName = linkEl ? linkEl.value.trim() : '';
    let target = null;
    if (linkName) {
      target = all.find(function (e) { return e.kind === f.kind && e.title === linkName; });
      if (!target) { toast('Pick a series from the suggestions, or clear that box.'); return; }
    } else {
      const m = TL.bestMatch(all, f.kind, page.det && !page.form ? page.det.candidates : [title]);
      if (m && m.score >= 0.85) target = m.entry;
    }
    const ctx = { url: page.url, host: page.host, tabId: page.tabId, links: page.det && page.det.number === n ? page.det.links : null };
    const res = target ? await send(Object.assign({ type: 'apply', id: target.id, number: n, altTitle: title }, ctx))
      : await send(Object.assign({ type: 'add', fields: { kind: f.kind, title: title, number: n } }, ctx));
    if (!res.ok) { toast(res.error || 'That was not saved. Try again.'); return; }
    chrome.tabs.sendMessage(page.tabId, { type: 'refresh' }).catch(function () {});
    page.form = null; page.manual = false; page.det = { kind: f.kind, number: n, title: res.entry.title, candidates: [res.entry.title] };
    state.view = f.kind; state.status[f.kind] = res.entry.status;
    toast(res.entry.title + ': ' + WORD[f.kind].unit + ' ' + n + ' saved');
    if (IS_WEB) page.back = page.url;
    render();
  });

  /* ---------- shell ---------- */

  function renderNotice() {
    const n = settings.notice, box = $('#notice');
    if (!n || !n.lines || !n.lines.length) { box.hidden = true; return; }
    box.className = n.error ? 'err' : '';
    box.innerHTML = '<div>' + n.lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</div><button class="btn ghost" id="noticeOk">OK</button>';
    box.hidden = false;
  }
  $('#notice').addEventListener('click', function (ev) { if (ev.target.id === 'noticeOk') send({ type: 'settings', patch: { notice: null } }); });

  /* ---------- mute ---------- */

  const BELL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 7H4c0-1 2-2 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/>';
  function muteText() {
    const m = settings.muteUntil, end = TL.muteEnd(settings);
    if (end === -1) return 'Muted until you turn it back on';
    const d = new Date(end), same = d.toDateString() === new Date().toDateString();
    return (m > Date.now() ? 'Muted until ' : 'Quiet hours until ') + d.toLocaleString([], same ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function renderBell() {
    const muted = TL.isMuted(settings), b = $('#bell');
    b.innerHTML = BELL + (muted ? '<path d="M3 3l18 18"/>' : '') + '</svg>';
    b.classList.toggle('on', muted);
    b.title = muted ? muteText() : 'Mute notifications';
    b.setAttribute('aria-label', b.title);
    const menu = $('#muteMenu');
    if (menu.hidden) return;
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(7, 0, 0, 0);
    menu.innerHTML = '<div class="lbl">' + (muted ? esc(muteText()) : 'Mute notifications') + '</div>' +
      (muted ? '<button data-mute="0">Unmute now</button>' : '') +
      [['For 1 hour', 36e5], ['For 3 hours', 3 * 36e5], ['For 8 hours', 8 * 36e5]].map(function (o) { return '<button data-mute="' + (Date.now() + o[1]) + '">' + o[0] + '</button>'; }).join('') +
      '<button data-mute="' + tomorrow.getTime() + '">Until tomorrow morning</button><button data-mute="-1">Until I turn it back on</button><button data-quiet="1">Set quiet hours…</button>' +
      (settings.focus.until > Date.now() ? '<button data-focusm="0">Stop blocking sites (until ' + esc(timeText(settings.focus.until)) + ')</button>' : '<button data-focusm="60">Block manga and YouTube for 1 hour</button>');
  }
  $('#bell').addEventListener('click', function (ev) { ev.stopPropagation(); $('#muteMenu').hidden = !$('#muteMenu').hidden; renderBell(); });
  $('#muteMenu').addEventListener('click', async function (ev) {
    const fm = ev.target.closest('button[data-focusm]');
    if (fm) { $('#muteMenu').hidden = true; const m = Number(fm.dataset.focusm); await setFocus({}, m ? Date.now() + m * 6e4 : 0); toast(m ? 'Blocking until ' + timeText(settings.focus.until) : 'Blocking stopped'); return; }
    if (ev.target.closest('button[data-quiet]')) {
      $('#muteMenu').hidden = true;
      if (isPopup) { chrome.tabs.create({ url: chrome.runtime.getURL('app.html#settings') }); window.close(); return; }
      state.view = 'settings'; render(); return;
    }
    const b = ev.target.closest('button[data-mute]'); if (!b) return;
    const until = Number(b.dataset.mute);
    $('#muteMenu').hidden = true;
    if (!until) settings.quietSkip = TL.quietEnd(settings) || 0;
    settings.muteUntil = until; renderBell();
    const res = await send({ type: 'mute', until: until });
    toast(!res.ok ? 'That did not save. Try again.' : until ? muteText() : 'Notifications are back on');
  });
  document.addEventListener('click', function (ev) { if (!ev.target.closest('#muteMenu')) { $('#muteMenu').hidden = true; } });

  function render() {
    renderBell();
    document.querySelectorAll('#tabs button').forEach(function (b) { b.setAttribute('aria-current', String(b.dataset.view === state.view)); });
    renderNotice();
    if (state.view === 'stats') $('#main').innerHTML = recapHTML() + statsFor('manga') + statsFor('anime');
    else if (state.view === 'settings') renderSettings();
    else renderList();
    renderNow();
  }
  $('#tabs').addEventListener('click', function (ev) {
    const b = ev.target.closest('button[data-view]'); if (!b) return;
    if (b.dataset.view === 'settings' && isPopup) { chrome.tabs.create({ url: chrome.runtime.getURL('app.html#settings') }); window.close(); return; }
    state.view = b.dataset.view; state.shown = 60; state.open = null; state.q = '';
    saveView(); render(); window.scrollTo(0, 0);
  });
  $('#expand').addEventListener('click', function () { chrome.tabs.create({ url: chrome.runtime.getURL('app.html') }); window.close(); });

  (async function () {
    await Promise.all([load(), loadPage()]);
    if (page && page.det) state.view = page.det.kind;
    if (IS_WEB && !ghOn && !page) state.view = 'settings'; // first visit: connect GitHub
    if (wantNew) { const k = all.some(function (e) { return e.kind === 'manga' && isNew(e); }) ? 'manga' : 'anime'; state.view = k; state.status[k] = 'new'; state.site[k] = 'all'; }
    render();
  })();
})();
