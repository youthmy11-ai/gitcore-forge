import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createApp } from './app.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  buildTreeFromFlat,
  countLineChanges,
  diffTrees,
  hashObject,
  makeObject,
  parseCommit,
  parseTree,
} from './git-objects.ts';
import { encodePktText, encodeSidebandPack } from './git.ts';
import { ForgeStore, decodeNodeId, encodeNodeId } from './store.ts';

async function listenEphemeral(token = 'test-token'): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createApp({ token });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('git-objects builds deterministic trees, commits, and line diffs', () => {
  const objects = new Map();
  const b1 = makeObject('blob', Buffer.from('alpha\nbeta\n', 'utf8'));
  const b2 = makeObject('blob', Buffer.from('alpha\ngamma\ndelta\n', 'utf8'));
  objects.set(b1.oid, b1);
  objects.set(b2.oid, b2);

  const t1 = buildTreeFromFlat(objects, new Map([['dir/a.txt', { oid: b1.oid, mode: '100644' }]]));
  const t2 = buildTreeFromFlat(objects, new Map([['dir/a.txt', { oid: b2.oid, mode: '100644' }], ['b.txt', { oid: b1.oid, mode: '100644' }]]));

  const parsedRoot = parseTree(objects.get(t2)!.data);
  assert.deepEqual(parsedRoot.map((e) => e.name), ['b.txt', 'dir']);

  const commitBuf = buildCommit({
    tree: t2,
    parents: [],
    authorName: 'Test User',
    authorEmail: 'test@example.invalid',
    timestampSec: 1735689600,
    message: 'initial commit',
  });
  const parsed = parseCommit(commitBuf);
  assert.equal(parsed.tree, t2);
  assert.equal(parsed.parents.length, 0);
  assert.equal(parsed.author.timestampSec, 1735689600);

  const lc = countLineChanges(b1.data, b2.data);
  assert.deepEqual(lc, { additions: 2, deletions: 1 });

  const diffs = diffTrees(objects, t1, t2);
  assert.equal(diffs.length, 2);
  assert.deepEqual(diffs[0], { filename: 'b.txt', status: 'added', additions: 2, deletions: 0, changes: 2 });
  assert.deepEqual(diffs[1], { filename: 'dir/a.txt', status: 'modified', additions: 2, deletions: 1, changes: 3 });
});

test('pkt-line and sideband framing produce valid lengths', () => {
  const pkt = encodePktText(['# service=git-upload-pack\n', 'flush']);
  assert.equal(pkt.subarray(0, 4).toString('ascii'), '001e');
  assert.equal(pkt.subarray(pkt.length - 4).toString('ascii'), '0000');

  const pack = Buffer.from('PACK\x00\x00\x00\x02\x00\x00\x00\x00' + '0'.repeat(20), 'binary');
  const framed = encodeSidebandPack(pack);
  assert.equal(framed[4], 1);
  assert.equal(framed.subarray(framed.length - 4).toString('ascii'), '0000');
});

test('ForgeStore enforces 3-way merge conflict detection and squash merges cleanly', () => {
  const store = new ForgeStore();
  const repo = store.createRepo({ name: 'merge-test' });
  const init = store.putContent(repo, 'app.txt', {
    message: 'init',
    contentBase64: Buffer.from('line1\n', 'utf8').toString('base64'),
  });
  const initSha = (init.body.commit as { sha: string }).sha;

  store.createRef(repo, 'refs/heads/feat-a', initSha);
  store.createRef(repo, 'refs/heads/feat-b', initSha);

  const curA = store.getContent(repo, 'app.txt', 'feat-a') as { sha: string };
  store.putContent(repo, 'app.txt', {
    message: 'a edits app',
    contentBase64: Buffer.from('line1 a\n', 'utf8').toString('base64'),
    branch: 'feat-a',
    sha: curA.sha,
  });

  const curB = store.getContent(repo, 'app.txt', 'feat-b') as { sha: string };
  store.putContent(repo, 'app.txt', {
    message: 'b edits app',
    contentBase64: Buffer.from('line1 b\n', 'utf8').toString('base64'),
    branch: 'feat-b',
    sha: curB.sha,
  });

  const pr1 = store.createPull(repo, { title: 'PR A', head: 'feat-a', base: 'main' });
  const pr2 = store.createPull(repo, { title: 'PR B', head: 'feat-b', base: 'main' });

  const merged = store.mergePull(repo, pr1.number, { mergeMethod: 'squash' });
  assert.equal(merged.merged, true);
  assert.equal(store.isPullMergeable(repo, pr2), false);
  assert.throws(() => store.mergePull(repo, pr2.number, { mergeMethod: 'squash' }), (err: unknown) => {
    return typeof err === 'object' && err !== null && (err as { status?: number }).status === 405;
  });
});

test('Relay NodeID encoding round-trips deterministically', () => {
  const id = encodeNodeId('Issue', 12, 34);
  assert.notEqual(id, '34');
  assert.deepEqual(decodeNodeId(id), { kind: 'Issue', repoId: 12, number: 34 });
});

test('HTTP surfaces share synchronized store state and enforce auth', async () => {
  const srv = await listenEphemeral('secret-tok');
  try {
    const authHeaders = {
      authorization: 'Bearer secret-tok',
      'content-type': 'application/json',
    };

    const hz = await fetch(`${srv.baseUrl}/healthz`);
    assert.equal(hz.status, 200);
    assert.deepEqual(await hz.json(), { ok: true });

    const unauth = await fetch(`${srv.baseUrl}/api/v3/user`);
    assert.equal(unauth.status, 401);

    const created = await fetch(`${srv.baseUrl}/mcp`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_repo', arguments: { name: 'sync-repo', private: false } },
      }),
    });
    assert.equal(created.status, 200);
    assert.ok(created.headers.get('x-github-request-id'));

    const restRead = await fetch(`${srv.baseUrl}/api/v3/repos/adaiversen/sync-repo`, { headers: authHeaders });
    assert.equal(restRead.status, 200);
    const restRepo = (await restRead.json()) as { id: number; name: string };
    assert.equal(restRepo.name, 'sync-repo');

    const gql = await fetch(`${srv.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        query: 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){databaseId name}}',
        variables: { owner: 'adaiversen', name: 'sync-repo' },
      }),
    });
    assert.equal(gql.status, 200);
    const gqlJson = (await gql.json()) as { data: { repository: { databaseId: number; name: string } } };
    assert.equal(gqlJson.data.repository.databaseId, restRepo.id);
    assert.equal(gqlJson.data.repository.name, 'sync-repo');
  } finally {
    await srv.close();
  }
});

function buildMinimalPack(objects: ReadonlyArray<{ type: 'commit' | 'tree' | 'blob'; data: Buffer }>): Buffer {
  const typeMap = { commit: 1, tree: 2, blob: 3 } as const;
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    let size = obj.data.length;
    const typeBits = typeMap[obj.type] << 4;
    const hdrBytes: number[] = [];
    let first = typeBits | (size & 0x0f);
    size >>>= 4;
    if (size > 0) first |= 0x80;
    hdrBytes.push(first);
    while (size > 0) {
      let next = size & 0x7f;
      size >>>= 7;
      if (size > 0) next |= 0x80;
      hdrBytes.push(next);
    }
    parts.push(Buffer.from(hdrBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const sha = createHash('sha1').update(body).digest();
  return Buffer.concat([body, sha]);
}

test('Git v2 ls-refs and fetch caches serve deterministic hits and invalidate on push', async () => {
  const srv = await listenEphemeral('git-tok');
  try {
    const auth = { authorization: 'Bearer git-tok', 'content-type': 'application/json' };
    const created = await fetch(`${srv.baseUrl}/api/v3/user/repos`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'v2-cache' }),
    });
    assert.equal(created.status, 201);

    const b1 = Buffer.from('one\n', 'utf8');
    const b1Oid = hashObject('blob', b1);
    const t1 = buildTree([{ mode: '100644', name: 'f.txt', oid: b1Oid }]);
    const t1Oid = hashObject('tree', t1);
    const c1 = buildCommit({
      tree: t1Oid,
      parents: [],
      authorName: 'A',
      authorEmail: 'a@example.invalid',
      timestampSec: 1700000001,
      message: 'first',
    });
    const c1Oid = hashObject('commit', c1);
    const pack1 = buildMinimalPack([
      { type: 'commit', data: c1 },
      { type: 'tree', data: t1 },
      { type: 'blob', data: b1 },
    ]);
    const push1 = Buffer.concat([
      encodePktText([`${ZERO_OID} ${c1Oid} refs/heads/main\u0000report-status side-band-64k\n`, 'flush']),
      pack1,
    ]);
    const p1Res = await fetch(`${srv.baseUrl}/adaiversen/v2-cache.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: 'Bearer git-tok', 'content-type': 'application/x-git-receive-pack-request' },
      body: push1,
    });
    assert.equal(p1Res.status, 200);

    const lsBody = encodePktText(['command=ls-refs\n', 'delim', 'peel\n', 'symrefs\n', 'flush']);
    const lsHeaders = {
      authorization: 'Bearer git-tok',
      'git-protocol': 'version=2',
      'content-type': 'application/x-git-upload-pack-request',
    };
    const ls1 = await fetch(`${srv.baseUrl}/adaiversen/v2-cache.git/git-upload-pack`, { method: 'POST', headers: lsHeaders, body: lsBody });
    const ls1Buf = Buffer.from(await ls1.arrayBuffer());
    const ls1Repeat = await fetch(`${srv.baseUrl}/adaiversen/v2-cache.git/git-upload-pack`, { method: 'POST', headers: lsHeaders, body: lsBody });
    const ls1RepeatBuf = Buffer.from(await ls1Repeat.arrayBuffer());
    assert.ok(ls1Buf.toString('utf8').includes(c1Oid));
    assert.deepEqual(ls1RepeatBuf, ls1Buf);

    const fetch1Body = encodePktText(['command=fetch\n', 'delim', `want ${c1Oid}\n`, 'deepen 1\n', 'done\n', 'flush']);
    const f1 = await fetch(`${srv.baseUrl}/adaiversen/v2-cache.git/git-upload-pack`, { method: 'POST', headers: lsHeaders, body: fetch1Body });
    assert.equal(f1.status, 200);
    assert.ok((await f1.text()).includes('packfile\n'));

    // Second push must invalidate cached ls-refs response for refs/heads/main
    const b2 = Buffer.from('two\n', 'utf8');
    const b2Oid = hashObject('blob', b2);
    const t2 = buildTree([{ mode: '100644', name: 'f.txt', oid: b2Oid }]);
    const t2Oid = hashObject('tree', t2);
    const c2 = buildCommit({
      tree: t2Oid,
      parents: [c1Oid],
      authorName: 'A',
      authorEmail: 'a@example.invalid',
      timestampSec: 1700000002,
      message: 'second',
    });
    const c2Oid = hashObject('commit', c2);
    const pack2 = buildMinimalPack([
      { type: 'commit', data: c2 },
      { type: 'tree', data: t2 },
      { type: 'blob', data: b2 },
    ]);
    const push2 = Buffer.concat([
      encodePktText([`${c1Oid} ${c2Oid} refs/heads/main\u0000report-status side-band-64k\n`, 'flush']),
      pack2,
    ]);
    const p2Res = await fetch(`${srv.baseUrl}/adaiversen/v2-cache.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: 'Bearer git-tok', 'content-type': 'application/x-git-receive-pack-request' },
      body: push2,
    });
    assert.equal(p2Res.status, 200);

    const ls2 = await fetch(`${srv.baseUrl}/adaiversen/v2-cache.git/git-upload-pack`, { method: 'POST', headers: lsHeaders, body: lsBody });
    const ls2Text = await ls2.text();
    assert.ok(ls2Text.includes(c2Oid));
    assert.ok(!ls2Text.includes(c1Oid));
  } finally {
    await srv.close();
  }
});

test('main.ts enforces MAKEFUN_ENV_URL requirement and completes register/healthz/done lifecycle', async () => {
  const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));

  const missingCode = await new Promise<number | null>((resolve, reject) => {
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const child = spawn(process.execPath, ['--experimental-strip-types', mainPath], { env, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
  assert.equal(missingCode, 1);

  let registeredPort = 0;
  let donePolls = 0;
  let healthzStatus = 0;
  const mockEnv = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/register') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { port: number };
        registeredPort = parsed.port;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/done') {
      donePolls += 1;
      if (donePolls === 1 && registeredPort > 0) {
        void fetch(`http://127.0.0.1:${registeredPort}/healthz`).then((r) => {
          healthzStatus = r.status;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ done: false }));
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ done: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockEnv.listen(0, '127.0.0.1', resolve));
  const envAddr = mockEnv.address();
  if (!envAddr || typeof envAddr === 'string') throw new Error('expected TCP address');

  let child: ReturnType<typeof spawn> | undefined;
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child?.kill('SIGKILL');
        reject(new Error('main.ts lifecycle test timed out'));
      }, 10_000);
      child = spawn(process.execPath, ['--experimental-strip-types', mainPath], {
        env: {
          ...process.env,
          MAKEFUN_ENV_URL: `http://127.0.0.1:${envAddr.port}`,
          MAKEFUN_SHOP_TOKEN: 'life-tok',
        },
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0);
    assert.ok(registeredPort > 0 && registeredPort !== 8080);
    assert.equal(healthzStatus, 200);
    assert.ok(donePolls >= 2);
  } finally {
    mockEnv.closeAllConnections?.();
    await new Promise<void>((resolve) => mockEnv.close(() => resolve()));
  }
});
