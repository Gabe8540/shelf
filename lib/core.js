/* Shelf core: title matching, chapter/episode detection, import helpers.
   Pure functions, shared by the background worker, the content script and the tracker page. */
(function (root) {
  'use strict';
  const TL = {};

  TL.DEFAULTS = { auto: true, delay: 15, malUser: '', sites: {}, siteNames: {}, gh: null, notice: null, notify: true, lastCheck: null, muteUntil: 0, missed: 0,
    quiet: [], quietSkip: 0, mutedSites: [], covers: true,
    focus: { quiet: true, tracked: true, sites: ['youtube.com'], until: 0, pass: 0 }, recapAt: 0, mal: { clientId: '', on: true, manga: false } };

  // Sites where "Episode 5" in a title is almost never something being watched/read.
  TL.DEFAULT_OFF = /(^|\.)(google\.[a-z.]+|youtube\.com|reddit\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|tiktok\.com|wikipedia\.org|fandom\.com|myanimelist\.net|anilist\.co|mangaupdates\.com|discord\.com|twitch\.tv|amazon\.[a-z.]+|bing\.com|duckduckgo\.com|github\.com|claude\.ai|imdb\.com)$/i;

  TL.hostOf = function (url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
  };
  TL.siteState = function (settings, host) {
    const s = settings && settings.sites && settings.sites[host];
    return s || (TL.DEFAULT_OFF.test(host) ? 'off' : 'new');
  };
  TL.today = function () {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  TL.newId = function (kind) {
    return (kind === 'anime' ? 'a' : 'm') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  };

  /* ---------- title normalisation and matching ---------- */

  const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
  TL.norm = function (s) {
    let t = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ').replace(/['’‘`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    // "2nd Season", "Season 2", "Season II", "S2" and a trailing "II" all become a bare "2"
    t = t.replace(/\b(\d+)(?:st|nd|rd|th) season\b/g, '$1')
      .replace(/\bseason (\d+)\b/g, '$1')
      .replace(/\bseason (ii|iii|iv|v|vi)\b/g, function (m, r) { return ROMAN[r]; })
      .replace(/\bs(\d{1,2})\b/g, '$1')
      .replace(/ (ii|iii|iv|vi)$/, function (m, r) { return ' ' + ROMAN[r]; });
    t = t.replace(/\s+/g, ' ').trim();
    return t.replace(/^(.*\D) 1$/, '$1'); // "Title Season 1" is just "Title"
  };

  function bigrams(s) {
    const m = new Map(), t = ' ' + s + ' ';
    for (let i = 0; i < t.length - 1; i++) { const g = t.substr(i, 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  }
  const nums = function (s) { return (s.match(/\b\d+\b/g) || []).join(','); };

  function dice(a, ga, da, b, gb, db) {
    let inter = 0;
    const small = ga.size <= gb.size ? ga : gb, big = small === ga ? gb : ga;
    small.forEach(function (c, g) { const x = big.get(g); if (x) inter += Math.min(x, c); });
    let score = 2 * inter / (a.length + b.length + 2);
    if (da !== db) score *= 0.6; // "Season 2" must never match "Season 3"
    return Math.min(score, 0.98);
  }
  // Similarity of two already-normalised strings, 0..1
  TL.simNorm = function (a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    return dice(a, bigrams(a), nums(a), b, bigrams(b), nums(b));
  };

  // Per-entry cache of normalised names; the letter-pair tables are built only when a fuzzy compare needs them.
  const normCache = new WeakMap();
  function namesOf(e) {
    let r = normCache.get(e);
    if (!r) {
      const n = [TL.norm(e.title)].concat((e.alt || []).map(TL.norm)).filter(Boolean);
      r = { n: n, g: new Array(n.length), d: new Array(n.length) };
      normCache.set(e, r);
    }
    return r;
  }
  TL.searchKey = function (e) { return namesOf(e).n; };

  // Exact-title lookup table: "kind|normalised title" -> { e: entry, s: 1 (main title) or 0.99 (alt title) }
  TL.makeIndex = function (entries) {
    const ix = new Map();
    for (const e of entries) {
      const n = namesOf(e).n;
      for (let i = 0; i < n.length; i++) {
        const k = e.kind + '|' + n[i], cur = ix.get(k);
        if (!cur || (i === 0 && cur.s < 1)) ix.set(k, { e: e, s: i === 0 ? 1 : 0.99 });
      }
    }
    return ix;
  };

  // Best entry of this kind for one title. Exact title = 1, exact alt title = 0.99, else fuzzy.
  // `floor` lets a caller skip anything that cannot beat a score it already has.
  TL.findMatch = function (entries, kind, title, floor) {
    const q = TL.norm(title);
    if (!q) return null;
    const lq = q.length;
    let gq = null, dq = null, best = null, bs = floor || 0;
    for (const e of entries) {
      if (e.kind !== kind) continue;
      const r = namesOf(e), names = r.n;
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        let s;
        if (n === q) s = i === 0 ? 1 : 0.99;
        else {
          const ln = n.length;
          if (lq < 5 || ln < 5) continue;
          // the most two strings of these lengths could ever score; skip the real compare if that cannot win
          if (2 * (Math.min(lq, ln) + 1) / (lq + ln + 2) <= bs) continue;
          if (!gq) { gq = bigrams(q); dq = nums(q); }
          if (!r.g[i]) { r.g[i] = bigrams(n); r.d[i] = nums(n); }
          s = dice(q, gq, dq, n, r.g[i], r.d[i]);
        }
        if (s > bs) { bs = s; best = e; }
      }
      if (bs === 1) break;
    }
    return best ? { entry: best, score: bs } : null;
  };

  // Try every candidate title a page offered; return the strongest match.
  // With an index, exact hits are found without scanning the list at all.
  TL.bestMatch = function (entries, kind, titles, index) {
    titles = titles || [];
    let best = null;
    if (index) {
      for (const t of titles) {
        const h = index.get(kind + '|' + TL.norm(t));
        if (h && (!best || h.s > best.score)) { best = { entry: h.e, score: h.s, via: t }; if (h.s === 1) return best; }
      }
      if (best) return best;
    }
    for (const t of titles) {
      const m = TL.findMatch(entries, kind, t, best ? best.score : 0.5);
      if (m && (!best || m.score > best.score)) { best = m; best.via = t; }
      if (best && best.score === 1) break;
    }
    return best;
  };

  /* ---------- interest: how much a series is being read lately ---------- */

  const DAY = 864e5;
  TL.dayNum = function (ts) { const d = new Date(ts == null ? Date.now() : ts); return Math.floor((d.getTime() - d.getTimezoneOffset() * 6e4) / DAY); };
  // Reading log: [[dayNumber, chaptersThatDay], ...], newest last, at most 90 days of entries.
  TL.logRead = function (log, count, day) {
    day = day == null ? TL.dayNum() : day;
    const out = (log || []).filter(function (x) { return day - x[0] <= 180; }).map(function (x) { return [x[0], x[1]]; });
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1] = Math.round((last[1] + count) * 10) / 10; else out.push([day, count]);
    return out.slice(-90);
  };
  TL.readIn = function (e, days, day) {
    day = day == null ? TL.dayNum() : day;
    let n = 0;
    for (const x of e.log || []) if (day - x[0] < days) n += x[1];
    return Math.round(n * 10) / 10;
  };
  // Chapters read through Shelf, each one fading by half every 3 weeks; plus a small head start from
  // "last read" and chapter count for series that came in from an import and have no log yet.
  TL.interest = function (e, day) {
    day = day == null ? TL.dayNum() : day;
    let s = 0;
    for (const x of e.log || []) s += x[1] * Math.pow(0.5, (day - x[0]) / 21);
    if (e.lastRead) {
      const age = Math.max(0, day - Math.floor(Date.parse(e.lastRead) / DAY));
      if (!isNaN(age)) s += Math.pow(0.5, age / 30) * (0.4 + 0.2 * Math.log10(1 + (e.progress || 0)));
    }
    return s;
  };

  // Total anime watch time. Uses each title's real episode length when known, else a typical one for its type.
  TL.watchTime = function (entries) {
    let min = 0, guessed = 0, titles = 0;
    for (const e of entries) {
      if (e.kind !== 'anime' || !(e.progress > 0)) continue;
      titles++;
      let d = e.dur;
      if (!(d > 0)) { d = /movie/i.test(e.origin || '') ? 100 : 24; guessed++; }
      min += e.progress * d;
    }
    return { minutes: Math.round(min), hours: Math.round(min / 6) / 10, days: Math.round(min / 144) / 10, guessed: guessed, titles: titles };
  };

  /* ---------- weekly recap ---------- */

  // Monday of the week that holds `day` (a TL.dayNum).
  TL.weekStart = function (day) {
    day = day == null ? TL.dayNum() : day;
    const dow = new Date(day * DAY + 12 * 36e5).getUTCDay(); // day numbers are local days counted like UTC days
    return day - ((dow + 6) % 7);
  };
  // What was read and watched from day `from` to day `to` (inclusive), and what is waiting.
  TL.recap = function (entries, from, to) {
    const sum = function (e, a, b) { let n = 0; for (const x of e.log || []) if (x[0] >= a && x[0] <= b) n += x[1]; return n; };
    const out = { from: from, to: to, manga: 0, anime: 0, prev: 0, series: 0, days: 0, top: [], behind: [], quiet: [] };
    const days = new Set(), today = TL.dayNum();
    for (const e of entries) {
      const n = sum(e, from, to);
      out.prev += sum(e, from - 7, from - 1);
      if (n) {
        out[e.kind === 'anime' ? 'anime' : 'manga'] += n; out.series++;
        out.top.push({ id: e.id, title: e.title, kind: e.kind, n: Math.round(n * 10) / 10 });
        for (const x of e.log) if (x[0] >= from && x[0] <= to) days.add(x[0]);
      }
      const have = e.progress || 0;
      if (TL.newState(e) === 'new') out.behind.push({ id: e.id, title: e.title, kind: e.kind, gap: Math.max(1, Math.round((e.next.latest || e.next.number) - have)), url: e.next.url });
      else if (e.status === 'current' && e.lastRead && have > 0) {
        const idle = today - Math.floor(Date.parse(e.lastRead) / DAY);
        if (idle >= 21 && idle <= 120 && (e.log || []).length) out.quiet.push({ id: e.id, title: e.title, kind: e.kind, idle: idle });
      }
    }
    out.manga = Math.round(out.manga * 10) / 10; out.anime = Math.round(out.anime * 10) / 10; out.prev = Math.round(out.prev * 10) / 10;
    out.days = days.size;
    out.top.sort(function (a, b) { return b.n - a.n; }); out.top = out.top.slice(0, 5);
    out.behind.sort(function (a, b) { return b.gap - a.gap; }); out.behind = out.behind.slice(0, 6);
    out.quiet.sort(function (a, b) { return a.idle - b.idle; }); out.quiet = out.quiet.slice(0, 4);
    return out;
  };

  /* ---------- focus blocker ---------- */

  // When the current focus block ends, or 0 when nothing is being blocked right now.
  TL.focusEnd = function (settings, now) {
    now = now || Date.now();
    const f = (settings && settings.focus) || {};
    if (f.pass > now) return 0; // a short pass is running
    return Math.max(f.until > now ? f.until : 0, f.quiet !== false ? TL.quietEnd(settings, now, true) : 0);
  };
  TL.focusSites = function (settings) {
    const f = (settings && settings.focus) || {}, out = (f.sites || []).slice();
    if (f.tracked !== false) Object.keys((settings && settings.sites) || {}).forEach(function (h) { if (settings.sites[h] === 'on' && out.indexOf(h) < 0) out.push(h); });
    return out;
  };
  TL.blocked = function (settings, url, now) {
    if (!/^https?:/.test(url || '')) return false;
    const host = TL.hostOf(url);
    if (!host || host === 'music.youtube.com' || !TL.focusEnd(settings, now)) return false; // music stays available
    return TL.focusSites(settings).some(function (s) { return host === s || host.slice(-s.length - 1) === '.' + s; });
  };

  /* ---------- mute and quiet hours ---------- */

  const mins = function (hhmm) { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  // Quiet hours: settings.quiet = [{ days: [1,2,3,4,5], from: '08:00', to: '15:30' }, ...] (0 = Sunday).
  // Returns when the quiet period that covers `now` ends, or 0 when not in one.
  TL.quietEnd = function (settings, now, raw) { // raw: ignore an "unmute now" (the focus blocker keeps to the schedule)
    now = now || Date.now();
    if (!settings || (!raw && now < (settings.quietSkip || 0))) return 0;
    const d = new Date(now), day = d.getDay(), m = d.getHours() * 60 + d.getMinutes();
    const at = function (off, mm) { const x = new Date(now); x.setDate(x.getDate() + off); x.setHours(0, mm, 0, 0); return x.getTime(); };
    let end = 0;
    for (const s of settings.quiet || []) {
      const f = mins(s.from), t = mins(s.to), days = s.days || [];
      if (f == null || t == null || f === t) continue;
      if (f < t) { if (days.indexOf(day) >= 0 && m >= f && m < t) end = Math.max(end, at(0, t)); }
      else if (days.indexOf(day) >= 0 && m >= f) end = Math.max(end, at(1, t)); // runs past midnight
      else if (days.indexOf((day + 6) % 7) >= 0 && m < t) end = Math.max(end, at(0, t));
    }
    return end;
  };
  TL.isMuted = function (settings, now) {
    const m = settings && settings.muteUntil;
    now = now || Date.now();
    return m === -1 || (m > 0 && m > now) || TL.quietEnd(settings, now) > 0;
  };
  // When notifications come back: 0 = not muted, -1 = until turned back on, else a time.
  TL.muteEnd = function (settings, now) {
    now = now || Date.now();
    if (!settings) return 0;
    if (settings.muteUntil === -1) return -1;
    let t = now, end = 0;
    for (let i = 0; i < 12; i++) {
      const e = Math.max(settings.muteUntil > t ? settings.muteUntil : 0, TL.quietEnd(settings, t));
      if (!e) break;
      end = e; t = e + 1000;
    }
    return end;
  };

  /* ---------- series pages and next links ---------- */

  const RX_TOKEN = /(?:^|[\/\-_.])(?:chapter|chap|ch|episode|ep)[-_\/]?\d{1,4}(?:[.\-_]\d{1,2})?(?!\d)/i;
  // The series page a chapter address sits under, or null when the address does not show one.
  TL.seriesUrl = function (url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const p = u.pathname, m = RX_TOKEN.exec(p);
    if (!m) return null;
    let before = p.slice(0, m.index);
    if (p.charAt(m.index) !== '/') before = before.slice(0, Math.max(before.lastIndexOf('/'), 0)); // number sits inside a segment
    before = before.replace(/\/(?:chapter|chapters|episode|episodes|read|view)$/i, '');
    const segs = before.split('/').filter(Boolean);
    if (!segs.length || segs.every(function (s) { return SKIP_SEG.test(s.toLowerCase()); })) return null;
    return u.origin + before + (/\/$/.test(p) ? '/' : '');
  };

  // Chapter or episode numbers listed on a series page: number -> address (or null when only the number is known).
  /* ---------- locked and timed chapters ---------- */

  // "free in 3 days", "unlocks in 2d 5h", "5 hours left", "free on Nov 20", data-unlock="1794800000" -> a time, or 0.
  TL.parseWait = function (text, now) {
    now = now || Date.now();
    text = String(text || '');
    const span = function (s) {
      let ms = 0, m;
      const re = /(\d+)\s*(w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?)\b/gi;
      while ((m = re.exec(s))) { const u = m[2].charAt(0).toLowerCase(); ms += Number(m[1]) * (u === 'w' ? 6048e5 : u === 'd' ? 864e5 : u === 'h' ? 36e5 : 6e4); }
      return ms;
    };
    const U = '(?:\\d+\\s*(?:w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?)\\b[\\s,]*(?:and\\s+)?){1,3}';
    let m = new RegExp('(?:free|unlock\\w*|available|opens?|wait)\\b[^<>|]{0,30}?\\b(?:in|for)\\s+(' + U + ')', 'i').exec(text) ||
      new RegExp('(' + U + ')\\s*(?:left|remaining|until\\s+free|to\\s+unlock|till\\s+free)', 'i').exec(text);
    if (m && !/\bago\b/i.test(text.slice(m.index, m.index + m[0].length + 6))) { const ms = span(m[1]); if (ms > 0) return now + ms; }
    m = /(?:free|unlock\w*|available|opens?)\b[^<>|]{0,24}?\b(?:on|at|from)\s+((?:[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)|(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?))/i.exec(text);
    if (m) {
      const raw = m[1].replace(/(\d)(st|nd|rd|th)/, '$1'), hasYear = /\d{4}/.test(raw);
      let t = Date.parse(hasYear ? raw : raw + ', ' + new Date(now).getFullYear());
      if (!isNaN(t)) { if (!hasYear && t < now - 864e5) t = Date.parse(raw + ', ' + (new Date(now).getFullYear() + 1)); if (t > now - 864e5) return Math.max(t, now); }
    }
    m = /data-(?:free|unlock|release|available|publish)[\w-]*\s*=\s*["'](\d{10,13}|\d{4}-\d{2}-\d{2}[^"']*)["']/i.exec(text);
    if (m) { let t = /^\d+$/.test(m[1]) ? Number(m[1]) * (m[1].length <= 10 ? 1000 : 1) : Date.parse(m[1]); if (!isNaN(t) && t > now && t < now + 400 * 864e5) return t; }
    return 0;
  };
  const LOCK_TEXT = /(^|[^\p{L}])(locked|premium|paid|early[\s-]?access|fast[\s-]?pass|unlocks?\s+(?:in|on|at)|free\s+(?:in|on)|wait\s+(?:until|to|for)|coins?|vip|(?:subscribers?|patrons?|members?)\s+only)(?![\p{L}])/iu;
  const LOCK_ATTR = /(^|[\s_"'=-])(lock|locked|premium|paid|coins?|vip|fastpass|fast-pass|early-access|paywall)([\s_"'-]|$)/i;
  // One row of a chapter list: is this chapter still locked, and until when?
  TL.lockInfo = function (ctx, now) {
    ctx = String(ctx || '');
    const attrs = (ctx.match(/\b(?:class|data-[\w-]+|title|alt|aria-label)\s*=\s*["'][^"']*["']/gi) || []).join(' ');
    const txt = ctx.replace(/<[^>]+>/g, ' ');
    const freeAt = TL.parseWait(txt + ' ' + attrs, now);
    return { locked: !!freeAt || LOCK_TEXT.test(txt) || LOCK_ATTR.test(attrs) || /\u{1F512}|\u{1F510}/u.test(ctx), freeAt: freeAt };
  };
  const PAYWALL = /(this (?:chapter|episode) is (?:locked|premium|paid)|unlock (?:this|the) (?:chapter|episode)|(?:purchase|buy) (?:this |the )?(?:chapter|episode)|subscribe to (?:read|unlock|continue)|(?:premium|paid|early[- ]access) (?:chapter|episode)|coins? (?:to unlock|required|needed)|wait until free|free in \d+\s*(?:d|h|day|hour)|unlocks? in \d+|log ?in to (?:read|unlock|continue reading))/i;
  // A chapter's own page: is it showing a paywall or a wait timer instead of the chapter?
  TL.pageLocked = function (html, now) {
    const body = String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').slice(0, 60000);
    const m = PAYWALL.exec(body);
    if (!m) return { locked: false, freeAt: 0 };
    return { locked: true, freeAt: TL.parseWait(body.slice(Math.max(0, m.index - 200), m.index + 300), now) };
  };
  /* ---------- release rhythm: when is the next one likely? ---------- */

  // "3 days ago", "last week", "yesterday", "Nov 14, 2026" -> days ago (0 = today), or null.
  TL.parseAgo = function (text, now) {
    now = now || Date.now();
    text = String(text || '');
    let m = /(\d+|an?)\s*(minute|min|hour|hr|day|week|month|year)s?\s+ago/i.exec(text);
    if (m) { const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]), u = m[2].toLowerCase(); return u === 'day' ? n : u === 'week' ? n * 7 : u === 'month' ? n * 30 : u === 'year' ? n * 365 : 0; }
    if (/\byesterday\b/i.test(text)) return 1;
    if (/\b(today|just now)\b/i.test(text)) return 0;
    if (/\blast week\b/i.test(text)) return 7;
    if (/\blast month\b/i.test(text)) return 30;
    m = /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}-\d{2}-\d{2})\b/i.exec(text);
    if (m) { const t = Date.parse(m[1].replace(/(\d)(st|nd|rd|th)/, '$1')); if (!isNaN(t) && t <= now + DAY && t > now - 3650 * DAY) return Math.max(0, Math.round((now - t) / DAY)); }
    return null;
  };
  const median = function (a) { const s = a.slice().sort(function (x, y) { return x - y; }), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
  // From a chapter list's dates: the usual gap between releases and when the latest one came out.
  TL.siteCadence = function (ages, now) {
    now = now || Date.now();
    if (!ages || ages.size < 2) return null;
    const rows = Array.from(ages.entries()).sort(function (a, b) { return b[0] - a[0]; }).slice(0, 10);
    const gaps = [];
    for (let i = 1; i < rows.length; i++) { const g = rows[i][1] - rows[i - 1][1]; if (g >= 1 && g <= 45) gaps.push(g); } // 0 = uploaded together
    if (!gaps.length) return null;
    return { iv: Math.max(1, Math.round(median(gaps))), last: now - rows[0][1] * DAY, upTo: rows[0][0] };
  };
  // The usual gap for a series: the site's own dates when Shelf has seen them, else the rhythm you read it at.
  TL.cadence = function (e) {
    if (e.cad && e.cad.iv > 0) return { iv: e.cad.iv, last: e.cad.last, src: 'site' };
    const set = new Set(e.rel || []);
    for (const x of e.log || []) if (x[1] <= 3) set.add(x[0]); // a day with many chapters is catching up, not a release
    const days = Array.from(set).sort(function (a, b) { return a - b; }), gaps = [];
    for (let i = 1; i < days.length; i++) { const g = days[i] - days[i - 1]; if (g >= 2 && g <= 45) gaps.push(g); }
    if (!gaps.length) return null;
    return { iv: Math.max(2, Math.round(median(gaps))), last: days[days.length - 1] * DAY + new Date().getTimezoneOffset() * 6e4 + DAY / 2, src: 'reads' };
  };
  // When the next chapter is likely, for a series with nothing confirmed waiting. { at, number, due, iv, src } or null.
  TL.expect = function (e, now) {
    now = now || Date.now();
    const have = e.progress || 0;
    if (!e || e.status !== 'current' || !(have > 0) || (e.total && have >= e.total) || (e.next && e.next.number > have)) return null;
    const c = TL.cadence(e);
    if (!c) return null;
    if (c.src === 'site' && e.cad.upTo != null && e.cad.upTo > have) return null; // the dates belong to chapters not read yet
    let at = c.last + c.iv * DAY;
    if (e.upTo && e.upTo.n === have && e.upTo.at >= at) at = e.upTo.at + DAY; // looked after it was due and it was not out: try again a day later
    if (now - at > 60 * DAY) return null; // long overdue: the series has probably stopped or moved
    return { at: at, number: Math.floor(have) + 1, due: now >= at, iv: c.iv, src: c.src };
  };
  TL.whenText = function (at, now) {
    now = now || Date.now();
    const d = Math.round((at - now) / DAY);
    if (at - now < 20 * 36e5) return d <= 0 && new Date(at).getDate() === new Date(now).getDate() ? 'today' : 'tomorrow';
    if (d < 7) return new Date(at).toLocaleDateString([], { weekday: 'short' });
    return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // '' = nothing waiting, 'locked' = out but not free yet, 'new' = newly released, 'next' = out for a while, 'due' = probably out
  TL.newState = function (e, now) {
    if (!(e && e.next && e.next.number > (e.progress || 0))) { const x = e && (e.cad || e.rel || e.log) ? TL.expect(e, now) : null; return x && x.due ? 'due' : ''; } // due: not confirmed, but its usual gap has passed
    if (e.next.locked && !(e.next.freeAt && e.next.freeAt <= (now || Date.now()))) return 'locked';
    return e.next.backlog ? 'next' : 'new'; // backlog: it was already out when first seen, so it is not news
  };
  TL.waitText = function (freeAt, now) {
    const ms = (freeAt || 0) - (now || Date.now());
    if (!freeAt || ms <= 0) return 'locked';
    return 'free in ' + (ms >= 864e5 ? Math.round(ms / 864e5) + 'd' : ms >= 36e5 ? Math.round(ms / 36e5) + 'h' : Math.max(1, Math.round(ms / 6e4)) + 'm');
  };

  TL.scanChapters = function (html, base, kind, have) {
    html = String(html || '').slice(0, 800000);
    const map = new Map(), locks = new Map(), ages = new Map();
    let basePath = '/', key = '';
    try {
      basePath = new URL(base).pathname.replace(/\/+$/, '').toLowerCase();
      key = (basePath.split('/').filter(Boolean).pop() || '').replace(/\.[a-z]{2,5}$/, '');
    } catch (e) { return { map: map, max: 0, locks: locks, ages: ages }; }
    const re = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;
    let m, guard = 0;
    while ((m = re.exec(html)) && guard++ < 6000) {
      let abs;
      try { abs = new URL(m[1].replace(/&amp;/g, '&'), base); } catch (e) { continue; }
      if (!/^https?:$/.test(abs.protocol)) continue;
      const path = abs.pathname.toLowerCase();
      // only links that belong to this series, not "latest updates" for other ones
      if (!(path.indexOf(basePath + '/') === 0 || (key.length >= 4 && path.indexOf(key) >= 0))) continue;
      const fu = TL.fromUrl(abs.href);
      let n = fu && fu.kind === kind ? fu.number : null;
      if (n == null) {
        const h = TL.fromText(m[2].replace(/<[^>]+>/g, ' '));
        if (h && h.kind === kind) n = h.number;
      }
      if (n != null && !map.has(n)) {
        map.set(n, abs.href);
        // the row around the link: back to the previous row's end, forward to this row's end
        const before = html.slice(Math.max(0, m.index - 200), m.index), cutB = Math.max(before.lastIndexOf('</a>'), before.lastIndexOf('</li>'), before.lastIndexOf('</tr>'), before.lastIndexOf('</div>'));
        const after = html.slice(re.lastIndex, re.lastIndex + 300), cutA = after.search(/<a[\s>]|<\/li>|<\/tr>|<li[\s>]|<tr[\s>]/i);
        const row = (cutB >= 0 ? before.slice(cutB) : before) + m[0] + (cutA >= 0 ? after.slice(0, cutA) : after);
        const info = TL.lockInfo(row);
        if (info.locked) locks.set(n, info);
        else { const age = TL.parseAgo(row.replace(/<[^>]+>/g, ' ')); if (age != null) ages.set(n, age); } // when this chapter came out, in days ago
      }
    }
    if (!map.size) {
      // lists drawn by script: numbers only, trusted only when the list contains the chapter already read
      const names = kind === 'anime' ? 'episode|episode_number|episodeNumber|episodeNum|ep_num' : 'chap|chapter|chapter_number|chapterNumber|chapterNum|chapter_num';
      const rj = new RegExp('\\\\?"(?:' + names + ')\\\\?"\\s*:\\s*\\\\?"?(\\d{1,4}(?:\\.\\d{1,2})?)(?![\\d.])', 'g');
      const found = new Set();
      guard = 0;
      while ((m = rj.exec(html)) && guard++ < 6000) found.add(parseFloat(m[1]));
      if (have != null && (found.has(have) || found.has(Math.floor(have)))) found.forEach(function (n) { map.set(n, null); });
    }
    let max = 0;
    map.forEach(function (u, n) { if (n > max) max = n; });
    // a "lock" on a chapter already read means the page marks every row that way: the marker cannot be trusted
    let bogus = false;
    locks.forEach(function (v, n) { if (have != null && n <= have) bogus = true; });
    if (bogus) locks.clear();
    return { map: map, max: max, locks: locks, ages: ages };
  };

  // Where the "next" button on a series should go.
  const metaOf = function (html, re) { const m = re.exec(html); return m ? m[1].replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim() : ''; };
  /* Is something newer than the reader's chapter out? Tries, in order: a chapter list already on the page
     (dom), the series page, then the next chapter's own page. get(url) -> { url, html } | { status } | null.
     Returns { found: true, number, url, latest, locked, freeAt } / { found: false } / { unknown: true, why }. */
  TL.probe = async function (e, get, dom) {
    const have = e.progress || 0, next = Math.floor(have) + 1;
    const captured = e.nextUrl && e.nextUrl.from === have ? e.nextUrl.url : null;
    let image = '', why = '';
    const read = function (sc, pageUrl) {
      let best = null;
      sc.map.forEach(function (u, n) { if (n > have && (best == null || n < best)) best = n; });
      const cad = TL.siteCadence(sc.ages);
      if (best == null) return { found: false, image: image, cad: cad };
      const lock = sc.locks.get(best) || {};
      return { cad: cad, found: true, number: best, url: sc.map.get(best) || (best === next && captured) || pageUrl, latest: sc.max, image: image, locked: !!lock.locked, freeAt: lock.freeAt || 0 };
    };
    if (dom && dom.html && dom.base) { // a real list (not just a lone "next" button) that includes the chapter being read
      const sc = TL.scanChapters(dom.html, dom.base, e.kind, have);
      if (sc.map.size >= 3 && (sc.map.has(have) || sc.map.has(Math.floor(have)))) return read(sc, dom.base);
    }
    const su = e.seriesUrl || TL.seriesUrl(e.lastUrl);
    if (su) {
      const pg = await get(su);
      if (pg && pg.html) {
        const og = metaOf(pg.html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || metaOf(pg.html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (/^https:\/\//.test(og)) image = og;
        const sc = TL.scanChapters(pg.html, pg.url, e.kind, have);
        if (sc.map.size) return read(sc, pg.url);
        why = 'no chapter list on the series page';
      } else why = pg ? 'status ' + pg.status : 'unreachable';
    }
    const url = captured || TL.nextUrl(e.lastUrl, next);
    if (!url) return { unknown: true, why: why || 'no address to check' };
    const pg = await get(url);
    if (!pg) return { unknown: true, why: 'unreachable' };
    const no = { found: false, image: image };
    if (!pg.html) return pg.status === 404 || pg.status === 410 ? no : { unknown: true, why: 'status ' + pg.status };
    const wall = TL.pageLocked(pg.html); // the page exists but shows a paywall or a wait timer
    const yes = { found: true, number: next, url: pg.url, latest: next, image: image, locked: wall.locked, freeAt: wall.freeAt };
    const fu = TL.fromUrl(pg.url);
    if (!fu || fu.number !== next) return no; // sent back to the series page or the home page
    const title = metaOf(pg.html, /<title[^>]*>([^<]*)<\/title>/i), ogt = metaOf(pg.html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
    if (/\b(404|not found|doesn.?t exist|no longer available)\b/i.test(title)) return no;
    const h = TL.fromText(title) || TL.fromText(ogt);
    if (h) return h.number === next ? yes : no;
    const body = pg.html.replace(/<script[\s\S]*?<\/script>/gi, ' ').slice(0, 80000);
    if (/not found|coming soon|not available|not yet released|doesn.?t exist|\b404\b/i.test(body)) return no;
    const word = e.kind === 'anime' ? '(?:episode|ep)' : '(?:chapter|ch)';
    return new RegExp(word + '\\.?\\W{0,3}0*' + next + '(?!\\d)', 'i').test(body) ? yes : no;
  };

  // Where the link on a series should go. Only chapters a check has confirmed are out get a link:
  // 'new' (just released), 'next' (already out, you are catching up), 'locked' (out but not free yet).
  TL.nextLink = function (e) {
    const ok = function (u) { return typeof u === 'string' && /^https?:\/\//.test(u); };
    const have = e.progress || 0, st = TL.newState(e);
    if (st === 'due') { const u = e.seriesUrl || TL.seriesUrl(e.lastUrl) || e.lastUrl; return ok(u) ? { type: 'due', url: u, number: Math.floor(have) + 1 } : null; } // opens the series page, never a guessed chapter address
    if (st && ok(e.next.url)) return { type: st, url: e.next.url, number: e.next.number, latest: e.next.latest || 0, freeAt: e.next.freeAt || 0 };
    if (e.total && have >= e.total) return null;
    const x = TL.expect(e), eta = x ? { at: x.at, number: x.number } : null;
    if (e.upTo && e.upTo.n === have && Date.now() - e.upTo.at < 36 * 36e5) return { type: 'none', eta: eta }; // checked: nothing newer is out
    return ok(e.lastUrl) ? { type: 'continue', url: e.lastUrl, eta: eta } : null; // not checked yet: back to where you left off
  };

  /* ---------- detection ---------- */

  const RX_SE = /(?:^|[^\p{L}\p{N}])s(\d{1,2})\s*[-:]?\s*ep?\s*(\d{1,4})(?![\d\p{L}])/iu;
  const RX_EP = /(?:^|[^\p{L}\p{N}])(?:episode|episodio|épisode|folge|eps|ep)\.?\s*[-#:]?\s*(\d{1,4}(?:\.\d)?)(?![\d\p{L}])/iu;
  const RX_CH = /(?:^|[^\p{L}\p{N}])(?:chapter|chapitre|capitulo|capítulo|kapitel|chap|ch)\.?\s*[-#:]?\s*(\d{1,4}(?:\.\d{1,2})?)(?![\d\p{L}])/iu;

  // Find "Episode 5" / "Chapter 70" / "S2E5" in a piece of text.
  TL.fromText = function (s) {
    s = String(s || '');
    const out = [];
    let m = RX_SE.exec(s);
    if (m) out.push({ kind: 'anime', number: parseFloat(m[2]), season: parseInt(m[1], 10), index: m.index, end: m.index + m[0].length });
    m = RX_EP.exec(s);
    if (m) out.push({ kind: 'anime', number: parseFloat(m[1]), index: m.index, end: m.index + m[0].length });
    m = RX_CH.exec(s);
    if (m) out.push({ kind: 'manga', number: parseFloat(m[1]), index: m.index, end: m.index + m[0].length });
    if (!out.length) return null;
    out.sort(function (a, b) { return a.index - b.index; });
    return out[0];
  };

  const SKIP_SEG = /^(comic|comics|manga|manhwa|manhua|read|reader|watch|anime|series|title|chapter|chapters|episode|episodes|view|viewer|en|e|c|w|webtoon|webtoons|tv|show|shows|stream|video|videos|play|player)$/;
  function deslug(seg) {
    let w = seg.replace(/\.[a-z]{2,5}$/, '').split(/[-_+.\s]+/).filter(Boolean);
    while (w.length > 1 && (/^\d+$/.test(w[0]) || (/\d/.test(w[0]) && /[a-z]/.test(w[0]) && w[0].length >= 5))) w.shift();
    while (w.length > 1 && /\d/.test(w[w.length - 1]) && /[a-z]/.test(w[w.length - 1]) && w[w.length - 1].length >= 5) w.pop();
    if (!w.length || (w.length === 1 && (SKIP_SEG.test(w[0]) || /^\d+$/.test(w[0])))) return '';
    return w.map(function (x) { return x.charAt(0).toUpperCase() + x.slice(1); }).join(' ');
  }

  // Find "/chapter-70" or "/episode-5" in the address, plus a title guess from the slug.
  TL.fromUrl = function (url) {
    let p;
    try { p = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch (e) { return null; }
    const rc = /(?:^|[\/\-_.])(?:chapter|chap|ch)[-_\/]?(\d{1,4}(?:[.\-_]\d{1,2})?)(?!\d)/;
    const re = /(?:^|[\/\-_.])(?:episode|ep)[-_\/]?(\d{1,4})(?!\d)/;
    let m = rc.exec(p), kind = 'manga';
    if (!m) { m = re.exec(p); kind = 'anime'; }
    if (!m) return null;
    const number = parseFloat(m[1].replace(/[-_]/, '.'));
    const titles = [];
    const before = p.slice(0, m.index);
    const cut = before.lastIndexOf('/');
    const inSeg = deslug(before.slice(cut + 1));
    if (inSeg && (inSeg.split(' ').length >= 2 || inSeg.length >= 8)) titles.push(inSeg);
    const segs = before.slice(0, Math.max(cut, 0)).split('/').filter(Boolean).reverse();
    for (const s of segs) { if (SKIP_SEG.test(s)) continue; const t = deslug(s); if (t) { titles.push(t); break; } }
    if (inSeg && titles.indexOf(inSeg) < 0) titles.push(inSeg);
    return { kind: kind, number: number, titles: titles };
  };

  // The address of chapter/episode `next` on the same site, or null when the address has no number to swap.
  TL.nextUrl = function (url, next) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const rc = /((?:^|[\/\-_.])(?:chapter|chap|ch)[-_\/]?)(\d{1,4})(?:[.\-_]\d{1,2})?(?!\d)/i;
    const re = /((?:^|[\/\-_.])(?:episode|ep)[-_\/]?)(\d{1,4})(?!\d)/i;
    const p = u.pathname, m = rc.exec(p) || re.exec(p);
    if (!m) return null;
    const pad = m[2].length > 1 && m[2].charAt(0) === '0' ? m[2].length : 0;
    u.pathname = p.slice(0, m.index) + m[1] + (pad ? String(next).padStart(pad, '0') : String(next)) + p.slice(m.index + m[0].length);
    return u.toString();
  };

  // Which site a series is filed under: the label you gave it, else the site it was last saved from.
  TL.siteLabel = function (e) { return (e && (e.source || e.site)) || ''; };
  // Reuse an existing label when the address clearly belongs to it ("Asura" for asuracomic.net).
  TL.guessSource = function (host, labels) {
    const h = String(host || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const l of labels || []) {
      const k = String(l).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (k.length >= 3 && h.indexOf(k) >= 0) return l;
    }
    return '';
  };

  function hostLike(t, host) {
    const h = (host || '').split('.')[0].replace(/[^a-z0-9]/g, '');
    const s = String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!h || s.length < 3) return false;
    return s === h || (s.length <= h.length + 6 && s.indexOf(h) >= 0) || (h.indexOf(s) >= 0 && s.length >= 4);
  }
  const GENERIC = /^(?:home|homepage|read|watch|online|free|latest|next|prev(?:ious)?|(?:read |watch )?(?:free )?(?:manga|anime|manhwa|manhua|comics?|webtoons?|episodes?|chapters?)(?: online)?(?: free)?|(?:chapter|episode|ep|ch)\.?\s*\d.*)$/i;

  TL.clean = function (s) {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(?:watch|read|stream|streaming|ver|lire|baca)\s+/i, '');
    t = t.replace(/\s+(?:(?:english|eng)\s+)?(?:sub|dub)(?:bed)?(?:\b|\/).*$/i, '');
    t = t.replace(/\s+online\s+(?:free|for|in|at|on|hd)\b.*$/i, '');
    let prev;
    do {
      prev = t;
      t = t.replace(/[\s\-–—|:,·•»(\[]+$/, '').replace(/^[\s\-–—|:,·•»)\]]+/, '');
      t = t.replace(/\s*[(\[][^)\]]{0,24}[)\]]$/, function (m) {
        return /sub|dub|raw|manga|manhwa|manhua|webtoon|uncensored|english|eng|official|\bhd\b|\btv\b/i.test(m) ? '' : m;
      });
      if (t.split(' ').length >= 3) t = t.replace(/\s+(?:manga|manhwa|manhua|webtoon)$/i, '');
    } while (t !== prev);
    return t;
  };

  const splitSegs = function (s) { return String(s || '').split(/\s+[|\-–—·•»:]\s+|\s*\|\s*/).map(function (x) { return x.trim(); }).filter(Boolean); };

  /* ctx: { url, title, og, h1:[...], dom:{kind,number}|null, media:{video:bool, bigImgs:n} }
     returns null, or { kind, number, title, candidates[], signals{}, count } */
  TL.detect = function (ctx) {
    const host = TL.hostOf(ctx.url);
    const texts = [ctx.title, ctx.og].concat(ctx.h1 || []).filter(Boolean);
    let hit = null;
    for (const s of texts) { const h = TL.fromText(s); if (h) { hit = h; hit.src = s; break; } }
    const u = TL.fromUrl(ctx.url);
    const d = ctx.dom && ctx.dom.number != null && !isNaN(ctx.dom.number) ? ctx.dom : null;
    if (!hit && !u && !d) return null;
    const media = ctx.media || {};
    const kind = (hit && hit.kind) || (u && u.kind) || d.kind || (media.video ? 'anime' : 'manga');
    const number = hit ? hit.number : (u ? u.number : d.number);
    if (!(number >= 0)) return null;

    const cands = [], seen = new Set();
    const add = function (raw, suffix) {
      let t = TL.clean(raw);
      if (!t || t.length < 2 || t.length > 140 || !/\p{L}/u.test(t) || GENERIC.test(t) || hostLike(t, host)) return;
      if (suffix) t += suffix;
      const k = TL.norm(t);
      if (!k || seen.has(k)) return;
      seen.add(k); cands.push(t);
    };
    let gotPrefix = false;
    if (hit) {
      const suffix = hit.season && hit.season > 1 ? ' Season ' + hit.season : '';
      const segs = splitSegs(hit.src.slice(0, hit.index)).filter(function (s) { const c = TL.clean(s); return c && !hostLike(c, host) && !GENERIC.test(c); });
      if (segs.length) { add(segs.join(' - '), suffix); segs.forEach(function (s) { add(s, suffix); }); gotPrefix = cands.length > 0; }
    }
    for (const s of ctx.h1 || []) { if (!TL.fromText(s)) add(s); }
    for (const s of [ctx.og, ctx.title]) {
      if (!s || (hit && s === hit.src)) continue;
      const h = TL.fromText(s);
      splitSegs(h ? s.slice(0, h.index) : s).forEach(function (x) { add(x); });
    }
    if (hit && !gotPrefix) splitSegs(hit.src.slice(hit.end)).forEach(function (x) { add(x); });
    if (u) u.titles.forEach(function (x) { add(x); });
    if (!cands.length) return null;

    const signals = {
      text: !!hit,
      url: !!(u && u.kind === kind),
      dom: !!(d && d.number === number),
      media: kind === 'anime' ? !!media.video : (media.bigImgs || 0) >= 3
    };
    const count = Object.keys(signals).filter(function (k) { return signals[k]; }).length;
    return { kind: kind, number: number, title: cands[0], candidates: cands.slice(0, 8), signals: signals, count: count };
  };

  /* ---------- imports ---------- */

  TL.statusFrom = function (v) {
    if (typeof v === 'number') return ({ 1: 'current', 2: 'completed', 3: 'on_hold', 4: 'dropped', 6: 'planning' })[v] || 'current';
    const s = String(v || '').toLowerCase();
    if (/plan|want|ptw|ptr|wish/.test(s)) return 'planning';
    if (/complete|finish/.test(s)) return 'completed';
    if (/hold|pause/.test(s)) return 'on_hold';
    if (/drop/.test(s)) return 'dropped';
    return 'current';
  };

  // One row of MAL's load.json list -> entry fields
  TL.malToEntry = function (it, kind) {
    const a = kind === 'anime';
    const romaji = String((a ? it.anime_title : it.manga_title) || '').trim();
    const eng = String((a ? it.anime_title_eng : it.manga_english) || '').trim();
    const title = eng || romaji;
    if (!title) return null;
    const path = a ? it.anime_url : it.manga_url;
    const progress = Number(a ? it.num_watched_episodes : it.num_read_chapters) || 0;
    const ts = (Number(it.updated_at) || 0) * 1000;
    return {
      kind: kind, malId: Number(a ? it.anime_id : it.manga_id) || null, title: title,
      alt: romaji && romaji !== title ? [romaji] : [],
      progress: progress, total: Number(a ? it.anime_num_episodes : it.manga_num_chapters) || null,
      status: TL.statusFrom(Number(it.status)), score: Number(it.score) || 0,
      origin: String((a ? it.anime_media_type_string : it.manga_media_type_string) || ''),
      image: String((a ? it.anime_image_path : it.manga_image_path) || ''),
      links: path ? { mal: 'https://myanimelist.net' + path } : {},
      lastRead: ts && progress ? new Date(ts).toISOString().slice(0, 10) : null, updatedAt: ts
    };
  };

  TL.parseCSV = function (text) {
    const rows = []; let row = [], cur = '', q = false;
    text = String(text).replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(function (x) { return x !== ''; })) rows.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some(function (x) { return x !== ''; })) rows.push(row);
    if (rows.length < 2) return [];
    const head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    return rows.slice(1).map(function (r) { const o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
  };

  const pick = function (o, keys) {
    for (const k of keys) { if (o[k] != null && o[k] !== '') return o[k]; }
    return null;
  };
  // Loose row (CSV line, JSON object from another tracker or a Shelf backup) -> entry fields
  TL.rowToEntry = function (o, kind) {
    const low = {};
    Object.keys(o || {}).forEach(function (k) { low[k.toLowerCase()] = o[k]; });
    const title = String(pick(low, ['title', 'name', 'series', 'series_title', 'manga_title']) || '').trim();
    if (!title) return null;
    const k = /anime/i.test(String(low.kind || low.media || '')) ? 'anime' : /manga|manhwa|manhua/i.test(String(low.kind || low.media || '')) ? 'manga' : kind;
    const num = function (v) { const n = parseFloat(v); return isNaN(n) ? null : n; };
    let alt = pick(low, ['alt', 'synonyms', 'syn', 'alt_titles']);
    if (typeof alt === 'string') alt = alt.split(/\s*[,;|]\s*/);
    const e = {
      kind: k, title: title, alt: (alt || []).map(function (x) { return String(x).trim(); }).filter(function (x) { return x.length >= 4 && x !== title; }),
      progress: num(pick(low, ['progress', 'read', 'chapters_read', 'my_read_chapters', 'watched', 'episodes_watched', 'my_watched_episodes', 'chapter', 'episode'])),
      total: num(pick(low, ['total', 'chapters', 'episodes', 'series_episodes', 'manga_chapters'])) || null,
      status: TL.statusFrom(pick(low, ['status', 'my_status', 'list', 'type'])),
      score: num(pick(low, ['score', 'rating', 'my_score'])) || 0,
      origin: String(pick(low, ['origin', 'origination', 'country', 'format']) || ''),
      lastRead: (String(pick(low, ['lastread', 'last_read', 'updated', 'date']) || '').match(/\d{4}-\d{2}-\d{2}/) || [null])[0]
    };
    const links = low.links && typeof low.links === 'object' ? Object.assign({}, low.links) : {};
    if (low.mal && /^https?:/.test(low.mal)) links.mal = low.mal;
    if (low.anilist && /^https?:/.test(low.anilist)) links.anilist = low.anilist;
    const mu = low.mangaupdates || low.mu; if (mu && /^https?:/.test(mu)) links.mu = mu;
    if (Object.keys(links).length) e.links = links;
    ['id', 'malid', 'source', 'image', 'lasturl', 'site', 'updatedat', 'lists', 'log', 'next', 'seriesurl', 'nexturl', 'muted'].forEach(function (f) {
      if (low[f] != null && low[f] !== '') e[{ malid: 'malId', lasturl: 'lastUrl', updatedat: 'updatedAt', seriesurl: 'seriesUrl', nexturl: 'nextUrl' }[f] || f] = low[f];
    });
    if (!e.malId && links.mal) { const m = /\/(?:anime|manga)\/(\d+)/.exec(links.mal); if (m) e.malId = Number(m[1]); }
    return e;
  };

  root.TL = TL;
  if (typeof module !== 'undefined' && module.exports) module.exports = TL;
})(typeof self !== 'undefined' ? self : globalThis);
