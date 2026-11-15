import type { ServerResponse } from 'node:http';
import { sendJson } from './rest.ts';
import {
  type CommentRecord,
  type ForgeStore,
  type IssueRecord,
  type LabelRecord,
  type PullRecord,
  type RepoState,
  StoreError,
  VIEWER,
  decodeNodeId,
} from './store.ts';

type TokenKind = 'NAME' | 'INT' | 'FLOAT' | 'STRING' | 'PUNCT' | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source.charCodeAt(i);
    // whitespace or comma
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 44 || ch === 0xfeff) {
      i++;
      continue;
    }
    // comment
    if (ch === 35) {
      while (i < len && source.charCodeAt(i) !== 10 && source.charCodeAt(i) !== 13) i++;
      continue;
    }
    // punctuators
    if (
      ch === 33 || // !
      ch === 36 || // $
      ch === 38 || // &
      ch === 40 || // (
      ch === 41 || // )
      ch === 58 || // :
      ch === 61 || // =
      ch === 64 || // @
      ch === 91 || // [
      ch === 93 || // ]
      ch === 123 || // {
      ch === 124 || // |
      ch === 125 // }
    ) {
      tokens.push({ kind: 'PUNCT', value: source[i]! });
      i++;
      continue;
    }
    // spread ...
    if (ch === 46 && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'PUNCT', value: '...' });
      i += 3;
      continue;
    }
    // string or block string
    if (ch === 34) {
      if (source.slice(i, i + 3) === '"""') {
        i += 3;
        const start = i;
        while (i < len && source.slice(i, i + 3) !== '"""') {
          if (source[i] === '\\' && source.slice(i, i + 4) === '\\"""') {
            i += 4;
          } else {
            i++;
          }
        }
        if (i >= len) throw new Error('Syntax Error: Unterminated block string');
        const val = source.slice(start, i).replace(/\\"""/g, '"""');
        i += 3;
        tokens.push({ kind: 'STRING', value: val });
        continue;
      }
      i++;
      let out = '';
      while (i < len && source.charCodeAt(i) !== 34) {
        if (source[i] === '\\') {
          i++;
          const esc = source[i++];
          if (esc === 'n') out += '\n';
          else if (esc === 'r') out += '\r';
          else if (esc === 't') out += '\t';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            const hex = source.slice(i, i + 4);
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
          } else if (esc !== undefined) {
            out += esc;
          }
        } else {
          out += source[i++];
        }
      }
      if (i >= len) throw new Error('Syntax Error: Unterminated string');
      i++;
      tokens.push({ kind: 'STRING', value: out });
      continue;
    }
    // number
    if ((ch >= 48 && ch <= 57) || ch === 45) {
      const start = i;
      if (source[i] === '-') i++;
      while (i < len && source.charCodeAt(i) >= 48 && source.charCodeAt(i) <= 57) i++;
      let isFloat = false;
      if (source[i] === '.') {
        isFloat = true;
        i++;
        while (i < len && source.charCodeAt(i) >= 48 && source.charCodeAt(i) <= 57) i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        while (i < len && source.charCodeAt(i) >= 48 && source.charCodeAt(i) <= 57) i++;
      }
      tokens.push({ kind: isFloat ? 'FLOAT' : 'INT', value: source.slice(start, i) });
      continue;
    }
    // name
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95) {
      const start = i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) i++;
        else break;
      }
      tokens.push({ kind: 'NAME', value: source.slice(start, i) });
      continue;
    }
    throw new Error(`Syntax Error: Unexpected character ${JSON.stringify(source[i])}`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

type ValueAst =
  | { kind: 'Var'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueAst[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueAst }> };

interface DirectiveAst {
  name: string;
  args: Record<string, ValueAst>;
}

type SelectionAst =
  | {
      kind: 'Field';
      name: string;
      alias: string | null;
      args: Record<string, ValueAst>;
      directives: DirectiveAst[];
      selectionSet: SelectionAst[] | null;
    }
  | {
      kind: 'InlineFragment';
      typeCondition: string | null;
      directives: DirectiveAst[];
      selectionSet: SelectionAst[];
    }
  | {
      kind: 'FragmentSpread';
      name: string;
      directives: DirectiveAst[];
    };

interface VariableDefAst {
  name: string;
  defaultValue: ValueAst | null;
}

interface OperationAst {
  kind: 'Operation';
  opType: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDefAst[];
  selectionSet: SelectionAst[];
}

interface FragmentDefAst {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionAst[];
}

class GqlParser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private consume(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(kind: TokenKind, value?: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind || (value !== undefined && tok.value !== value)) {
      throw new Error(`Syntax Error: Expected ${value ?? kind}, found ${JSON.stringify(tok.value || tok.kind)}`);
    }
    this.pos++;
    return tok;
  }

  private skipPunct(value: string): boolean {
    if (this.peek().kind === 'PUNCT' && this.peek().value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: OperationAst[]; fragments: Map<string, FragmentDefAst> } {
    const operations: OperationAst[] = [];
    const fragments = new Map<string, FragmentDefAst>();
    while (this.peek().kind !== 'EOF') {
      const tok = this.peek();
      if (tok.kind === 'PUNCT' && tok.value === '{') {
        operations.push({
          kind: 'Operation',
          opType: 'query',
          name: null,
          variables: [],
          selectionSet: this.parseSelectionSet(),
        });
      } else if (tok.kind === 'NAME' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        const opType = this.consume().value as 'query' | 'mutation' | 'subscription';
        const name = this.peek().kind === 'NAME' ? this.consume().value : null;
        const variables = this.skipPunct('(') ? this.parseVariableDefs() : [];
        if (this.peek().kind === 'PUNCT' && this.peek().value === '@') this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        operations.push({ kind: 'Operation', opType, name, variables, selectionSet });
      } else if (tok.kind === 'NAME' && tok.value === 'fragment') {
        this.consume();
        const name = this.expect('NAME').value;
        this.expect('NAME', 'on');
        const typeCondition = this.expect('NAME').value;
        if (this.peek().kind === 'PUNCT' && this.peek().value === '@') this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        fragments.set(name, { kind: 'Fragment', name, typeCondition, selectionSet });
      } else {
        throw new Error(`Syntax Error: Unexpected token ${JSON.stringify(tok.value)}`);
      }
    }
    if (operations.length === 0) throw new Error('Syntax Error: Document contains no operations');
    return { operations, fragments };
  }

  private parseVariableDefs(): VariableDefAst[] {
    const defs: VariableDefAst[] = [];
    while (!this.skipPunct(')')) {
      this.expect('PUNCT', '$');
      const name = this.expect('NAME').value;
      this.expect('PUNCT', ':');
      this.parseTypeRef();
      const defaultValue = this.skipPunct('=') ? this.parseValue() : null;
      if (this.peek().kind === 'PUNCT' && this.peek().value === '@') this.parseDirectives();
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  private parseTypeRef(): void {
    if (this.skipPunct('[')) {
      this.parseTypeRef();
      this.expect('PUNCT', ']');
    } else {
      this.expect('NAME');
    }
    this.skipPunct('!');
  }

  private parseDirectives(): DirectiveAst[] {
    const list: DirectiveAst[] = [];
    while (this.skipPunct('@')) {
      const name = this.expect('NAME').value;
      const args = this.skipPunct('(') ? this.parseArgs() : {};
      list.push({ name, args });
    }
    return list;
  }

  private parseArgs(): Record<string, ValueAst> {
    const args: Record<string, ValueAst> = {};
    while (!this.skipPunct(')')) {
      const name = this.expect('NAME').value;
      this.expect('PUNCT', ':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseValue(): ValueAst {
    const tok = this.peek();
    if (tok.kind === 'PUNCT') {
      if (tok.value === '$') {
        this.consume();
        return { kind: 'Var', name: this.expect('NAME').value };
      }
      if (tok.value === '[') {
        this.consume();
        const values: ValueAst[] = [];
        while (!this.skipPunct(']')) values.push(this.parseValue());
        return { kind: 'List', values };
      }
      if (tok.value === '{') {
        this.consume();
        const fields: Array<{ name: string; value: ValueAst }> = [];
        while (!this.skipPunct('}')) {
          const name = this.expect('NAME').value;
          this.expect('PUNCT', ':');
          fields.push({ name, value: this.parseValue() });
        }
        return { kind: 'Object', fields };
      }
    }
    this.consume();
    if (tok.kind === 'INT') return { kind: 'Int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'FLOAT') return { kind: 'Float', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'STRING') return { kind: 'String', value: tok.value };
    if (tok.kind === 'NAME') {
      if (tok.value === 'true') return { kind: 'Boolean', value: true };
      if (tok.value === 'false') return { kind: 'Boolean', value: false };
      if (tok.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: tok.value };
    }
    throw new Error(`Syntax Error: Invalid value ${JSON.stringify(tok.value)}`);
  }

  private parseSelectionSet(): SelectionAst[] {
    this.expect('PUNCT', '{');
    const items: SelectionAst[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'PUNCT' && this.peek().value === '...') {
        this.consume();
        if (this.peek().kind === 'NAME' && this.peek().value !== 'on') {
          const name = this.consume().value;
          const directives = this.parseDirectives();
          items.push({ kind: 'FragmentSpread', name, directives });
        } else {
          let typeCondition: string | null = null;
          if (this.peek().kind === 'NAME' && this.peek().value === 'on') {
            this.consume();
            typeCondition = this.expect('NAME').value;
          }
          const directives = this.parseDirectives();
          const selectionSet = this.parseSelectionSet();
          items.push({ kind: 'InlineFragment', typeCondition, directives, selectionSet });
        }
      } else {
        const first = this.expect('NAME').value;
        let alias: string | null = null;
        let name = first;
        if (this.skipPunct(':')) {
          alias = first;
          name = this.expect('NAME').value;
        }
        const args = this.skipPunct('(') ? this.parseArgs() : {};
        const directives = this.parseDirectives();
        const selectionSet = this.peek().kind === 'PUNCT' && this.peek().value === '{' ? this.parseSelectionSet() : null;
        items.push({ kind: 'Field', name, alias, args, directives, selectionSet });
      }
    }
    return items;
  }
}

interface SchemaTypeMeta {
  readonly kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  readonly fields?: readonly string[];
  readonly enumValues?: readonly string[];
}

const SCHEMA_TYPES: Readonly<Record<string, SchemaTypeMeta>> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', '__type', '__schema', '__typename'],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'login', 'name', 'email', '__typename'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'description',
      'isPrivate',
      'owner',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequest',
      'pullRequests',
      'labels',
      '__typename',
    ],
  },
  Ref: {
    kind: 'OBJECT',
    fields: ['name', 'prefix', 'target', '__typename'],
  },
  GitObject: {
    kind: 'OBJECT',
    fields: ['oid', '__typename'],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'number',
      'title',
      'body',
      'state',
      'createdAt',
      'updatedAt',
      'closedAt',
      'author',
      'labels',
      'comments',
      '__typename',
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: ['cursor', 'node', '__typename'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'number',
      'title',
      'body',
      'state',
      'merged',
      'mergeable',
      'mergeCommit',
      'mergedAt',
      'headRefName',
      'baseRefName',
      'headRefOid',
      'baseRefOid',
      'createdAt',
      'updatedAt',
      'author',
      'files',
      'comments',
      '__typename',
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: ['cursor', 'node', '__typename'],
  },
  PullRequestFile: {
    kind: 'OBJECT',
    fields: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  },
  PullRequestFileConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', '__typename'],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: ['cursor', 'node', '__typename'],
  },
  Label: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'color', 'description', '__typename'],
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  },
  Node: {
    kind: 'INTERFACE',
    fields: ['id', '__typename'],
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: ['issue', 'clientMutationId', '__typename'],
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: ['issue', 'clientMutationId', '__typename'],
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: ['pullRequest', 'clientMutationId', '__typename'],
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: ['pullRequest', 'clientMutationId', '__typename'],
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  },
  IssueState: {
    kind: 'ENUM',
    enumValues: ['OPEN', 'CLOSED'],
  },
  PullRequestState: {
    kind: 'ENUM',
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  MergeableState: {
    kind: 'ENUM',
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
  __Schema: {
    kind: 'OBJECT',
    fields: ['types', 'queryType', 'mutationType', '__typename'],
  },
  __Type: {
    kind: 'OBJECT',
    fields: ['name', 'kind', 'description', 'fields', 'enumValues', '__typename'],
  },
  __Field: {
    kind: 'OBJECT',
    fields: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  },
};

const FIELD_RETURN_TYPE: Readonly<Record<string, string>> = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Query.node': 'Node',
  'Query.__type': '__Type',
  'Query.__schema': '__Schema',
  'Mutation.createIssue': 'CreateIssuePayload',
  'Mutation.closeIssue': 'CloseIssuePayload',
  'Mutation.createPullRequest': 'CreatePullRequestPayload',
  'Mutation.mergePullRequest': 'MergePullRequestPayload',
  'Mutation.addComment': 'AddCommentPayload',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequest': 'PullRequest',
  'Repository.pullRequests': 'PullRequestConnection',
  'Repository.labels': 'LabelConnection',
  'Ref.target': 'GitObject',
  'Issue.author': 'User',
  'Issue.labels': 'LabelConnection',
  'Issue.comments': 'IssueCommentConnection',
  'IssueConnection.nodes': 'Issue',
  'IssueConnection.edges': 'IssueEdge',
  'IssueConnection.pageInfo': 'PageInfo',
  'IssueEdge.node': 'Issue',
  'PullRequest.author': 'User',
  'PullRequest.files': 'PullRequestFileConnection',
  'PullRequest.comments': 'IssueCommentConnection',
  'PullRequest.mergeCommit': 'GitObject',
  'PullRequestConnection.nodes': 'PullRequest',
  'PullRequestConnection.edges': 'PullRequestEdge',
  'PullRequestConnection.pageInfo': 'PageInfo',
  'PullRequestEdge.node': 'PullRequest',
  'PullRequestFileConnection.nodes': 'PullRequestFile',
  'PullRequestFileConnection.pageInfo': 'PageInfo',
  'IssueComment.author': 'User',
  'IssueCommentConnection.nodes': 'IssueComment',
  'IssueCommentConnection.edges': 'IssueCommentEdge',
  'IssueCommentConnection.pageInfo': 'PageInfo',
  'IssueCommentEdge.node': 'IssueComment',
  'LabelConnection.nodes': 'Label',
  'LabelConnection.pageInfo': 'PageInfo',
  'CreateIssuePayload.issue': 'Issue',
  'CloseIssuePayload.issue': 'Issue',
  'CreatePullRequestPayload.pullRequest': 'PullRequest',
  'MergePullRequestPayload.pullRequest': 'PullRequest',
  'AddCommentPayload.commentEdge': 'IssueCommentEdge',
  'AddCommentPayload.subject': 'Node',
  '__Schema.types': '__Type',
  '__Schema.queryType': '__Type',
  '__Schema.mutationType': '__Type',
  '__Type.fields': '__Field',
  '__Type.enumValues': '__EnumValue',
};

function evalValue(ast: ValueAst, vars: Readonly<Record<string, unknown>>): unknown {
  switch (ast.kind) {
    case 'Var':
      return vars[ast.name];
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
    case 'Enum':
      return ast.value;
    case 'Null':
      return null;
    case 'List':
      return ast.values.map((v) => evalValue(v, vars));
    case 'Object': {
      const obj: Record<string, unknown> = {};
      for (const f of ast.fields) obj[f.name] = evalValue(f.value, vars);
      return obj;
    }
  }
}

function evalArgs(rawArgs: Readonly<Record<string, ValueAst>>, vars: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs)) out[k] = evalValue(v, vars);
  return out;
}

function shouldInclude(directives: readonly DirectiveAst[], vars: Readonly<Record<string, unknown>>): boolean {
  for (const dir of directives) {
    const cond = dir.args.if ? evalValue(dir.args.if, vars) : true;
    if (dir.name === 'skip' && Boolean(cond)) return false;
    if (dir.name === 'include' && !Boolean(cond)) return false;
  }
  return true;
}

function validateSelectionSet(
  typeName: string,
  selections: readonly SelectionAst[],
  fragments: ReadonlyMap<string, FragmentDefAst>,
  errors: Array<{ message: string }>,
  visitedFrags: Set<string>,
): void {
  const meta = SCHEMA_TYPES[typeName];
  if (!meta || !meta.fields) return;
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (!meta.fields.includes(sel.name)) {
        errors.push({ message: `Field '${sel.name}' doesn't exist on type '${typeName}'` });
        continue;
      }
      if (sel.selectionSet) {
        const nextType = FIELD_RETURN_TYPE[`${typeName}.${sel.name}`];
        if (nextType) {
          validateSelectionSet(nextType, sel.selectionSet, fragments, errors, visitedFrags);
        }
      }
    } else if (sel.kind === 'InlineFragment') {
      const cond = sel.typeCondition ?? typeName;
      validateSelectionSet(cond, sel.selectionSet, fragments, errors, visitedFrags);
    } else if (sel.kind === 'FragmentSpread') {
      if (visitedFrags.has(sel.name)) continue;
      const frag = fragments.get(sel.name);
      if (!frag) {
        errors.push({ message: `Unknown fragment '${sel.name}'` });
        continue;
      }
      visitedFrags.add(sel.name);
      validateSelectionSet(frag.typeCondition, frag.selectionSet, fragments, errors, visitedFrags);
      visitedFrags.delete(sel.name);
    }
  }
}

function encodeCursor(index: number): string {
  return Buffer.from(`cur:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    if (!raw.startsWith('cur:')) return -1;
    const idx = Number.parseInt(raw.slice(4), 10);
    return Number.isInteger(idx) && idx >= 0 ? idx : -1;
  } catch {
    return -1;
  }
}

function paginateConnection<T>(
  items: readonly T[],
  args: Record<string, unknown>,
): {
  slice: readonly T[];
  edges: Array<{ cursor: string; node: T }>;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
} {
  const afterIdx = decodeCursor(args.after);
  let start = afterIdx >= 0 ? afterIdx + 1 : 0;
  let end = items.length;
  if (typeof args.first === 'number' && args.first >= 0) {
    end = Math.min(end, start + args.first);
  } else if (typeof args.last === 'number' && args.last >= 0) {
    start = Math.max(start, end - args.last);
  }
  const slice = items.slice(start, end);
  const edges = slice.map((node, i) => ({
    cursor: encodeCursor(start + i),
    node,
  }));
  return {
    slice,
    edges,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
    totalCount: items.length,
  };
}

function makeViewerObject(): Record<string, unknown> {
  return {
    __typename: 'User',
    id: 'VXNlcjoxMDAw',
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function makeCommentObject(c: CommentRecord): Record<string, unknown> {
  return {
    __typename: 'IssueComment',
    id: c.nodeId,
    databaseId: c.id,
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    author: {
      __typename: 'User',
      id: 'VXNlcjoxMDAw',
      databaseId: c.userId,
      login: c.userLogin,
    },
  };
}

function makeLabelObject(l: LabelRecord): Record<string, unknown> {
  return {
    __typename: 'Label',
    id: l.nodeId,
    databaseId: l.id,
    name: l.name,
    color: l.color,
    description: l.description,
  };
}

function makeIssueObject(repo: RepoState, issue: IssueRecord): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issue.nodeId,
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    author: {
      __typename: 'User',
      id: 'VXNlcjoxMDAw',
      databaseId: issue.userId,
      login: issue.userLogin,
    },
    labels: (args: Record<string, unknown>) => {
      const conn = paginateConnection(
        issue.labels.map(makeLabelObject),
        args,
      );
      return {
        __typename: 'LabelConnection',
        nodes: conn.slice,
        edges: conn.edges,
        pageInfo: { __typename: 'PageInfo', ...conn.pageInfo },
        totalCount: conn.totalCount,
      };
    },
    comments: (args: Record<string, unknown>) => {
      const conn = paginateConnection(
        issue.comments.map(makeCommentObject),
        args,
      );
      return {
        __typename: 'IssueCommentConnection',
        nodes: conn.slice,
        edges: conn.edges,
        pageInfo: { __typename: 'PageInfo', ...conn.pageInfo },
        totalCount: conn.totalCount,
      };
    },
  };
}

function makePullObject(store: ForgeStore, repo: RepoState, pr: PullRecord): Record<string, unknown> {
  const { headSha, baseSha } = store.getPullLiveShas(repo, pr);
  const state = pr.merged ? 'MERGED' : pr.state.toUpperCase();
  const mergeable = pr.state === 'open' ? (store.isPullMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
  return {
    __typename: 'PullRequest',
    id: pr.nodeId,
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state,
    merged: pr.merged,
    mergeable,
    mergeCommit: pr.mergeCommitSha ? { __typename: 'GitObject', oid: pr.mergeCommitSha } : null,
    mergedAt: pr.mergedAt,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    headRefOid: headSha,
    baseRefOid: baseSha,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    author: {
      __typename: 'User',
      id: 'VXNlcjoxMDAw',
      databaseId: pr.userId,
      login: pr.userLogin,
    },
    files: (args: Record<string, unknown>) => {
      const files = store.getPullFiles(repo, pr).map((f) => ({
        __typename: 'PullRequestFile',
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status.toUpperCase(),
      }));
      const conn = paginateConnection(files, args);
      return {
        __typename: 'PullRequestFileConnection',
        nodes: conn.slice,
        edges: conn.edges,
        pageInfo: { __typename: 'PageInfo', ...conn.pageInfo },
        totalCount: conn.totalCount,
      };
    },
    comments: (args: Record<string, unknown>) => {
      const conn = paginateConnection(
        pr.comments.map(makeCommentObject),
        args,
      );
      return {
        __typename: 'IssueCommentConnection',
        nodes: conn.slice,
        edges: conn.edges,
        pageInfo: { __typename: 'PageInfo', ...conn.pageInfo },
        totalCount: conn.totalCount,
      };
    },
  };
}

function makeRepoObject(store: ForgeStore, repo: RepoState): Record<string, unknown> {
  const defOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    owner: {
      __typename: 'User',
      id: 'VXNlcjoxMDAw',
      databaseId: VIEWER.id,
      login: repo.owner,
    },
    defaultBranchRef: {
      __typename: 'Ref',
      name: repo.defaultBranch,
      prefix: 'refs/heads/',
      target: defOid ? { __typename: 'GitObject', oid: defOid } : null,
    },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issue: (args: Record<string, unknown>) => {
      const num = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.get(num);
      return issue ? makeIssueObject(repo, issue) : null;
    },
    issues: (args: Record<string, unknown>) => {
      let list = [...repo.issueList];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      if (args.orderBy && typeof args.orderBy === 'object') {
        const ord = args.orderBy as Record<string, unknown>;
        const field = String(ord.field ?? 'CREATED_AT');
        const desc = String(ord.direction ?? 'ASC').toUpperCase() === 'DESC';
        const mult = desc ? -1 : 1;
        list.sort((a, b) => {
          if (field === 'COMMENTS' && a.comments.length !== b.comments.length) {
            return (a.comments.length - b.comments.length) * mult;
          }
          if (field === 'UPDATED_AT' && a.updatedAt !== b.updatedAt) {
            return (a.updatedAt < b.updatedAt ? -1 : 1) * mult;
          }
          if (a.seq !== b.seq) return (a.seq - b.seq) * mult;
          return (a.number - b.number) * mult;
        });
      } else {
        list.sort((a, b) => a.seq - b.seq);
      }
      const conn = paginateConnection(
        list.map((i) => makeIssueObject(repo, i)),
        args,
      );
      return {
        __typename: 'IssueConnection',
        nodes: conn.slice,
        edges: conn.edges,
        pageInfo: { __typename: 'PageInfo', ...conn.pageInfo },
        totalCount: conn.totalCount,
      };
    },
    pullRequest: (args: Record<string, unknown>) => {
      const num = typeof args.number === 'number' ? args.number : -1;
      const pr = repo.pulls.get(num);
      return pr ? makePullObject(store, repo, pr) : null;
    },
    pullRequests: (args: Record<string, unknown>) => {
      let list = [...repo.pullList];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
        list = list.filter((p) => {
          const st = p.merged ? 'MERGED' : p.state.toUpperCase();
          return wanted.has(st);
        });
      }
      list.sort((a, b) => b.number - a.number);
      const conn = paginateConnection(
        list.map((p) => makePullObject(store, repo, p)),
        args,
      );
      return {
        __typename: 'PullRequestConnection',
        nodes: conn.slice,
        edges: conn.edges,
        pageInfo: { __typename: 'PageInfo', ...conn.pageInfo },
        totalCount: conn.totalCount,
      };
    },
    labels: (args: Record<string, unknown>) => {
      const conn = paginateConnection([...repo.labels.values()].map(makeLabelObject), args);
      return {
        __typename: 'LabelConnection',
        nodes: conn.slice,
        edges: conn.edges,
        pageInfo: { __typename: 'PageInfo', ...conn.pageInfo },
        totalCount: conn.totalCount,
      };
    },
  };
}

function makeIntrospectionType(name: string): Record<string, unknown> | null {
  const meta = SCHEMA_TYPES[name];
  if (!meta) return null;
  return {
    __typename: '__Type',
    name,
    kind: meta.kind,
    description: null,
    fields: () =>
      meta.fields
        ? meta.fields
            .filter((f) => !f.startsWith('__'))
            .map((fname) => ({
              __typename: '__Field',
              name: fname,
              description: null,
              isDeprecated: false,
              deprecationReason: null,
            }))
        : null,
    enumValues: () =>
      meta.enumValues
        ? meta.enumValues.map((ename) => ({
            __typename: '__EnumValue',
            name: ename,
            description: null,
            isDeprecated: false,
            deprecationReason: null,
          }))
        : null,
  };
}

function collectFields(
  typeName: string,
  selections: readonly SelectionAst[],
  fragments: ReadonlyMap<string, FragmentDefAst>,
  vars: Readonly<Record<string, unknown>>,
): Array<{ responseKey: string; name: string; args: Record<string, unknown>; selectionSet: SelectionAst[] | null }> {
  const out: Array<{ responseKey: string; name: string; args: Record<string, unknown>; selectionSet: SelectionAst[] | null }> = [];
  for (const sel of selections) {
    if (!shouldInclude(sel.directives, vars)) continue;
    if (sel.kind === 'Field') {
      out.push({
        responseKey: sel.alias ?? sel.name,
        name: sel.name,
        args: evalArgs(sel.args, vars),
        selectionSet: sel.selectionSet,
      });
    } else if (sel.kind === 'InlineFragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        out.push(...collectFields(typeName, sel.selectionSet, fragments, vars));
      }
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments.get(sel.name);
      if (frag && frag.typeCondition === typeName) {
        out.push(...collectFields(typeName, frag.selectionSet, fragments, vars));
      }
    }
  }
  return out;
}

function resolveValue(
  value: unknown,
  selections: readonly SelectionAst[] | null,
  fragments: ReadonlyMap<string, FragmentDefAst>,
  vars: Readonly<Record<string, unknown>>,
  errors: Array<{ message: string }>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, selections, fragments, vars, errors));
  }
  if (typeof value !== 'object') return value;
  if (!selections) return value;

  const rec = value as Record<string, unknown>;
  const typeName = typeof rec.__typename === 'string' ? rec.__typename : 'Unknown';
  const fields = collectFields(typeName, selections, fragments, vars);
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.name === '__typename') {
      result[field.responseKey] = typeName;
      continue;
    }
    const rawProp = rec[field.name];
    let resolvedProp: unknown;
    try {
      resolvedProp = typeof rawProp === 'function' ? (rawProp as (a: Record<string, unknown>) => unknown)(field.args) : rawProp;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      resolvedProp = null;
    }
    result[field.responseKey] = resolveValue(resolvedProp, field.selectionSet, fragments, vars, errors);
  }
  return result;
}

function executeSingle(store: ForgeStore, reqObj: Record<string, unknown>): Record<string, unknown> {
  const queryText = typeof reqObj.query === 'string' ? reqObj.query : '';
  if (!queryText.trim()) {
    return { errors: [{ message: 'Must provide query string.' }] };
  }

  let parsed: { operations: OperationAst[]; fragments: Map<string, FragmentDefAst> };
  try {
    parsed = new GqlParser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }

  const opName = typeof reqObj.operationName === 'string' ? reqObj.operationName : null;
  let op: OperationAst | undefined;
  if (opName) {
    op = parsed.operations.find((o) => o.name === opName);
    if (!op) {
      return { errors: [{ message: `Unknown operation named ${JSON.stringify(opName)}.` }] };
    }
  } else if (parsed.operations.length === 1) {
    op = parsed.operations[0]!;
  } else {
    return { errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }

  const rawVars = reqObj.variables && typeof reqObj.variables === 'object' && !Array.isArray(reqObj.variables)
    ? (reqObj.variables as Record<string, unknown>)
    : {};
  const vars: Record<string, unknown> = {};
  for (const vdef of op.variables) {
    if (rawVars[vdef.name] !== undefined) vars[vdef.name] = rawVars[vdef.name];
    else if (vdef.defaultValue !== null) vars[vdef.name] = evalValue(vdef.defaultValue, vars);
  }
  for (const [k, v] of Object.entries(rawVars)) {
    if (!(k in vars)) vars[k] = v;
  }

  const rootTypeName = op.opType === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: Array<{ message: string }> = [];
  validateSelectionSet(rootTypeName, op.selectionSet, parsed.fragments, validationErrors, new Set());
  if (validationErrors.length > 0) {
    return { errors: validationErrors };
  }

  const errors: Array<{ message: string }> = [];

  const rootResolver: Record<string, unknown> =
    op.opType === 'mutation'
      ? {
          __typename: 'Mutation',
          createIssue: (args: Record<string, unknown>) => {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const dec = decodeNodeId(String(input.repositoryId ?? ''));
            const repo = dec?.kind === 'Repo' ? store.reposById.get(dec.repoId) : undefined;
            if (!repo) throw new StoreError(404, 'Repository not found');
            const issue = store.createIssue(repo, {
              title: String(input.title ?? ''),
              body: typeof input.body === 'string' ? input.body : '',
            });
            return {
              __typename: 'CreateIssuePayload',
              clientMutationId: input.clientMutationId ?? null,
              issue: makeIssueObject(repo, issue),
            };
          },
          closeIssue: (args: Record<string, unknown>) => {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const dec = decodeNodeId(String(input.issueId ?? ''));
            const repo = dec?.kind === 'Issue' ? store.reposById.get(dec.repoId) : undefined;
            if (!repo || dec?.kind !== 'Issue') throw new StoreError(404, 'Issue not found');
            const issue = store.updateIssue(repo, dec.number, { state: 'closed' });
            return {
              __typename: 'CloseIssuePayload',
              clientMutationId: input.clientMutationId ?? null,
              issue: makeIssueObject(repo, issue),
            };
          },
          createPullRequest: (args: Record<string, unknown>) => {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const dec = decodeNodeId(String(input.repositoryId ?? ''));
            const repo = dec?.kind === 'Repo' ? store.reposById.get(dec.repoId) : undefined;
            if (!repo) throw new StoreError(404, 'Repository not found');
            const pr = store.createPull(repo, {
              head: String(input.headRefName ?? ''),
              base: String(input.baseRefName ?? ''),
              title: String(input.title ?? ''),
              body: typeof input.body === 'string' ? input.body : '',
            });
            return {
              __typename: 'CreatePullRequestPayload',
              clientMutationId: input.clientMutationId ?? null,
              pullRequest: makePullObject(store, repo, pr),
            };
          },
          mergePullRequest: (args: Record<string, unknown>) => {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const dec = decodeNodeId(String(input.pullRequestId ?? ''));
            const repo = dec?.kind === 'PR' ? store.reposById.get(dec.repoId) : undefined;
            if (!repo || dec?.kind !== 'PR') throw new StoreError(404, 'Pull request not found');
            const result = store.mergePull(repo, dec.number, {
              mergeMethod: typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH',
            });
            return {
              __typename: 'MergePullRequestPayload',
              clientMutationId: input.clientMutationId ?? null,
              pullRequest: makePullObject(store, repo, result.pr),
            };
          },
          addComment: (args: Record<string, unknown>) => {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const dec = decodeNodeId(String(input.subjectId ?? ''));
            if (!dec || (dec.kind !== 'Issue' && dec.kind !== 'PR')) {
              throw new StoreError(404, 'Subject not found');
            }
            const repo = store.reposById.get(dec.repoId);
            if (!repo) throw new StoreError(404, 'Repository not found');
            const comment = store.addComment(repo, dec.number, String(input.body ?? ''));
            const subject =
              dec.kind === 'Issue'
                ? makeIssueObject(repo, repo.issues.get(dec.number)!)
                : makePullObject(store, repo, repo.pulls.get(dec.number)!);
            return {
              __typename: 'AddCommentPayload',
              clientMutationId: input.clientMutationId ?? null,
              commentEdge: {
                __typename: 'IssueCommentEdge',
                cursor: encodeCursor(comment.id),
                node: makeCommentObject(comment),
              },
              subject,
            };
          },
        }
      : {
          __typename: 'Query',
          viewer: () => makeViewerObject(),
          repository: (args: Record<string, unknown>) => {
            const owner = typeof args.owner === 'string' ? args.owner : '';
            const name = typeof args.name === 'string' ? args.name : '';
            const repo = store.findRepo(owner, name);
            return repo ? makeRepoObject(store, repo) : null;
          },
          node: (args: Record<string, unknown>) => {
            const dec = decodeNodeId(String(args.id ?? ''));
            if (!dec) return null;
            const repo = store.reposById.get(dec.repoId);
            if (!repo) return null;
            if (dec.kind === 'Repo') return makeRepoObject(store, repo);
            if (dec.kind === 'Issue') {
              const issue = repo.issues.get(dec.number);
              return issue ? makeIssueObject(repo, issue) : null;
            }
            if (dec.kind === 'PR') {
              const pr = repo.pulls.get(dec.number);
              return pr ? makePullObject(store, repo, pr) : null;
            }
            return null;
          },
          __type: (args: Record<string, unknown>) => makeIntrospectionType(String(args.name ?? '')),
          __schema: () => ({
            __typename: '__Schema',
            types: Object.keys(SCHEMA_TYPES).map((n) => makeIntrospectionType(n)!),
            queryType: makeIntrospectionType('Query'),
            mutationType: makeIntrospectionType('Mutation'),
          }),
        };

  const data = resolveValue(rootResolver, op.selectionSet, parsed.fragments, vars, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

export function handleGraphqlRequest(
  store: ForgeStore,
  res: ServerResponse,
  body: Buffer,
  requestId: string,
): void {
  let parsed: unknown;
  try {
    parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
    return;
  }

  if (Array.isArray(parsed)) {
    const out = parsed.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? executeSingle(store, item as Record<string, unknown>)
        : { errors: [{ message: 'Invalid operation entry in batch' }] },
    );
    sendJson(res, 200, out, requestId);
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
    return;
  }

  const out = executeSingle(store, parsed as Record<string, unknown>);
  sendJson(res, 200, out, requestId);
}
