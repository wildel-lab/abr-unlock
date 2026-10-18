/* Anki package (.apkg) reader: renders each card with its own Anki template, so fields,
   images on either side, reversed cards and cloze numbers come through as Anki shows them.
   Needs: JSZip (global) and SQLiteLite (sqlite.js). Legacy packages only (schema 11). */
(function (root) {
  'use strict';

  var IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic' };
  var NEW_FORMAT_MSG = 'This file was exported in Anki’s newest package format, which ABR Unlock can’t read. In Anki, export again as “Anki Deck Package (.apkg)” with “Support older Anki versions” ticked (keep “Include media” ticked too).';

  function stripHtml(s) {
    return String(s == null ? '' : s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  function isEmptyField(v) { return !/<img/i.test(v || '') && stripHtml(v).replace(/\s+/g, '') === ''; }

  // Anki LaTeX tags -> MathJax delimiters the app understands
  function convertLatex(s) {
    return String(s || '')
      .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, '\\[$1\\]')
      .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, '\\($1\\)')
      .replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, '\\[$1\\]');
  }

  var CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
  function renderCloze(text, n, side) {
    return String(text || '').replace(CLOZE_RE, function (m, num, content, hint) {
      if (parseInt(num, 10) !== n) return content;
      return side === 'q' ? '<b class="cloze">[' + (hint || '…') + ']</b>' : '<b class="cloze">' + content + '</b>';
    });
  }
  function clozeNumbers(text) {
    var nums = {}, m;
    CLOZE_RE.lastIndex = 0;
    while ((m = CLOZE_RE.exec(String(text || '')))) nums[parseInt(m[1], 10)] = 1;
    return Object.keys(nums).map(Number).sort(function (a, b) { return a - b; });
  }

  // Mustache-style Anki template rendering: {{Field}}, {{#Field}}..{{/Field}}, {{^Field}}..{{/Field}}, filters
  function renderTemplate(tpl, ctx) {
    var look = function (name) {
      var n = name.split(':').pop().trim();
      if (n === 'FrontSide') return ctx.front || '';
      if (n === 'Tags') return ctx.tags || '';
      if (n === 'Deck') return ctx.deck || '';
      if (n === 'Subdeck') return (ctx.deck || '').split('::').pop();
      if (n === 'Card') return ctx.cardName || '';
      if (n === 'Type') return ctx.modelName || '';
      return Object.prototype.hasOwnProperty.call(ctx.fields, n) ? ctx.fields[n] : '';
    };
    var sec = /\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
    var guard = 0;
    while (sec.test(tpl) && guard++ < 500) {
      tpl = tpl.replace(sec, function (m, kind, name, inner) {
        var present = !isEmptyField(look(name));
        return (kind === '#' ? present : !present) ? inner : '';
      });
    }
    return tpl.replace(/\{\{([^{}]+?)\}\}/g, function (m, inner) {
      inner = inner.trim();
      if (!inner || inner[0] === '!' || inner[0] === '/' || /^tts\b/i.test(inner)) return '';
      var parts = inner.split(':');
      var name = parts.pop().trim();
      var filters = parts.map(function (f) { return f.trim().toLowerCase(); });
      var v = look(name);
      for (var i = filters.length - 1; i >= 0; i--) {
        var f = filters[i];
        if (f === 'type') return '';
        if (f === 'text') v = stripHtml(v);
        else if (f === 'cloze') v = renderCloze(v, ctx.cloze, ctx.side);
        else if (f === 'cloze-only') v = '';
      }
      return v;
    });
  }

  function answerOnly(html) {
    var m = html.match(/<hr[^>]*\bid\s*=\s*["']?answer["']?[^>]*>/i);
    return m ? html.slice(m.index + m[0].length) : null;
  }

  async function parseApkg(file) {
    var zip = await JSZip.loadAsync(file);
    var dbEntry = zip.file('collection.anki21') || zip.file('collection.anki2');
    var hasNew = !!zip.file('collection.anki21b');
    if (!dbEntry) throw new Error(hasNew ? NEW_FORMAT_MSG : 'This doesn’t look like an Anki package (.apkg).');
    var db = SQLiteLite.open(await dbEntry.async('arraybuffer'));
    if (!db.has('col') || !db.has('notes') || !db.has('cards')) throw new Error(hasNew ? NEW_FORMAT_MSG : 'Unrecognised Anki collection.');
    var col = db.rows('col')[0];
    if (!col || !col.models) throw new Error(NEW_FORMAT_MSG);
    var models = JSON.parse(col.models), decks = JSON.parse(col.decks || '{}');
    var notes = db.rows('notes');
    if (hasNew && notes.length <= 1 && notes.some(function (n) { return /update to the latest Anki/i.test(n.flds); }))
      throw new Error(NEW_FORMAT_MSG);
    var notesById = {};
    notes.forEach(function (n) { notesById[n.id] = n; });
    var cards = db.rows('cards');
    var items = [], keyByCid = {}, deckNames = {}, skipped = 0, occlusion = 0;

    cards.forEach(function (c) {
      var n = notesById[c.nid];
      if (!n) { skipped++; return; }
      var model = models[String(n.mid)];
      if (!model) { skipped++; return; }
      var values = n.flds.split('\x1f').map(convertLatex);
      var fields = {};
      (model.flds || []).forEach(function (f, i) { fields[f.name] = values[f.ord != null ? f.ord : i] || ''; });
      var deckObj = decks[String(c.odid || c.did)] || decks[String(c.did)] || { name: 'Anki' };
      var deck = String(deckObj.name || 'Anki');
      var isCloze = model.type === 1;
      var tmpl = isCloze ? model.tmpls[0] : (model.tmpls || []).filter(function (t) { return t.ord === c.ord; })[0] || model.tmpls[c.ord];
      if (!tmpl) { skipped++; return; }
      // Image Occlusion masks are drawn by Anki's own JavaScript; they can't be reproduced faithfully here
      if (/image occlusion/i.test(model.name || '') || /image-occlusion:/i.test(tmpl.qfmt || '')) { occlusion++; return; }
      var ctx = { fields: fields, tags: (n.tags || '').trim(), deck: deck, cardName: tmpl.name, modelName: model.name, cloze: c.ord + 1, side: 'q' };
      var q = renderTemplate(tmpl.qfmt, ctx).trim();
      if (isEmptyField(q) || (isCloze && q.indexOf('class="cloze"') < 0)) { skipped++; return; }
      ctx.side = 'a'; ctx.front = q;
      var full = renderTemplate(tmpl.afmt, ctx);
      var a = answerOnly(full);
      if (a == null) { ctx.front = ''; a = renderTemplate(tmpl.afmt, ctx); }
      a = a.trim();
      var key = 'anki:' + n.guid + ':' + c.ord;
      keyByCid[c.id] = key;
      deckNames[deck] = 1;
      items.push({
        q: q, a: a || '(no answer)', html: true, deck: deck.split('::').join(' › '), idKey: key,
        type: isCloze ? 'recall' : 'auto', topic: ''
      });
    });

    // Review history (ease 1-4); manual reschedules (ease 0) are ignored
    var events = [];
    if (db.has('revlog')) {
      db.rows('revlog').forEach(function (r) {
        var key = keyByCid[r.cid];
        if (key && r.ease >= 1 && r.ease <= 4) events.push({ key: key, g: r.ease, t: Math.round(r.id / 1000) * 1000 });
      });
    }

    // Media: legacy packages store a JSON map {"0": "file.jpg"} and numbered files
    var media = [];
    var mediaEntry = zip.file('media');
    if (mediaEntry) {
      var raw = await mediaEntry.async('string');
      var map = null;
      try { map = JSON.parse(raw); } catch (e) { map = null; }
      if (!map && raw.length) throw new Error(NEW_FORMAT_MSG);
      var names = Object.keys(map || {});
      for (var i = 0; i < names.length; i++) {
        var fname = map[names[i]], ext = String(fname).split('.').pop().toLowerCase();
        var entry = zip.file(names[i]);
        if (!entry || !IMAGE_EXT[ext]) continue;
        var buf = await entry.async('arraybuffer');
        media.push({ name: fname, blob: new Blob([buf], { type: IMAGE_EXT[ext] }) });
      }
    }

    return { format: 'Anki package', items: items, events: events, media: media, skipped: skipped, occlusion: occlusion, decks: Object.keys(deckNames).length };
  }

  var api = { parseApkg: parseApkg, renderTemplate: renderTemplate, renderCloze: renderCloze, clozeNumbers: clozeNumbers, convertLatex: convertLatex, IMAGE_EXT: IMAGE_EXT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AnkiPkg = api;
})(this);
