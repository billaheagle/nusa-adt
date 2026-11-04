// Minimal stand-in for CodeMirror 5, used only by the headless smoke test (no CDN access there).
(function () {
  function Doc(text, mode) { this.lines = String(text).split('\n'); this.mode = mode; this.gen = 0; this.clean = 0; this.cursor = { line: 0, ch: 0 }; this.marks = []; this.gm = {}; }
  Doc.prototype.getValue = function () { return this.lines.join('\n'); };
  Doc.prototype.isClean = function () { return this.gen === this.clean; };
  Doc.prototype.markClean = function () { this.clean = this.gen; };
  Doc.prototype.eachLine = function (f) { this.lines.forEach((_, i) => f({ i, gutterMarkers: this.gm[i] })); };
  Doc.prototype.getLineNumber = function (h) { return h.i; };
  Doc.prototype.addLineClass = function () {}; Doc.prototype.removeLineClass = function () {};
  function CM(host) {
    const ta = document.createElement('textarea'); ta.className = 'fake-cm'; ta.style.cssText = 'width:100%;height:100%;box-sizing:border-box;background:var(--bg);color:var(--fg);font:13px/20px monospace;border:0;padding:6px 12px';
    const wrap = document.createElement('div'); wrap.className = 'CodeMirror'; wrap.appendChild(ta); host.appendChild(wrap);
    const h = {}; let doc = new Doc('', 'abap');
    const fire = (n, ...a) => (h[n] || []).forEach(f => f(cm, ...a));
    ta.addEventListener('input', () => { doc.lines = ta.value.split('\n'); doc.gen++; fire('changes'); });
    const cm = {
      state: {}, ta,
      swapDoc(d) { const o = doc; doc = d; ta.value = d.getValue(); return o; }, getDoc() { return doc; },
      on(n, f) { (h[n] = h[n] || []).push(f); }, getValue() { return doc.getValue(); },
      getCursor() { return doc.cursor; }, setCursor(p) { doc.cursor = p; }, scrollIntoView() {}, getScrollInfo() { return { clientHeight: 400, left: 0, top: 0 }; },
      refresh() {}, focus() { ta.focus(); }, getLine(i) { return doc.lines[i]; }, lineCount() { return doc.lines.length; }, lastLine() { return doc.lines.length - 1; },
      getAllMarks() { return doc.marks; }, markText(a, b, o) { const m = { className: o.className, clear() { doc.marks = doc.marks.filter(x => x !== m); } }; doc.marks.push(m); return m; },
      lineInfo(l) { return { gutterMarkers: doc.gm[l] }; }, setGutterMarker(l, g, el) { if (el) doc.gm[l] = { [g]: el }; else delete doc.gm[l]; },
      replaceRange(text, from, to) {
        const v = doc.getValue(); const idx = p => doc.lines.slice(0, p.line).join('\n').length + (p.line ? 1 : 0) + p.ch;
        const s = idx(from), e = to ? idx(to) : s; const nv = v.slice(0, s) + text + v.slice(e); doc.lines = nv.split('\n'); doc.gen++; ta.value = nv; fire('changes');
      },
      operation(f) { f(); }, scrollTo() {}, getTokenTypeAt() { return ''; }, showHint(o) { const put = d => { if (!d) return; window.__hintList = d.list.map(x => x.displayText); window.__hintItems = d.list; }; if (o.hint.async) o.hint(cm, put, o); else put(o.hint(cm, o)); },
      indentSelection() {}, replaceSelection() {}, somethingSelected() { return false; },
      getCursorFrom() {},
    };
    window.__cm = cm;
    return cm;
  }
  CM.Doc = function (t, m) { return new Doc(t, m); };
  CM.defineSimpleMode = function () {}; CM.on = function () {}; CM.Pos = function (line, ch) { return { line, ch }; };
  window.CodeMirror = CM;
})();
