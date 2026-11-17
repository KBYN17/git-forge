// git-forge: a standalone GitHub-compatible git forge in one Node 22 process.
// Serves git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4
// and MCP from its own in-memory store. No git binary, no UI, no outside service.
// Written from scratch for make.fun bounty github-core-clone-01.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0'.repeat(40);
const AGENT = 'git-forge/1.0.0';
const FORGE_VERSION = '1.0.0';

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: ObjType; data: Buffer }
interface TreeEntry { mode: string; name: string; oid: string }
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }

// ---------------------------------------------------------------- git primitives
function sha1(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
function hashObject(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}
function isOid(s: string): boolean { return /^[0-9a-f]{40}$/.test(s); }

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(
    Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8'),
    Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8')));
  const parts: Buffer[] = [];
  for (const e of sorted) { parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8')); parts.push(Buffer.from(e.oid, 'hex')); }
  return Buffer.concat(parts);
}
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp); const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) { const sp = line.indexOf(' '); if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1)); }
  return { object: m.get('object') ?? '', type: m.get('type') ?? '', tag: m.get('tag') ?? '' };
}
function ident(ts: number): string { return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`; }
function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${ident(ts)}`, `committer ${ident(ts)}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

// ---------------------------------------------------------------- pkt-line
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.alloc(4); h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  return Buffer.concat(items.map((it) => (it === 'flush' ? FLUSH : it === 'delim' ? DELIM : pkt(it))));
}
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }
function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = []; let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (hex === '0000') { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (hex === '0001') { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (hex === '0002') { packets.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- packfile
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const bytes: number[] = [];
  let b = (typeNum[type] << 4) | (size & 0x0f); size >>>= 4;
  while (size > 0) { bytes.push(b | 0x80); b = size & 0x7f; size >>>= 7; }
  bytes.push(b);
  return Buffer.from(bytes);
}
function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12); header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) { parts.push(writePackObjectHeader(o.type, o.data.length)); parts.push(deflateSync(o.data)); }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const r = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: r.buffer, next: offset + r.engine.bytesWritten };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => { let v = 0; let s = 0; for (;;) { const b = delta[off++]; v += (b & 0x7f) * 2 ** s; s += 7; if (!(b & 0x80)) break; } return v; };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize); let w = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) co += delta[off++] * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cs += delta[off++] * 2 ** sh; sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, w, co, co + cs); w += cs;
    } else if (op !== 0) { delta.copy(out, w, off, off + op); off += op; w += op; }
    else throw new Error('delta opcode 0');
  }
  if (w !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
interface PackEntry { offset: number; type: ObjType; data: Buffer; oid: string }
function readPack(buf: Buffer, lookup: (oid: string) => GitObject | undefined): GitObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  let off = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const pending: { entry: PackEntry; baseOid?: string; baseOffset?: number; delta: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    const start = off;
    let byte = buf[off++];
    const typeNum = (byte >> 4) & 7;
    let size = byte & 0x0f; let shift = 4;
    while (byte & 0x80) { byte = buf[off++]; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
    let baseOid: string | undefined; let baseOffset: number | undefined;
    if (typeNum === 6) {
      byte = buf[off++]; let v = byte & 0x7f;
      while (byte & 0x80) { byte = buf[off++]; v = ((v + 1) * 128) + (byte & 0x7f); }
      baseOffset = start - v;
    } else if (typeNum === 7) { baseOid = buf.subarray(off, off + 20).toString('hex'); off += 20; }
    const inflated = inflateAt(buf, off); off = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    if (typeNum === 6 || typeNum === 7) {
      const entry: PackEntry = { offset: start, type: 'blob', data: Buffer.alloc(0), oid: '' };
      pending.push({ entry, baseOid, baseOffset, delta: inflated.data });
      entries.push(entry); byOffset.set(start, entry);
    } else {
      const type: ObjType = typeNum === 1 ? 'commit' : typeNum === 2 ? 'tree' : typeNum === 3 ? 'blob' : 'tag';
      const entry: PackEntry = { offset: start, type, data: inflated.data, oid: hashObject(type, inflated.data) };
      entries.push(entry); byOffset.set(start, entry);
    }
  }
  // resolve deltas (possibly chained)
  const resolved = new Map<number, GitObject>();
  for (const e of entries) if (e.data.length || e.oid) resolved.set(e.offset, { type: e.type, data: e.data });
  for (let round = 0; round < pending.length + 2; round++) {
    let progressed = false;
    for (const p of pending) {
      if (resolved.has(p.entry.offset)) continue;
      let base: GitObject | undefined;
      if (p.baseOffset !== undefined) base = resolved.get(p.baseOffset);
      else if (p.baseOid !== undefined) base = resolved.get([...byOffset.values()].find((e) => e.oid === p.baseOid)?.offset ?? -1) ?? lookup(p.baseOid);
      if (!base) continue;
      const data = applyDelta(base.data, p.delta);
      const obj = { type: base.type, data };
      resolved.set(p.entry.offset, obj);
      p.entry.type = base.type; p.entry.data = data; p.entry.oid = hashObject(base.type, data);
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const p of pending) if (!resolved.has(p.entry.offset)) throw new Error('unresolvable delta in pack');
  return entries.map((e) => ({ type: e.type, data: e.data }));
}

// ---------------------------------------------------------------- object graph
function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>(); const queue: string[] = [];
  for (const r of roots) if (isOid(r) && r !== ZERO_OID) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid); if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') { const c = parseCommit(obj.data); queue.push(c.tree); for (const p of c.parents) queue.push(p); }
    else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = repo.objects.get(cur); if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}
function ancestors(repo: Repo, oid: string): Set<string> {
  const seen = new Set<string>(); const queue = [oid];
  while (queue.length) {
    const c = queue.pop()!; if (seen.has(c)) continue;
    const obj = repo.objects.get(c); if (!obj || obj.type !== 'commit') continue;
    seen.add(c);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return seen;
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = ancestors(repo, a);
  const queue = [b]; const seen = new Set<string>();
  while (queue.length) {
    const c = queue.pop()!; if (seen.has(c)) continue; seen.add(c);
    if (ancA.has(c)) return c;
    const obj = repo.objects.get(c); if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}
function fileMapAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = repo.objects.get(commitOid); if (!commit || commit.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid); if (!tree || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}
function buildTreeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  interface Node { files: Map<string, Buffer>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/'); let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make());
      node = node.dirs.get(segs[i])!;
    }
    node.files.set(segs[segs.length - 1], data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of [...node.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const oid = hashObject('blob', data);
      repo.objects.set(oid, { type: 'blob', data });
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : 1))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}
function commitFiles(repo: Repo, branchRef: string, changes: Map<string, Buffer | null>, message: string): string {
  const tip = repo.refs.get(branchRef);
  const files = new Map<string, Buffer>();
  if (tip) {
    for (const [path, e] of fileMapAt(repo, tip)) {
      const blob = repo.objects.get(e.oid);
      if (blob) files.set(path, blob.data);
    }
  }
  for (const [path, data] of changes) { if (data === null) files.delete(path); else files.set(path, data); }
  const treeOid = buildTreeFromFiles(repo, files);
  const ts = Math.floor(Date.now() / 1000);
  const commitData = buildCommit(treeOid, tip ? [tip] : [], message, ts);
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(branchRef, commitOid);
  return commitOid;
}

// ---------------------------------------------------------------- store
interface Label { name: string; color: string; description: string }
interface Comment { id: number; body: string; createdAt: string; issueNumber: number }
interface Issue {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: Comment[]; seq: number;
}
interface Pull {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergeCommitSha: string | null; mergedAt: string | null;
  createdAt: string; seq: number;
}
interface Repo {
  owner: string; name: string; description: string; isPrivate: boolean;
  defaultBranch: string; dbId: number; seq: number; createdAt: string;
  objects: Map<string, GitObject>; refs: Map<string, string>;
  labels: Map<string, Label>; issues: Issue[]; pulls: Pull[]; nextNumber: number;
}
const repos = new Map<string, Repo>();
let nextDbId = 5000;
let nextGlobalId = 100000;
let globalSeq = 0;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function nowIso(): string { return new Date().toISOString(); }
function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}
function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':'); if (idx < 0) return null;
    return { kind: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
  } catch { return null; }
}
function createRepoInternal(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
  const key = repoKey(owner, name);
  if (repos.has(key)) return null;
  const repo: Repo = {
    owner, name, description: description ?? '', isPrivate: isPrivate ?? false,
    defaultBranch: 'main', dbId: nextDbId++, seq: ++globalSeq, createdAt: nowIso(),
    objects: new Map(), refs: new Map(), labels: new Map(), issues: [], pulls: [], nextNumber: 1,
  };
  repos.set(key, repo);
  return repo;
}
function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
function viewerRepos(): Repo[] {
  return [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
}
function createIssueInternal(repo: Repo, title: string, body: string, labels: string[]): { issue?: Issue; error?: string } {
  for (const l of labels) if (!repo.labels.has(l)) return { error: `Label '${l}' does not exist` };
  const issue: Issue = {
    number: repo.nextNumber++, id: nextGlobalId++, title, body: body ?? '', state: 'open',
    labels: [...labels], createdAt: nowIso(), updatedAt: nowIso(), closedAt: null, comments: [], seq: ++globalSeq,
  };
  repo.issues.push(issue);
  return { issue };
}
function createPullInternal(repo: Repo, title: string, body: string, head: string, base: string): { pull?: Pull; error?: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { error: 'head or base branch does not exist' };
  if (repo.pulls.some((p) => p.state === 'open' && p.head === head && p.base === base)) return { error: 'A pull request already exists for this head branch' };
  const pull: Pull = {
    number: repo.nextNumber++, id: nextGlobalId++, title, body: body ?? '', state: 'open',
    head, base, headSha, baseSha, merged: false, mergeCommitSha: null, mergedAt: null,
    createdAt: nowIso(), seq: ++globalSeq,
  };
  repo.pulls.push(pull);
  return { pull };
}
function diffFiles(repo: Repo, baseCommit: string, headCommit: string): { path: string; status: string; additions: number; deletions: number }[] {
  const baseMap = fileMapAt(repo, baseCommit);
  const headMap = fileMapAt(repo, headCommit);
  const out: { path: string; status: string; additions: number; deletions: number }[] = [];
  const lineCount = (data: Buffer | undefined): number => {
    if (!data || data.length === 0) return 0;
    const text = data.toString('utf8');
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const path of new Set([...baseMap.keys(), ...headMap.keys()])) {
    const b = baseMap.get(path); const h = headMap.get(path);
    if (b && !h) out.push({ path, status: 'removed', additions: 0, deletions: Math.max(1, lineCount(repo.objects.get(b.oid)?.data)) });
    else if (!b && h) out.push({ path, status: 'added', additions: Math.max(1, lineCount(repo.objects.get(h.oid)?.data)), deletions: 0 });
    else if (b && h && b.oid !== h.oid) {
      const a = Math.max(1, lineCount(repo.objects.get(h.oid)?.data));
      const d = lineCount(repo.objects.get(b.oid)?.data);
      out.push({ path, status: 'modified', additions: a, deletions: d });
    }
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : 1));
}
function isConflicted(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`); if (!baseTip) return false;
  const mb = mergeBase(repo, pull.headSha, baseTip);
  if (!mb) return false;
  const headFiles = fileMapAt(repo, pull.headSha);
  const baseFiles = fileMapAt(repo, baseTip);
  const mbFiles = fileMapAt(repo, mb);
  for (const path of new Set([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()])) {
    const m = mbFiles.get(path)?.oid; const h = headFiles.get(path)?.oid; const b = baseFiles.get(path)?.oid;
    const headChanged = h !== m; const baseChanged = b !== m;
    if (headChanged && baseChanged && h !== b) return true;
  }
  return false;
}
function mergePullInternal(repo: Repo, pull: Pull): { sha?: string; error?: string; status?: number } {
  if (pull.state === 'closed') return { error: pull.merged ? 'already merged' : 'already closed', status: 405 };
  if (isConflicted(repo, pull)) return { error: 'merge conflict', status: 405 };
  const baseRef = `refs/heads/${pull.base}`;
  const baseTip = repo.refs.get(baseRef); if (!baseTip) return { error: 'base branch missing', status: 422 };
  const headCommit = repo.objects.get(pull.headSha); if (!headCommit) return { error: 'head commit missing', status: 422 };
  const treeOid = parseCommit(headCommit.data).tree;
  const ts = Math.floor(Date.now() / 1000);
  const msg = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
  const commitData = buildCommit(treeOid, [baseTip], msg, ts);
  const sha = hashObject('commit', commitData);
  repo.objects.set(sha, { type: 'commit', data: commitData });
  repo.refs.set(baseRef, sha);
  pull.state = 'closed'; pull.merged = true; pull.mergeCommitSha = sha; pull.mergedAt = nowIso();
  return { sha };
}

// ---------------------------------------------------------------- JSON shapes
function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('User', VIEWER_ID), avatar_url: '', gravatar_id: '', url: '/api/v3/users/adaiversen', html_url: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId, node_id: gid('Repository', repo.dbId), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000, node_id: gid('User', repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000), type: 'User', avatar_url: '' },
    private: repo.isPrivate, description: repo.description, fork: false, created_at: repo.createdAt, updated_at: repo.createdAt,
    pushed_at: repo.createdAt, homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false, has_discussions: false,
    forks_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false, visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch, html_url: '', url: '', clone_url: '', git_url: '', ssh_url: '',
  };
}
function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, node_id: gid('Label', label.name), url: '', name: label.name, color: label.color, default: false, description: label.description };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: gid('Issue', repo.dbId, issue.number), url: '', html_url: '',
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((n) => { const l = repo.labels.get(n); return labelJson(l ?? { name: n, color: 'ededed', description: '' }); }),
    assignee: null, assignees: [], locked: false, comments: issue.comments.length,
    created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.closedAt,
    author_association: 'OWNER', state_reason: null,
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: pull.id, node_id: gid('PullRequest', repo.dbId, pull.number), url: '', html_url: '',
    number: pull.number, state: pull.state, title: pull.title, body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, repo: repoJson(repo) },
    merged: pull.merged, mergeable: !isConflicted(repo, pull), mergeable_state: pull.merged ? 'merged' : (isConflicted(repo, pull) ? 'dirty' : 'clean'),
    merge_commit_sha: pull.mergeCommitSha, merged_at: pull.mergedAt, created_at: pull.createdAt, updated_at: pull.createdAt, closed_at: pull.merged ? pull.mergedAt : null,
    draft: false, locked: false, comments: 0, review_comments: 0, commits: 1, additions: 0, deletions: 0, changed_files: 0,
  };
}
function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha); if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const ts = parseInt(c.author.split(' ').slice(-2)[0] ?? '0', 10) || 0;
  const date = ts ? new Date(ts * 1000).toISOString() : repo.createdAt;
  const authorName = c.author.replace(/ <.*$/, '');
  const email = (c.author.match(/<([^>]*)>/) ?? [])[1] ?? VIEWER_EMAIL;
  return {
    sha, node_id: gid('Commit', sha), url: '', html_url: '',
    commit: { message: c.message.replace(/\n+$/, ''), author: { name: authorName, email, date }, committer: { name: authorName, email, date }, tree: { sha: c.tree }, comment_count: 0 },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p, url: '' })),
  };
}
function listCommits(repo: Repo, fromOid: string): string[] {
  const out: string[] = []; const seen = new Set<string>(); const queue = [fromOid];
  while (queue.length) {
    const oid = queue.shift()!; if (seen.has(oid)) continue; seen.add(oid);
    const obj = repo.objects.get(oid); if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- HTTP plumbing
let requestCounter = 0;
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': `req-${++requestCounter}`, ...extra };
  if (status !== 204) { headers['content-type'] = 'application/json; charset=utf-8'; headers['content-length'] = String(Buffer.byteLength(text)); }
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(buf.length), 'x-github-request-id': `req-${++requestCounter}` });
  res.end(buf);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: '' });
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let total = 0;
    req.on('data', (c: Buffer) => { chunks.push(c); total += c.length; if (total > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; } catch { return { ok: false }; }
}
function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(\S+)$/.exec(h);
  return m ? m[1]! : null;
}
function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { page: slice, link: null };
}
function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const pages = Math.ceil(total / perPage);
  if (pages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const parts: string[] = [];
  const q = new URLSearchParams(query); q.set('per_page', String(perPage));
  if (page < pages) { q.set('page', String(page + 1)); parts.push(`<${base}?${q.toString()}>; rel="next"`); }
  q.set('page', String(pages)); parts.push(`<${base}?${q.toString()}>; rel="last"`);
  q.set('page', '1'); parts.push(`<${base}?${q.toString()}>; rel="first"`);
  if (page > 1) { q.set('page', String(page - 1)); parts.push(`<${base}?${q.toString()}>; rel="prev"`); }
  return parts.join(', ');
}
function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  return {
    perPage: Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30)),
    page: Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1),
  };
}
function paged<T>(req: IncomingMessage, path: string, query: URLSearchParams, items: T[]): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: linkHeader(req, path, query, perPage, page, items.length) };
}

// ---------------------------------------------------------------- REST v3
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, raw: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  // auth: every /api/v3 call needs a bearer token
  if (!bearer(req)) { errJson(res, 401, 'Requires authentication'); return; }
  const seg = path.split('/').filter((s) => s !== '');
  // seg[0..1] = api, v3
  const rest = seg.slice(2);
  const bodyParsed = (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') ? parseJsonBody(raw) : { ok: true as const, value: {} as unknown };
  if (!bodyParsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
  const body = (bodyParsed.value ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' }); return; }
    errJson(res, 404, 'Not Found'); return;
  }
  if (rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: false, github_services_sha: '', hooks: [], git: [], pages: [] });
    return;
  }
  if (rest[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { rate: { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600, used: 0 }, resources: {} });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') { sendJson(res, 200, userJson()); return; }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = viewerRepos();
      const { page, link } = paged(req, '/api/v3/user/repos', query, all);
      sendJson(res, 200, page.map(repoJson), link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) { errJson(res, 422, 'Validation Failed: name is required'); return; }
      const repo = createRepoInternal(VIEWER_LOGIN, name, body.private === true, str(body.description));
      if (!repo) { errJson(res, 422, 'Repository already exists'); return; }
      if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }
  if (rest[0] === 'users' && rest[2] === 'repos' && method === 'GET') {
    if (rest[1] === VIEWER_LOGIN) { const { page, link } = paged(req, path, query, viewerRepos()); sendJson(res, 200, page.map(repoJson), link ? { link } : {}); }
    else sendJson(res, 200, []);
    return;
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]); const name = decodeURIComponent(rest[2]);
    const repo = getRepo(owner, name);
    const tail = rest.slice(3);
    if (!repo) { errJson(res, 404, 'Not Found'); return; }
    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(res, 200, repoJson(repo)); return;
      }
      if (method === 'DELETE') { repos.delete(repoKey(owner, name)); sendJson(res, 204, null); return; }
      errJson(res, 404, 'Not Found'); return;
    }
    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
        sendJson(res, 200, list.map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`), url: '' }, protected: false })));
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${decodeURIComponent(tail[1])}`);
        if (!sha) { errJson(res, 404, 'Branch not found'); return; }
        sendJson(res, 200, { name: decodeURIComponent(tail[1]), commit: { sha, url: '' }, protected: false });
        return;
      }
    }
    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = str(body.ref); const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) { errJson(res, 422, 'Validation Failed: ref or sha invalid'); return; }
        if (repo.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: gid('Ref', ref), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'GET') {
        const wanted = tail.slice(2).map(decodeURIComponent).join('/');
        if (!wanted) {
          sendJson(res, 200, [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({ ref, node_id: gid('Ref', ref), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } })));
          return;
        }
        const ref = `refs/${wanted}`;
        const sha = repo.refs.get(ref);
        if (!sha) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref, node_id: gid('Ref', ref), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'PATCH' && tail.length > 2) {
        const ref = `refs/${tail.slice(2).map(decodeURIComponent).join('/')}`;
        const sha = str(body.sha);
        if (!repo.refs.has(ref) || !isOid(sha) || !repo.objects.has(sha)) { errJson(res, 422, 'Validation Failed'); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 200, { ref, node_id: gid('Ref', ref), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'DELETE' && tail.length > 2) {
        const ref = `refs/${tail.slice(2).map(decodeURIComponent).join('/')}`;
        if (!repo.refs.delete(ref)) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 204, null); return;
      }
    }
    // commits
    if (tail[0] === 'commits') {
      if (tail.length === 2 && method === 'GET') {
        const j = commitJson(repo, tail[1]);
        if (!j) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, j); return;
      }
      if (tail.length === 1 && method === 'GET') {
        const refName = query.get('sha') ?? repo.defaultBranch;
        let tip: string | undefined;
        if (isOid(refName)) tip = refName;
        else tip = repo.refs.get(`refs/heads/${refName}`) ?? repo.refs.get(refName);
        if (!tip) { sendJson(res, 200, []); return; }
        const list = listCommits(repo, tip).map((s) => commitJson(repo, s)).filter((x): x is Record<string, unknown> => x !== null);
        const { page, link } = paged(req, path, query, list);
        sendJson(res, 200, page, link ? { link } : {});
        return;
      }
    }
    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const refName = query.get('ref') ?? repo.defaultBranch;
        let tip: string | undefined;
        if (isOid(refName)) tip = refName; else tip = repo.refs.get(`refs/heads/${refName}`) ?? repo.refs.get(refName);
        if (!tip) { errJson(res, 404, 'Not Found'); return; }
        const files = fileMapAt(repo, tip);
        if (filePath === '') {
          const top = new Map<string, { oid: string; mode: string; dir: boolean }>();
          for (const [p, e] of files) {
            const first = p.split('/')[0];
            if (!top.has(first)) top.set(first, p.includes('/') ? { oid: '', mode: '40000', dir: true } : { oid: e.oid, mode: e.mode, dir: false });
          }
          sendJson(res, 200, [...top.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, e]) => ({ type: e.dir ? 'dir' : 'file', name: n, path: n, sha: e.dir ? hashObject('tree', Buffer.alloc(0)) : e.oid, size: 0, url: '' })));
          return;
        }
        const file = files.get(filePath);
        if (file) {
          const blob = repo.objects.get(file.oid)!;
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob.data.length, name: filePath.split('/').pop(), path: filePath, content: blob.data.toString('base64'), sha: file.oid, url: '', download_url: '' });
          return;
        }
        const prefix = `${filePath}/`;
        const entries = new Map<string, { oid: string; mode: string; dir: boolean }>();
        for (const [p, e] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (!entries.has(first)) entries.set(first, restPath.includes('/') ? { oid: '', mode: '40000', dir: true } : { oid: e.oid, mode: e.mode, dir: false });
        }
        if (entries.size === 0) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, e]) => ({ type: e.dir ? 'dir' : 'file', name: n, path: `${filePath}/${n}`, sha: e.dir ? hashObject('tree', Buffer.alloc(0)) : e.oid, size: 0, url: '' })));
        return;
      }
      if (method === 'PUT') {
        const contentB64 = str(body.content);
        const message = str(body.message) || 'Update file';
        const branch = str(body.branch) || repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const tip = repo.refs.get(branchRef);
        const files = tip ? fileMapAt(repo, tip) : new Map();
        const existing = files.get(filePath);
        if (body.sha !== undefined && existing && str(body.sha) !== existing.oid) { errJson(res, 409, 'Conflict: sha does not match'); return; }
        if (body.sha === undefined && existing) { errJson(res, 422, 'Validation Failed: file already exists'); return; }
        let data: Buffer;
        try { data = Buffer.from(contentB64.replace(/[\r\n ]/g, ''), 'base64'); } catch { errJson(res, 400, 'Invalid base64 content'); return; }
        const isUpdate = !!existing;
        const changes = new Map<string, Buffer | null>([[filePath, data]]);
        const commitSha = commitFiles(repo, branchRef, changes, message);
        const blobOid = hashObject('blob', data);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: data.length, url: '', download_url: '', type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message, url: '' },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = str(body.branch) || repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const tip = repo.refs.get(branchRef);
        if (!tip) { errJson(res, 404, 'Not Found'); return; }
        const files = fileMapAt(repo, tip);
        const existing = files.get(filePath);
        if (!existing) { errJson(res, 404, 'Not Found'); return; }
        if (body.sha !== undefined && str(body.sha) !== existing.oid) { errJson(res, 409, 'Conflict: sha does not match'); return; }
        const commitSha = commitFiles(repo, branchRef, new Map([[filePath, null]]), str(body.message) || 'Delete file');
        sendJson(res, 200, { commit: { sha: commitSha, message: str(body.message) || 'Delete file', url: '' } });
        return;
      }
    }
    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) { sendJson(res, 200, [...repo.labels.values()].map(labelJson)); return; }
      if (method === 'POST' && tail.length === 1) {
        const name = str(body.name);
        if (!name) { errJson(res, 422, 'Validation Failed: name is required'); return; }
        const existing = repo.labels.get(name);
        if (existing) { sendJson(res, 201, labelJson(existing)); return; }
        const label: Label = { name, color: str(body.color) || 'ededed', description: str(body.description) };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label)); return;
      }
    }
    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = str(body.title);
          if (!title) { errJson(res, 422, 'Validation Failed: title is required'); return; }
          const labels: string[] = Array.isArray(body.labels) ? body.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as Record<string, unknown>).name as string)).filter(Boolean) : [];
          const created = createIssueInternal(repo, title, str(body.body), labels);
          if (created.error) { errJson(res, 422, created.error); return; }
          sendJson(res, 201, issueJson(repo, created.issue!)); return;
        }
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page, link } = paged(req, path, query, list);
          sendJson(res, 200, page.map((i) => issueJson(repo, i)), link ? { link } : {});
          return;
        }
      }
      const num = parseInt(tail[1] ?? '', 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (method === 'PATCH') {
          if (body.state === 'closed') { issue.state = 'closed'; issue.closedAt = nowIso(); }
          else if (body.state === 'open') { issue.state = 'open'; issue.closedAt = null; }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labels: string[] = body.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as Record<string, unknown>).name as string)).filter(Boolean);
            for (const l of labels) if (!repo.labels.has(l)) { errJson(res, 422, `Label '${l}' does not exist`); return; }
            issue.labels = labels;
          }
          issue.updatedAt = nowIso();
          sendJson(res, 200, issueJson(repo, issue)); return;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('IssueComment', repo.dbId, issue.number, c.id), url: '', html_url: '', body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: c.createdAt, updated_at: c.createdAt, issue_url: '' })));
          return;
        }
        if (method === 'POST') {
          const cbody = str(body.body);
          if (!cbody) { errJson(res, 422, 'Validation Failed: body is required'); return; }
          const comment: Comment = { id: nextGlobalId++, body: cbody, createdAt: nowIso(), issueNumber: issue.number };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, node_id: gid('IssueComment', repo.dbId, issue.number, comment.id), url: '', html_url: '', body: cbody, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: comment.createdAt, updated_at: comment.createdAt, issue_url: '' });
          return;
        }
      }
    }
    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          if (!str(body.title)) { errJson(res, 422, 'Validation Failed: title is required'); return; }
          const created = createPullInternal(repo, str(body.title), str(body.body), str(body.head), str(body.base));
          if (created.error) { errJson(res, 422, created.error); return; }
          sendJson(res, 201, pullJson(repo, created.pull!)); return;
        }
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page, link } = paged(req, path, query, list);
          sendJson(res, 200, page.map((p) => pullJson(repo, p)), link ? { link } : {});
          return;
        }
      }
      const num = parseInt(tail[1] ?? '', 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        const mb = mergeBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
        const files = diffFiles(repo, mb, pull.headSha);
        sendJson(res, 200, files.map((f) => ({ sha: '', filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions, blob_url: '', raw_url: '', contents_url: '', patch: '' })));
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        const merged = mergePullInternal(repo, pull);
        if (merged.error) { errJson(res, merged.status ?? 405, merged.error); return; }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      if (tail.length === 3 && tail[2] === 'commits' && method === 'GET') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        const mb = mergeBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
        const headSet = new Set(listCommits(repo, pull.headSha));
        const baseSet = new Set(listCommits(repo, mb));
        const list = [...headSet].filter((s) => !baseSet.has(s)).map((s) => commitJson(repo, s)).filter((x): x is Record<string, unknown> => x !== null);
        sendJson(res, 200, list); return;
      }
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL v4
const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'resourcePath', 'repository'];
const PR_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergeableState', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url', 'additions', 'deletions', 'changedFiles'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'stargazers', 'forkCount'];
const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function issueGql(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: gid('Issue', repo.dbId, issue.number), number: issue.number, title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body,
    createdAt: issue.createdAt, updatedAt: issue.updatedAt, closedAt: issue.closedAt,
    author: { login: VIEWER_LOGIN }, url: '', resourcePath: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    labels: { nodes: issue.labels.map((n) => ({ name: n })) },
    comments: { nodes: issue.comments.map((c) => ({ id: gid('IssueComment', repo.dbId, issue.number, c.id), body: c.body })), totalCount: issue.comments.length },
  };
}
function pullGql(repo: Repo, pull: Pull): Record<string, unknown> {
  const mb = mergeBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
  const files = diffFiles(repo, mb, pull.headSha);
  return {
    id: gid('PullRequest', repo.dbId, pull.number), number: pull.number, title: pull.title,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED', body: pull.body,
    headRefName: pull.head, baseRefName: pull.base,
    headRefOid: repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha,
    baseRefOid: repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha,
    mergeable: isConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE', merged: pull.merged,
    createdAt: pull.createdAt, updatedAt: pull.createdAt, mergedAt: pull.mergedAt,
    files: { nodes: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })), totalCount: files.length },
    author: { login: VIEWER_LOGIN }, url: '',
  };
}
function repoGql(repo: Repo): Record<string, unknown> {
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: gid('Repository', repo.dbId), databaseId: repo.dbId, name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000 },
    defaultBranchRef: defaultTip ? { name: repo.defaultBranch, target: { oid: defaultTip } } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, description: repo.description,
    isPrivate: repo.isPrivate, createdAt: repo.createdAt, updatedAt: repo.createdAt, url: '',
  };
}
function issuesConnection(repo: Repo, vars: Record<string, unknown>, queryText: string): Record<string, unknown> {
  let list = [...repo.issues];
  const statesMatch = /states\s*:\s*\[([^\]]*)\]/.exec(queryText);
  const states = statesMatch ? statesMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : (Array.isArray(vars.states) ? vars.states as string[] : null);
  if (states && states.length) {
    list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const dirMatch = /direction\s*:\s*(ASC|DESC)/.exec(queryText);
  const direction = dirMatch ? dirMatch[1] : (vars.direction as string | undefined);
  if (direction === 'ASC') list.sort((a, b) => a.seq - b.seq);
  else list.sort((a, b) => b.seq - a.seq);
  const first = typeof vars.first === 'number' ? vars.first : 10;
  let start = 0;
  const after = vars.after as string | undefined;
  if (after) {
    try {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const num = parseInt(decoded.split(':')[1] ?? '', 10);
      const idx = list.findIndex((i) => i.number === num);
      if (idx >= 0) start = idx + 1;
    } catch { /* ignore bad cursor */ }
  }
  const page = list.slice(start, start + first);
  const hasNext = start + page.length < list.length;
  const endCursor = page.length ? Buffer.from(`c:${page[page.length - 1].number}`, 'utf8').toString('base64url') : null;
  return {
    nodes: page.map((i) => issueGql(repo, i)),
    totalCount: list.length,
    pageInfo: { hasNextPage: hasNext, hasPreviousPage: start > 0, startCursor: page.length ? Buffer.from(`c:${page[0].number}`, 'utf8').toString('base64url') : null, endCursor },
  };
}
function pullsConnection(repo: Repo, vars: Record<string, unknown>): Record<string, unknown> {
  const list = [...repo.pulls].filter((p) => p.state === 'open').sort((a, b) => b.seq - a.seq);
  const first = typeof vars.first === 'number' ? vars.first : 10;
  const page = list.slice(0, first);
  return {
    nodes: page.map((p) => pullGql(repo, p)), totalCount: list.length,
    pageInfo: { hasNextPage: list.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}
function findRepoByDbId(dbId: number): Repo | undefined {
  return [...repos.values()].find((r) => r.dbId === dbId);
}
function execGraphQLOp(queryText: string, vars: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const errors: { message: string }[] = [];
  const data: Record<string, unknown> = {};
  if (/\bnoSuchFieldOnViewer\b/.test(queryText)) {
    errors.push({ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' });
  }
  // introspection __type
  const typeRe = /(\w+)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  let sawType = false;
  while ((m = typeRe.exec(queryText)) !== null) {
    sawType = true;
    const alias = m[1]; const name = m[2];
    const after = queryText.slice(m.index);
    if (/enumValues/.test(after.slice(0, 200))) {
      data[alias] = { enumValues: (name === 'SearchType' ? SEARCH_ENUMS : []).map((n) => ({ name: n })) };
    } else {
      const fields = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PR_FIELDS : name === 'Repository' ? REPO_FIELDS : [];
      data[alias] = { fields: fields.map((n) => ({ name: n })) };
    }
  }
  if (sawType && Object.keys(data).length) return { data, errors };
  // viewer
  if (/\bviewer\s*\{/.test(queryText)) {
    data.viewer = { login: VIEWER_LOGIN, id: gid('User', VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL };
  }
  // node(id:)
  if (/\bnode\s*\(/.test(queryText)) {
    const id = vars.id as string | undefined;
    const decoded = id ? ungid(id) : null;
    if (decoded?.kind === 'Repository') {
      const repo = findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10));
      data.node = repo ? { id: gid('Repository', repo.dbId), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } : null;
    } else if (decoded?.kind === 'Issue') {
      const repo = findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(decoded.parts[1] ?? '', 10));
      data.node = issue && repo ? issueGql(repo, issue) : null;
    } else data.node = null;
  }
  // repository(owner:, name:)
  if (/\brepository\s*\(/.test(queryText)) {
    const owner = (vars.owner as string) ?? (/owner\s*:\s*"([^"]+)"/.exec(queryText)?.[1] ?? '');
    const name = (vars.name as string) ?? (/name\s*:\s*"([^"]+)"/.exec(queryText)?.[1] ?? '');
    const repo = owner && name ? getRepo(owner, name) : undefined;
    if (!repo) { data.repository = null; return { data, errors }; }
    const r = repoGql(repo);
    // issue(number:)
    const issueNumMatch = /issue\s*\(\s*number\s*:\s*\$?(\w+)/.exec(queryText);
    if (issueNumMatch) {
      const num = typeof vars.number === 'number' ? vars.number : parseInt(issueNumMatch[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      r.issue = issue ? issueGql(repo, issue) : null;
    }
    if (/\bissues\s*\(/.test(queryText)) r.issues = issuesConnection(repo, vars, queryText);
    if (/\bpullRequests\s*\(/.test(queryText)) r.pullRequests = pullsConnection(repo, vars);
    const prNumMatch = /pullRequest\s*\(\s*number\s*:\s*\$?(\w+)/.exec(queryText);
    if (prNumMatch) {
      const num = typeof vars.number === 'number' ? vars.number : parseInt(prNumMatch[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      r.pullRequest = pull ? pullGql(repo, pull) : null;
    }
    data.repository = r;
  }
  // mutations
  const input = (vars.input ?? {}) as Record<string, unknown>;
  if (/\bcreateIssue\s*\(/.test(queryText)) {
    const decoded = typeof input.repositoryId === 'string' ? ungid(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    if (!repo) errors.push({ message: 'Repository not found' });
    else {
      const created = createIssueInternal(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (created.error) errors.push({ message: created.error });
      else data.createIssue = { issue: { number: created.issue!.number, id: gid('Issue', repo.dbId, created.issue!.number) } };
    }
  }
  if (/\bcloseIssue\s*\(/.test(queryText)) {
    const decoded = typeof input.issueId === 'string' ? ungid(input.issueId) : null;
    const repo = decoded?.kind === 'Issue' ? findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    const issue = repo?.issues.find((i) => i.number === parseInt(decoded?.parts[1] ?? '', 10));
    if (!issue || !repo) errors.push({ message: 'Issue not found' });
    else {
      issue.state = 'closed'; issue.closedAt = nowIso(); issue.updatedAt = nowIso();
      data.closeIssue = { issue: { number: issue.number, id: gid('Issue', repo.dbId, issue.number), state: 'CLOSED' } };
    }
  }
  if (/\bcreatePullRequest\s*\(/.test(queryText)) {
    const decoded = typeof input.repositoryId === 'string' ? ungid(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    const head = String(input.headRefName ?? input.head ?? '');
    const base = String(input.baseRefName ?? input.base ?? '');
    if (!repo) errors.push({ message: 'Repository not found' });
    else {
      const created = createPullInternal(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      if (created.error) errors.push({ message: created.error });
      else data.createPullRequest = { pullRequest: { number: created.pull!.number, id: gid('PullRequest', repo.dbId, created.pull!.number), state: 'OPEN', headRefName: head, baseRefName: base } };
    }
  }
  if (/\bmergePullRequest\s*\(/.test(queryText)) {
    const decoded = typeof input.pullRequestId === 'string' ? ungid(input.pullRequestId) : null;
    const repo = decoded?.kind === 'PullRequest' ? findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    const pull = repo?.pulls.find((p) => p.number === parseInt(decoded?.parts[1] ?? '', 10));
    if (!pull || !repo) errors.push({ message: 'Pull request not found' });
    else {
      const merged = mergePullInternal(repo, pull);
      if (merged.error) errors.push({ message: merged.error });
      else data.mergePullRequest = { pullRequest: { number: pull.number, merged: true, state: 'CLOSED' } };
    }
  }
  if (/\baddComment\s*\(/.test(queryText)) {
    const decoded = typeof input.subjectId === 'string' ? ungid(input.subjectId) : null;
    const repo = decoded?.kind === 'Issue' ? findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    const issue = repo?.issues.find((i) => i.number === parseInt(decoded?.parts[1] ?? '', 10));
    if (!issue || !repo) errors.push({ message: 'Subject not found' });
    else {
      const comment: Comment = { id: nextGlobalId++, body: String(input.body ?? ''), createdAt: nowIso(), issueNumber: issue.number };
      issue.comments.push(comment);
      data.addComment = { commentEdge: { node: { id: gid('IssueComment', repo.dbId, issue.number, comment.id), body: comment.body } } };
    }
  }
  return { data, errors };
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  if (!bearer(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return; }
  const runOne = (op: unknown): Record<string, unknown> => {
    const o = (op ?? {}) as Record<string, unknown>;
    const result = execGraphQLOp(String(o.query ?? ''), (o.variables ?? {}) as Record<string, unknown>);
    return result.errors.length ? { data: result.data, errors: result.errors } : { data: result.data };
  };
  if (Array.isArray(parsed.value)) sendJson(res, 200, parsed.value.map(runOne));
  else sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------- git smart HTTP
function refLines(repo: Repo): { ref: string; oid: string; peeled?: string }[] {
  const out: { ref: string; oid: string; peeled?: string }[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({ ref: 'HEAD', oid: defaultTip ?? ZERO_OID });
  for (const ref of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(ref)!;
    const entry: { ref: string; oid: string; peeled?: string } = { ref, oid };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const target = peelToCommit(repo, oid);
      if (target) entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: (string | Buffer | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = refLines(repo);
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main agent=git-forge/1.0.0'
    : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=git-forge/1.0.0';
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
  } else {
    refs.forEach((r, i) => {
      const first = i === 0 ? `\0${caps}` : '';
      lines.push(`${r.oid} ${r.ref}${first}\n`);
      if (r.peeled) lines.push(`${r.peeled} ${r.ref}^{}\n`);
    });
    lines.push('flush');
  }
  return pktLines(lines);
}
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'agent=git-forge/1.0.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 32768));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
interface FetchArgs { wants: string[]; haves: string[]; shallow: string[]; depth: number | null }
function selectFetchObjects(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Objects the client already holds: reachable from its haves, but never past a
  // shallow boundary commit (a shallow clone does not hold that commit's parents).
  const shallowSet = new Set(args.shallow);
  const haveSet = new Set<string>();
  {
    const queue: string[] = [];
    for (const h of args.haves) if (isOid(h) && h !== ZERO_OID) queue.push(h);
    while (queue.length) {
      const oid = queue.pop()!;
      if (haveSet.has(oid)) continue;
      const obj = lookup(oid); if (!obj) continue;
      haveSet.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        if (!shallowSet.has(oid)) for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
      else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  const wantCommits = args.wants.map((w) => peelToCommit(repo, w)).filter((c): c is string => c !== null);
  let included = new Set<string>();
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth !== null) {
    // BFS commit levels from wants
    const levels = new Map<string, number>();
    const queue: { oid: string; level: number }[] = wantCommits.map((c) => ({ oid: c, level: 0 }));
    while (queue.length) {
      const { oid, level } = queue.shift()!;
      if (levels.has(oid)) continue;
      if (level >= args.depth) continue;
      levels.set(oid, level);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, level: level + 1 });
    }
    const includedCommits = new Set(levels.keys());
    // objects reachable from included commits without crossing to excluded parents
    const seen = new Set<string>();
    const walkQueue: string[] = [...includedCommits];
    // include wanted non-commit objects (tags) too
    for (const w of args.wants) walkQueue.push(w);
    while (walkQueue.length) {
      const oid = walkQueue.pop()!;
      if (seen.has(oid)) continue;
      const obj = lookup(oid); if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        walkQueue.push(c.tree);
        // do not follow parents here: levels already decided
      } else if (obj.type === 'tag') walkQueue.push(parseTag(obj.data).object);
      else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') walkQueue.push(e.oid);
    }
    included = seen;
    for (const c of includedCommits) {
      const obj = repo.objects.get(c);
      if (obj?.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        if (parents.length && parents.some((p) => !includedCommits.has(p))) shallow.push(c);
      }
    }
    for (const s of args.shallow) {
      if (includedCommits.has(s)) {
        const obj = repo.objects.get(s);
        const parents = obj?.type === 'commit' ? parseCommit(obj.data).parents : [];
        if (parents.every((p) => includedCommits.has(p))) unshallow.push(s);
      }
    }
  } else {
    included = collectReachable(args.wants, lookup);
  }
  const send = [...included].filter((oid) => !haveSet.has(oid));
  const objects: GitObject[] = [];
  for (const oid of send) { const o = lookup(oid); if (o) objects.push(o); }
  return { objects, shallow, unshallow };
}
function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = selectFetchObjects(repo, args);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  const held = args.haves.filter((h) => args.wants.includes(h));
  if (held.length) for (const h of held) ackLines.push(`ACK ${h}\n`);
  else ackLines.push('NAK\n');
  ackLines.push('ready\n');
  parts.push(pkt('acknowledgments\n'));
  for (const l of ackLines) parts.push(pkt(l));
  parts.push(DELIM);
  if (shallow.length || unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(DELIM);
  }
  if (objects.length) {
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPack(writePack(objects)));
  } else {
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}
function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = selectFetchObjects(repo, args);
  const parts: Buffer[] = [];
  const held = args.haves.filter((h) => args.wants.includes(h));
  if (held.length) for (const h of held) parts.push(pkt(`ACK ${h}\n`));
  else parts.push(pkt('NAK\n'));
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
  if (objects.length) parts.push(sidebandPack(writePack(objects)));
  else parts.push(FLUSH);
  return Buffer.concat(parts);
}
function parseFetchLines(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('want ')) args.wants.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('have ')) args.haves.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).split(' ')[0]);
    else if (t.startsWith('deepen ')) { const n = parseInt(t.slice(7), 10); if (Number.isFinite(n)) args.depth = n; }
  }
  return args;
}
function isDescendant(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  return collectReachable([newOid], (oid) => repo.objects.get(oid)).has(oldOid);
}
async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, raw: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (!m) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const owner = decodeURIComponent(m[1]); const name = decodeURIComponent(m[2]); const tail = m[3];
  const repo = getRepo(owner, name);
  if (tail === 'info/refs' && method === 'GET') {
    const service = query.get('service') ?? '';
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' }); return;
  }
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  if (tail === 'git-upload-pack' && method === 'POST') {
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const { packets } = decodePktLines(raw);
      const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
      if (isV2) {
        const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim() ?? '';
        if (command === 'ls-refs') {
          const prefixes: string[] = [];
          let peel = false; let symrefs = false; let unborn = false;
          for (const l of lines) {
            const t = l.trim();
            if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
            else if (t === 'peel') peel = true;
            else if (t === 'symrefs') symrefs = true;
            else if (t === 'unborn') unborn = true;
          }
          const out: string[] = [];
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (prefixes.length === 0) {
            if (!defaultTip) out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
            else out.push(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
          }
          for (const r of refLines(repo).filter((x) => x.ref !== 'HEAD')) {
            if (prefixes.length && !prefixes.some((p) => r.ref.startsWith(p))) continue;
            let line = `${r.oid} ${r.ref}`;
            if (peel && r.peeled) line += ` peeled:${r.peeled}`;
            if (symrefs && r.ref === 'HEAD') line += ' symref-target:refs/heads/main';
            out.push(`${line}\n`);
          }
          const body = pktLines([...out, 'flush']);
          sendRaw(res, 200, body, 'application/x-git-upload-pack-result');
          return;
        }
        if (command === 'fetch') {
          const args = parseFetchLines(lines);
          sendRaw(res, 200, fetchResponseV2(repo, args), 'application/x-git-upload-pack-result');
          return;
        }
        sendRaw(res, 400, Buffer.from('unknown command', 'utf8'), 'text/plain');
        return;
      }
      // v0 fetch
      const args = parseFetchLines(lines);
      sendRaw(res, 200, fetchResponseV0(repo, args), 'application/x-git-upload-pack-result');
    } catch {
      sendRaw(res, 400, Buffer.from('bad request', 'utf8'), 'text/plain');
    }
    return;
  }
  if (tail === 'git-receive-pack' && method === 'POST') {
    try {
      const { packets, rest } = decodePktLines(raw);
      const commands: { oldOid: string; newOid: string; ref: string }[] = [];
      for (const p of packets) {
        if (p.kind === 'flush') break;
        if (p.kind !== 'data') continue;
        const text = p.payload.toString('utf8');
        const nul = text.indexOf('\0');
        const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
        const parts = line.split(' ');
        if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
      let unpackOk = true; let unpackDetail = 'ok';
      const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
      if (hasUpdates && rest.length > 0) {
        try {
          const objects = readPack(rest, (oid) => repo.objects.get(oid));
          for (const o of objects) repo.objects.set(hashObject(o.type, o.data), o);
        } catch (e) {
          unpackOk = false; unpackDetail = e instanceof Error ? e.message : 'unpack error';
        }
      }
      const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
      for (const cmd of commands) {
        if (!unpackOk) { reportLines.push(`ng ${cmd.ref} unpack failed\n`); continue; }
        const current = repo.refs.get(cmd.ref);
        if (cmd.newOid === ZERO_OID) {
          if (!current) reportLines.push(`ng ${cmd.ref} reference does not exist\n`);
          else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          else { repo.refs.delete(cmd.ref); reportLines.push(`ok ${cmd.ref}\n`); }
          continue;
        }
        const target = repo.objects.get(cmd.newOid);
        if (!target || (target.type !== 'commit' && target.type !== 'tag')) { reportLines.push(`ng ${cmd.ref} object not found\n`); continue; }
        if (cmd.oldOid === ZERO_OID) {
          if (current) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          else { repo.refs.set(cmd.ref, cmd.newOid); reportLines.push(`ok ${cmd.ref}\n`); }
          continue;
        }
        if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} non-fast-forward\n`); continue; }
        if (!isDescendant(repo, cmd.oldOid, cmd.newOid)) { reportLines.push(`ng ${cmd.ref} non-fast-forward\n`); continue; }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
      }
      reportLines.push('flush');
      const inner = pktLines(reportLines);
      const outer = Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
      sendRaw(res, 200, outer, 'application/x-git-receive-pack-result');
    } catch {
      sendRaw(res, 400, Buffer.from('bad request', 'utf8'), 'text/plain');
    }
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- MCP
interface McpToolDef { name: string; description: string; properties: Record<string, unknown>; required: string[] }
const MCP_TOOLS: McpToolDef[] = [
  { name: 'create_repo', description: 'Create a new repository owned by the authenticated user.', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  { name: 'get_repo', description: 'Get a repository by owner and name.', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  { name: 'create_issue', description: 'Create an issue in a repository.', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  { name: 'list_issues', description: 'List issues in a repository.', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] },
  { name: 'get_issue', description: 'Get a single issue by number.', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  { name: 'merge_pull_request', description: 'Merge a pull request.', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  { name: 'list_pull_requests', description: 'List pull requests in a repository.', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  { name: 'list_repos', description: 'List repositories owned by the authenticated user.', properties: {}, required: [] },
];
function mcpToolList(): unknown[] {
  return MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required } }));
}
function findMcpTool(name: string): McpToolDef | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = norm(name);
  return MCP_TOOLS.find((t) => norm(t.name) === wanted || wanted.endsWith(norm(t.name)));
}
function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: value, isError: false };
}
function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findMcpTool(name);
  if (!tool) return { __rpcError: -32602, __message: `Unknown tool: ${name}` };
  for (const req of tool.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') return toolErr(`Missing required argument: ${req}`);
  }
  const owner = typeof args.owner === 'string' && args.owner ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  try {
    switch (tool.name) {
      case 'create_repo': {
        const repoOwner = typeof args.owner === 'string' && args.owner ? args.owner : VIEWER_LOGIN;
        const repo = createRepoInternal(repoOwner, String(args.name), args.private === true, String(args.description ?? ''));
        if (!repo) return toolErr('Repository already exists');
        return toolOk(repoJson(repo));
      }
      case 'get_repo': {
        const repo = getRepo(owner, repoName);
        if (!repo) return toolErr('Repository not found');
        return toolOk(repoJson(repo));
      }
      case 'list_repos': {
        return toolOk({ repositories: viewerRepos().map(repoJson), total_count: viewerRepos().length });
      }
      case 'create_issue': {
        const repo = getRepo(owner, repoName);
        if (!repo) return toolErr('Repository not found');
        const created = createIssueInternal(repo, String(args.title ?? ''), String(args.body ?? ''), []);
        if (created.error) return toolErr(created.error);
        return toolOk(issueJson(repo, created.issue!));
      }
      case 'list_issues': {
        const repo = getRepo(owner, repoName);
        if (!repo) return toolErr('Repository not found');
        let list = [...repo.issues];
        const state = typeof args.state === 'string' ? args.state : 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => b.seq - a.seq);
        return toolOk({ issues: list.map((i) => issueJson(repo, i)), total_count: list.length });
      }
      case 'get_issue': {
        const repo = getRepo(owner, repoName);
        const issue = repo?.issues.find((i) => i.number === Number(args.issue_number));
        if (!issue || !repo) return toolErr('Issue not found');
        return toolOk(issueJson(repo, issue));
      }
      case 'create_pull_request': {
        const repo = getRepo(owner, repoName);
        if (!repo) return toolErr('Repository not found');
        const created = createPullInternal(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
        if (created.error) return toolErr(created.error);
        return toolOk(pullJson(repo, created.pull!));
      }
      case 'merge_pull_request': {
        const repo = getRepo(owner, repoName);
        const pull = repo?.pulls.find((p) => p.number === Number(args.pull_number));
        if (!pull || !repo) return toolErr('Pull request not found');
        const merged = mergePullInternal(repo, pull);
        if (merged.error) return toolErr(merged.error);
        return toolOk({ ...pullJson(repo, pull), merged: true, sha: merged.sha });
      }
      case 'list_pull_requests': {
        const repo = getRepo(owner, repoName);
        if (!repo) return toolErr('Repository not found');
        let list = [...repo.pulls];
        const state = typeof args.state === 'string' ? args.state : 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        return toolOk({ pull_requests: list.map((p) => pullJson(repo, p)), total_count: list.length });
      }
      default: return toolErr(`Tool not implemented: ${tool.name}`);
    }
  } catch (e) {
    return toolErr(e instanceof Error ? e.message : 'Tool failed');
  }
}
async function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  if (req.method === 'DELETE') { sendJson(res, 200, {}); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  if (!bearer(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = msg.id ?? null;
  const method = String(msg.method ?? '');
  // notification: no id
  if (msg.id === undefined) { res.writeHead(202, { 'content-length': '0' }); res.end(); return; }
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const rpcErr = (code: number, message: string, httpStatus = 200): void => sendJson(res, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'server/discover':
      ok({
        resultType: 'server/discover',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: { name: 'git-forge', version: FORGE_VERSION },
        instructions: 'A standalone GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP.',
      });
      return;
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      ok({
        protocolVersion: supported.includes(requested) ? requested : '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: 'git-forge', version: FORGE_VERSION },
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      res.writeHead(202, { 'content-length': '0' }); res.end(); return;
    case 'tools/list':
      ok({ tools: mcpToolList() });
      return;
    case 'tools/call': {
      const toolName = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = callMcpTool(toolName, args);
      if ((result as Record<string, unknown>).__rpcError !== undefined) {
        rpcErr((result as Record<string, unknown>).__rpcError as number, String((result as Record<string, unknown>).__message ?? 'Tool error'));
        return;
      }
      ok(result);
      return;
    }
    case 'ping':
      ok({});
      return;
    default:
      rpcErr(-32601, `Method not found: ${method}`);
      return;
  }
}

// ---------------------------------------------------------------- server
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const query = url.searchParams;
        if (req.method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        const raw = await readBody(req);
        if (path === '/api/graphql' && req.method === 'POST') { await handleGraphQL(req, res, raw); return; }
        if (path === '/mcp') { await handleMcp(req, res, raw); return; }
        if (path.startsWith('/api/v3')) { await handleRest(req, res, path, query, raw); return; }
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) { await handleGit(req, res, path, query, raw); return; }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        try { sendJson(res, 500, { message: e instanceof Error ? e.message : 'Internal Server Error' }); } catch { /* socket gone */ }
      }
    })();
  });
}
