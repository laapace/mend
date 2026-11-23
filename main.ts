// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the `R` output lines (SPEC.md section 2). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of a hunk or chunk body: ' ' context, '-' old, '+' new. `nonl` means a `\` line followed it. */
interface Op {
  k: ' ' | '-' | '+';
  s: string;
  nonl?: boolean;
  /** An empty patch line read as a context line; trailing ones are not part of a hunk body. */
  fromEmpty?: boolean;
}

/** A file split into lines (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  nl: string;
  endsNl: boolean;
}

function splitFile(text: string): FileModel {
  const i = text.indexOf('\n');
  const nl = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const endsNl = text.length > 0 && text.endsWith(nl);
  const lines = text === '' ? [] : text.split(nl);
  if (endsNl) lines.pop();
  return { lines, nl, endsNl };
}

function joinFile(lines: string[], nl: string, endsNl: boolean): string {
  return lines.length === 0 ? '' : lines.join(nl) + (endsNl ? nl : '');
}

/** Tier normalisation (SPEC.md section 5): only spaces and tabs, never trim() or \s. */
const norm = [
  (s: string): string => s,
  (s: string): string => s.replace(/[ \t]+$/, ''),
  (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, ''),
];

const lead = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/**
 * Find O in the file's lines at the first tier where it occurs at least once (section 5).
 * Only occurrences at or after `from` count, and with `eofOnly` only ones ending at the file's
 * last line; occurrences may overlap, and a tier is chosen before the caller sees ambiguity.
 */
function occ(
  lines: string[],
  O: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { t: number; pos: number[] } | null {
  const k = O.length;
  for (const t of strict ? [0] : [0, 1, 2]) {
    const nO = O.map(norm[t]!);
    const nF = lines.map(norm[t]!);
    const pos: number[] = [];
    for (let i = from; i + k <= lines.length; i++) {
      if (eofOnly && i + k !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (nF[i + j] !== nO[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { t, pos };
  }
  return null;
}

/**
 * Rebuild the lines that replace the matched ones (section 5). A context line is written as the
 * file's own matched line, never the patch's. At tier 2 every other line of N that is not empty
 * and not only whitespace, and starts with P (the leading spaces and tabs of O's first line),
 * has that P replaced by F (the leading spaces and tabs of the file's first matched line).
 */
function rebuild(ops: Op[], lines: string[], i: number, t: number): string[] {
  const O = ops.filter((o) => o.k === ' ' || o.k === '-').map((o) => o.s);
  const F = lead(lines[i]!);
  const P = O.length > 0 ? lead(O[0]!) : '';
  const out: string[] = [];
  let j = 0;
  for (const op of ops) {
    if (op.k === ' ') {
      out.push(lines[i + j]!);
      j++;
    } else if (op.k === '-') {
      j++;
    } else if (t === 2 && /\S/.test(op.s) && op.s.startsWith(P)) {
      out.push(F + op.s.slice(P.length));
    } else {
      out.push(op.s);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** ---- Section 6: unified diffs ---- */

interface Hunk {
  A: number;
  ops: Op[];
}

interface UniSection {
  line: number;
  X: string | null;
  Y: string | null;
  pOld: string | null;
  pNew: string | null;
  hasPair: boolean;
  rFrom: string | null;
  rTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

const hunkHead = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, spaces removed. */
function uniPath(l: string): string {
  return l.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string | null {
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const secs: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const parseErr = (no: number): never => {
    throw new Exit2(`error: parse ${no}`);
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      const m1 = /^a\/(.+) b\/\1$/.exec(rest);
      const m2 = m1 === null ? /^a\/(.+?) b\/(.+)$/.exec(rest) : null;
      if (m1 === null && m2 === null) parseErr(i + 1);
      const X = (m1?.[1] ?? m2![1])!;
      const Y = (m1?.[1] ?? m2![2])!;
      cur = { line: i + 1, X, Y, pOld: null, pNew: null, hasPair: false, rFrom: null, rTo: null, isNew: false, isDel: false, hunks: [] };
      secs.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ') && !(inHeader && cur !== null && !cur.hasPair)) {
      cur = { line: i + 1, X: null, Y: null, pOld: stripAB(uniPath(l)), pNew: stripAB(uniPath(lines[i + 1]!)), hasPair: true, rFrom: null, rTo: null, isNew: false, isDel: false, hunks: [] };
      secs.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (inHeader && cur !== null && l.startsWith('--- ')) {
      if (i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
        cur.pOld = stripAB(uniPath(l));
        cur.pNew = stripAB(uniPath(lines[i + 1]!));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      parseErr(i + 2);
    }
    if (l.startsWith('@@')) {
      if (cur === null) parseErr(i + 1);
      const m = hunkHead.exec(l);
      if (m === null) parseErr(i + 1);
      inHeader = false;
      const A = parseInt(m[1]!, 10);
      const ops: Op[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ') || (bl.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ '))) break;
        const c = bl[0];
        if (bl === '') ops.push({ k: ' ', s: '', fromEmpty: true });
        else if (c === ' ') ops.push({ k: ' ', s: bl.slice(1) });
        else if (c === '-' || c === '+') ops.push({ k: c, s: bl.slice(1) });
        else if (c === '\\') {
          if (ops.length > 0) ops[ops.length - 1]!.nonl = true;
        } else break;
        j++;
      }
      while (ops.length > 0 && ops[ops.length - 1]!.fromEmpty) ops.pop();
      cur.hunks.push({ A, ops });
      i = j;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) cur.rFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.rTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDel = true;
      i++;
      continue;
    }
    i++;
  }
  if (secs.length === 0) parseErr(1);
  return secs.map((s) => uniEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text (section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  const lines = f.lines;
  let endsNl = f.endsNl;
  let d = 0;
  for (const h of hunks) {
    const O = h.ops.filter((o) => o.k === ' ' || o.k === '-').map((o) => o.s);
    const N = h.ops.filter((o) => o.k === ' ' || o.k === '+').map((o) => o.s);
    const beforeLen = lines.length;
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.A + d, lines.length));
      const out = h.ops.filter((o) => o.k === '+').map((o) => o.s);
      lines.splice(pos, 0, ...out);
      if (pos === beforeLen) {
        const lastCP = h.ops.filter((o) => o.k === ' ' || o.k === '+').at(-1);
        endsNl = !(lastCP !== undefined && lastCP.nonl === true);
      }
    } else {
      const r = occ(lines, O, strict);
      if (r === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = r.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of r.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const out = rebuild(h.ops, lines, best, r.t);
      lines.splice(best, O.length, ...out);
      if (best + O.length === beforeLen) {
        const lastCP = h.ops.filter((o) => o.k === ' ' || o.k === '+').at(-1);
        endsNl = !(lastCP !== undefined && lastCP.nonl === true);
      }
    }
    d += N.length - O.length;
  }
  return joinFile(lines, f.nl, endsNl);
}

function uniEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.hasPair ? s.pOld : (s.rFrom ?? s.X);
  const newP = s.hasPair ? s.pNew : (s.rTo ?? s.Y);
  // Both paths /dev/null: the spec is silent; refuse the section rather than crash.
  if (oldP === null && newP === null) throw new Exit2(`error: parse ${s.line}`);
  const kind = oldP === null || s.isNew ? 'create' : newP === null || s.isDel ? 'delete' : oldP !== newP ? 'move' : 'change';
  if (kind === 'create') {
    const np = newP!;
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus = s.hunks.flatMap((h) => h.ops.filter((o) => o.k === '+'));
      const text = plus.length === 0 ? '' : plus.map((o) => o.s).join('\n') + (plus[plus.length - 1]!.nonl === true ? '' : '\n');
      tree.now.set(np, text);
    };
  }
  if (kind === 'delete') {
    const op = oldP!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (kind === 'move') {
    const op = oldP!;
    const np = newP!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const text = applyHunks(tree.get(op)!, s.hunks, strict, op);
      tree.now.set(np, text);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    const text = applyHunks(tree.get(p)!, s.hunks, strict, p);
    tree.now.set(p, text);
  };
}

/** ---- Section 7: SEARCH/REPLACE blocks ---- */

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const blocks: SrBlock[] = [];
  let lastEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j > lastEnd; j--) {
        const t = lines[j]!.trim();
        if (t !== '' && !t.startsWith('```')) {
          path = t;
          break;
        }
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${i + 1}`);
      let e = -1;
      for (let k = i + 1; k < n; k++) {
        if (lines[k]!.trimEnd() === '=======') {
          e = k;
          break;
        }
      }
      if (e < 0) throw new Exit2(`error: parse ${i + 1}`);
      let r = -1;
      for (let k = e + 1; k < n; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          r = k;
          break;
        }
      }
      if (r < 0) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, old: lines.slice(i + 1, e), nw: lines.slice(e + 1, r) });
      prevPath = path;
      lastEnd = r;
      i = r + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const r = occ(f.lines, b.old, strict);
    if (r === null) throw new Fail('no-match', p);
    if (r.pos.length > 1) throw new Fail('ambiguous', p);
    const ops: Op[] = [
      ...b.old.map((s): Op => ({ k: '-', s })),
      ...b.nw.map((s): Op => ({ k: '+', s })),
    ];
    const out = rebuild(ops, f.lines, r.pos[0]!, r.t);
    f.lines.splice(r.pos[0]!, b.old.length, ...out);
    tree.now.set(p, joinFile(f.lines, f.nl, f.endsNl));
  };
}

/** ---- Section 8: V4A patches ---- */

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  content: { text: string; no: number }[];
}

interface V4aChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

const v4aStarters = ['*** Add File: ', '*** Delete File: ', '*** Update File: '] as const;

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const b = lines.findIndex((l) => !blank(l));
  if (b < 0) throw new Exit2('error: parse 1');
  if (lines[b]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${b + 1}`);
  let e = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      e = k;
      break;
    }
  }
  if (lines[e]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const body = lines.slice(b + 1, e);
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    const no = b + k + 2;
    let matched: V4aSection | null = null;
    for (const s of v4aStarters) {
      if (l.startsWith(s)) {
        matched = { kind: s === v4aStarters[0] ? 'add' : s === v4aStarters[1] ? 'delete' : 'update', path: l.slice(s.length).trim(), line: no, content: [] };
        break;
      }
    }
    if (matched !== null) {
      sections.push(matched);
      cur = matched;
    } else if (cur === null) {
      if (!blank(l)) throw new Exit2(`error: parse ${no}`);
    } else {
      cur.content.push({ text: l, no });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  for (const s of sections) {
    while (s.content.length > 0 && blank(s.content[s.content.length - 1]!.text)) s.content.pop();
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const c of s.content) {
      if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
      else if (c.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${c.no}`);
    }
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    for (const c of s.content) throw new Exit2(`error: parse ${c.no}`);
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  // Update: a `*** Move to: ` line only as the first line, then chunks.
  let moveTo: string | null = null;
  let idx = 0;
  if (s.content.length > 0 && s.content[0]!.text.startsWith('*** Move to: ')) {
    moveTo = s.content[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let curChunk: V4aChunk | null = null;
  let closed = false;
  for (let k = idx; k < s.content.length; k++) {
    const c = s.content[k]!;
    const l = c.text;
    if (l.startsWith('@@')) {
      curChunk = { anchor: l.slice(2).trim() || null, ops: [], eof: false };
      chunks.push(curChunk);
      closed = false;
    } else if (l === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${c.no}`);
      curChunk.eof = true;
      closed = true;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (closed) throw new Exit2(`error: parse ${c.no}`);
      if (curChunk === null) {
        curChunk = { anchor: null, ops: [], eof: false };
        chunks.push(curChunk);
      }
      curChunk.ops.push({ k: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), s: l === '' ? '' : l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${c.no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.line}`);
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    const lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = occ(lines, [ch.anchor], strict, cursor, false);
        if (a === null) throw new Fail('no-match', s.path);
        cursor = a.pos[0]! + 1;
      }
      const O = ch.ops.filter((o) => o.k === ' ' || o.k === '-').map((o) => o.s);
      if (O.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const out = ch.ops.filter((o) => o.k === '+').map((o) => o.s);
        lines.splice(pos, 0, ...out);
        cursor = pos + out.length;
      } else {
        const r = occ(lines, O, strict, cursor, ch.eof);
        if (r === null) throw new Fail('no-match', s.path);
        const i = r.pos[0]!;
        const out = rebuild(ch.ops, lines, i, r.t);
        lines.splice(i, O.length, ...out);
        cursor = i + out.length;
      }
    }
    const text = joinFile(lines, f.nl, f.endsNl);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, moveTo]);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move whose old path existed before and does not after, and whose new path did not exist
  // before and does after, is one `R <old> -> <new>` line in place of that pair's `D` and `A`
  // lines, and sorts by <new> (SPEC.md section 2).
  const rMoves: [string, string][] = [];
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) rMoves.push([old, nw]);
  }
  const rOld = new Set(rMoves.map(([o]) => o));
  const rNew = new Set(rMoves.map(([, n]) => n));
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null && rOld.has(p)) continue;
    if (was === null && rNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [old, nw] of rMoves) rows.push({ key: nw, line: `R ${old} -> ${nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
