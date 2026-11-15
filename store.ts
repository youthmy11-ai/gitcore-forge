import {
  type FlatTreeEntry,
  type GitObject,
  type PullFileDiff,
  buildCommit,
  buildTreeFromFlat,
  diffTrees,
  flattenTree,
  isOid,
  makeObject,
  parseCommit,
  parseTree,
  resolveTreeEntry,
} from './git-objects.ts';

export const DEFAULT_EPOCH_SEC = 1_735_689_600;

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface LabelRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly body: string;
  readonly userLogin: string;
  readonly userId: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  readonly seq: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRecord[];
  readonly userLogin: string;
  readonly userId: number;
  readonly createdAtEpoch: number;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: CommentRecord[];
  cachedJson: Buffer;
}

export interface PullRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  readonly seq: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaCreated: string;
  readonly baseShaCreated: string;
  lockedHeadSha: string | null;
  lockedMergeBaseSha: string | null;
  lockedFiles: PullFileDiff[] | null;
  readonly userLogin: string;
  readonly userId: number;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: CommentRecord[];
}

export interface RepoState {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  nextNumber: number;
  refVersion: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: Map<number, IssueRecord>;
  readonly issueList: IssueRecord[];
  readonly pulls: Map<number, PullRecord>;
  readonly pullList: PullRecord[];
  readonly packCache: Map<string, Buffer>;
  readonly adsCache: Map<string, Buffer>;
}

export class StoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function encodeNodeId(kind: 'Repo' | 'Issue' | 'PR' | 'Comment' | 'Label', ...parts: Array<number | string>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export type DecodedNodeId =
  | { kind: 'Repo'; repoId: number }
  | { kind: 'Issue'; repoId: number; number: number }
  | { kind: 'PR'; repoId: number; number: number }
  | { kind: 'Comment'; repoId: number; commentId: number }
  | { kind: 'Label'; repoId: number; labelId: number };

export function decodeNodeId(nodeId: string): DecodedNodeId | null {
  try {
    const raw = Buffer.from(nodeId, 'base64url').toString('utf8');
    const parts = raw.split(':');
    const kind = parts[0];
    if (kind === 'Repo' && parts.length === 2) {
      const repoId = Number(parts[1]);
      if (Number.isInteger(repoId) && repoId > 0) return { kind, repoId };
    } else if (kind === 'Issue' && parts.length === 3) {
      const repoId = Number(parts[1]);
      const number = Number(parts[2]);
      if (Number.isInteger(repoId) && Number.isInteger(number)) return { kind, repoId, number };
    } else if (kind === 'PR' && parts.length === 3) {
      const repoId = Number(parts[1]);
      const number = Number(parts[2]);
      if (Number.isInteger(repoId) && Number.isInteger(number)) return { kind, repoId, number };
    } else if (kind === 'Comment' && parts.length === 3) {
      const repoId = Number(parts[1]);
      const commentId = Number(parts[2]);
      if (Number.isInteger(repoId) && Number.isInteger(commentId)) return { kind, repoId, commentId };
    } else if (kind === 'Label' && parts.length === 3) {
      const repoId = Number(parts[1]);
      const labelId = Number(parts[2]);
      if (Number.isInteger(repoId) && Number.isInteger(labelId)) return { kind, repoId, labelId };
    }
    return null;
  } catch {
    return null;
  }
}

function parseTrialBaseEpochSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return n > 10_000_000_000 ? Math.floor(n / 1000) : n;
    }
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return DEFAULT_EPOCH_SEC;
}

function sameTreeEntry(a: FlatTreeEntry | undefined, b: FlatTreeEntry | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.oid === b.oid && a.mode === b.mode;
}

function normalizeBranchName(input: string, ownerLogin: string): string {
  let s = input.trim();
  if (s.startsWith(`${ownerLogin}:`)) s = s.slice(ownerLogin.length + 1);
  if (s.startsWith('refs/heads/')) s = s.slice('refs/heads/'.length);
  return s;
}

export class ForgeStore {
  readonly baseEpochSec: number;
  private clockOffset = 0;
  private reqCounter = 0;
  private nextRepoIdVal = 1;
  private nextItemIdVal = 1;
  private nextLabelIdVal = 1;
  private nextCommentIdVal = 1;
  private nextSeqVal = 1;

  readonly reposByKey = new Map<string, RepoState>();
  readonly reposById = new Map<number, RepoState>();
  readonly reposList: RepoState[] = [];
  private cachedOwnerLower = '';
  private cachedRepoLower = '';
  private cachedRepo: RepoState | null = null;

  constructor() {
    this.baseEpochSec = parseTrialBaseEpochSec();
  }

  nextRequestId(): string {
    this.reqCounter += 1;
    return `gf-${this.reqCounter}`;
  }

  private nextClock(): { epochSec: number; iso: string } {
    this.clockOffset += 1;
    const epochSec = this.baseEpochSec + this.clockOffset;
    return {
      epochSec,
      iso: new Date(epochSec * 1000).toISOString(),
    };
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): RepoState {
    const repo = this.findRepo(owner, name);
    if (!repo) {
      throw new StoreError(404, 'Not Found', 'not_found');
    }
    return repo;
  }

  findRepo(owner: string, name: string): RepoState | null {
    if (
      this.cachedRepo !== null &&
      owner === this.cachedOwnerLower &&
      name === this.cachedRepoLower
    ) {
      return this.cachedRepo;
    }
    const oLow = owner.toLowerCase();
    if (oLow !== VIEWER.login) return null;
    const rLow = name.toLowerCase();
    if (this.cachedRepo !== null && oLow === this.cachedOwnerLower && rLow === this.cachedRepoLower) {
      return this.cachedRepo;
    }
    const repo = this.reposByKey.get(`${oLow}/${rLow}`) ?? null;
    if (repo !== null) {
      this.cachedOwnerLower = oLow;
      this.cachedRepoLower = rLow;
      this.cachedRepo = repo;
    }
    return repo;
  }

  createRepo(input: { name: string; description?: string; private?: boolean; defaultBranch?: string }): RepoState {
    const name = input.name.trim();
    if (!name || name.length > 100 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new StoreError(422, 'Repository name is invalid', 'invalid');
    }
    const key = this.repoKey(VIEWER.login, name);
    if (this.reposByKey.has(key)) {
      throw new StoreError(422, 'Repository creation failed.', 'already_exists');
    }
    const { iso } = this.nextClock();
    const id = this.nextRepoIdVal++;
    const defaultBranch = (input.defaultBranch ?? 'main').trim() || 'main';
    const repo: RepoState = {
      id,
      nodeId: encodeNodeId('Repo', id),
      owner: VIEWER.login,
      name,
      description: input.description ?? '',
      isPrivate: Boolean(input.private),
      defaultBranch,
      createdAt: iso,
      updatedAt: iso,
      nextNumber: 1,
      refVersion: 1,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueList: [],
      pulls: new Map(),
      pullList: [],
      packCache: new Map(),
      adsCache: new Map(),
    };
    this.reposByKey.set(key, repo);
    this.reposById.set(id, repo);
    this.reposList.push(repo);
    return repo;
  }

  updateRepo(repo: RepoState, patch: { description?: string; private?: boolean; defaultBranch?: string }): RepoState {
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.private !== undefined) repo.isPrivate = Boolean(patch.private);
    if (patch.defaultBranch !== undefined && patch.defaultBranch.trim() !== '') {
      repo.defaultBranch = patch.defaultBranch.trim();
      this.invalidateRepoPackCaches(repo);
    }
    repo.updatedAt = this.nextClock().iso;
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    const repo = this.getRepo(owner, name);
    if (this.cachedRepo === repo) {
      this.cachedRepo = null;
      this.cachedOwnerLower = '';
      this.cachedRepoLower = '';
    }
    this.reposByKey.delete(this.repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.id);
    const idx = this.reposList.indexOf(repo);
    if (idx >= 0) this.reposList.splice(idx, 1);
  }

  invalidateRepoPackCaches(repo: RepoState): void {
    repo.refVersion += 1;
    repo.packCache.clear();
    repo.adsCache.clear();
  }

  serializeRepo(repo: RepoState): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: repo.nodeId,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      owner: {
        login: repo.owner,
        id: VIEWER.id,
      },
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
    };
  }

  resolveRefOid(repo: RepoState, refOrOid?: string): string | null {
    if (!refOrOid) {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (repo.refs.has(refOrOid)) return repo.refs.get(refOrOid)!;
    const headRef = `refs/heads/${refOrOid}`;
    if (repo.refs.has(headRef)) return repo.refs.get(headRef)!;
    const tagRef = `refs/tags/${refOrOid}`;
    if (repo.refs.has(tagRef)) return repo.refs.get(tagRef)!;
    const lower = refOrOid.toLowerCase();
    if (isOid(lower) && repo.objects.has(lower)) return lower;
    return null;
  }

  createRef(repo: RepoState, ref: string, sha: string): { ref: string; object: { sha: string; type: string } } {
    const cleanRef = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const oid = sha.toLowerCase();
    if (!isOid(oid) || !repo.objects.has(oid)) {
      throw new StoreError(422, 'Reference update failed: target object does not exist', 'invalid_sha');
    }
    if (repo.refs.has(cleanRef)) {
      throw new StoreError(422, 'Reference already exists', 'already_exists');
    }
    const obj = repo.objects.get(oid)!;
    repo.refs.set(cleanRef, oid);
    this.invalidateRepoPackCaches(repo);
    return {
      ref: cleanRef,
      object: {
        sha: oid,
        type: obj.type,
      },
    };
  }

  listBranches(repo: RepoState): Array<{ name: string; commit: { sha: string } }> {
    const branches: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        branches.push({
          name: ref.slice('refs/heads/'.length),
          commit: { sha },
        });
      }
    }
    return branches;
  }

  listCommits(repo: RepoState, shaOrRef?: string): Array<Record<string, unknown>> {
    let startOid = this.resolveRefOid(repo, shaOrRef);
    if (!startOid) {
      if (!shaOrRef) return [];
      throw new StoreError(404, 'Not Found', 'not_found');
    }
    const visited = new Set<string>();
    const commits: Array<{ oid: string; parsed: ReturnType<typeof parseCommit>; order: number }> = [];
    const queue: string[] = [startOid];
    let order = 0;

    while (queue.length > 0 && commits.length < 500) {
      const oid = queue.shift()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        const innerLine = obj.data.toString('utf8').split('\n')[0] ?? '';
        if (innerLine.startsWith('object ')) queue.push(innerLine.slice(7).trim());
        continue;
      }
      if (obj.type !== 'commit') continue;
      const parsed = parseCommit(obj.data);
      commits.push({ oid, parsed, order: order++ });
      for (const p of parsed.parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }

    commits.sort((a, b) => {
      if (b.parsed.committer.timestampSec !== a.parsed.committer.timestampSec) {
        return b.parsed.committer.timestampSec - a.parsed.committer.timestampSec;
      }
      return a.order - b.order;
    });

    return commits.map(({ oid, parsed }) => ({
      sha: oid,
      commit: {
        message: parsed.message.replace(/\n$/, ''),
        author: {
          name: parsed.author.name,
          email: parsed.author.email,
          date: new Date(parsed.author.timestampSec * 1000).toISOString(),
        },
        committer: {
          name: parsed.committer.name,
          email: parsed.committer.email,
          date: new Date(parsed.committer.timestampSec * 1000).toISOString(),
        },
        tree: { sha: parsed.tree },
      },
      parents: parsed.parents.map((p) => ({ sha: p })),
    }));
  }

  getCommitRootTreeOid(repo: RepoState, commitOid: string | null | undefined): string | null {
    if (!commitOid) return null;
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  getContent(repo: RepoState, rawPath: string, ref?: string): unknown {
    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    const commitOid = this.resolveRefOid(repo, ref);
    if (!commitOid) {
      throw new StoreError(404, 'Not Found', 'not_found');
    }
    const rootTree = this.getCommitRootTreeOid(repo, commitOid);
    const resolved = resolveTreeEntry(repo.objects, rootTree, cleanPath);
    if (!resolved) {
      throw new StoreError(404, 'Not Found', 'not_found');
    }
    if (resolved.kind === 'dir') {
      return resolved.entries.map((entry) => {
        const isDir = entry.mode === '40000' || entry.mode === '040000';
        const full = cleanPath === '' ? entry.name : `${cleanPath}/${entry.name}`;
        const blobSize = isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
        return {
          type: isDir ? 'dir' : 'file',
          name: entry.name,
          path: full,
          sha: entry.oid,
          size: blobSize,
        };
      });
    }
    const blob = repo.objects.get(resolved.oid);
    if (!blob) throw new StoreError(404, 'Not Found', 'not_found');
    const name = cleanPath.slice(cleanPath.lastIndexOf('/') + 1);
    return {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: blob.oid,
      size: blob.data.length,
      name,
      path: cleanPath,
    };
  }

  putContent(
    repo: RepoState,
    rawPath: string,
    input: { message: string; contentBase64: string; branch?: string; sha?: string },
  ): { status: 200 | 201; body: Record<string, unknown> } {
    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    if (cleanPath === '') {
      throw new StoreError(422, 'Path cannot be empty', 'invalid_path');
    }
    const targetBranch = (input.branch ?? repo.defaultBranch).trim() || repo.defaultBranch;
    const targetRef = `refs/heads/${targetBranch}`;
    let parentOid = repo.refs.get(targetRef) ?? null;
    if (parentOid === null && targetBranch !== repo.defaultBranch) {
      const defTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!defTip) {
        throw new StoreError(404, `Branch ${targetBranch} not found`, 'branch_not_found');
      }
      throw new StoreError(404, `Branch ${targetBranch} not found`, 'branch_not_found');
    }

    const baseTreeOid = parentOid ? this.getCommitRootTreeOid(repo, parentOid) : null;
    const existing = resolveTreeEntry(repo.objects, baseTreeOid, cleanPath);

    if (existing) {
      if (existing.kind === 'dir') {
        throw new StoreError(422, 'Cannot overwrite directory with file', 'is_dir');
      }
      if (!input.sha || input.sha.toLowerCase() !== existing.oid) {
        throw new StoreError(
          409,
          `${cleanPath} does not match ${input.sha ?? 'missing sha'}`,
          'conflict',
        );
      }
    } else if (input.sha) {
      throw new StoreError(
        409,
        `${cleanPath} was supplied with sha ${input.sha} but does not exist`,
        'conflict',
      );
    }

    const decoded = Buffer.from(input.contentBase64.replace(/\s+/g, ''), 'base64');
    const blobObj = makeObject('blob', decoded);
    if (!repo.objects.has(blobObj.oid)) repo.objects.set(blobObj.oid, blobObj);

    const flat = flattenTree(repo.objects, baseTreeOid);
    const mutable = new Map<string, { oid: string; mode: string }>();
    for (const [k, v] of flat) mutable.set(k, { oid: v.oid, mode: v.mode });
    mutable.set(cleanPath, { oid: blobObj.oid, mode: '100644' });

    const newTreeOid = buildTreeFromFlat(repo.objects, mutable);
    const { epochSec } = this.nextClock();
    const commitData = buildCommit({
      tree: newTreeOid,
      parents: parentOid ? [parentOid] : [],
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      timestampSec: epochSec,
      message: input.message,
    });
    const commitObj = makeObject('commit', commitData);
    repo.objects.set(commitObj.oid, commitObj);
    repo.refs.set(targetRef, commitObj.oid);
    this.invalidateRepoPackCaches(repo);

    const name = cleanPath.slice(cleanPath.lastIndexOf('/') + 1);
    return {
      status: existing ? 200 : 201,
      body: {
        content: {
          name,
          path: cleanPath,
          sha: blobObj.oid,
          size: decoded.length,
          type: 'file',
          encoding: 'base64',
          content: decoded.toString('base64'),
        },
        commit: {
          sha: commitObj.oid,
          message: input.message,
          tree: { sha: newTreeOid },
        },
      },
    };
  }

  deleteContent(
    repo: RepoState,
    rawPath: string,
    input: { message: string; sha: string; branch?: string },
  ): Record<string, unknown> {
    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    const targetBranch = (input.branch ?? repo.defaultBranch).trim() || repo.defaultBranch;
    const targetRef = `refs/heads/${targetBranch}`;
    const parentOid = repo.refs.get(targetRef) ?? null;
    if (!parentOid) {
      throw new StoreError(404, 'Not Found', 'not_found');
    }
    const baseTreeOid = this.getCommitRootTreeOid(repo, parentOid);
    const existing = resolveTreeEntry(repo.objects, baseTreeOid, cleanPath);
    if (!existing || existing.kind !== 'file') {
      throw new StoreError(404, 'Not Found', 'not_found');
    }
    if (!input.sha || input.sha.toLowerCase() !== existing.oid) {
      throw new StoreError(409, `${cleanPath} does not match ${input.sha}`, 'conflict');
    }

    const flat = flattenTree(repo.objects, baseTreeOid);
    const mutable = new Map<string, { oid: string; mode: string }>();
    for (const [k, v] of flat) {
      if (k !== cleanPath) mutable.set(k, { oid: v.oid, mode: v.mode });
    }

    const newTreeOid = buildTreeFromFlat(repo.objects, mutable);
    const { epochSec } = this.nextClock();
    const commitData = buildCommit({
      tree: newTreeOid,
      parents: [parentOid],
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      timestampSec: epochSec,
      message: input.message,
    });
    const commitObj = makeObject('commit', commitData);
    repo.objects.set(commitObj.oid, commitObj);
    repo.refs.set(targetRef, commitObj.oid);
    this.invalidateRepoPackCaches(repo);

    return {
      content: null,
      commit: {
        sha: commitObj.oid,
        message: input.message,
      },
    };
  }

  createLabel(repo: RepoState, input: { name: string; color?: string; description?: string }): LabelRecord {
    const name = input.name.trim();
    if (!name) throw new StoreError(422, 'Validation Failed: name required', 'invalid');
    if (repo.labels.has(name)) {
      throw new StoreError(422, 'Validation Failed: label already exists', 'already_exists');
    }
    const id = this.nextLabelIdVal++;
    const rec: LabelRecord = {
      id,
      nodeId: encodeNodeId('Label', repo.id, id),
      name,
      color: (input.color ?? 'ededed').replace(/^#/, ''),
      description: input.description ?? '',
    };
    repo.labels.set(name, rec);
    return rec;
  }

  serializeLabel(l: LabelRecord): Record<string, unknown> {
    return {
      id: l.id,
      node_id: l.nodeId,
      name: l.name,
      color: l.color,
      description: l.description,
    };
  }

  private refreshIssueCache(issue: IssueRecord): void {
    const labels =
      issue.labels.length === 0
        ? []
        : issue.labels.map((l) => ({
            id: l.id,
            node_id: l.nodeId,
            name: l.name,
            color: l.color,
            description: l.description,
          }));
    const payload = {
      id: issue.id,
      node_id: issue.nodeId,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels,
      comments: issue.comments.length,
      user: {
        login: issue.userLogin,
        id: issue.userId,
      },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
    };
    issue.cachedJson = Buffer.from(JSON.stringify(payload), 'utf8');
  }

  createIssue(
    repo: RepoState,
    input: { title: string; body?: string; labels?: readonly string[] },
  ): IssueRecord {
    const title = input.title;
    if (typeof title !== 'string' || title.trim() === '') {
      throw new StoreError(422, 'Validation Failed: title is required', 'invalid');
    }
    const resolvedLabels: LabelRecord[] = [];
    if (input.labels !== undefined) {
      for (const labelName of input.labels) {
        const found = repo.labels.get(labelName);
        if (!found) {
          throw new StoreError(422, `Validation Failed: unknown label ${labelName}`, 'unknown_label');
        }
        resolvedLabels.push(found);
      }
    }
    const { epochSec, iso } = this.nextClock();
    const id = this.nextItemIdVal++;
    const number = repo.nextNumber++;
    const seq = this.nextSeqVal++;
    const issue: IssueRecord = {
      id,
      nodeId: encodeNodeId('Issue', repo.id, number),
      number,
      seq,
      title,
      body: input.body ?? '',
      state: 'open',
      labels: resolvedLabels,
      userLogin: VIEWER.login,
      userId: VIEWER.id,
      createdAtEpoch: epochSec,
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      comments: [],
      cachedJson: Buffer.alloc(0),
    };
    this.refreshIssueCache(issue);
    repo.issues.set(number, issue);
    repo.issueList.push(issue);
    return issue;
  }

  updateIssue(
    repo: RepoState,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: readonly string[] },
  ): IssueRecord {
    const issue = repo.issues.get(number);
    if (!issue) throw new StoreError(404, 'Not Found', 'not_found');
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.labels !== undefined) {
      const nextLabels: LabelRecord[] = [];
      for (const name of patch.labels) {
        const found = repo.labels.get(name);
        if (!found) throw new StoreError(422, `Validation Failed: unknown label ${name}`, 'unknown_label');
        nextLabels.push(found);
      }
      issue.labels = nextLabels;
    }
    if (patch.state !== undefined) {
      if (patch.state !== 'open' && patch.state !== 'closed') {
        throw new StoreError(422, 'Validation Failed: invalid state', 'invalid');
      }
      if (patch.state === 'closed' && issue.state !== 'closed') {
        issue.closedAt = this.nextClock().iso;
      } else if (patch.state === 'open') {
        issue.closedAt = null;
      }
      issue.state = patch.state;
    }
    issue.updatedAt = this.nextClock().iso;
    this.refreshIssueCache(issue);
    return issue;
  }

  addComment(
    repo: RepoState,
    number: number,
    bodyText: string,
  ): CommentRecord {
    const issue = repo.issues.get(number);
    const pr = issue ? null : repo.pulls.get(number);
    if (!issue && !pr) throw new StoreError(404, 'Not Found', 'not_found');
    if (typeof bodyText !== 'string' || bodyText.length === 0) {
      throw new StoreError(422, 'Validation Failed: body is required', 'invalid');
    }
    const { iso } = this.nextClock();
    const id = this.nextCommentIdVal++;
    const comment: CommentRecord = {
      id,
      nodeId: encodeNodeId('Comment', repo.id, id),
      body: bodyText,
      userLogin: VIEWER.login,
      userId: VIEWER.id,
      createdAt: iso,
      updatedAt: iso,
    };
    if (issue) {
      issue.comments.push(comment);
      issue.updatedAt = iso;
      this.refreshIssueCache(issue);
    } else if (pr) {
      pr.comments.push(comment);
      pr.updatedAt = iso;
    }
    return comment;
  }

  serializeComment(c: CommentRecord): Record<string, unknown> {
    return {
      id: c.id,
      node_id: c.nodeId,
      body: c.body,
      user: {
        login: c.userLogin,
        id: c.userId,
      },
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    };
  }

  computeMergeBase(repo: RepoState, commitA: string, commitB: string): string | null {
    const distA = new Map<string, number>();
    const qA: Array<[string, number]> = [[commitA, 0]];
    while (qA.length > 0) {
      const [oid, d] = qA.shift()!;
      if (distA.has(oid)) continue;
      distA.set(oid, d);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) {
          if (!distA.has(p)) qA.push([p, d + 1]);
        }
      }
    }
    let bestOid: string | null = null;
    let bestScore = Infinity;
    const seenB = new Set<string>();
    const qB: Array<[string, number]> = [[commitB, 0]];
    while (qB.length > 0) {
      const [oid, dB] = qB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const dA = distA.get(oid);
      if (dA !== undefined) {
        const score = dA + dB;
        if (score < bestScore) {
          bestScore = score;
          bestOid = oid;
        }
      }
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) {
          if (!seenB.has(p)) qB.push([p, dB + 1]);
        }
      }
    }
    return bestOid;
  }

  computeThreeWayMerge(
    repo: RepoState,
    baseCommitOid: string,
    headCommitOid: string,
  ): { conflict: boolean; files: Map<string, { oid: string; mode: string }>; mergeBaseOid: string | null } {
    const mergeBaseOid = this.computeMergeBase(repo, baseCommitOid, headCommitOid);
    const t0 = flattenTree(repo.objects, mergeBaseOid ? this.getCommitRootTreeOid(repo, mergeBaseOid) : null);
    const tBase = flattenTree(repo.objects, this.getCommitRootTreeOid(repo, baseCommitOid));
    const tHead = flattenTree(repo.objects, this.getCommitRootTreeOid(repo, headCommitOid));

    const allPaths = new Set<string>([...t0.keys(), ...tBase.keys(), ...tHead.keys()]);
    const merged = new Map<string, { oid: string; mode: string }>();
    for (const p of allPaths) {
      const e0 = t0.get(p);
      const eb = tBase.get(p);
      const eh = tHead.get(p);
      if (sameTreeEntry(eb, eh)) {
        if (eb) merged.set(p, { oid: eb.oid, mode: eb.mode });
      } else if (sameTreeEntry(e0, eb)) {
        if (eh) merged.set(p, { oid: eh.oid, mode: eh.mode });
      } else if (sameTreeEntry(e0, eh)) {
        if (eb) merged.set(p, { oid: eb.oid, mode: eb.mode });
      } else {
        return { conflict: true, files: merged, mergeBaseOid };
      }
    }
    return { conflict: false, files: merged, mergeBaseOid };
  }

  createPull(
    repo: RepoState,
    input: { title: string; body?: string; head: string; base: string },
  ): PullRecord {
    const headRef = normalizeBranchName(input.head, repo.owner);
    const baseRef = normalizeBranchName(input.base, repo.owner);
    if (!headRef || !baseRef) {
      throw new StoreError(422, 'Validation Failed: head and base are required', 'invalid');
    }
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      throw new StoreError(422, 'Validation Failed: head or base branch not found', 'invalid_branch');
    }
    if (!input.title || input.title.trim() === '') {
      throw new StoreError(422, 'Validation Failed: title is required', 'invalid');
    }
    const { iso } = this.nextClock();
    const id = this.nextItemIdVal++;
    const number = repo.nextNumber++;
    const seq = this.nextSeqVal++;
    const pr: PullRecord = {
      id,
      nodeId: encodeNodeId('PR', repo.id, number),
      number,
      seq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      headRef,
      baseRef,
      headShaCreated: headSha,
      baseShaCreated: baseSha,
      lockedHeadSha: null,
      lockedMergeBaseSha: null,
      lockedFiles: null,
      userLogin: VIEWER.login,
      userId: VIEWER.id,
      createdAt: iso,
      updatedAt: iso,
      comments: [],
    };
    repo.pulls.set(number, pr);
    repo.pullList.push(pr);
    return pr;
  }

  getPullLiveShas(repo: RepoState, pr: PullRecord): { headSha: string; baseSha: string } {
    if (pr.state === 'open') {
      return {
        headSha: repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headShaCreated,
        baseSha: repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseShaCreated,
      };
    }
    return {
      headSha: pr.lockedHeadSha ?? repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headShaCreated,
      baseSha: pr.mergeCommitSha ?? repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseShaCreated,
    };
  }

  isPullMergeable(repo: RepoState, pr: PullRecord): boolean | null {
    if (pr.merged || pr.state !== 'open') return false;
    const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!headSha || !baseSha) return false;
    return !this.computeThreeWayMerge(repo, baseSha, headSha).conflict;
  }

  getPullFiles(repo: RepoState, pr: PullRecord): PullFileDiff[] {
    if (pr.lockedFiles !== null) return pr.lockedFiles;
    const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headShaCreated;
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseShaCreated;
    const mergeBase = this.computeMergeBase(repo, baseSha, headSha);
    const baseTree = mergeBase ? this.getCommitRootTreeOid(repo, mergeBase) : this.getCommitRootTreeOid(repo, baseSha);
    const headTree = this.getCommitRootTreeOid(repo, headSha);
    return diffTrees(repo.objects, baseTree, headTree);
  }

  serializePull(repo: RepoState, pr: PullRecord): Record<string, unknown> {
    const { headSha, baseSha } = this.getPullLiveShas(repo, pr);
    const mergeable = pr.state === 'open' ? this.isPullMergeable(repo, pr) : false;
    return {
      id: pr.id,
      node_id: pr.nodeId,
      number: pr.number,
      state: pr.state,
      title: pr.title,
      body: pr.body,
      merged: pr.merged,
      mergeable,
      merge_commit_sha: pr.mergeCommitSha,
      merged_at: pr.mergedAt,
      head: {
        ref: pr.headRef,
        label: `${repo.owner}:${pr.headRef}`,
        sha: headSha,
      },
      base: {
        ref: pr.baseRef,
        label: `${repo.owner}:${pr.baseRef}`,
        sha: baseSha,
      },
      user: {
        login: pr.userLogin,
        id: pr.userId,
      },
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
    };
  }

  mergePull(
    repo: RepoState,
    number: number,
    options: { mergeMethod?: string; commitTitle?: string; commitMessage?: string } = {},
  ): { sha: string; merged: true; message: string; pr: PullRecord } {
    const pr = repo.pulls.get(number);
    if (!pr) throw new StoreError(404, 'Not Found', 'not_found');
    if (pr.merged || pr.state !== 'open') {
      throw new StoreError(405, 'Pull Request is not mergeable', 'not_mergeable');
    }
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (!baseTip || !headTip) {
      throw new StoreError(405, 'Pull Request branch is missing', 'not_mergeable');
    }

    const mergedResult = this.computeThreeWayMerge(repo, baseTip, headTip);
    if (mergedResult.conflict) {
      throw new StoreError(405, 'Merge conflict', 'conflict');
    }

    const baseTree = mergedResult.mergeBaseOid
      ? this.getCommitRootTreeOid(repo, mergedResult.mergeBaseOid)
      : this.getCommitRootTreeOid(repo, baseTip);
    const headTree = this.getCommitRootTreeOid(repo, headTip);
    pr.lockedHeadSha = headTip;
    pr.lockedMergeBaseSha = mergedResult.mergeBaseOid;
    pr.lockedFiles = diffTrees(repo.objects, baseTree, headTree);

    const newTreeOid = buildTreeFromFlat(repo.objects, mergedResult.files);
    const method = (options.mergeMethod ?? 'squash').toLowerCase();
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const { epochSec, iso } = this.nextClock();
    const message = options.commitTitle ?? `${pr.title} (#${pr.number})`;
    const commitData = buildCommit({
      tree: newTreeOid,
      parents,
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      timestampSec: epochSec,
      message,
    });
    const commitObj = makeObject('commit', commitData);
    repo.objects.set(commitObj.oid, commitObj);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commitObj.oid);
    this.invalidateRepoPackCaches(repo);

    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = commitObj.oid;
    pr.mergedAt = iso;
    pr.updatedAt = iso;

    return {
      sha: commitObj.oid,
      merged: true,
      message: 'Pull Request successfully merged',
      pr,
    };
  }
}
