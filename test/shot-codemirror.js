// Read-only CodeMirror stand-in that renders real highlighting from the defined simple
// modes, for README screenshots (the CDN is not reachable in headless CI).
(function () {
  const modes = {};
  function Doc(text, mode) { this.lines = String(text).split('\n'); this.mode = mode; this.gen = 0; this.clean = 0; this.cursor = { line: 0, ch: 0 }; this.marks = []; this.gm = {}; this.lc = {}; }
  Doc.prototype.getValue = function () { return this.lines.join('\n'); };
  Doc.prototype.isClean = function () { return this.gen === this.clean; };
  Doc.prototype.markClean = function () { this.clean = this.gen; };
  Doc.prototype.eachLine = function (f) { this.lines.forEach((_, i) => f({ i, gutterMarkers: this.gm[i] })); };
  Doc.prototype.getLineNumber = function (h) { return h.i; };
  Doc.prototype.addLineClass = function (l, w, c) { this.lc[l] = c; };
  Doc.prototype.removeLineClass = function (l) { delete this.lc[l]; };
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function highlight(line, mode, st) {
    const m = modes[mode]; if (!m) return esc(line);
    let out = '', pos = 0;
    while (pos < line.length) {
      const rules = m[st.s] || m.start; let hit = false;
      for (const r of rules) {
        if (r.sol && pos !== 0) continue;
        const re = new RegExp('^(?:' + r.regex.source + ')', r.regex.ignoreCase ? 'i' : '');
        const mm = line.slice(pos).match(re);
        if (!mm || !mm[0].length) continue;
        if (Array.isArray(r.token)) {
          const g = new RegExp('^' + r.regex.source, r.regex.ignoreCase ? 'i' : '').exec(line.slice(pos));
          if (g && g.length - 1 === r.token.length) { g.slice(1).forEach((t, i) => { out += r.token[i] ? `<span class="cm-${r.token[i]}">${esc(t || '')}</span>` : esc(t || ''); }); }
          else out += esc(mm[0]);
        } else out += r.token ? `<span class="cm-${r.token}">${esc(mm[0])}</span>` : esc(mm[0]);
        pos += mm[0].length; if (r.next) st.s = r.next; hit = true; break;
      }
      if (!hit) { out += esc(line[pos]); pos++; }
    }
    return out;
  }
  function CM(host) {
    const wrap = document.createElement('div'); wrap.className = 'CodeMirror cm-s-nusa CodeMirror-focused';
    wrap.style.cssText = 'overflow:auto;';
    host.appendChild(wrap);
    const h = {}; let doc = new Doc('', 'abap');
    const render = () => {
      const st = { s: 'start' };
      wrap.innerHTML = `<div style="display:flex;padding:6px 0;min-height:100%"><div class="gut" style="width:58px;flex:none"></div><div class="code" style="flex:1;position:relative"></div></div>`;
      const gut = wrap.querySelector('.gut'), code = wrap.querySelector('.code');
      doc.lines.forEach((l, i) => {
        const on = i === doc.cursor.line;
        gut.insertAdjacentHTML('beforeend', `<div style="height:20px;display:flex;align-items:center;justify-content:flex-end;gap:6px"><span style="width:9px;height:9px;border-radius:50%;${doc.gm[i] ? 'background:var(--err)' : ''}"></span><span class="CodeMirror-linenumber" style="${on ? 'color:var(--fg)' : ''}">${i + 1}</span></div>`);
        const bg = doc.lc[i] ? 'background:var(--dbg-line);box-shadow:inset 3px 0 0 var(--accent);' : on ? 'background:var(--active-line);' : '';
        code.insertAdjacentHTML('beforeend', `<pre class="CodeMirror-line" style="height:20px;${bg}">${highlight(l, doc.mode, st) || ' '}</pre>`);
      });
    };
    const fire = (n, ...a) => (h[n] || []).forEach(f => f(cm, ...a));
    const cm = {
      state: {}, wrap,
      swapDoc(d) { const o = doc; doc = d; render(); return o; }, getDoc() { return doc; },
      on(n, f) { (h[n] = h[n] || []).push(f); }, getValue() { return doc.getValue(); },
      getCursor() { return doc.cursor; }, setCursor(p) { doc.cursor = p; render(); }, scrollIntoView() {}, getScrollInfo() { return { clientHeight: 400, left: 0, top: 0 }; },
      refresh() { render(); }, focus() {}, getLine(i) { return doc.lines[i]; }, lineCount() { return doc.lines.length; }, lastLine() { return doc.lines.length - 1; },
      getAllMarks() { return doc.marks; }, markText(a, b, o) { const m = { className: o.className, clear() { doc.marks = doc.marks.filter(x => x !== m); } }; doc.marks.push(m); return m; },
      lineInfo(l) { return { gutterMarkers: doc.gm[l] }; }, setGutterMarker(l, g, el) { if (el) doc.gm[l] = { [g]: el }; else delete doc.gm[l]; render(); },
      replaceRange(text, from, to) {
        const v = doc.getValue(); const idx = p => doc.lines.slice(0, p.line).join('\n').length + (p.line ? 1 : 0) + p.ch;
        const s = idx(from), e = to ? idx(to) : s; doc.lines = (v.slice(0, s) + text + v.slice(e)).split('\n'); doc.gen++; render(); fire('changes');
      },
      setValueForShot(t) { doc.lines = t.split('\n'); doc.gen++; render(); fire('changes'); },
      operation(f) { f(); }, scrollTo() {}, getTokenTypeAt() { return ''; },
      showHint(o) {
        const hint = o.hint;
        if (hint.async) { hint(cm, d => d && cm.__drawHints(d), o); return; }
        cm.__drawHints(hint(cm, o));
      },
      __drawHints(d) {
        window.__hintList = d.list.map(it => typeof it === 'string' ? it : (it.label || it.text));
        document.querySelectorAll('.CodeMirror-hints').forEach(x => x.remove());
        const ul = document.createElement('ul'); ul.className = 'CodeMirror-hints';
        d.list.slice(0, 9).forEach((it, i) => { const li = document.createElement('li'); li.className = 'CodeMirror-hint' + (i === 0 ? ' CodeMirror-hint-active' : ''); if (it.render) it.render(li, d, it); else li.textContent = it.text || it; ul.appendChild(li); });
        const r = wrap.querySelector('.code').getBoundingClientRect();
        ul.style.left = (r.left + 8 + doc.cursor.ch * 7.83) + 'px'; ul.style.top = (r.top + (doc.cursor.line + 1) * 20 + 2) + 'px';
        document.body.appendChild(ul);
        (CM._handlers.select || []).forEach(f => f(d.list[0], ul.firstChild));
      },
      indentSelection() {}, replaceSelection() {}, somethingSelected() { return false; },
    };
    window.__cm = cm;
    return cm;
  }
  CM._handlers = {};
  CM.Doc = function (t, m) { return new Doc(t, m); };
  CM.defineSimpleMode = function (name, spec) { modes[name] = spec; };
  CM.on = function (obj, ev, f) { (CM._handlers[ev] = CM._handlers[ev] || []).push(f); };
  CM.Pos = function (line, ch) { return { line, ch }; };
  window.CodeMirror = CM;
})();
