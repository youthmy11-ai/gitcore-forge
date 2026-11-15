import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitGetInfoRefs, handleGitPostService } from './git.ts';
import { handleGraphqlRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleRestRequest, sendJsonBuffer } from './rest.ts';
import { ForgeStore } from './store.ts';

export interface AppOptions {
  token?: string;
}

const HEALTHZ_BUF = Buffer.from('{"ok":true}', 'utf8');
const UNAUTH_BUF = Buffer.from('{"message":"Requires authentication"}', 'utf8');
const NOT_FOUND_BUF = Buffer.from('{"message":"Not Found"}', 'utf8');
const EMPTY_BUF = Buffer.alloc(0);

function readBodyFast(req: IncomingMessage, cb: (body: Buffer) => void): void {
  const lenHdr = req.headers['content-length'];
  const teHdr = req.headers['transfer-encoding'];
  if ((req.method === 'GET' || req.method === 'HEAD') && !lenHdr && !teHdr) {
    cb(EMPTY_BUF);
    return;
  }
  if (lenHdr === '0' && !teHdr) {
    cb(EMPTY_BUF);
    return;
  }

  let firstChunk: Buffer | null = null;
  let extraChunks: Buffer[] | null = null;
  let total = 0;

  req.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (firstChunk === null) {
      firstChunk = chunk;
    } else if (extraChunks === null) {
      extraChunks = [firstChunk, chunk];
    } else {
      extraChunks.push(chunk);
    }
  });

  req.on('end', () => {
    if (firstChunk === null) {
      cb(EMPTY_BUF);
    } else if (extraChunks === null) {
      cb(firstChunk);
    } else {
      cb(Buffer.concat(extraChunks, total));
    }
  });
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || auth.length < 8) return false;
  // Fast case-insensitive check for 'bearer '
  const prefix = auth.slice(0, 7).toLowerCase();
  if (prefix !== 'bearer ') return false;
  const token = auth.slice(7).trim();
  if (token === '') return false;
  if (expectedToken !== '' && token !== expectedToken) return false;
  return true;
}

function parseGitPath(pathname: string): { owner: string; repo: string; tail: string } | null {
  if (!pathname.startsWith('/')) return null;
  const s1 = pathname.indexOf('/', 1);
  if (s1 <= 1) return null;
  const s2 = pathname.indexOf('/', s1 + 1);
  if (s2 <= s1 + 5) return null;
  const repoSeg = pathname.slice(s1 + 1, s2);
  if (!repoSeg.endsWith('.git')) return null;
  const owner = pathname.slice(1, s1);
  const repo = repoSeg.slice(0, -4);
  if (!owner || !repo) return null;
  return {
    owner: owner.indexOf('%') >= 0 ? decodeURIComponent(owner) : owner,
    repo: repo.indexOf('%') >= 0 ? decodeURIComponent(repo) : repo,
    tail: pathname.slice(s2),
  };
}

export function createApp(options: AppOptions = {}): Server {
  const store = new ForgeStore();
  const expectedToken = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedBearer = expectedToken !== '' ? `Bearer ${expectedToken}` : '';

  const checkAuth = (req: IncomingMessage): boolean => {
    const auth = req.headers.authorization;
    if (expectedBearer !== '' && auth === expectedBearer) return true;
    return isAuthorized(req, expectedToken);
  };

  const server = createServer(
    {
      noDelay: true,
      keepAlive: true,
      keepAliveTimeout: 60_000,
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const rawUrl = req.url ?? '/';
      const qIdx = rawUrl.indexOf('?');
      const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
      const queryStr = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
      const method = req.method ?? 'GET';

      if (method === 'GET' && pathname === '/healthz') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': HEALTHZ_BUF.length,
        });
        res.end(HEALTHZ_BUF);
        return;
      }

      const requestId = store.nextRequestId();

      // REST v3 surface
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        if (!checkAuth(req)) {
          sendJsonBuffer(res, 401, UNAUTH_BUF, requestId);
          return;
        }
        const subPath = pathname.length === 7 ? '' : pathname.slice(7);
        if (method === 'GET' && !req.headers['content-length'] && !req.headers['transfer-encoding']) {
          handleRestRequest(store, req, res, subPath, queryStr, EMPTY_BUF, requestId);
          return;
        }
        readBodyFast(req, (body) => {
          handleRestRequest(store, req, res, subPath, queryStr, body, requestId);
        });
        return;
      }

      // GraphQL v4 surface
      if (pathname === '/api/graphql') {
        if (!checkAuth(req)) {
          sendJsonBuffer(res, 401, UNAUTH_BUF, requestId);
          return;
        }
        if (method !== 'POST') {
          sendJsonBuffer(res, 404, NOT_FOUND_BUF, requestId);
          return;
        }
        readBodyFast(req, (body) => {
          handleGraphqlRequest(store, res, body, requestId);
        });
        return;
      }

      // MCP surface
      if (pathname === '/mcp') {
        if (!checkAuth(req)) {
          sendJsonBuffer(res, 401, UNAUTH_BUF, requestId);
          return;
        }
        if (method === 'DELETE') {
          res.writeHead(204, {
            'content-type': 'application/json; charset=utf-8',
            'x-github-request-id': requestId,
          });
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJsonBuffer(res, 405, Buffer.from('{"message":"Method Not Allowed"}', 'utf8'), requestId);
          return;
        }
        readBodyFast(req, (body) => {
          handleMcpRequest(store, req, res, body, requestId);
        });
        return;
      }

      // Smart HTTP Git surface
      const gitRoute = parseGitPath(pathname);
      if (gitRoute) {
        if (expectedToken !== '' && !checkAuth(req)) {
          sendJsonBuffer(res, 401, UNAUTH_BUF, requestId);
          return;
        }
        if (gitRoute.tail === '/info/refs' && method === 'GET') {
          let service: string | null = null;
          if (queryStr !== '') {
            if (queryStr === 'service=git-upload-pack') service = 'git-upload-pack';
            else if (queryStr === 'service=git-receive-pack') service = 'git-receive-pack';
            else service = new URLSearchParams(queryStr).get('service');
          }
          handleGitGetInfoRefs(store, req, res, gitRoute.owner, gitRoute.repo, service, requestId);
          return;
        }
        if (gitRoute.tail === '/git-upload-pack' && method === 'POST') {
          readBodyFast(req, (body) => {
            handleGitPostService(store, req, res, gitRoute.owner, gitRoute.repo, 'git-upload-pack', body, requestId);
          });
          return;
        }
        if (gitRoute.tail === '/git-receive-pack' && method === 'POST') {
          readBodyFast(req, (body) => {
            handleGitPostService(store, req, res, gitRoute.owner, gitRoute.repo, 'git-receive-pack', body, requestId);
          });
          return;
        }
      }

      if (!checkAuth(req)) {
        sendJsonBuffer(res, 401, UNAUTH_BUF, requestId);
        return;
      }
      sendJsonBuffer(res, 404, NOT_FOUND_BUF, requestId);
    },
  );

  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.requestTimeout = 0;
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  return server;
}
