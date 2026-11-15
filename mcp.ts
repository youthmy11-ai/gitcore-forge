import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './rest.ts';
import { type ForgeStore, StoreError, VIEWER } from './store.ts';

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required: readonly string[];
  };
}

const SERVER_INFO = Object.freeze({
  name: 'gitcore-forge',
  version: '1.0.0',
});

const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Optional repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Fetch repository metadata by owner and repository name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Optional issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Filter state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a new pull request from head branch into base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Optional pull request description.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
        merge_method: { type: 'string', description: 'Merge method (squash, merge, rebase).' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOL_NAMES = new Set<string>(MCP_TOOLS.map((t) => t.name));

function makeToolResult(data: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

function asNonEmptyString(val: unknown): string | null {
  return typeof val === 'string' && val.trim() !== '' ? val : null;
}

function asPositiveInt(val: unknown): number | null {
  if (typeof val === 'number' && Number.isInteger(val) && val > 0) return val;
  if (typeof val === 'string' && /^\d+$/.test(val)) {
    const n = Number(val);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function executeTool(store: ForgeStore, toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  try {
    if (toolName === 'create_repo') {
      const name = asNonEmptyString(args.name);
      if (!name) return makeToolResult({ error: 'Missing required argument: name' }, true);
      const repo = store.createRepo({
        name,
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      return makeToolResult(store.serializeRepo(repo));
    }

    if (toolName === 'get_repo') {
      const owner = asNonEmptyString(args.owner) ?? VIEWER.login;
      const repoName = asNonEmptyString(args.repo);
      if (!repoName) return makeToolResult({ error: 'Missing required argument: repo' }, true);
      const repo = store.getRepo(owner, repoName);
      return makeToolResult(store.serializeRepo(repo));
    }

    if (toolName === 'create_issue') {
      const owner = asNonEmptyString(args.owner);
      const repoName = asNonEmptyString(args.repo);
      const title = asNonEmptyString(args.title);
      if (!owner || !repoName || !title) {
        return makeToolResult({ error: 'Missing required arguments: owner, repo, title' }, true);
      }
      const repo = store.getRepo(owner, repoName);
      const issue = store.createIssue(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
      });
      return makeToolResult(JSON.parse(issue.cachedJson.toString('utf8')));
    }

    if (toolName === 'list_issues') {
      const owner = asNonEmptyString(args.owner);
      const repoName = asNonEmptyString(args.repo);
      if (!owner || !repoName) {
        return makeToolResult({ error: 'Missing required arguments: owner, repo' }, true);
      }
      const repo = store.getRepo(owner, repoName);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const items =
        state === 'all'
          ? repo.issueList
          : repo.issueList.filter((i) => i.state === state);
      const payload = items.map((i) => JSON.parse(i.cachedJson.toString('utf8')));
      return makeToolResult({ issues: payload });
    }

    if (toolName === 'create_pull_request') {
      const owner = asNonEmptyString(args.owner);
      const repoName = asNonEmptyString(args.repo);
      const title = asNonEmptyString(args.title);
      const head = asNonEmptyString(args.head);
      const base = asNonEmptyString(args.base);
      if (!owner || !repoName || !title || !head || !base) {
        return makeToolResult({ error: 'Missing required arguments: owner, repo, title, head, base' }, true);
      }
      const repo = store.getRepo(owner, repoName);
      const pr = store.createPull(repo, {
        title,
        head,
        base,
        body: typeof args.body === 'string' ? args.body : '',
      });
      return makeToolResult(store.serializePull(repo, pr));
    }

    if (toolName === 'merge_pull_request') {
      const owner = asNonEmptyString(args.owner);
      const repoName = asNonEmptyString(args.repo);
      const pullNumber = asPositiveInt(args.pull_number);
      if (!owner || !repoName || pullNumber === null) {
        return makeToolResult({ error: 'Missing required arguments: owner, repo, pull_number' }, true);
      }
      const repo = store.getRepo(owner, repoName);
      const res = store.mergePull(repo, pullNumber, {
        mergeMethod: typeof args.merge_method === 'string' ? args.merge_method : 'squash',
      });
      return makeToolResult({
        sha: res.sha,
        merged: res.merged,
        message: res.message,
      });
    }

    return makeToolResult({ error: `Unknown tool: ${toolName}` }, true);
  } catch (err) {
    if (err instanceof StoreError) {
      return makeToolResult({ error: err.message, status: err.status }, true);
    }
    return makeToolResult({ error: err instanceof Error ? err.message : String(err) }, true);
  }
}

export function handleMcpRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  requestId: string,
): void {
  const extraHeaders: Record<string, string> = {};
  const reqProtoVer = req.headers['mcp-protocol-version'];
  if (typeof reqProtoVer === 'string' && reqProtoVer !== '') {
    extraHeaders['mcp-protocol-version'] = '2026-07-28';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(
      res,
      400,
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      requestId,
      extraHeaders,
    );
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(
      res,
      400,
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      },
      requestId,
      extraHeaders,
    );
    return;
  }

  const rpc = parsed as Record<string, unknown>;
  const hasId = 'id' in rpc && rpc.id !== undefined;
  const id = (hasId ? rpc.id : null) as string | number | null;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params =
    rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
      ? (rpc.params as Record<string, unknown>)
      : {};

  if (!hasId || method.startsWith('notifications/')) {
    res.writeHead(202, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': 2,
      'x-github-request-id': requestId,
      ...extraHeaders,
    });
    res.end('{}');
    return;
  }

  if (method === 'server/discover') {
    extraHeaders['mcp-protocol-version'] = '2026-07-28';
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/serverInfo': SERVER_INFO,
            'io.modelcontextprotocol/capabilities': { tools: {} },
          },
        },
      },
      requestId,
      extraHeaders,
    );
    return;
  }

  if (method === 'initialize') {
    extraHeaders['mcp-session-id'] = 'mcp-session-1';
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      },
      requestId,
      extraHeaders,
    );
    return;
  }

  if (method === 'ping') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: {} }, requestId, extraHeaders);
    return;
  }

  if (method === 'tools/list') {
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS,
        },
      },
      requestId,
      extraHeaders,
    );
    return;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    if (!toolName || !TOOL_NAMES.has(toolName)) {
      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Unknown tool: ${toolName}`,
          },
        },
        requestId,
        extraHeaders,
      );
      return;
    }
    const rawArgs = params.arguments;
    if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: 'Invalid arguments object',
          },
        },
        requestId,
        extraHeaders,
      );
      return;
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const toolResult = executeTool(store, toolName, args);
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: toolResult,
      },
      requestId,
      extraHeaders,
    );
    return;
  }

  sendJson(
    res,
    200,
    {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    },
    requestId,
    extraHeaders,
  );
}
