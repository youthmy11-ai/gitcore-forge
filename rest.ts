import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ForgeStore, type IssueRecord, type RepoState, StoreError } from './store.ts';

function fastDecode(seg: string): string {
  return seg.indexOf('%') >= 0 ? decodeURIComponent(seg) : seg;
}

const NOT_FOUND_BUF = Buffer.from('{"message":"Not Found"}', 'utf8');
const BAD_JSON_BUF = Buffer.from('{"message":"Problems parsing JSON"}', 'utf8');
const TITLE_REQUIRED_BUF = Buffer.from('{"message":"Validation Failed: title is required"}', 'utf8');

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  requestId: string,
  extraHeaders?: Record<string, string>,
): void {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', buf.length);
  res.setHeader('x-github-request-id', requestId);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(buf);
}

export function sendJsonBuffer(res: ServerResponse, status: number, buf: Buffer, requestId: string): void {
  res.writeHead(status, [
    'content-type',
    'application/json; charset=utf-8',
    'content-length',
    String(buf.length),
    'x-github-request-id',
    requestId,
  ]);
  res.end(buf);
}

function sendNoContent(res: ServerResponse, requestId: string): void {
  res.statusCode = 204;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-github-request-id', requestId);
  res.end();
}

function sendNotFound(res: ServerResponse, requestId: string): void {
  sendJsonBuffer(res, 404, NOT_FOUND_BUF, requestId);
}

function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StoreError(400, 'Problems parsing JSON', 'bad_json');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof StoreError) throw err;
    throw new StoreError(400, 'Problems parsing JSON', 'bad_json');
  }
}

function parseJsonObjectSafe(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function parseIntStrict(raw: string): number | null {
  if (raw.length === 0) return null;
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const digit = raw.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return null;
    n = n * 10 + digit;
    if (n > Number.MAX_SAFE_INTEGER) return null;
  }
  return n > 0 ? n : null;
}

function parseIntStrictSlice(raw: string, start: number): number | null {
  const len = raw.length;
  if (start >= len) return null;
  let n = 0;
  for (let i = start; i < len; i++) {
    const digit = raw.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return null;
    n = n * 10 + digit;
    if (n > Number.MAX_SAFE_INTEGER) return null;
  }
  return n > 0 ? n : null;
}

export function tryFastGetIssue(
  store: ForgeStore,
  res: ServerResponse,
  pathname: string,
  requestId: string,
): boolean {
  const s1 = 14; // after '/api/v3/repos/'
  const slash1 = pathname.indexOf('/', s1);
  if (slash1 <= s1) return false;
  const slash2 = pathname.indexOf('/', slash1 + 1);
  if (slash2 <= slash1 + 1 || !pathname.startsWith('/issues/', slash2)) return false;
  const numStart = slash2 + 8;
  if (numStart >= pathname.length || pathname.indexOf('/', numStart) >= 0 || pathname.indexOf('%') >= 0) {
    return false;
  }
  const num = parseIntStrictSlice(pathname, numStart);
  if (num === null) return false;
  const owner = pathname.slice(s1, slash1);
  const repoName = pathname.slice(slash1 + 1, slash2);
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    sendNotFound(res, requestId);
    return true;
  }
  const issue = repo.issues.get(num);
  if (!issue) {
    sendNotFound(res, requestId);
    return true;
  }
  sendJsonBuffer(res, 200, issue.cachedJson, requestId);
  return true;
}

export function tryFastPostIssue(
  store: ForgeStore,
  res: ServerResponse,
  pathname: string,
  body: Buffer,
  requestId: string,
): boolean {
  const s1 = 14; // after '/api/v3/repos/'
  const slash1 = pathname.indexOf('/', s1);
  if (slash1 <= s1) return false;
  const slash2 = pathname.indexOf('/', slash1 + 1);
  if (slash2 <= slash1 + 1 || slash2 + 7 !== pathname.length || pathname.indexOf('%') >= 0) {
    return false;
  }
  const owner = pathname.slice(s1, slash1);
  const repoName = pathname.slice(slash1 + 1, slash2);
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    sendNotFound(res, requestId);
    return true;
  }
  const data = parseJsonObjectSafe(body);
  if (!data) {
    sendJsonBuffer(res, 400, BAD_JSON_BUF, requestId);
    return true;
  }
  if (data.labels !== undefined) return false;
  const title = typeof data.title === 'string' ? data.title : '';
  if (title.trim() === '') {
    sendJsonBuffer(res, 422, TITLE_REQUIRED_BUF, requestId);
    return true;
  }
  const issueBody = typeof data.body === 'string' ? data.body : undefined;
  const created = store.createIssue(repo, { title, body: issueBody });
  sendJsonBuffer(res, 201, created.cachedJson, requestId);
  return true;
}

function paginate<T>(
  items: readonly T[],
  query: URLSearchParams | null,
  req: IncomingMessage,
  basePath: string,
): { pageItems: readonly T[]; extraHeaders?: Record<string, string> } {
  const perPageRaw = query?.get('per_page');
  const pageRaw = query?.get('page');
  let perPage = perPageRaw ? Number.parseInt(perPageRaw, 10) : 30;
  let page = pageRaw ? Number.parseInt(pageRaw, 10) : 1;
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  if (!Number.isFinite(page) || page < 1) page = 1;

  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + slice.length < items.length) {
    const host = req.headers.host || '127.0.0.1';
    const nextParams = new URLSearchParams(query ?? undefined);
    nextParams.set('per_page', String(perPage));
    nextParams.set('page', String(page + 1));
    const linkUrl = `http://${host}${basePath}?${nextParams.toString()}`;
    return {
      pageItems: slice,
      extraHeaders: {
        link: `<${linkUrl}>; rel="next"`,
      },
    };
  }
  return { pageItems: slice };
}

function sortIssues(
  issues: IssueRecord[],
  sort: string,
  direction: string,
): IssueRecord[] {
  const asc = direction === 'asc';
  const mult = asc ? 1 : -1;
  return issues.sort((a, b) => {
    if (sort === 'comments') {
      if (a.comments.length !== b.comments.length) {
        return (a.comments.length - b.comments.length) * mult;
      }
    } else if (sort === 'updated') {
      if (a.updatedAt !== b.updatedAt) {
        return (a.updatedAt < b.updatedAt ? -1 : 1) * mult;
      }
    }
    if (a.seq !== b.seq) return (a.seq - b.seq) * mult;
    return (a.number - b.number) * mult;
  });
}

export function handleRestRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string,
  queryStr: string,
  body: Buffer,
  requestId: string,
): void {
  const method = req.method ?? 'GET';
  const query = queryStr !== '' ? new URLSearchParams(queryStr) : null;

  try {

    if (subPath === '' || subPath === '/') {
      if (method === 'GET') {
        sendJson(
          res,
          200,
          {
            current_user_url: '/api/v3/user',
            user_repositories_url: '/api/v3/users/{user}/repos',
          },
          requestId,
          { 'x-oauth-scopes': 'repo, read:org' },
        );
        return;
      }
      sendNotFound(res, requestId);
      return;
    }

    if (subPath === '/meta' && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false }, requestId);
      return;
    }

    if (subPath === '/user' && method === 'GET') {
      sendJson(
        res,
        200,
        {
          login: 'adaiversen',
          id: 1000,
          node_id: 'VXNlcjoxMDAw',
          name: 'ada iversen',
          email: 'adaiversen@example.invalid',
        },
        requestId,
      );
      return;
    }

    if (subPath === '/user/repos') {
      if (method === 'GET') {
        const { pageItems, extraHeaders } = paginate(store.reposList, query, req, '/api/v3/user/repos');
        sendJson(
          res,
          200,
          pageItems.map((r) => store.serializeRepo(r)),
          requestId,
          extraHeaders,
        );
        return;
      }
      if (method === 'POST') {
        const data = parseJsonBody(body);
        const name = typeof data.name === 'string' ? data.name : '';
        const repo = store.createRepo({
          name,
          description: typeof data.description === 'string' ? data.description : undefined,
          private: typeof data.private === 'boolean' ? data.private : undefined,
          defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : undefined,
        });
        sendJson(res, 201, store.serializeRepo(repo), requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }

    if (!subPath.startsWith('/repos/')) {
      sendNotFound(res, requestId);
      return;
    }

    const parts = subPath.slice('/repos/'.length).split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      sendNotFound(res, requestId);
      return;
    }

    const owner = fastDecode(parts[0]);
    const repoName = fastDecode(parts[1]);

    // /repos/{owner}/{repo}
    if (parts.length === 2) {
      if (method === 'GET') {
        const repo = store.getRepo(owner, repoName);
        sendJson(res, 200, store.serializeRepo(repo), requestId);
        return;
      }
      if (method === 'PATCH') {
        const repo = store.getRepo(owner, repoName);
        const data = parseJsonBody(body);
        store.updateRepo(repo, {
          description: typeof data.description === 'string' ? data.description : undefined,
          private: typeof data.private === 'boolean' ? data.private : undefined,
          defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : undefined,
        });
        sendJson(res, 200, store.serializeRepo(repo), requestId);
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendNoContent(res, requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }

    const repo: RepoState = store.getRepo(owner, repoName);
    const resource = parts[2];

    if (resource === 'branches') {
      if (parts.length === 3 && method === 'GET') {
        sendJson(res, 200, store.listBranches(repo), requestId);
        return;
      }
      if (parts.length >= 4 && method === 'GET') {
        const branchName = parts.slice(3).map(fastDecode).join('/');
        const oid = repo.refs.get(`refs/heads/${branchName}`);
        if (!oid) {
          sendNotFound(res, requestId);
          return;
        }
        sendJson(res, 200, { name: branchName, commit: { sha: oid } }, requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }

    if (resource === 'git' && parts[3] === 'refs') {
      if (parts.length === 4) {
        if (method === 'POST') {
          const data = parseJsonBody(body);
          const ref = typeof data.ref === 'string' ? data.ref : '';
          const sha = typeof data.sha === 'string' ? data.sha : '';
          const created = store.createRef(repo, ref, sha);
          sendJson(res, 201, created, requestId);
          return;
        }
        if (method === 'GET') {
          const out: Array<{ ref: string; object: { sha: string; type: string } }> = [];
          for (const [ref, sha] of repo.refs) {
            const obj = repo.objects.get(sha);
            out.push({ ref, object: { sha, type: obj?.type ?? 'commit' } });
          }
          sendJson(res, 200, out, requestId);
          return;
        }
      } else if (method === 'GET') {
        const tail = parts.slice(4).map(fastDecode).join('/');
        const fullRef = tail.startsWith('refs/') ? tail : `refs/${tail}`;
        const oid = repo.refs.get(fullRef);
        if (!oid) {
          sendNotFound(res, requestId);
          return;
        }
        const obj = repo.objects.get(oid);
        sendJson(res, 200, { ref: fullRef, object: { sha: oid, type: obj?.type ?? 'commit' } }, requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }

    if (resource === 'commits' && parts.length === 3 && method === 'GET') {
      const shaParam = query?.get('sha') ?? undefined;
      const commits = store.listCommits(repo, shaParam);
      const { pageItems, extraHeaders } = paginate(
        commits,
        query,
        req,
        `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits`,
      );
      sendJson(res, 200, pageItems, requestId, extraHeaders);
      return;
    }

    if (resource === 'contents') {
      const contentPath = parts.slice(3).map(fastDecode).join('/');
      if (method === 'GET') {
        const refParam = query?.get('ref') ?? undefined;
        const result = store.getContent(repo, contentPath, refParam);
        sendJson(res, 200, result, requestId);
        return;
      }
      if (method === 'PUT') {
        const data = parseJsonBody(body);
        const message = typeof data.message === 'string' ? data.message : '';
        const content = typeof data.content === 'string' ? data.content : '';
        if (!message) throw new StoreError(422, 'Validation Failed: message is required', 'invalid');
        const branch = typeof data.branch === 'string' ? data.branch : undefined;
        const sha = typeof data.sha === 'string' ? data.sha : undefined;
        const result = store.putContent(repo, contentPath, {
          message,
          contentBase64: content,
          branch,
          sha,
        });
        sendJson(res, result.status, result.body, requestId);
        return;
      }
      if (method === 'DELETE') {
        const data = parseJsonBody(body);
        const message = typeof data.message === 'string' ? data.message : '';
        const sha = typeof data.sha === 'string' ? data.sha : '';
        const branch = typeof data.branch === 'string' ? data.branch : undefined;
        const result = store.deleteContent(repo, contentPath, { message, sha, branch });
        sendJson(res, 200, result, requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }

    if (resource === 'labels') {
      if (parts.length === 3) {
        if (method === 'GET') {
          sendJson(
            res,
            200,
            [...repo.labels.values()].map((l) => store.serializeLabel(l)),
            requestId,
          );
          return;
        }
        if (method === 'POST') {
          const data = parseJsonBody(body);
          const name = typeof data.name === 'string' ? data.name : '';
          const color = typeof data.color === 'string' ? data.color : undefined;
          const description = typeof data.description === 'string' ? data.description : undefined;
          const created = store.createLabel(repo, { name, color, description });
          sendJson(res, 201, store.serializeLabel(created), requestId);
          return;
        }
      }
      sendNotFound(res, requestId);
      return;
    }

    if (resource === 'issues') {
      if (parts.length === 3) {
        if (method === 'POST') {
          const data = parseJsonBody(body);
          const title = typeof data.title === 'string' ? data.title : '';
          const issueBody = typeof data.body === 'string' ? data.body : undefined;
          let labels: string[] | undefined;
          if (data.labels !== undefined) {
            if (!Array.isArray(data.labels)) {
              throw new StoreError(422, 'Validation Failed: labels must be an array', 'invalid');
            }
            labels = data.labels.map((l) => (typeof l === 'string' ? l : typeof l === 'object' && l && typeof (l as Record<string, unknown>).name === 'string' ? String((l as Record<string, unknown>).name) : ''));
          }
          const created = store.createIssue(repo, { title, body: issueBody, labels });
          sendJsonBuffer(res, 201, created.cachedJson, requestId);
          return;
        }
        if (method === 'GET') {
          const stateParam = query?.get('state') ?? 'open';
          const sortParam = query?.get('sort') ?? 'created';
          const dirParam = query?.get('direction') ?? 'desc';
          const filtered =
            stateParam === 'all'
              ? [...repo.issueList]
              : repo.issueList.filter((i) => i.state === stateParam);
          sortIssues(filtered, sortParam, dirParam);
          const { pageItems, extraHeaders } = paginate(
            filtered,
            query,
            req,
            `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues`,
          );
          const out = `[${pageItems.map((i) => i.cachedJson.toString('utf8')).join(',')}]`;
          const buf = Buffer.from(out, 'utf8');
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('content-length', buf.length);
          res.setHeader('x-github-request-id', requestId);
          if (extraHeaders) {
            for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
          }
          res.end(buf);
          return;
        }
      }
      const num = parseIntStrict(parts[3] ?? '');
      if (num === null) {
        sendNotFound(res, requestId);
        return;
      }
      if (parts.length === 4) {
        if (method === 'GET') {
          const issue = repo.issues.get(num);
          if (!issue) {
            sendNotFound(res, requestId);
            return;
          }
          sendJsonBuffer(res, 200, issue.cachedJson, requestId);
          return;
        }
        if (method === 'PATCH') {
          const data = parseJsonBody(body);
          let labels: string[] | undefined;
          if (data.labels !== undefined && Array.isArray(data.labels)) {
            labels = data.labels.map((l) => String(l));
          }
          const updated = store.updateIssue(repo, num, {
            title: typeof data.title === 'string' ? data.title : undefined,
            body: typeof data.body === 'string' ? data.body : undefined,
            state: data.state === 'open' || data.state === 'closed' ? data.state : undefined,
            labels,
          });
          sendJsonBuffer(res, 200, updated.cachedJson, requestId);
          return;
        }
      }
      if (parts.length === 5 && parts[4] === 'comments') {
        const target = repo.issues.get(num) ?? repo.pulls.get(num);
        if (!target) {
          sendNotFound(res, requestId);
          return;
        }
        if (method === 'GET') {
          sendJson(
            res,
            200,
            target.comments.map((c) => store.serializeComment(c)),
            requestId,
          );
          return;
        }
        if (method === 'POST') {
          const data = parseJsonBody(body);
          const commentBody = typeof data.body === 'string' ? data.body : '';
          const comment = store.addComment(repo, num, commentBody);
          sendJson(res, 201, store.serializeComment(comment), requestId);
          return;
        }
      }
      sendNotFound(res, requestId);
      return;
    }

    if (resource === 'pulls') {
      if (parts.length === 3) {
        if (method === 'POST') {
          const data = parseJsonBody(body);
          const pr = store.createPull(repo, {
            title: typeof data.title === 'string' ? data.title : '',
            body: typeof data.body === 'string' ? data.body : undefined,
            head: typeof data.head === 'string' ? data.head : '',
            base: typeof data.base === 'string' ? data.base : '',
          });
          sendJson(res, 201, store.serializePull(repo, pr), requestId);
          return;
        }
        if (method === 'GET') {
          const stateParam = query?.get('state') ?? 'open';
          const filtered =
            stateParam === 'all'
              ? [...repo.pullList]
              : repo.pullList.filter((p) => p.state === stateParam);
          filtered.sort((a, b) => b.number - a.number);
          const { pageItems, extraHeaders } = paginate(
            filtered,
            query,
            req,
            `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls`,
          );
          sendJson(
            res,
            200,
            pageItems.map((p) => store.serializePull(repo, p)),
            requestId,
            extraHeaders,
          );
          return;
        }
      }
      const num = parseIntStrict(parts[3] ?? '');
      if (num === null) {
        sendNotFound(res, requestId);
        return;
      }
      if (parts.length === 4) {
        const pr = repo.pulls.get(num);
        if (!pr) {
          sendNotFound(res, requestId);
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, store.serializePull(repo, pr), requestId);
          return;
        }
        if (method === 'PATCH') {
          const data = parseJsonBody(body);
          if (typeof data.title === 'string') pr.title = data.title;
          if (typeof data.body === 'string') pr.body = data.body;
          if (data.state === 'open' || data.state === 'closed') pr.state = data.state;
          sendJson(res, 200, store.serializePull(repo, pr), requestId);
          return;
        }
      }
      if (parts.length === 5 && parts[4] === 'files' && method === 'GET') {
        const pr = repo.pulls.get(num);
        if (!pr) {
          sendNotFound(res, requestId);
          return;
        }
        sendJson(res, 200, store.getPullFiles(repo, pr), requestId);
        return;
      }
      if (parts.length === 5 && parts[4] === 'merge' && method === 'PUT') {
        const data = parseJsonBody(body);
        const result = store.mergePull(repo, num, {
          mergeMethod: typeof data.merge_method === 'string' ? data.merge_method : undefined,
          commitTitle: typeof data.commit_title === 'string' ? data.commit_title : undefined,
          commitMessage: typeof data.commit_message === 'string' ? data.commit_message : undefined,
        });
        sendJson(
          res,
          200,
          {
            sha: result.sha,
            merged: result.merged,
            message: result.message,
          },
          requestId,
        );
        return;
      }
      sendNotFound(res, requestId);
      return;
    }

    sendNotFound(res, requestId);
  } catch (err) {
    if (err instanceof URIError) {
      sendJson(res, 400, { message: 'Malformed URL path' }, requestId);
      return;
    }
    if (err instanceof StoreError) {
      if (err.code === 'bad_json') {
        sendJsonBuffer(res, 400, BAD_JSON_BUF, requestId);
        return;
      }
      const errBody: Record<string, unknown> = { message: err.message };
      if (err.code === 'already_exists') {
        errBody.errors = [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }];
      }
      sendJson(res, err.status, errBody, requestId);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { message }, requestId);
  }
}
