# gitcore-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/youthmy11-ai/gitcore-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/youthmy11-ai/gitcore-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A deterministic, high-throughput, GitHub-compatible git forge implemented in pure TypeScript for Node 22+ with zero external runtime dependencies and no `git` binary dependency.

## Architecture

All protocol surfaces share a single deterministic in-memory state (`ForgeStore`) so repositories, git refs, commits, trees, blobs, issues, labels, comments, pull requests, diffs, and merges remain synchronized across every endpoint:

- **`main.ts`**: Environment lifecycle runner implementing the `MAKEFUN_ENV_URL` contract—binds an ephemeral port (`listen(0)`), configures HTTP keep-alive (`keepAliveTimeout`, `headersTimeout`, `requestTimeout = 0`) and `socket.setNoDelay(true)`, registers via `POST /register`, polls `GET /done` with bounded backoff, and shuts down cleanly on completion.
- **`app.ts`**: Node `http.Server` entrypoint (`createApp`) providing bearer-token enforcement (`MAKEFUN_SHOP_TOKEN`), fast path dispatching, and `/healthz` readiness checks.
- **`store.ts`**: Unified deterministic state engine (`ForgeStore`) without `Math.random()` or wall-clock `Date.now()` side effects (anchored to `MAKEFUN_TRIAL_NOW` when set), pre-serialized issue response buffers, 3-way merge conflict detection, squash merging, and automatic pack/advertisement cache invalidation on ref updates.
- **`git-objects.ts`**: Pure `node:crypto` + `node:zlib` object serialization/hashing (`blob`, `tree`, `commit`, `tag`), tree flattening/rebuilding, and line-level diffs.
- **`git.ts`**: Git Smart HTTP (`/<owner>/<repo>.git/...`) supporting `git-upload-pack` protocol v2 (`ls-refs`, `fetch` with `shallow`, `deepen`, `want`, `have`, `done`) and v0 fallback (`side-band-64k`), `git-receive-pack` with `report-status`, per-ref fast-forward validation, and packfile parsing/writing with `OFS_DELTA` / `REF_DELTA` resolution and cached pack responses.
- **`rest.ts`**: GitHub REST v3 (`/api/v3/...`) covering repositories, branches, refs, commits, contents CRUD with SHA conflict detection (`409`), labels, issues, comments, and pull requests/files/merges with Link pagination and fast paths for hot issue read/write routes.
- **`graphql.ts`**: GitHub GraphQL v4 (`/api/graphql`) implementing a recursive-descent parser, schema validation, full `__schema`/`__type` introspection, Relay `node(id:)` lookups, aliases, fragments, cursor pagination, and mutations.
- **`mcp.ts`**: Streamable HTTP JSON-RPC 2.0 endpoint (`/mcp`) supporting protocol discovery (`server/discover`), `initialize` with `Mcp-Session-Id`, `tools/list`, and concurrent `tools/call` execution (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Running

Start the server against a harness environment:

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=your-token node --experimental-strip-types main.ts
```

Run the unit test suite:

```sh
node --experimental-strip-types --test forge.test.ts
```

Check TypeScript types (when `tsc` is available in your toolchain):

```sh
tsc --noEmit
```

## License

MIT — see [LICENSE](./LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=dd535zhy&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
