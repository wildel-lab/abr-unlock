/* ABR Unlock — spaced-repetition gate for iPhone Shortcuts.
   Cards, images and review history stay on this device (IndexedDB). Each finished batch is
   handed to the "ABR Pass" shortcut, which appends it to reviews-log.txt in iCloud Drive and
   saves it to abr-pass.txt; ABR Gate passes abr-pass.txt back (&ack=) to confirm the save. */
(function () {
  'use strict';

  var APP_VERSION = '3.2';
  var PASS_SHORTCUT = 'ABR Pass';
  var MAX_TOKENS_PER_CALL = 400;
  var DAY = 86400000;
  var DEFAULTS = { batch: 3, newPerDay: 10, retention: 0.9, maxInterval: 180, relearnMinutes: 10, unlockRule: 'finish', mode: 'general', thinkSeconds: 3 };

  var app = document.getElementById('app');
  var params = new URLSearchParams(location.search);
  var GATE = params.has('gate');

  /* ================= utilities ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cyrb53(str, seed) {
    seed = seed || 0;
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function hid(s) { return cyrb53(s).toString(36); }
  function seedFor(id, reps) { return cyrb53(id + ':' + reps); }
  function todayStr(t) {
    var d = new Date(t || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function startOfToday() { var d = new Date(Date.now()); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function stripHtml(s) {
    return String(s == null ? '' : s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  function norm(s) { return stripHtml(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function fmtIvl(ms) {
    var m = ms / 60000;
    if (m < 60) return Math.max(1, Math.round(m)) + 'm';
    var h = m / 60;
    if (h < 24) return Math.round(h) + 'h';
    var d = h / 24;
    if (d < 30) return Math.round(d) + 'd';
    if (d < 365) return (d / 30).toFixed(1).replace(/\.0$/, '') + 'mo';
    return (d / 365).toFixed(1).replace(/\.0$/, '') + 'y';
  }
  function fmtAgo(t) { return t ? fmtIvl(Date.now() - t) + ' ago' : 'never'; }
  function uniq(arr) { var s = {}, out = []; arr.forEach(function (x) { if (!s[x]) { s[x] = 1; out.push(x); } }); return out; }
  function navigate(u) { (window.__abrNavigate || function (x) { location.href = x; })(u); }

  /* ================= numbers and units ================= */
  var PREFIX = { p: 1e-12, n: 1e-9, 'µ': 1e-6, u: 1e-6, m: 1e-3, c: 1e-2, k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  var BASES = ['Gy', 'Sv', 'Bq', 'Ci', 'Hz', 'eV', 'm', 's', 'g', 'L', 'W', 'J', 'C', 'A', 'V', 'Vp', 'As', 'Pa', 'T', 'R', 'rad', 'rem',
    'Gy/s', 'Gy/min', 'Gy/h', 'Sv/h', 'Sv/y', 'Sv/yr', 'm/s', 'Bq/mL', 'Ci/mL', 'Gy·cm', 'Gy·cm²', 'Gy·cm2', 'C/kg', 'R/h', 'R/min', 'R/mAs',
    'Gy/mAs', 'Hz/T', 'T/m', 'W/kg', 'J/kg', 'dB/cm', 'dB', '%', 'min', 'h', 'd', 'y', 'yr', 'HU', 'cycles/mm', 'lp/mm', 'lp/cm', 'cycles/cm'];
  function normUnit(u) {
    return String(u || '').trim().replace(/μ/g, 'µ').replace(/\s*\/\s*/g, '/').replace(/\s*[·*]\s*/g, '·').replace(/\.$/, '');
  }
  function parseUnit(u) {
    u = normUnit(u);
    if (!u) return null;
    if (BASES.indexOf(u) >= 0) return { base: u, f: 1 };
    if (u.length > 1 && PREFIX[u[0]] != null && BASES.indexOf(u.slice(1)) >= 0) return { base: u.slice(1), f: PREFIX[u[0]] };
    return { base: u, f: 1, unknown: true };
  }
  // A number (decimal comma ok, 1.2e3 or 1.2 × 10^3) optionally followed by a unit. Leading text is rejected.
  function parseQuantity(s, lenient) {
    var t = stripHtml(s).replace(/[−–]/g, '-').replace(/\s+/g, ' ').trim();
    if (lenient) t = t.replace(/^(about|approx\.?|approximately|~|≈|=)\s*/i, '');
    t = t.replace(/(\d),(\d)/g, '$1.$2');
    var m = t.match(/^([-+]?(?:\d+\.?\d*|\.\d+))(?:\s*[eE]\s*([-+]?\d+)|\s*[x×*]\s*10\s*\^?\s*\(?\s*([-+]?\d+)\s*\)?)?\s*(.*)$/);
    if (!m) return null;
    var v = parseFloat(m[1]);
    var exp = m[2] != null ? m[2] : m[3];
    if (exp != null) v *= Math.pow(10, parseInt(exp, 10));
    return { v: v, unit: m[4].trim() }; // any trailing words are treated as a unit and checked by gradeNumber
  }
  // -> {status: 'ok'|'wrong'|'invalid'|'unit', expected}
  function gradeNumber(input, answer, tol) {
    var x = parseQuantity(input, false);
    if (!x || isNaN(x.v)) return { status: 'invalid' };
    var a = parseQuantity(answer, true);
    if (!a) return { status: 'invalid' };
    var xv = x.v, av = a.v;
    if (x.unit && a.unit) {
      var pu = parseUnit(x.unit), pa = parseUnit(a.unit);
      if (pu.base === pa.base && !pu.unknown) { xv = x.v * pu.f; av = a.v * pa.f; }
      else if (normUnit(x.unit).toLowerCase() !== normUnit(a.unit).toLowerCase()) return { status: 'unit', expected: a.unit };
    } else if (x.unit && !a.unit) {
      return { status: 'unit', expected: '' };
    }
    var t = (tol == null || isNaN(tol)) ? 0.02 : tol; // 0 means exact (allowing only floating-point noise)
    var ok = Math.abs(xv - av) <= Math.max(Math.abs(av) * t, Math.abs(av) * 1e-9, 1e-12);
    return { status: ok ? 'ok' : 'wrong' };
  }

  /* ================= storage ================= */
  var db;
  function openDB() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('abr-unlock', 2);
      r.onupgradeneeded = function (e) {
        var d = r.result, tx = r.transaction;
        if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('reviews')) d.createObjectStore('reviews', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
        var rv = tx.objectStore('reviews');
        if (!rv.indexNames.contains('id')) rv.createIndex('id', 'id', { unique: false });
      };
      r.onsuccess = function () { db = r.result; res(db); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function p(req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); }
  function os(name, mode) { return db.transaction(name, mode || 'readonly').objectStore(name); }
  function getAll(name) { return p(os(name).getAll()); }
  function getAllKeys(name) { return p(os(name).getAllKeys()); }
  function get(name, key) { return p(os(name).get(key)); }
  function put(name, val, key) { return p(key === undefined ? os(name, 'readwrite').put(val) : os(name, 'readwrite').put(val, key)); }
  function reviewsFor(id) { return p(os('reviews').index('id').getAll(IDBKeyRange.only(id))); }
  function bulk(name, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction(name, 'readwrite'), s = t.objectStore(name);
      fn(s);
      t.oncomplete = function () { res(); };
      t.onerror = function () { rej(t.error); };
    });
  }
  function putMany(name, vals) { return bulk(name, function (s) { vals.forEach(function (v) { s.put(v); }); }); }
  function putPairs(name, pairs) { return bulk(name, function (s) { pairs.forEach(function (kv2) { s.put(kv2[1], kv2[0]); }); }); }
  function delMany(name, keys) { return bulk(name, function (s) { keys.forEach(function (k) { s.delete(k); }); }); }
  async function kv(key, def) { var v = await get('kv', key); return v === undefined ? def : v; }
  function setKv(key, val) { return put('kv', val, key); }
  async function settings() { return Object.assign({}, DEFAULTS, await kv('settings', {})); }
  async function saveSettingsObj(s) { await setKv('settings', s); }
  async function daily() {
    var d = await kv('daily', null), t = todayStr();
    return d && d.date === t ? d : { date: t, newIntro: 0, reviews: 0, correct: 0 };
  }
  async function decksMap() { return await kv('decks', {}); }
  function deckCfg(decks, name) {
    var c = Object.assign({ focus: false, style: 'flash' }, decks[name] || {});
    if (c.style !== 'genmc') c.style = c.style === 'mc' ? 'genmc' : 'flash'; // v2 values: auto/recall -> flash, mc -> genmc
    return c;
  }
  // Scheduling settings in force at time t (so a replay uses what was used originally)
  function schedAt(hist, t) {
    var cur = { retention: DEFAULTS.retention, maxInterval: DEFAULTS.maxInterval, relearnMinutes: DEFAULTS.relearnMinutes };
    for (var i = 0; i < hist.length && hist[i].t <= t; i++) cur = hist[i];
    return cur;
  }
  async function schedHistory() {
    return (await kv('settingsHistory', [])).slice().sort(function (a, b) { return a.t - b.t; });
  }
  function cfgToken(h) { return 'cfg' + Math.round(h.retention * 100) + 'x' + h.maxInterval + 'x' + h.relearnMinutes + '.' + Math.round(h.t / 1000).toString(36); }
  async function addSchedHistory(entries) {
    var hist = await kv('settingsHistory', []), byT = {};
    hist.concat(entries).forEach(function (h) { byT[h.t] = { t: h.t, retention: h.retention, maxInterval: h.maxInterval, relearnMinutes: h.relearnMinutes }; });
    var out = Object.keys(byT).map(function (k) { return byT[k]; }).sort(function (a, b) { return a.t - b.t; });
    await setKv('settingsHistory', out);
    return out;
  }
  function fsrsOpts(s, seed) { return { retention: s.retention, maxInterval: s.maxInterval, relearnMinutes: s.relearnMinutes, seed: seed }; }

  /* ================= rich text: sanitize, math, images ================= */
  var ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, SUB: 1, SUP: 1, BR: 1, P: 1, DIV: 1, SPAN: 1, UL: 1, OL: 1, LI: 1, IMG: 1, TABLE: 1, TBODY: 1, THEAD: 1, TR: 1, TD: 1, TH: 1, HR: 1, CODE: 1, PRE: 1, FONT: 0 };
  var DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1, SVG: 1, svg: 1, FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1, AUDIO: 1, VIDEO: 1 };
  function sanitize(node) {
    Array.prototype.slice.call(node.childNodes).forEach(function (child) {
      if (child.nodeType === 1) {
        if (DROP[child.tagName]) { child.remove(); return; }
        sanitize(child);
        if (!ALLOWED[child.tagName]) { child.replaceWith.apply(child, Array.prototype.slice.call(child.childNodes)); return; }
        var src = child.tagName === 'IMG' ? child.getAttribute('src') || '' : '';
        var cls = child.getAttribute('class') === 'cloze' ? 'cloze' : '';
        Array.prototype.slice.call(child.attributes).forEach(function (at) {
          if (!(child.tagName === 'IMG' && at.name === 'alt')) child.removeAttribute(at.name);
        });
        if (cls) child.setAttribute('class', cls);
        if (child.tagName === 'IMG') {
          if (!src || /^\s*javascript:/i.test(src)) child.remove();
          else child.setAttribute('data-src', src); // nothing loads until resolved from this phone's image store
        }
      } else if (child.nodeType !== 3) {
        child.remove();
      }
    });
  }
  var MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;
  function renderMath(container) {
    if (!window.katex) return;
    var tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT), nodes = [];
    while (tw.nextNode()) nodes.push(tw.currentNode);
    nodes.forEach(function (n) {
      var s = n.nodeValue;
      if (s.indexOf('$') < 0 && s.indexOf('\\') < 0) return;
      MATH_RE.lastIndex = 0;
      if (!MATH_RE.test(s)) return;
      MATH_RE.lastIndex = 0;
      var frag = document.createDocumentFragment(), last = 0, m;
      while ((m = MATH_RE.exec(s))) {
        frag.append(s.slice(last, m.index));
        var display = m[1] !== undefined || m[2] !== undefined;
        var tex = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
        var span = document.createElement('span');
        span.className = display ? 'math display' : 'math';
        try { span.innerHTML = katex.renderToString(tex, { output: 'mathml', throwOnError: false, displayMode: display }); }
        catch (e) { span.textContent = m[0]; }
        frag.append(span);
        last = m.index + m[0].length;
      }
      frag.append(s.slice(last));
      n.replaceWith(frag);
    });
  }
  var blobUrls = {};
  async function resolveImages(container) {
    var imgs = Array.prototype.slice.call(container.querySelectorAll('img'));
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i], src = img.getAttribute('data-src') || img.getAttribute('src') || '';
      img.removeAttribute('data-src');
      if (/^(https?:|blob:|data:image\/)/i.test(src)) { img.src = src; continue; }
      var name = src.split('/').pop();
      try { name = decodeURIComponent(name); } catch (e) { /* keep raw */ }
      var url = blobUrls[name];
      if (!url) {
        var blob = await get('images', name);
        if (blob) { url = URL.createObjectURL(blob); blobUrls[name] = url; }
      }
      if (url) { img.src = url; img.setAttribute('data-zoom', '1'); }
      else {
        var sp = document.createElement('span');
        sp.className = 'missing-img';
        sp.textContent = '[missing image: ' + name + ']';
        img.replaceWith(sp);
      }
    }
  }
  async function renderRich(el, text, isHtml) {
    var html = isHtml
      ? (window.AnkiPkg ? AnkiPkg.convertLatex(String(text == null ? '' : text)) : String(text == null ? '' : text)).replace(/\[sound:[^\]]*\]/g, '')
      : esc(text).replace(/\r?\n/g, '<br>');
    var body = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html').body;
    sanitize(body);
    var holder = document.createElement('div');
    holder.append.apply(holder, Array.prototype.slice.call(body.childNodes).map(function (n) { return document.importNode(n, true); }));
    renderMath(holder);
    await resolveImages(holder);
    el.replaceChildren.apply(el, Array.prototype.slice.call(holder.childNodes));
  }
  function hasImage(s) { return /<img/i.test(s || ''); }

  /* ================= import parsing (text formats) ================= */
  function parseCSV(text, delim) {
    var rows = [], row = [], field = '', i = 0, q = false, c;
    while (i < text.length) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { q = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (f) { return f.trim() !== ''; }); });
  }
  function typeFrom(s, fallback) {
    s = String(s || '').toLowerCase().trim();
    if (/^(mc|mcq|multiple|choice)/.test(s)) return 'mc';
    if (/^(calc|calculation|num|numeric|number)/.test(s)) return 'num';
    if (/^(recall|basic|flashcard|self|free)/.test(s)) return 'recall';
    return fallback;
  }
  function withDirection(items, dir) {
    if (!dir || dir === 'term') return items;
    var flipped = items.map(function (it) { return Object.assign({}, it, { q: it.a, a: it.q, flip: true }); });
    return dir === 'def' ? flipped : items.concat(flipped);
  }
  function parseTwoCol(text, opts) {
    var items = [], skipped = 0;
    text.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var idx = line.indexOf('\t');
      if (idx < 0) { if (items.length) items[items.length - 1].a += '\n' + line; else skipped++; return; }
      items.push({ q: line.slice(0, idx).trim(), a: line.slice(idx + 1).trim(), type: 'auto', html: false });
    });
    items = items.filter(function (it) { if (!it.q || !it.a) { skipped++; return false; } return true; });
    return { format: 'Quizlet / two-column text', items: withDirection(items, opts.dir), skipped: skipped, twoCol: true };
  }
  function parseAnkiText(text, opts) {
    var sepNames = { tab: '\t', comma: ',', semicolon: ';', space: ' ', pipe: '|', colon: ':' };
    var meta = { sep: '\t', html: true, cols: {} }, body = [];
    text.split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^#([a-z ]+):(.*)$/i);
      if (m) {
        var key = m[1].trim().toLowerCase(), val = m[2].trim();
        if (key === 'separator') meta.sep = sepNames[val.toLowerCase()] || val || '\t';
        else if (key === 'html') meta.html = val.toLowerCase() === 'true';
        else if (/ column$/.test(key)) meta.cols[key.replace(/ column$/, '')] = parseInt(val, 10) - 1;
        return;
      }
      body.push(line);
    });
    var metaIdx = {};
    Object.keys(meta.cols).forEach(function (k) { metaIdx[meta.cols[k]] = k; });
    var items = [], skipped = 0;
    parseCSV(body.join('\n'), meta.sep).forEach(function (row) {
      var fields = [];
      row.forEach(function (f, i) { if (!(i in metaIdx)) fields.push(f); });
      var front = fields[0] || '', back = fields[1] || '';
      var notetype = meta.cols.notetype != null ? row[meta.cols.notetype] || '' : '';
      var deck = meta.cols.deck != null ? (row[meta.cols.deck] || '').split('::').join(' › ') : '';
      var guid = meta.cols.guid != null ? row[meta.cols.guid] : '';
      if (!front.trim()) { skipped++; return; }
      var nums = AnkiPkg.clozeNumbers(front);
      if (/cloze/i.test(notetype) || nums.length) {
        // one card per cloze number, like Anki
        nums.forEach(function (n) {
          items.push({
            q: AnkiPkg.renderCloze(front, n, 'q'),
            a: AnkiPkg.renderCloze(front, n, 'a') + (back.trim() ? '<br><br>' + back : ''),
            type: 'recall', html: true, deck: deck, idKey: (guid ? 'anki:' + guid : 'cloze:' + deck + '|' + norm(front)) + ':c' + n
          });
        });
        return;
      }
      if (!back.trim()) { skipped++; return; }
      items.push({ q: front, a: back, type: 'auto', html: meta.html, deck: deck, idKey: guid ? 'anki:' + guid : '' });
    });
    return { format: 'Anki “Notes in Plain Text”', items: withDirection(items, opts.dir), skipped: skipped, twoCol: true };
  }
  function parseStructured(text, delim, opts) {
    var rows = parseCSV(text, delim);
    var head = rows.shift().map(function (h) { return h.trim().toLowerCase(); });
    var col = function (name) { return head.indexOf(name); };
    var ix = {
      id: col('id'), deck: col('deck'), topic: col('topic'), type: col('type'), q: col('question'), a: col('answer'),
      options: col('options'), tol: col('tolerance'), expl: col('explanation'), src: col('source'), img: col('image'), aimg: col('answer image')
    };
    var items = [], skipped = 0;
    rows.forEach(function (r) {
      var g = function (k) { return ix[k] >= 0 ? (r[ix[k]] || '').trim() : ''; };
      var q = g('q'), a = g('a');
      if (!q || !a) { skipped++; return; }
      var options = g('options') ? g('options').split('|').map(function (s) { return s.trim(); }).filter(Boolean) : null;
      var tolRaw = g('tol'), tol = 0.02;
      if (tolRaw) { var tv = parseFloat(tolRaw.replace('%', '')); if (!isNaN(tv)) tol = tv / 100; }
      var looksHtml = /<\/?[a-z][^>]*>/i.test(q + a + g('expl') + (options || []).join(''));
      items.push({
        q: q, a: a, type: typeFrom(g('type'), 'auto'), opts: options, tol: tol, expl: g('expl'), src: g('src'),
        img: g('img'), aimg: g('aimg'), topic: g('topic'), deck: g('deck'), html: looksHtml,
        idKey: g('id') ? 'id:' + (g('deck') || opts.deck || '') + ':' + g('id') : ''
      });
    });
    return { format: 'Structured CSV', items: items, skipped: skipped };
  }
  function parseText(text, opts) {
    text = text.replace(/^﻿/, '');
    var lines = text.split(/\r?\n/);
    if (lines.some(function (l) { return /^#(separator|html|columns|notetype column|deck column|guid column|tags column):/i.test(l); }))
      return parseAnkiText(text, opts);
    var first = (lines[0] || '').toLowerCase();
    var delims = ['\t', ',', ';'];
    for (var i = 0; i < delims.length; i++) {
      var cols = first.split(delims[i]).map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
      if (cols.indexOf('question') >= 0 && cols.indexOf('answer') >= 0) return parseStructured(text, delims[i], opts);
    }
    if (text.indexOf('\t') >= 0) return parseTwoCol(text, opts);
    throw new Error('Could not recognise this file. Use an Anki package (.apkg), a Quizlet export (tab between term and definition), an Anki “Notes in Plain Text” export, or a CSV with question and answer columns.');
  }

  /* ================= cards, events and replay ================= */
  function buildCard(it, deckDefault) {
    var deck = (it.deck || deckDefault || 'Imported').trim();
    var key = it.idKey ? it.idKey + (it.flip ? ':rev' : '') : 'q:' + deck + '|' + norm(it.q) + (hasImage(it.q) ? '|' + (it.q.match(/<img[^>]*>/gi) || []).join('') : '');
    return {
      id: hid(key), key: key, deck: deck, topic: it.topic || '', type: it.type || 'auto',
      q: it.q, a: it.a, opts: it.opts || null, tol: it.tol == null ? 0.02 : it.tol, expl: it.expl || '',
      src: it.src || '', img: it.img || '', aimg: it.aimg || '', html: !!it.html, flip: !!it.flip
    };
  }
  var CONTENT_FIELDS = ['deck', 'topic', 'type', 'q', 'a', 'opts', 'tol', 'expl', 'src', 'img', 'aimg', 'html'];

  async function replayCards(ids) {
    var hist = await schedHistory();
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var c = await get('cards', ids[i]);
      if (!c) continue;
      var evs = (await reviewsFor(c.id)).sort(function (a, b) { return a.t - b.t; });
      var st = null;
      evs.forEach(function (e) { st = FSRS.review(st, e.g, e.t, fsrsOpts(schedAt(hist, e.t), seedFor(c.id, (st ? st.reps : 0) + 1))); });
      c.st = st;
      out.push(c);
    }
    if (out.length) await putMany('cards', out);
  }

  // items: parsed cards; events: [{key|id, g, t, src}]; media: [{name, blob}]
  async function commitImport(items, deckDefault, events, media) {
    var all = await getAll('cards');
    var byId = {};
    all.forEach(function (c) { byId[c.id] = c; });
    var nextOrder = await kv('nextOrder', 1);
    var seen = {}, out = [], added = 0, updated = 0, unchanged = 0, dupes = 0, now = Date.now();
    items.forEach(function (it) {
      var c = buildCard(it, deckDefault);
      if (seen[c.id]) dupes++;
      seen[c.id] = c;
    });
    Object.keys(seen).forEach(function (id) {
      var c = seen[id], old = byId[id];
      if (old) {
        var changed = CONTENT_FIELDS.some(function (f) { return JSON.stringify(old[f]) !== JSON.stringify(c[f]); });
        if (changed) { CONTENT_FIELDS.forEach(function (f) { old[f] = c[f]; }); out.push(old); updated++; }
        else unchanged++;
      } else {
        c.st = null; c.order = nextOrder++; c.created = now;
        out.push(c); added++;
      }
    });
    if (out.length) await putMany('cards', out);
    await setKv('nextOrder', nextOrder);
    var decks = await decksMap();
    Object.keys(seen).forEach(function (id) { var d = seen[id].deck; if (!decks[d]) decks[d] = { focus: false, style: 'flash' }; });
    await setKv('decks', decks);
    var imgCount = 0;
    if (media && media.length) { await putPairs('images', media.map(function (m) { return [m.name, m.blob]; })); imgCount = media.length; }
    var histCards = 0;
    if (events && events.length) {
      var existing = {};
      (await getAllKeys('reviews')).forEach(function (k) { existing[k] = 1; });
      var fresh = [], touched = {};
      events.forEach(function (e) {
        var id = e.id || hid(e.key);
        if (!byId[id] && !seen[id]) return;
        var k = id + '|' + e.t;
        if (existing[k]) return;
        existing[k] = 1;
        fresh.push({ k: k, id: id, g: e.g, t: e.t, src: e.src || 'anki' });
        touched[id] = 1;
      });
      if (fresh.length) { await putMany('reviews', fresh); await replayCards(Object.keys(touched)); }
      histCards = Object.keys(touched).length;
    }
    return { added: added, updated: updated, unchanged: unchanged, dupes: dupes, images: imgCount, history: histCards };
  }

  /* ================= scheduling ================= */
  function inPool(c, decks, s, deckFilter) {
    if (deckFilter) return deckFilter.indexOf(c.deck) >= 0;
    if (s.mode === 'focus') return deckCfg(decks, c.deck).focus;
    return true;
  }
  function lastStudiedByDeck(all) {
    var last = {};
    all.forEach(function (c) { if (c.st) last[c.deck] = Math.max(last[c.deck] || 0, c.st.last); });
    return last;
  }
  // Due cards are interleaved across decks: the deck studied longest ago goes first,
  // and within a deck the card most likely to be forgotten goes first.
  async function buildBatch(size, deckFilter) {
    var all = await getAll('cards'), decks = await decksMap(), s = await settings(), d = await daily(), now = Date.now();
    var pool = all.filter(function (c) { return inPool(c, decks, s, deckFilter); });
    var last = lastStudiedByDeck(all);
    var byDeckOrder = function (names) { return names.sort(function (a, b) { return (last[a] || 0) - (last[b] || 0) || a.localeCompare(b); }); };
    var dueGroups = {};
    pool.forEach(function (c) {
      if (!c.st || c.st.due > now) return;
      var pr = c.st.state === 'learning' || c.st.state === 'relearning' ? -1 : FSRS.retrievability((now - c.st.last) / DAY, c.st.s);
      (dueGroups[c.deck] = dueGroups[c.deck] || []).push({ c: c, pr: pr });
    });
    Object.keys(dueGroups).forEach(function (k) { dueGroups[k].sort(function (a, b) { return a.pr - b.pr || a.c.st.due - b.c.st.due; }); });
    var batch = [], dueCount = 0;
    Object.keys(dueGroups).forEach(function (k) { dueCount += dueGroups[k].length; });
    var order = byDeckOrder(Object.keys(dueGroups));
    for (var round = 0; batch.length < size; round++) {
      var took = false;
      for (var i = 0; i < order.length && batch.length < size; i++) {
        var g = dueGroups[order[i]][round];
        if (g) { batch.push(g.c); took = true; }
      }
      if (!took) break;
    }
    var newLeft = Math.max(0, s.newPerDay - d.newIntro);
    if (batch.length < size && newLeft > 0) {
      var newGroups = {};
      pool.forEach(function (c) { if (!c.st) (newGroups[c.deck] = newGroups[c.deck] || []).push(c); });
      Object.keys(newGroups).forEach(function (k) { newGroups[k].sort(function (a, b) { return a.order - b.order; }); });
      var norder = byDeckOrder(Object.keys(newGroups));
      for (var r2 = 0; batch.length < size && newLeft > 0; r2++) {
        var took2 = false;
        for (var j = 0; j < norder.length && batch.length < size && newLeft > 0; j++) {
          var nc = newGroups[norder[j]][r2];
          if (nc) { batch.push(nc); newLeft--; took2 = true; }
        }
        if (!took2) break;
      }
    }
    return { batch: batch, all: all, dueCount: dueCount };
  }

  async function recordReview(c, g) {
    var s = await settings();
    var now = Math.round(Date.now() / 1000) * 1000; // second precision: a replay from the log is exact
    var wasNew = !c.st;
    c.st = FSRS.review(c.st, g, now, fsrsOpts(s, seedFor(c.id, (c.st ? c.st.reps : 0) + 1)));
    await put('cards', c);
    await put('reviews', { k: c.id + '|' + now, id: c.id, g: g, t: now, src: 'app' });
    var un = await kv('unsent', []);
    un.push(c.id + '.' + g + '.' + Math.round(now / 1000).toString(36));
    await setKv('unsent', un);
    var d = await daily();
    d.reviews++;
    if (g > 1) d.correct++;
    if (wasNew) d.newIntro++;
    await setKv('daily', d);
  }
  function previewIntervals(c, s) {
    var now = Date.now();
    return [1, 2, 3, 4].map(function (g) {
      var st = FSRS.review(c.st, g, now, fsrsOpts(s, 5003)); // 5003 = middle of the fuzz range
      return fmtIvl(st.due - now);
    });
  }
  function shortAnswer(c) {
    if (hasImage(c.a) || c.aimg) return false;
    var t = stripHtml(c.a).trim();
    return t.length > 0 && t.length <= 60 && !/\n/.test(c.a) && !/<br|<li|<div/i.test(c.a);
  }
  function distractors(c, all) {
    var correct = norm(c.a), numeric = /^[-+]?[\d.]/.test(correct), len = correct.length || 1;
    var seen = {}; seen[correct] = 1;
    (c.excl || []).forEach(function (x) { seen[x] = 1; });
    var out = [];
    var take = function (pool) {
      shuffle(pool.slice()).forEach(function (o) {
        var n = norm(o.a);
        if (out.length < 3 && n && !seen[n]) { seen[n] = 1; out.push(o.a); }
      });
    };
    var similar = function (o) {
      var n = norm(o.a);
      return /^[-+]?[\d.]/.test(n) === numeric && n.length <= len * 3 + 10 && n.length * 3 + 10 >= len;
    };
    var usable = all.filter(function (o) { return o.id !== c.id && !!o.flip === !!c.flip && o.type !== 'recall' && o.type !== 'num' && shortAnswer(o); });
    var sameDeck = usable.filter(function (o) { return o.deck === c.deck; });
    take(sameDeck.filter(similar));
    if (out.length < 3) take(sameDeck);
    if (out.length < 3) take(usable.filter(similar));
    return out.length === 3 ? out : null;
  }
  // -> {type: 'mc'|'num'|'recall', options}
  function resolveType(c, decks, all) {
    var style = deckCfg(decks, c.deck).style;
    if (c.type === 'num') {
      var a = parseQuantity(c.a, true);
      return a ? { type: 'num' } : { type: 'recall' };
    }
    if (c.opts && c.opts.length >= 2) {           // the card's own, original answer choices
      var o = c.opts.slice();
      if (!o.some(function (x) { return norm(x) === norm(c.a); })) o[0] = c.a;
      return { type: 'mc', options: o };
    }
    if (style === 'genmc' && c.type !== 'recall' && shortAnswer(c)) { // opt-in, experimental
      var ds = distractors(c, all);
      if (ds) return { type: 'mc', options: [c.a].concat(ds), generated: true };
    }
    return { type: 'recall' };                    // default: flashcard
  }

  /* ================= hand-off to ABR Pass, with confirmation ================= */
  var TOKEN_RE = /(cfg\d+x\d+x\d+\.[0-9a-z]+)|([0-9a-z]+\.[1-4]\.[0-9a-z]+)/g;
  function tokensIn(text) {
    var out = [], str = String(text || ''), k = str.indexOf('abr1');
    if (k < 0) return out;
    var part = str.slice(k + 4), m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(part))) out.push(m[1] || m[2]);
    return out;
  }
  // token -> {n: times sent, last: when last sent}; entries leave only when ABR Gate confirms them
  async function pendingMap() {
    var p0 = await kv('pending', {});
    if (Array.isArray(p0)) { var m = {}; p0.forEach(function (t) { m[t] = { n: 1, last: 0 }; }); return m; }
    return p0 || {};
  }
  async function processAck(ackText) {
    if (!ackText || String(ackText).indexOf('abr1') < 0) return; // old "pass" content: no confirmation channel yet
    var toks = tokensIn(ackText), pend = await pendingMap(), n = 0;
    toks.forEach(function (t) { if (pend[t]) { delete pend[t]; n++; } });
    await setKv('pending', pend);
    await setKv('ackSeen', true);
    await setKv('lastAck', { t: Date.now(), n: toks.length, cleared: n });
  }
  async function goPass() {
    var un = await kv('unsent', []), pend = await pendingMap(), now = Date.now();
    var send = un.slice(0, MAX_TOKENS_PER_CALL);              // never-sent first, oldest first
    var inSend = {};
    send.forEach(function (t) { inSend[t] = 1; });
    var room = MAX_TOKENS_PER_CALL - send.length;
    if (room > 0) {                                           // then re-send unconfirmed ones, least recently sent first
      var again = Object.keys(pend).filter(function (t) { return !inSend[t]; })
        .sort(function (a, b) { return (pend[a].last - pend[b].last) || (pend[a].n - pend[b].n); }).slice(0, room);
      send = again.concat(send);
    }
    send.forEach(function (t) { pend[t] = { n: (pend[t] ? pend[t].n : 0) + 1, last: now }; });
    await setKv('pending', pend);
    await setKv('unsent', un.filter(function (t) { return !inSend[t]; }));
    await setKv('lastPass', now);
    var text = 'abr1;' + (send.length ? send.join(';') : 'none'); // only a-z 0-9 . ; so it is safe inside &ack=
    navigate('shortcuts://run-shortcut?name=' + encodeURIComponent(PASS_SHORTCUT) + '&input=text&text=' + encodeURIComponent(text));
  }

  /* ================= restore from reviews-log.txt ================= */
  function parseLog(text) {
    var events = {}, cfgs = {};
    String(text).split(/\r?\n/).forEach(function (line) {
      tokensIn(line).forEach(function (tok) {
        var m = tok.match(/^cfg(\d+)x(\d+)x(\d+)\.([0-9a-z]+)$/);
        if (m) {
          var tc = parseInt(m[4], 36) * 1000;
          cfgs[tc] = { t: tc, retention: parseInt(m[1], 10) / 100, maxInterval: parseInt(m[2], 10), relearnMinutes: parseInt(m[3], 10) };
          return;
        }
        var p2 = tok.split('.'), t = parseInt(p2[2], 36) * 1000;
        events[p2[0] + '|' + t] = { id: p2[0], g: parseInt(p2[1], 10), t: t };
      });
    });
    var list = Object.keys(events).map(function (k) { return events[k]; }).sort(function (a, b) { return a.t - b.t; });
    list.cfgs = Object.keys(cfgs).map(function (k) { return cfgs[k]; });
    return list;
  }
  async function recomputeDaily() {
    var t0 = startOfToday(), rv = await getAll('reviews');
    var first = {}, d = { date: todayStr(), newIntro: 0, reviews: 0, correct: 0 };
    rv.sort(function (a, b) { return a.t - b.t; }).forEach(function (e) {
      if (first[e.id] == null) { first[e.id] = e.t; if (e.t >= t0) d.newIntro++; }
      if (e.t >= t0) { d.reviews++; if (e.g > 1) d.correct++; }
    });
    await setKv('daily', d);
  }
  async function restoreFromLog(text) {
    var list = parseLog(text);
    if (list.cfgs.length) {
      var hist = await addSchedHistory(list.cfgs), latest = hist[hist.length - 1], s = await settings();
      if (latest.t >= (await kv('settingsChangedAt', 0))) {
        s.retention = latest.retention; s.maxInterval = latest.maxInterval; s.relearnMinutes = latest.relearnMinutes;
        await saveSettingsObj(s);
      }
    }
    var ids = {};
    (await getAllKeys('cards')).forEach(function (k) { ids[k] = 1; });
    var existing = {};
    (await getAllKeys('reviews')).forEach(function (k) { existing[k] = 1; });
    var fresh = [], touched = {}, unknown = {};
    list.forEach(function (e) {
      if (!ids[e.id]) { unknown[e.id] = 1; return; }
      touched[e.id] = 1;
      var k = e.id + '|' + e.t;
      if (!existing[k]) { existing[k] = 1; fresh.push({ k: k, id: e.id, g: e.g, t: e.t, src: 'log' }); }
    });
    if (fresh.length) await putMany('reviews', fresh);
    await replayCards(Object.keys(touched));
    await recomputeDaily();
    return { events: list.length, cards: Object.keys(touched).length, unknown: Object.keys(unknown).length };
  }

  /* ================= full backup (.zip with images and history) ================= */
  async function exportBackup() {
    var zip = new JSZip();
    zip.file('backup.json', JSON.stringify({
      app: 'abr-unlock', version: 3, exported: new Date().toISOString(),
      settings: await kv('settings', {}), settingsHistory: await kv('settingsHistory', []), decks: await decksMap(), nextOrder: await kv('nextOrder', 1),
      cards: await getAll('cards'), reviews: await getAll('reviews')
    }));
    var names = await getAllKeys('images');
    for (var i = 0; i < names.length; i++) zip.file('media/' + names[i], await get('images', names[i]), { binary: true });
    var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'abr-unlock-backup-' + todayStr() + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    return names.length;
  }
  async function importBackupZip(zip) {
    var data = JSON.parse(await zip.file('backup.json').async('string'));
    if (data.app !== 'abr-unlock' || !Array.isArray(data.cards)) throw new Error('This is not an ABR Unlock backup.');
    await putMany('cards', data.cards);
    if (data.reviews && data.reviews.length) await putMany('reviews', data.reviews);
    if (data.settings) await setKv('settings', data.settings);
    if (data.settingsHistory && data.settingsHistory.length) await addSchedHistory(data.settingsHistory);
    if (data.decks) await setKv('decks', Object.assign(await decksMap(), data.decks));
    if (data.nextOrder) await setKv('nextOrder', Math.max(data.nextOrder, await kv('nextOrder', 1)));
    var pairs = [], files = zip.file(/^media\//);
    for (var i = 0; i < files.length; i++) {
      var name = files[i].name.slice(6), ext = name.split('.').pop().toLowerCase();
      pairs.push([name, new Blob([await files[i].async('arraybuffer')], { type: AnkiPkg.IMAGE_EXT[ext] || 'application/octet-stream' })]);
    }
    if (pairs.length) await putPairs('images', pairs);
    await recomputeDaily();
    return { cards: data.cards.length, reviews: (data.reviews || []).length, images: pairs.length };
  }
  async function imagesFromZip(zip) {
    var pairs = [];
    var files = zip.file(/\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i);
    for (var i = 0; i < files.length; i++) {
      if (files[i].dir) continue;
      var name = files[i].name.split('/').pop(), ext = name.split('.').pop().toLowerCase();
      if (!name || name[0] === '.') continue;
      pairs.push([name, new Blob([await files[i].async('arraybuffer')], { type: AnkiPkg.IMAGE_EXT[ext] })]);
    }
    if (pairs.length) await putPairs('images', pairs);
    return pairs.length;
  }

  /* ================= quiz ================= */
  var Q = null;

  async function startQuiz(mode, deckFilter) {
    var s = await settings();
    var size = mode === 'gate' ? s.batch : 20;
    var r = await buildBatch(size, deckFilter || null);
    Q = {
      mode: mode, deckFilter: deckFilter || null, entries: r.batch.map(function (c) { return { c: c, retry: false }; }),
      all: r.all, decks: await decksMap(), settings: s, i: 0, results: [], answered: false, pending: null
    };
    if (!Q.entries.length) return showDone(true);
    showCard();
  }

  function headerHtml(entry) {
    var c = entry.c, total = Q.entries.length;
    return '<div class="spread"><span class="chip">' + esc(c.deck) + (c.topic ? ' · ' + esc(c.topic) : '') + '</span>' +
      '<span class="muted small" id="pos">' + (Q.i + 1) + ' of ' + total + (entry.retry ? ' · retry' : c.st ? '' : ' · new') + '</span></div>' +
      '<div class="progress"><i style="width:' + Math.round(Q.i / total * 100) + '%"></i></div>';
  }

  async function showCard() {
    var entry = Q.entries[Q.i], c = entry.c;
    Q.answered = false; Q.pending = null;
    if (Q.timer) { clearInterval(Q.timer); Q.timer = null; }
    var rt = resolveType(c, Q.decks, Q.all);
    Q.type = rt.type;
    Q.generated = !!rt.generated;
    app.innerHTML = headerHtml(entry) +
      (Q.mode === 'gate' && Q.i === 0 ? '<p class="muted small">' + (Q.settings.unlockRule === 'correct' ? 'Get ' : 'Answer ') +
        (Q.entries.length === 1 ? 'this card' : 'these ' + Q.entries.length + ' cards') + (Q.settings.unlockRule === 'correct' ? ' right' : '') + ' to unlock your apps.</p>' : '') +
      '<div class="card"><div class="q rich" id="q"></div><div class="qimg rich" id="qimg"></div></div><div id="area"></div>';
    await renderRich(document.getElementById('q'), c.q, c.html);
    if (c.img) await renderRich(document.getElementById('qimg'), '<img src="' + esc(c.img) + '" alt="">', true);
    var area = document.getElementById('area');
    if (rt.type === 'mc') {
      Q.options = shuffle(rt.options.slice());
      area.innerHTML = '<div class="opts">' + Q.options.map(function (o, i) {
        return '<button class="opt" data-act="pick" data-i="' + i + '"><span class="mark"></span><span class="rich" id="opt' + i + '"></span></button>';
      }).join('') + '</div>' +
        (rt.generated ? '<p class="muted small" style="margin-top:8px">Generated choices (taken from your other cards): more than one may be defensible.</p>' : '') +
        '<div id="fb"></div>';
      for (var i = 0; i < Q.options.length; i++) await renderRich(document.getElementById('opt' + i), Q.options[i], c.html);
    } else if (rt.type === 'num') {
      area.innerHTML = '<div class="card"><label for="numIn">Your answer (number, units optional)</label>' +
        '<input id="numIn" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. 2.5 or 2.5 mGy">' +
        '<p class="small" id="numMsg" style="margin:6px 0 0;color:var(--bad)"></p>' +
        '<div style="margin-top:8px"><button class="primary big" data-act="checkNum">Check</button></div>' +
        '<button class="link small" data-act="giveUp" style="margin-top:6px">I don’t know, show the solution</button></div><div id="fb"></div>';
      var inp = document.getElementById('numIn');
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') checkNum(); });
      inp.addEventListener('input', function () { document.getElementById('numMsg').textContent = ''; });
    } else {
      var wait = Math.max(0, Math.round(Q.settings.thinkSeconds || 0));
      area.innerHTML = '<button class="primary big" data-act="reveal" id="revealBtn"' + (wait ? ' disabled' : '') + '>' +
        (wait ? 'Recall it first… ' + wait : 'Show answer') + '</button><div id="fb"></div>';
      if (wait) {
        var left = wait, btn = document.getElementById('revealBtn');
        Q.timer = setInterval(function () {
          left--;
          if (left > 0) { btn.textContent = 'Recall it first… ' + left; return; }
          clearInterval(Q.timer); Q.timer = null;
          btn.disabled = false; btn.textContent = 'Show answer';
        }, 1000);
      }
    }
  }

  async function renderAnswerInto(el, c) {
    await renderRich(el, c.a + (c.aimg ? '<br><img src="' + esc(c.aimg) + '" alt="">' : ''), c.html || !!c.aimg);
  }

  async function feedback(ok, opts) {
    opts = opts || {};
    var c = Q.entries[Q.i].c;
    var fb = document.getElementById('fb');
    fb.innerHTML = '<div class="feedback ' + (ok ? 'ok' : opts.gaveUp ? 'sol' : 'bad') + '" id="fbBox"><b id="fbTitle">' + (ok ? '✓ Correct' : opts.gaveUp ? 'Solution' : '✗ Not quite') + '</b>' +
      '<div class="rich ans" style="margin-top:6px"><span class="small muted">' + (ok ? 'Answer' : 'Correct answer') + '</span><div id="fbAns"></div></div>' +
      (c.expl ? '<div class="expl rich" id="fbExpl"></div>' : '') +
      (!ok && Q.type === 'mc' && !opts.gaveUp && !Q.entries[Q.i].retry ? '<button class="link small" data-act="override" id="ovr">My choice was also correct…</button>' : '') +
      '</div><div style="margin-top:12px"><button class="primary big" data-act="next">' + (Q.i + 1 < Q.entries.length ? 'Next' : 'Finish') + '</button></div>';
    await renderAnswerInto(document.getElementById('fbAns'), c);
    if (c.expl) await renderRich(document.getElementById('fbExpl'), c.expl, c.html);
    fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function pick(i) {
    if (Q.answered) return;
    Q.answered = true;
    var c = Q.entries[Q.i].c;
    var correctIdx = Q.options.findIndex(function (o) { return norm(o) === norm(c.a); });
    var ok = i === correctIdx;
    app.querySelectorAll('.opt').forEach(function (b, j) {
      b.disabled = true;
      if (j === correctIdx) { b.classList.add('ok'); b.querySelector('.mark').textContent = '✓'; }
      else if (j === i) { b.classList.add('bad'); b.querySelector('.mark').textContent = '✗'; }
    });
    Q.pending = { g: ok ? 3 : 1, picked: norm(Q.options[i]) };
    await feedback(ok);
  }

  async function checkNum() {
    if (Q.answered) return;
    var c = Q.entries[Q.i].c;
    var inp = document.getElementById('numIn'), msg = document.getElementById('numMsg');
    var r = gradeNumber(inp.value, c.a, c.tol);
    if (r.status === 'invalid') { msg.textContent = 'Type a number first (for example 2.5, 2,5 or 3e-4), optionally followed by a unit.'; inp.focus(); return; }
    if (r.status === 'unit') { msg.textContent = r.expected ? 'Use ' + r.expected + ' (or a prefixed form of it), or leave the unit off.' : 'Leave the unit off for this one.'; inp.focus(); return; }
    Q.answered = true;
    inp.disabled = true;
    var ok = r.status === 'ok';
    Q.pending = { g: ok ? 3 : 1 };
    await feedback(ok);
  }

  async function giveUp() {
    if (Q.answered) return;
    Q.answered = true;
    var inp = document.getElementById('numIn'); if (inp) inp.disabled = true;
    Q.pending = { g: 1 };
    await feedback(false, { gaveUp: true });
  }

  async function override() {
    if (!Q.pending || Q.pending.g !== 1 || Q.type !== 'mc') return;
    var o0 = document.getElementById('ovr');
    if (o0 && !o0.getAttribute('data-armed')) {   // first tap only asks for confirmation
      o0.setAttribute('data-armed', '1');
      o0.textContent = 'Tap again to count your choice as correct (that option won’t be offered for this card again)';
      return;
    }
    var c = Q.entries[Q.i].c;
    Q.pending.g = 3;
    if (Q.pending.picked) { c.excl = uniq((c.excl || []).concat([Q.pending.picked])); }
    var box = document.getElementById('fbBox');
    box.classList.remove('bad'); box.classList.add('ok');
    document.getElementById('fbTitle').textContent = '✓ Counted as correct';
    var o = document.getElementById('ovr'); if (o) o.remove();
  }

  async function reveal() {
    var c = Q.entries[Q.i].c;
    var iv = previewIntervals(c, Q.settings);
    var fb = document.getElementById('fb');
    app.querySelector('[data-act="reveal"]').classList.add('hidden');
    var retry = Q.entries[Q.i].retry;
    fb.innerHTML = '<div class="card"><div class="q rich" id="ans"></div>' + (c.expl ? '<div class="expl rich" id="ansExpl"></div>' : '') + '</div>' +
      '<p class="muted small center">How well did you recall it?</p>' +
      '<div class="ratings">' + ['Again', 'Hard', 'Good', 'Easy'].map(function (l, i) {
        return '<button data-act="rate" data-g="' + (i + 1) + '"' + (i === 2 ? ' class="primary"' : '') + '>' + l +
          (retry ? '' : '<small' + (i === 2 ? ' style="color:inherit;opacity:.8"' : '') + '>' + iv[i] + '</small>') + '</button>';
      }).join('') + '</div>';
    await renderAnswerInto(document.getElementById('ans'), c);
    if (c.expl) await renderRich(document.getElementById('ansExpl'), c.expl, c.html);
    fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function finishCard(g) {
    var entry = Q.entries[Q.i];
    if (!entry.retry) {
      await recordReview(entry.c, g);
      Q.results.push(g > 1);
    }
    if (g === 1 && Q.settings.unlockRule === 'correct' && Q.mode === 'gate') Q.entries.push({ c: entry.c, retry: true });
    Q.i++;
    if (Q.i < Q.entries.length) showCard(); else showDone(false);
  }
  async function next() {
    if (!Q.pending) return;
    var g = Q.pending.g;
    Q.pending = null;
    await finishCard(g);
  }
  async function rate(g) {
    if (Q.answered) return;
    Q.answered = true;
    await finishCard(g);
  }

  async function nextDueText(deckFilter) {
    var all = await getAll('cards'), decks = await decksMap(), s = await settings(), now = Date.now();
    var dues = all.filter(function (c) { return c.st && inPool(c, decks, s, deckFilter); }).map(function (c) { return c.st.due; });
    if (!dues.length) return '';
    var m = Math.min.apply(null, dues);
    return m <= now ? 'More cards are due now.' : 'Next card due in ' + fmtIvl(m - now) + '.';
  }

  async function showDone(empty) {
    var total = (await getAllKeys('cards')).length;
    var n = Q ? Q.results.length : 0, ok = Q ? Q.results.filter(Boolean).length : 0;
    var un = await kv('unsent', []);
    var gate = Q && Q.mode === 'gate';
    var s = await settings();
    var title = empty ? (total ? 'Nothing due right now' : 'No cards yet') : 'Done';
    var sub = empty
      ? (total ? 'You’re clear' + (s.mode === 'focus' && gate ? ' in Focus mode' : '') + '. ' + (await nextDueText(Q && Q.deckFilter)) : 'Open ABR Unlock in Safari to import your cards.')
      : ok + ' of ' + n + ' correct. ' + (await nextDueText(Q && Q.deckFilter));
    app.innerHTML =
      '<div class="card center" style="margin-top:28px"><h1>' + esc(title) + '</h1><p class="muted">' + esc(sub) + '</p></div>' +
      (gate
        ? '<button class="primary big" data-act="pass">Unlock apps</button><p class="muted small center" style="margin-top:8px">Safari will ask to open Shortcuts; tap Open. Then go back to your app.</p>'
        : '<button class="primary big" data-act="pass"' + (un.length ? '' : ' disabled') + '>Back up progress</button>' +
          '<p class="muted small center" style="margin-top:8px">' + (un.length ? un.length + ' review' + (un.length > 1 ? 's' : '') + ' not backed up yet.' : 'Everything has been sent to the log.') + '</p>' +
          (empty ? '' : '<button class="big" data-act="studyMore" style="margin-top:10px">Study more</button>') +
          '<button class="link" data-act="home" style="margin-top:10px">← Home</button>');
  }

  /* ================= home ================= */
  async function showHome(msg) {
    Q = null;
    var all = await getAll('cards'), decks = await decksMap(), s = await settings(), d = await daily(), now = Date.now();
    var un = await kv('unsent', []), pend = Object.keys(await pendingMap()), ackSeen = await kv('ackSeen', false), lastAck = await kv('lastAck', null);
    if (typeof lastAck === 'number') lastAck = lastAck ? { t: lastAck, n: 0 } : null;
    var byDeck = {};
    all.forEach(function (c) {
      var x = byDeck[c.deck] || (byDeck[c.deck] = { total: 0, fresh: 0, due: 0, last: 0 });
      x.total++;
      if (!c.st) x.fresh++; else { if (c.st.due <= now) x.due++; x.last = Math.max(x.last, c.st.last); }
    });
    var dueNow = 0, freshPool = 0;
    all.forEach(function (c) { if (!inPool(c, decks, s, null)) return; if (!c.st) freshPool++; else if (c.st.due <= now) dueNow++; });
    var newLeft = Math.min(freshPool, Math.max(0, s.newPerDay - d.newIntro));
    var names = Object.keys(byDeck).sort(function (a, b) { return (byDeck[a].last - byDeck[b].last) || a.localeCompare(b); });
    var focusCount = names.filter(function (n) { return deckCfg(decks, n).focus; }).length;
    var focus = s.mode === 'focus';
    app.innerHTML =
      '<h1>ABR Unlock</h1><p class="muted small">Spaced repetition before your apps open.</p>' +
      missingHtml() +
      (msg ? '<div class="notice">' + msg + '</div>' : '') +
      '<div class="seg" role="group" aria-label="Study mode">' +
        '<button data-act="mode" data-mode="general"' + (focus ? '' : ' class="on"') + '>General</button>' +
        '<button data-act="mode" data-mode="focus"' + (focus ? ' class="on"' : '') + '>Focus' + (focusCount ? ' (' + focusCount + ')' : '') + '</button></div>' +
      '<p class="muted small" style="margin-top:6px">' + (focus
        ? (focusCount ? 'Only the ticked decks are used, still on their FSRS schedule.' : 'Tick the decks you want to focus on below.')
        : 'All decks. The deck you studied longest ago comes first, and decks are mixed within each batch.') + '</p>' +
      '<div class="stats">' +
        '<div class="stat"><b>' + dueNow + '</b><span>due now</span></div>' +
        '<div class="stat"><b>' + newLeft + '</b><span>new today</span></div>' +
        '<div class="stat"><b>' + d.reviews + '</b><span>reviewed</span></div>' +
        '<div class="stat"><b>' + all.length + '</b><span>cards</span></div>' +
      '</div>' +
      '<button class="primary big" data-act="study"' + (dueNow + newLeft ? '' : ' disabled') + '>' + (dueNow + newLeft ? 'Study now' : 'Nothing due') + '</button>' +

      '<div class="card"><h2>Decks</h2>' + (names.length ? names.map(function (n) {
        var x = byDeck[n], cfg = deckCfg(decks, n);
        return '<div class="deck"><div class="spread">' +
          (focus ? '<label class="toggle"><input type="checkbox" data-act="deckFocus" data-deck="' + esc(n) + '"' + (cfg.focus ? ' checked' : '') + '> <b>' + esc(n) + '</b></label>'
                 : '<b class="deckname">' + esc(n) + '</b>') +
          '<button class="small" data-act="studyDeck" data-deck="' + esc(n) + '"' + (x.due || x.fresh ? '' : ' disabled') + '>Study</button></div>' +
          '<div class="muted small">' + x.total + ' cards · ' + x.due + ' due · ' + x.fresh + ' new · studied ' + fmtAgo(x.last) + '</div>' +
          '<div class="row small" style="margin-top:6px"><label class="inline">Style <select data-act="deckStyle" data-deck="' + esc(n) + '">' +
            '<option value="flash"' + (cfg.style === 'flash' ? ' selected' : '') + '>Flashcard</option>' +
            '<option value="genmc"' + (cfg.style === 'genmc' ? ' selected' : '') + '>Generated choices (experimental)</option></select></label>' +
            '<button class="link danger" data-act="deckDelete" data-deck="' + esc(n) + '">Delete</button></div></div>';
      }).join('') : '<p class="muted">No cards yet. Import a file below.</p>') +
      '<p class="muted small" style="margin-top:8px">Cards are shown exactly as written, as flashcards: recall the answer, reveal it, rate yourself. Multiple choice appears only for cards that come with their own answer choices; calculation cards ask for a number. “Generated choices” builds options from your other cards and may produce more than one defensible answer.</p></div>' +

      '<div class="card"><h2>Import cards</h2>' +
        '<p class="muted small"><b>Best for Quizlet sets with images:</b> in Anki, export an <b>Anki Deck Package (.apkg)</b> or <b>Collection Package (.colpkg)</b> with “Include media” and “Support older Anki versions” ticked. Also accepted: Quizlet .txt export, Anki “Notes in Plain Text”, or CSV. Importing again updates cards and keeps your progress. Anki styling (CSS) and scripts aren’t carried over; text, images and formulas are.</p>' +
        '<p class="muted small">Cards are stored in this browser, on this device only. To study on your iPhone, import there; or import on your computer, then use <b>Export full backup</b> and import that .zip on the iPhone.</p>' +
        '<input type="file" id="impFile">' +
        '<div id="impOpts" class="hidden">' +
          '<div id="impTextOpts"><label for="impDeck">Deck name (if the file has none)</label><input type="text" id="impDeck">' +
          '<div id="impDirWrap"><label for="impDir">Ask</label><select id="impDir">' +
            '<option value="term">Front → back (term → definition)</option>' +
            '<option value="def">Back → front</option>' +
            '<option value="both">Both directions</option></select></div></div>' +
          '<p class="muted small" id="impPreview" style="margin-top:10px"></p>' +
          '<button class="primary big" data-act="doImport" id="impBtn">Import</button>' +
        '</div></div>' +

      '<div class="card"><h2>Images</h2><p class="muted small">Only needed for text or CSV imports that mention image files. Add the images, or a .zip of them (for example Anki’s collection.media folder). They are matched by file name.</p>' +
        '<input type="file" id="imgFiles" accept="image/*,.zip,application/zip" multiple></div>' +

      '<div class="card"><h2>Settings</h2>' +
        '<label for="sBatch">Cards per interruption</label><input type="number" id="sBatch" min="1" max="20" step="1" value="' + s.batch + '">' +
        '<label for="sNew">New cards per day</label><input type="number" id="sNew" min="0" max="200" step="1" value="' + s.newPerDay + '">' +
        '<label for="sRet">Target recall (%)</label><input type="number" id="sRet" min="70" max="97" step="1" value="' + Math.round(s.retention * 100) + '">' +
        '<label for="sMax">Longest interval (days)</label><input type="number" id="sMax" min="1" max="3650" step="1" value="' + s.maxInterval + '">' +
        '<label for="sThink">Think time before “Show answer” (seconds)</label><input type="number" id="sThink" min="0" max="15" step="1" value="' + s.thinkSeconds + '">' +
        '<label for="sRule">To unlock your apps</label><select id="sRule">' +
          '<option value="finish"' + (s.unlockRule === 'finish' ? ' selected' : '') + '>Answer every card in the batch</option>' +
          '<option value="correct"' + (s.unlockRule === 'correct' ? ' selected' : '') + '>Get every card right (missed cards come back at the end)</option></select>' +
        '<p class="muted small" style="margin-top:6px">Either way, a miss is recorded as a miss for scheduling; retries don’t change that.</p>' +
        '<div style="margin-top:12px"><button class="big" data-act="saveSettings">Save settings</button></div></div>' +

      '<div class="card"><h2>Backup &amp; restore</h2>' +
        '<p class="small">' + (un.length ? '<b>' + un.length + '</b> review' + (un.length > 1 ? 's' : '') + ' not sent yet. ' : '') +
          (ackSeen ? (pend.length ? '<b>' + pend.length + '</b> sent, waiting for ABR Gate to confirm they were saved (they keep being re-sent until then).' : 'Every review is confirmed saved in reviews-log.txt.') +
                     (lastAck ? ' Last confirmation ' + fmtAgo(lastAck.t) + (lastAck.n ? ' (' + lastAck.n + ' entries)' : '') + '.' : '')
                   : (pend.length ? '<b>' + pend.length + '</b> sent but unconfirmed. ' : '') + 'Saves aren’t confirmed yet: add <code>&amp;ack=</code> to ABR Gate (see setup). Nothing is discarded meanwhile.') + '</p>' +
        '<div class="row"><button data-act="pass">Back up now</button><button data-act="testPass">Send test entry</button></div>' +
        '<hr><label for="logFile">Restore progress from reviews-log.txt (import your decks first)</label><input type="file" id="logFile" accept=".txt,text/plain">' +
        '<hr><div class="row"><button data-act="exportZip">Export full backup (.zip)</button></div>' +
        '<p class="muted small" style="margin-top:6px">Includes cards, images, settings and the full review history. Restore it with the Import cards picker above.</p>' +
      '</div>' +
      '<p class="muted small center">ABR Unlock ' + APP_VERSION + ' · everything stays on this device</p>';

    document.getElementById('impFile').addEventListener('change', onPickImport);
    document.getElementById('imgFiles').addEventListener('change', onPickImages);
    document.getElementById('logFile').addEventListener('change', onPickLog);
    document.getElementById('impDir').addEventListener('change', previewImport);
  }

  /* ================= import handlers ================= */
  var pendingImport = null;
  function setBusy(text) { var b = document.getElementById('impBtn'); if (b) { b.disabled = !!text; if (text) b.textContent = text; else b.textContent = 'Import'; } }
  async function onPickImport(e) {
    var f = e.target.files[0];
    if (!f) return;
    var lower = f.name.toLowerCase();
    var opts = document.getElementById('impOpts'), prev = document.getElementById('impPreview');
    opts.classList.remove('hidden');
    pendingImport = null;
    try {
      if (/\.(apkg|zip|colpkg)$/.test(lower) && !window.JSZip) {
        throw new Error('This website is missing the file vendor/jszip.min.js, which opens .apkg/.colpkg/.zip files. Upload it to the vendor folder of your GitHub repository, wait a minute, then reload this page.');
      }
      if (/\.(apkg|zip|colpkg)$/.test(lower)) {
        document.getElementById('impTextOpts').classList.add('hidden');
        prev.textContent = 'Reading package…';
        setBusy('Reading…');
        var zip = await JSZip.loadAsync(f);
        if (zip.file('backup.json')) {
          pendingImport = { kind: 'backup', zip: zip };
          prev.textContent = 'ABR Unlock full backup. Importing restores its cards, images, settings and review history.';
        } else if (zip.file('collection.anki21') || zip.file('collection.anki2') || zip.file('collection.anki21b')) {
          var r = await AnkiPkg.parseApkg(f);
          pendingImport = { kind: 'apkg', parsed: r };
          var withImg = r.items.filter(function (it) { return hasImage(it.q) || hasImage(it.a); }).length;
          var histCards = {}; r.events.forEach(function (ev) { histCards[ev.key] = 1; });
          prev.textContent = 'Anki package: ' + r.items.length + ' cards in ' + r.decks + ' deck' + (r.decks === 1 ? '' : 's') + ', ' +
            withImg + ' with images, ' + r.media.length + ' image files' + (Object.keys(histCards).length ? ', Anki review history for ' + Object.keys(histCards).length + ' cards' : '') +
            (r.skipped ? ' (' + r.skipped + ' empty cards skipped)' : '') + '.' +
            (r.occlusion ? ' ' + r.occlusion + ' Image Occlusion card' + (r.occlusion === 1 ? ' is' : 's are') + ' left out: their masks are drawn by Anki itself and can’t be shown faithfully here.' : '');
        } else {
          pendingImport = { kind: 'images', zip: zip };
          prev.textContent = 'This .zip has no cards; its images will be added to the image store.';
        }
        setBusy('');
      } else {
        document.getElementById('impTextOpts').classList.remove('hidden');
        var text = await f.text();
        pendingImport = { kind: 'text', text: text };
        document.getElementById('impDeck').value = f.name.replace(/\.[^.]+$/, '');
        previewImport();
      }
    } catch (err) {
      pendingImport = null;
      prev.textContent = err.message || String(err);
      setBusy('');
      document.getElementById('impBtn').disabled = true;
    }
  }
  function previewImport() {
    if (!pendingImport || pendingImport.kind !== 'text') return;
    var el = document.getElementById('impPreview');
    try {
      var r = parseText(pendingImport.text, { dir: document.getElementById('impDir').value, deck: document.getElementById('impDeck').value });
      document.getElementById('impDirWrap').classList.toggle('hidden', !r.twoCol);
      var calc = r.items.filter(function (it) { return it.type === 'num'; }).length;
      el.textContent = r.format + ': ' + r.items.length + ' cards found' + (calc ? ' (' + calc + ' calculations)' : '') + (r.skipped ? ', ' + r.skipped + ' lines skipped' : '') + '.';
      document.getElementById('impBtn').disabled = false;
    } catch (err) { el.textContent = err.message; document.getElementById('impBtn').disabled = true; }
  }
  async function doImport() {
    if (!pendingImport) return;
    setBusy('Importing…');
    try {
      var res, pi = pendingImport;
      if (pi.kind === 'backup') {
        var b = await importBackupZip(pi.zip);
        pendingImport = null;
        return showHome('Backup restored: ' + b.cards + ' cards, ' + b.reviews + ' reviews, ' + b.images + ' images.');
      }
      if (pi.kind === 'images') {
        var n = await imagesFromZip(pi.zip);
        pendingImport = null;
        return showHome(n + ' image' + (n === 1 ? '' : 's') + ' added.');
      }
      if (pi.kind === 'apkg') {
        res = await commitImport(pi.parsed.items, 'Anki', pi.parsed.events, pi.parsed.media);
      } else {
        var deck = document.getElementById('impDeck').value.trim() || 'Imported';
        var r = parseText(pi.text, { dir: document.getElementById('impDir').value, deck: deck });
        res = await commitImport(r.items, deck, null, null);
      }
      pendingImport = null;
      showHome('Imported: ' + res.added + ' new, ' + res.updated + ' updated, ' + res.unchanged + ' unchanged' +
        (res.dupes ? ', ' + res.dupes + ' duplicates merged' : '') + (res.images ? ', ' + res.images + ' images' : '') +
        (res.history ? ', review history applied to ' + res.history + ' cards' : '') + '.');
    } catch (err) { showHome(esc(err.message || String(err))); }
  }
  async function onPickImages(e) {
    var files = Array.prototype.slice.call(e.target.files), count = 0;
    for (var i = 0; i < files.length; i++) {
      if (/\.zip$/i.test(files[i].name)) count += await imagesFromZip(await JSZip.loadAsync(files[i]));
      else { await put('images', files[i], files[i].name); count++; }
    }
    showHome(count + ' image' + (count === 1 ? '' : 's') + ' saved.');
  }
  async function onPickLog(e) {
    var f = e.target.files[0];
    if (!f) return;
    var r = await restoreFromLog(await f.text());
    showHome('Restore: replayed ' + r.events + ' reviews across ' + r.cards + ' cards.' + (r.unknown ? ' ' + r.unknown + ' cards in the log aren’t imported here yet; import those decks, then restore again.' : ''));
  }
  async function saveSettings() {
    var num = function (id, lo, hi, def) { var v = parseFloat(document.getElementById(id).value); return isNaN(v) ? def : Math.min(hi, Math.max(lo, v)); };
    var s = await settings();
    s.batch = Math.round(num('sBatch', 1, 20, DEFAULTS.batch));
    s.newPerDay = Math.round(num('sNew', 0, 200, DEFAULTS.newPerDay));
    s.retention = num('sRet', 70, 97, 90) / 100;
    s.maxInterval = Math.round(num('sMax', 1, 3650, DEFAULTS.maxInterval));
    s.unlockRule = document.getElementById('sRule').value === 'correct' ? 'correct' : 'finish';
    s.thinkSeconds = Math.round(num('sThink', 0, 15, DEFAULTS.thinkSeconds));
    var hist = await schedHistory(), cur = schedAt(hist, Date.now());
    if (cur.retention !== s.retention || cur.maxInterval !== s.maxInterval || cur.relearnMinutes !== s.relearnMinutes) {
      // remember when scheduling changed, locally and in the log, so a replay later uses the right values
      var entry = { t: Math.round(Date.now() / 1000) * 1000, retention: s.retention, maxInterval: s.maxInterval, relearnMinutes: s.relearnMinutes };
      await addSchedHistory([entry]);
      await setKv('settingsChangedAt', entry.t);
      var un = await kv('unsent', []); un.push(cfgToken(entry)); await setKv('unsent', un);
    }
    await saveSettingsObj(s);
    showHome('Settings saved.');
  }
  async function setDeck(name, patch) {
    var decks = await decksMap();
    decks[name] = Object.assign(deckCfg(decks, name), patch);
    await setKv('decks', decks);
  }
  async function deckDelete(name) {
    if (!window.confirm('Delete the deck “' + name + '” and its progress from this phone?')) return;
    var all = await getAll('cards');
    await delMany('cards', all.filter(function (c) { return c.deck === name; }).map(function (c) { return c.id; }));
    var decks = await decksMap(); delete decks[name]; await setKv('decks', decks);
    showHome('Deck deleted.');
  }

  /* ================= image zoom ================= */
  function zoom(src) {
    var ov = document.createElement('div');
    ov.className = 'lightbox';
    ov.innerHTML = '<img alt="">';
    ov.firstChild.src = src;
    ov.addEventListener('click', function () { ov.remove(); });
    document.body.appendChild(ov);
  }

  /* ================= events ================= */
  app.addEventListener('click', function (e) {
    var img = e.target.closest('img[data-zoom]');
    if (img && !e.target.closest('button')) { zoom(img.src); return; }
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    var act = b.getAttribute('data-act');
    if (act === 'pick') pick(parseInt(b.getAttribute('data-i'), 10));
    else if (act === 'checkNum') checkNum();
    else if (act === 'reveal') reveal();
    else if (act === 'rate') rate(parseInt(b.getAttribute('data-g'), 10));
    else if (act === 'next') next();
    else if (act === 'override') override();
    else if (act === 'giveUp') giveUp();
    else if (act === 'pass') { b.disabled = true; goPass(); }
    else if (act === 'testPass') navigate('shortcuts://run-shortcut?name=' + encodeURIComponent(PASS_SHORTCUT) + '&input=text&text=' + encodeURIComponent('abr1;test'));
    else if (act === 'study') startQuiz('study');
    else if (act === 'studyMore') startQuiz('study', Q && Q.deckFilter);
    else if (act === 'studyDeck') startQuiz('study', [b.getAttribute('data-deck')]);
    else if (act === 'home') showHome();
    else if (act === 'doImport') doImport();
    else if (act === 'saveSettings') saveSettings();
    else if (act === 'exportZip') { b.disabled = true; exportBackup().then(function () { b.disabled = false; }); }
    else if (act === 'deckDelete') deckDelete(b.getAttribute('data-deck'));
    else if (act === 'mode') settings().then(function (s) { s.mode = b.getAttribute('data-mode'); return saveSettingsObj(s); }).then(function () { showHome(); });
  });
  app.addEventListener('change', function (e) {
    var t = e.target, act = t.getAttribute && t.getAttribute('data-act');
    if (act === 'deckFocus') setDeck(t.getAttribute('data-deck'), { focus: t.checked }).then(function () { showHome(); });
    else if (act === 'deckStyle') setDeck(t.getAttribute('data-deck'), { style: t.value });
  });

  /* ================= start ================= */
  /* ================= self-check: did every app file load? ================= */
  var LIBS = [
    { test: function () { return !!window.JSZip; }, paths: ['vendor/jszip.min.js', 'jszip.min.js'], file: 'vendor/jszip.min.js' },
    { test: function () { return !!window.katex; }, paths: ['vendor/katex.min.js', 'katex.min.js'], file: 'vendor/katex.min.js' },
    { test: function () { return !!window.SQLiteLite; }, paths: ['sqlite.js'], file: 'sqlite.js' },
    { test: function () { return !!window.AnkiPkg; }, paths: ['anki.js'], file: 'anki.js' },
    { test: function () { return !!window.FSRS; }, paths: ['fsrs.js'], file: 'fsrs.js' }
  ];
  var MISSING = [];
  function loadScript(src) {
    return new Promise(function (res) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { res(true); };
      el.onerror = function () { el.remove(); res(false); };
      document.head.appendChild(el);
    });
  }
  async function ensureLibs() {
    MISSING = [];
    for (var i = 0; i < LIBS.length; i++) {
      // retry the expected place, then the site's top folder (a common upload slip)
      for (var j = 0; j < LIBS[i].paths.length && !LIBS[i].test(); j++) await loadScript(LIBS[i].paths[j] + '?r=' + Date.now());
      if (!LIBS[i].test()) MISSING.push(LIBS[i].file);
    }
  }
  function missingHtml() {
    return MISSING.length ? '<div class="notice"><b>Some app files didn’t load:</b> ' + MISSING.map(esc).join(', ') +
      '. Check they are in your GitHub repository at exactly those paths (the <code>vendor</code> folder included), wait a minute, then reload.</div>' : '';
  }

  async function start() {
    try {
      await ensureLibs();
      await openDB();
      if (!(await kv('settingsHistory', [])).length) {
        var s0 = await settings();
        if (s0.retention !== DEFAULTS.retention || s0.maxInterval !== DEFAULTS.maxInterval || s0.relearnMinutes !== DEFAULTS.relearnMinutes)
          await addSchedHistory([{ t: 0, retention: s0.retention, maxInterval: s0.maxInterval, relearnMinutes: s0.relearnMinutes }]);
      }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      if (GATE) { await processAck(params.get('ack')); await startQuiz('gate'); }
      else await showHome();
    } catch (err) {
      app.innerHTML = '<div class="card"><h2>Something went wrong</h2><p>' + esc(err && err.message || err) + '</p>' +
        (GATE ? '<button class="primary big" data-act="pass">Unlock apps</button>' : '') + '</div>';
    }
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  window.__abr = {
    parseText: parseText, parseLog: parseLog, gradeNumber: gradeNumber, parseQuantity: parseQuantity,
    current: function () { return Q && Q.entries[Q.i] ? Q.entries[Q.i].c : null; },
    currentType: function () { return Q && Q.type; },
    cards: function () { return getAll('cards'); },
    reviews: function () { return getAll('reviews'); },
    kv: kv, buildBatch: buildBatch
  };
  start();
})();
