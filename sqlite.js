/* Minimal read-only SQLite reader: walks table b-trees and decodes rows.
   Enough to read an Anki collection (col, notes, cards, revlog). No SQL engine. */
(function (root) {
  'use strict';
  var utf8 = new TextDecoder('utf-8');

  function SQLiteFile(buffer) {
    this.u8 = new Uint8Array(buffer);
    this.dv = new DataView(buffer);
    var head = utf8.decode(this.u8.subarray(0, 15));
    if (head !== 'SQLite format 3') throw new Error('Not an SQLite database');
    var ps = this.dv.getUint16(16);
    this.pageSize = ps === 1 ? 65536 : ps;
    this.usable = this.pageSize - this.u8[20];
    this.schema = this.readSchema();
  }

  SQLiteFile.prototype.varint = function (pos) {
    var v = 0, i, b;
    for (i = 0; i < 8; i++) {
      b = this.u8[pos + i];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return [v, i + 1];
    }
    b = this.u8[pos + 8];
    return [v * 256 + b, 9];
  };

  SQLiteFile.prototype.payload = function (start, size) {
    var U = this.usable, X = U - 35, local;
    if (size <= X) local = size;
    else {
      var M = Math.floor((U - 12) * 32 / 255) - 23;
      var K = M + ((size - M) % (U - 4));
      local = K <= X ? K : M;
    }
    if (local === size) return this.u8.subarray(start, start + size);
    var out = new Uint8Array(size);
    out.set(this.u8.subarray(start, start + local), 0);
    var filled = local;
    var next = this.dv.getUint32(start + local);
    while (filled < size && next) {
      var off = (next - 1) * this.pageSize;
      next = this.dv.getUint32(off);
      var n = Math.min(size - filled, U - 4);
      out.set(this.u8.subarray(off + 4, off + 4 + n), filled);
      filled += n;
    }
    return out;
  };

  function readInt(bytes, pos, len) {
    var v = bytes[pos] & 0x80 ? -1 : 0;
    // build as a float so 48/64-bit values keep their magnitude (ids are < 2^53)
    var x = 0;
    for (var i = 0; i < len; i++) x = x * 256 + bytes[pos + i];
    if (v === -1) x -= Math.pow(2, 8 * len);
    return x;
  }

  SQLiteFile.prototype.record = function (bytes) {
    var self = { u8: bytes };
    var vint = function (pos) {
      var v = 0, i, b;
      for (i = 0; i < 8; i++) { b = bytes[pos + i]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return [v, i + 1]; }
      return [v * 256 + bytes[pos + 8], 9];
    };
    var h = vint(0), hsize = h[0], p = h[1], types = [];
    while (p < hsize) { var t = vint(p); types.push(t[0]); p += t[1]; }
    var vals = [], q = hsize;
    types.forEach(function (t) {
      if (t === 0) vals.push(null);
      else if (t >= 1 && t <= 6) {
        var len = [0, 1, 2, 3, 4, 6, 8][t];
        vals.push(readInt(bytes, q, len)); q += len;
      } else if (t === 7) {
        vals.push(new DataView(bytes.buffer, bytes.byteOffset + q, 8).getFloat64(0)); q += 8;
      } else if (t === 8) vals.push(0);
      else if (t === 9) vals.push(1);
      else if (t >= 12 && t % 2 === 0) { var bl = (t - 12) / 2; vals.push(bytes.slice(q, q + bl)); q += bl; }
      else if (t >= 13) { var tl = (t - 13) / 2; vals.push(utf8.decode(bytes.subarray(q, q + tl))); q += tl; }
      else vals.push(null);
    });
    return vals;
  };

  // Visit every row of the table b-tree rooted at `page`
  SQLiteFile.prototype.walk = function (page, cb) {
    var stack = [page], seen = {};
    while (stack.length) {
      var pg = stack.pop();
      if (seen[pg]) continue;
      seen[pg] = 1;
      var base = (pg - 1) * this.pageSize;
      var hdr = base + (pg === 1 ? 100 : 0);
      var type = this.u8[hdr];
      var n = this.dv.getUint16(hdr + 3);
      var ptrs = hdr + (type === 0x05 || type === 0x02 ? 12 : 8);
      if (type === 0x0d) {
        for (var i = 0; i < n; i++) {
          var c = base + this.dv.getUint16(ptrs + 2 * i);
          var a = this.varint(c), b = this.varint(c + a[1]);
          cb(b[0], this.record(this.payload(c + a[1] + b[1], a[0])));
        }
      } else if (type === 0x05) {
        var kids = [];
        for (var j = 0; j < n; j++) kids.push(this.dv.getUint32(base + this.dv.getUint16(ptrs + 2 * j)));
        kids.push(this.dv.getUint32(hdr + 8));
        for (var k = kids.length - 1; k >= 0; k--) stack.push(kids[k]); // keep rowid order
      } else {
        throw new Error('Unexpected page type ' + type + ' on page ' + pg);
      }
    }
  };

  function columnsFromSql(sql) {
    var body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
    var parts = [], depth = 0, cur = '';
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    var cols = [];
    parts.forEach(function (p) {
      var t = p.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!t || /^(primary|unique|check|foreign|constraint)\b/i.test(t)) return;
      var m = t.match(/^["'`\[]?([^"'`\]\s]+)["'`\]]?\s*(.*)$/);
      if (!m) return;
      cols.push({ name: m[1], pk: /integer\s+primary\s+key/i.test(m[2]) });
    });
    return cols;
  }

  SQLiteFile.prototype.readSchema = function () {
    var tables = {};
    var self = this;
    this.walk(1, function (rowid, v) {
      if (v[0] === 'table' && v[4]) tables[v[1]] = { root: v[3], cols: columnsFromSql(v[4]), withoutRowid: /without\s+rowid/i.test(v[4]) };
    });
    return tables;
  };

  SQLiteFile.prototype.has = function (name) { return !!this.schema[name]; };

  SQLiteFile.prototype.rows = function (name) {
    var t = this.schema[name];
    if (!t) return [];
    if (t.withoutRowid) throw new Error('Table ' + name + ' is WITHOUT ROWID (unsupported)');
    var out = [];
    this.walk(t.root, function (rowid, vals) {
      var o = {};
      t.cols.forEach(function (c, i) { o[c.name] = c.pk && vals[i] == null ? rowid : vals[i]; });
      out.push(o);
    });
    return out;
  };

  var api = { open: function (buf) { return new SQLiteFile(buf); }, columnsFromSql: columnsFromSql };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SQLiteLite = api;
})(this);
