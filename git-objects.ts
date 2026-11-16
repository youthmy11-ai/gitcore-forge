import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/i;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
  compressed?: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface FlatTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
}

export interface CommitPerson {
  readonly name: string;
  readonly email: string;
  readonly timestampSec: number;
  readonly tz: string;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: CommitPerson;
  readonly committer: CommitPerson;
  readonly message: string;
}

export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
}

export interface PullFileDiff {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\u0000`, 'ascii').update(data).digest('hex');
}

export function makeObject(type: GitObjectType, data: Buffer, compressed?: Buffer): GitObject {
  return {
    type,
    data,
    oid: hashObject(type, data),
    compressed,
  };
}

export function getCompressedObject(obj: GitObject): Buffer {
  if (obj.compressed === undefined) {
    obj.compressed = deflateSync(obj.data);
  }
  return obj.compressed;
}

export function treeEntrySortKey(entry: { mode: string; name: string }): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeEntrySortKey(a);
    const kb = treeEntrySortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const chunks: Buffer[] = new Array(sorted.length * 2);
  let idx = 0;
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    chunks[idx++] = Buffer.from(`${mode} ${entry.name}\u0000`, 'utf8');
    chunks[idx++] = Buffer.from(entry.oid, 'hex');
  }
  return Buffer.concat(chunks);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('corrupt tree object: missing mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) {
      throw new Error('corrupt tree object: truncated entry');
    }
    const rawMode = data.subarray(offset, space).toString('ascii');
    const mode = rawMode === '040000' ? '40000' : rawMode;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function parsePerson(raw: string): CommitPerson {
  const lt = raw.indexOf('<');
  const gt = raw.indexOf('>', lt + 1);
  if (lt < 0 || gt < 0) {
    return { name: raw.trim(), email: '', timestampSec: 0, tz: '+0000' };
  }
  const name = raw.slice(0, lt).trim();
  const email = raw.slice(lt + 1, gt).trim();
  const rest = raw.slice(gt + 1).trim().split(/\s+/);
  const timestampSec = Number.parseInt(rest[0] ?? '0', 10) || 0;
  const tz = rest[1] ?? '+0000';
  return { name, email, timestampSec, tz };
}

export function buildCommit(params: {
  tree: string;
  parents: readonly string[];
  authorName: string;
  authorEmail: string;
  timestampSec: number;
  message: string;
  committerName?: string;
  committerEmail?: string;
  tz?: string;
}): Buffer {
  const tz = params.tz ?? '+0000';
  const cName = params.committerName ?? params.authorName;
  const cEmail = params.committerEmail ?? params.authorEmail;
  const lines: string[] = [`tree ${params.tree}`];
  for (const parent of params.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${params.authorName} <${params.authorEmail}> ${params.timestampSec} ${tz}`);
  lines.push(`committer ${cName} <${cEmail}> ${params.timestampSec} ${tz}`);
  const msg = params.message.endsWith('\n') ? params.message : `${params.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

export function parseCommit(data: Buffer): ParsedCommit {
  const sep = data.indexOf('\n\n');
  const headerText = (sep >= 0 ? data.subarray(0, sep) : data).toString('utf8');
  const message = sep >= 0 ? data.subarray(sep + 2).toString('utf8') : '';
  let tree = '';
  const parents: string[] = [];
  let author: CommitPerson = { name: '', email: '', timestampSec: 0, tz: '+0000' };
  let committer: CommitPerson = { name: '', email: '', timestampSec: 0, tz: '+0000' };

  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): ParsedTag {
  const sep = data.indexOf('\n\n');
  const headerText = (sep >= 0 ? data.subarray(0, sep) : data).toString('utf8');
  const message = sep >= 0 ? data.subarray(sep + 2).toString('utf8') : '';
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) {
      const t = line.slice(5).trim();
      if (t === 'commit' || t === 'tree' || t === 'blob' || t === 'tag') type = t;
    } else if (line.startsWith('tag ')) {
      tag = line.slice(4).trim();
    }
  }
  return { object, type, tag, message };
}

export function flattenTree(
  objects: ReadonlyMap<string, GitObject>,
  treeOid: string | null | undefined,
  prefix = '',
  out: Map<string, FlatTreeEntry> = new Map(),
): Map<string, FlatTreeEntry> {
  if (!treeOid) return out;
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  const entries = parseTree(obj.data);
  for (const entry of entries) {
    const fullPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      flattenTree(objects, entry.oid, fullPath, out);
    } else {
      out.set(fullPath, { path: fullPath, mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

interface TreeDirNode {
  files: Map<string, { oid: string; mode: string }>;
  dirs: Map<string, TreeDirNode>;
}

function emptyDirNode(): TreeDirNode {
  return { files: new Map(), dirs: new Map() };
}

function writeDirNode(objects: Map<string, GitObject>, node: TreeDirNode): string {
  const entries: TreeEntry[] = [];
  for (const [name, file] of node.files) {
    entries.push({ mode: file.mode, name, oid: file.oid });
  }
  for (const [name, child] of node.dirs) {
    if (child.files.size === 0 && child.dirs.size === 0) continue;
    const childOid = writeDirNode(objects, child);
    entries.push({ mode: '40000', name, oid: childOid });
  }
  const data = buildTree(entries);
  const obj = makeObject('tree', data);
  if (!objects.has(obj.oid)) objects.set(obj.oid, obj);
  return obj.oid;
}

export function buildTreeFromFlat(
  objects: Map<string, GitObject>,
  files: ReadonlyMap<string, { oid: string; mode: string }>,
): string {
  const root = emptyDirNode();
  for (const [path, entry] of files) {
    const parts = path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]!;
      let next = cur.dirs.get(segment);
      if (!next) {
        next = emptyDirNode();
        cur.dirs.set(segment, next);
      }
      cur = next;
    }
    cur.files.set(parts[parts.length - 1]!, { oid: entry.oid, mode: entry.mode });
  }
  return writeDirNode(objects, root);
}

export function resolveTreeEntry(
  objects: ReadonlyMap<string, GitObject>,
  rootTreeOid: string | null | undefined,
  relPath: string,
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string; entries: TreeEntry[] } | null {
  if (!rootTreeOid) return null;
  const parts = relPath.split('/').filter((p) => p.length > 0);
  let currentOid = rootTreeOid;
  if (parts.length === 0) {
    const rootObj = objects.get(currentOid);
    if (!rootObj || rootObj.type !== 'tree') return null;
    return { kind: 'dir', oid: currentOid, entries: parseTree(rootObj.data) };
  }
  for (let i = 0; i < parts.length; i++) {
    const obj = objects.get(currentOid);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const match = entries.find((e) => e.name === parts[i]);
    if (!match) return null;
    const isDir = match.mode === '40000' || match.mode === '040000';
    if (i === parts.length - 1) {
      if (isDir) {
        const sub = objects.get(match.oid);
        if (!sub || sub.type !== 'tree') return null;
        return { kind: 'dir', oid: match.oid, entries: parseTree(sub.data) };
      }
      return { kind: 'file', oid: match.oid, mode: match.mode };
    }
    if (!isDir) return null;
    currentOid = match.oid;
  }
  return null;
}

export function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function countLineChanges(oldBuf: Buffer | null, newBuf: Buffer | null): { additions: number; deletions: number } {
  if (oldBuf === null && newBuf === null) return { additions: 0, deletions: 0 };
  if (oldBuf === null) {
    const lines = splitLinesForDiff(newBuf!.toString('utf8'));
    return { additions: Math.max(lines.length, newBuf!.length > 0 ? 1 : 0), deletions: 0 };
  }
  if (newBuf === null) {
    const lines = splitLinesForDiff(oldBuf.toString('utf8'));
    return { additions: 0, deletions: Math.max(lines.length, oldBuf.length > 0 ? 1 : 0) };
  }
  if (oldBuf.equals(newBuf)) return { additions: 0, deletions: 0 };

  const a = splitLinesForDiff(oldBuf.toString('utf8'));
  const b = splitLinesForDiff(newBuf.toString('utf8'));
  if (a.length * b.length <= 200_000) {
    // Classic LCS DP using single 1D row
    const m = a.length;
    const n = b.length;
    let prev = new Int32Array(n + 1);
    let curr = new Int32Array(n + 1);
    for (let i = 1; i <= m; i++) {
      const ai = a[i - 1]!;
      for (let j = 1; j <= n; j++) {
        if (ai === b[j - 1]) {
          curr[j] = prev[j - 1]! + 1;
        } else {
          const up = prev[j]!;
          const left = curr[j - 1]!;
          curr[j] = up >= left ? up : left;
        }
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
      curr.fill(0);
    }
    const common = prev[n]!;
    return { additions: n - common, deletions: m - common };
  }
  // Fast frequency diff fallback for huge blobs
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const c = counts.get(line) ?? 0;
    if (c > 0) {
      common += 1;
      counts.set(line, c - 1);
    }
  }
  return { additions: b.length - common, deletions: a.length - common };
}

export function diffTrees(
  objects: ReadonlyMap<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): PullFileDiff[] {
  const baseFlat = flattenTree(objects, baseTreeOid);
  const headFlat = flattenTree(objects, headTreeOid);
  const allPaths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const sortedPaths = [...allPaths].sort();
  const result: PullFileDiff[] = [];

  for (const filename of sortedPaths) {
    const baseEntry = baseFlat.get(filename);
    const headEntry = headFlat.get(filename);
    if (baseEntry && headEntry && baseEntry.oid === headEntry.oid) continue;
    const oldBuf = baseEntry ? (objects.get(baseEntry.oid)?.data ?? null) : null;
    const newBuf = headEntry ? (objects.get(headEntry.oid)?.data ?? null) : null;
    const status: 'added' | 'modified' | 'removed' =
      baseEntry === undefined ? 'added' : headEntry === undefined ? 'removed' : 'modified';
    const { additions, deletions } = countLineChanges(oldBuf, newBuf);
    result.push({
      filename,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return result;
}
