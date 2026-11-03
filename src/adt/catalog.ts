// Catalog backed by a real system: repository search for names, object sources for
// fields, members and function module signatures. Results are cached per session.

import { AdtClient } from './client';
import { Catalog, CatEntry, ClassInfo, EntryKind, Field, FmInfo, parseCdsSource, parseClassSource, parseFmSource, parseTableSource } from '../core/catalog';

const ADT_OF: Record<EntryKind, string> = {
  table: 'TABL', structure: 'TABL', view: 'VIEW', cds: 'DDLS', dtel: 'DTEL', ttyp: 'TTYP', class: 'CLAS', exception: 'CLAS', interface: 'INTF', fm: 'FUGR/FF',
};
function kindOf(rawType: string, name: string): EntryKind | null {
  const t = rawType.toUpperCase();
  if (t.startsWith('TABL/DS')) return 'structure';
  if (t.startsWith('TABL')) return 'table';
  if (t.startsWith('DDLS')) return 'cds';
  if (t.startsWith('VIEW')) return 'view';
  if (t.startsWith('DTEL')) return 'dtel';
  if (t.startsWith('TTYP')) return 'ttyp';
  if (t.startsWith('INTF')) return 'interface';
  if (t.startsWith('CLAS')) return /(^|_|\/)CX_/i.test(name) ? 'exception' : 'class';
  if (t.startsWith('FUGR/FF')) return 'fm';
  return null;
}

export class RemoteCatalog implements Catalog {
  private search = new Map<string, Promise<CatEntry[]>>();
  private fields = new Map<string, Promise<Field[] | null>>();
  private classes = new Map<string, Promise<ClassInfo | null>>();
  private fms = new Map<string, Promise<FmInfo | null>>();

  constructor(private c: AdtClient) {}

  async find(prefix: string, kinds: EntryKind[], limit = 50): Promise<CatEntry[]> {
    if (!prefix) return [];                         // never list a whole repository
    const types = [...new Set(kinds.map(k => ADT_OF[k]))];
    const lists = await Promise.all(types.map(t => {
      const key = `${t}|${prefix.toUpperCase()}`;
      const cached = this.search.get(key);
      if (cached) return cached;
      const p: Promise<CatEntry[]> = this.c.searchObjects(prefix + '*', t, limit)
        .then(r => r.flatMap(o => { const kind = kindOf(o.type, o.name); return kind ? [{ name: o.name, kind, desc: o.desc, released: true }] : []; }))
        .catch(() => [] as CatEntry[]);
      this.search.set(key, p);
      setTimeout(() => this.search.delete(key), 60_000);
      return p;
    }));
    return lists.flat().filter(e => kinds.includes(e.kind)).slice(0, limit);
  }

  fieldsOf(name: string): Promise<Field[] | null> {
    const n = name.toLowerCase();
    let p = this.fields.get(n);
    if (!p) {
      const enc = encodeURIComponent(n);
      const tryGet = async (path: string, parse: (s: string) => Field[]) => parse(await this.c.source(path, 'active'));
      p = tryGet(`/sap/bc/adt/ddic/ddl/sources/${enc}/source/main`, parseCdsSource)
        .catch(() => tryGet(`/sap/bc/adt/ddic/tables/${enc}/source/main`, parseTableSource))
        .catch(() => tryGet(`/sap/bc/adt/ddic/structures/${enc}/source/main`, parseTableSource))
        .then(f => (f.length ? f : null))
        .catch(() => null);
      this.fields.set(n, p);
    }
    return p;
  }

  classInfo(name: string): Promise<ClassInfo | null> {
    const n = name.toLowerCase();
    let p = this.classes.get(n);
    if (!p) {
      const enc = encodeURIComponent(n);
      p = this.c.source(`/sap/bc/adt/oo/classes/${enc}/source/main`, 'active')
        .catch(() => this.c.source(`/sap/bc/adt/oo/interfaces/${enc}/source/main`, 'active'))
        .then(src => parseClassSource(src, n))
        .catch(() => null);
      this.classes.set(n, p);
    }
    return p;
  }

  fm(name: string): Promise<FmInfo | null> {
    const n = name.toUpperCase();
    let p = this.fms.get(n);
    if (!p) {
      p = this.c.searchObjects(n, 'FUGR/FF', 5)
        .then(r => r.find(o => o.name.toUpperCase() === n))
        .then(hit => (hit ? this.c.source(`${hit.uri}/source/main`, 'active').then(src => parseFmSource(src, n)) : null))
        .catch(() => null);
      this.fms.set(n, p);
    }
    return p;
  }

  async rowTypeOf(): Promise<string | null> { return null; }
}
