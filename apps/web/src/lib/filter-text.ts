import {
  type Dimension,
  DimensionSchema,
  type FilterLeaf,
  type FilterNode,
  type FilterOp,
} from '@featherstat/shared';

/**
 * The filter grammar as text (docs/05 § The filter editor), both ways:
 *
 *   country != "SG" and (path contains "/blog" or path starts "/docs")
 *   not (segment "Paying" or session path = "/pricing")
 *
 * A second way to say what the visual editor says — never a second vocabulary.
 * Dimensions and operators come from the zod enums, so a new dimension in
 * `packages/shared` is typeable here the day it lands and `OP_TEXT` fails to
 * compile until a new operator is given words.
 *
 * `parseFilterText(print(nodes))` is `nodes` for every tree, which is what lets
 * the editor toggle between visual and text without a lossy round-trip. The
 * printer therefore always quotes values and only parenthesizes where
 * precedence needs it — one spelling out, many spellings in.
 */

/** How each op is written. Exhaustive: a new op must be given words here. */
const OP_TEXT: Record<FilterOp, string> = {
  eq: '=',
  neq: '!=',
  contains: 'contains',
  starts: 'starts',
  glob: 'glob',
  in: 'in',
  is_null: 'is empty',
};

/** Words that cannot be a bare value — quote them to mean them literally. */
const RESERVED = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'empty',
  'contains',
  'starts',
  'with',
  'glob',
  'session',
  'segment',
]);

export interface TextError {
  message: string;
  /** Where in the source the reader should look. */
  index: number;
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

/** The whole filter list (an implicit AND) as one line of text. */
export function printFilterText(
  nodes: readonly FilterNode[],
  segmentNames?: ReadonlyMap<number, string>,
): string {
  return nodes.map((node) => printNode(node, segmentNames, 'and')).join(' and ');
}

/** `within` is the operator this node is being joined by — parens only when it
 * would otherwise re-associate: `or` inside `and`, or anything under `not`. */
function printNode(
  node: FilterNode,
  names: ReadonlyMap<number, string> | undefined,
  within: 'and' | 'or' | 'not',
): string {
  if ('segment' in node) {
    const name = names?.get(node.segment);
    return name === undefined ? `segment ${node.segment}` : `segment ${quote(name)}`;
  }
  if ('not' in node) {
    const inner = printNode(node.not, names, 'not');
    return `not ${inner}`;
  }
  if ('all' in node || 'any' in node) {
    const parts = 'all' in node ? node.all : node.any;
    const join = 'all' in node ? 'and' : 'or';
    const body = parts.map((child) => printNode(child, names, join)).join(` ${join} `);
    if (parts.length < 2) return body;
    // `and` inside `and` needs no parens; everything else does.
    return within === join && join === 'and' ? body : `(${body})`;
  }
  return printLeaf(node);
}

function printLeaf(leaf: FilterLeaf): string {
  const head = leaf.scope === 'session' ? `session ${leaf.dim}` : leaf.dim;
  if (leaf.op === 'is_null') return `${head} is empty`;
  if (leaf.op === 'in') {
    const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value ?? ''];
    return `${head} in (${values.map(quote).join(', ')})`;
  }
  return `${head} ${OP_TEXT[leaf.op]} ${quote(String(leaf.value ?? ''))}`;
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// ---------------------------------------------------------------------------
// tokenizing
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'word'; text: string; index: number }
  | { kind: 'string'; text: string; index: number }
  | { kind: 'punct'; text: '(' | ')' | ','; index: number }
  | { kind: 'end'; text: ''; index: number };

const PUNCT = new Set(['(', ')', ',']);

function tokenize(source: string): Token[] | TextError {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (PUNCT.has(char)) {
      tokens.push({ kind: 'punct', text: char as '(' | ')' | ',', index: i });
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quoted = readString(source, i, char);
      if ('message' in quoted) return quoted;
      tokens.push({ kind: 'string', text: quoted.value, index: i });
      i = quoted.next;
      continue;
    }
    // `!=` is the one two-character operator; `=` the one single-character one.
    if (char === '!' && source[i + 1] === '=') {
      tokens.push({ kind: 'word', text: '!=', index: i });
      i += 2;
      continue;
    }
    if (char === '=') {
      tokens.push({ kind: 'word', text: '=', index: i });
      i += 1;
      continue;
    }
    const start = i;
    while (i < source.length) {
      const next = source[i] as string;
      if (/\s/.test(next) || PUNCT.has(next) || next === '"' || next === "'" || next === '=') break;
      i += 1;
    }
    tokens.push({ kind: 'word', text: source.slice(start, i), index: start });
  }
  tokens.push({ kind: 'end', text: '', index: source.length });
  return tokens;
}

function readString(
  source: string,
  start: number,
  quoteChar: string,
): { value: string; next: number } | TextError {
  let value = '';
  let i = start + 1;
  while (i < source.length) {
    const char = source[i] as string;
    if (char === '\\') {
      const escaped = source[i + 1];
      if (escaped === undefined) break;
      value += escaped;
      i += 2;
      continue;
    }
    if (char === quoteChar) return { value, next: i + 1 };
    value += char;
    i += 1;
  }
  return { message: 'unterminated quote', index: start };
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/** Text in, the filter list out (an implicit AND), or the first thing wrong. */
export function parseFilterText(
  source: string,
  segmentIds?: ReadonlyMap<string, number>,
): { nodes: FilterNode[] } | { error: TextError } {
  const tokens = tokenize(source);
  if ('message' in tokens) return { error: tokens };
  if (tokens.length === 1) return { nodes: [] }; // whitespace only is no filter
  const parser = new Parser(tokens, segmentIds);
  try {
    const node = parser.parseExpression();
    parser.expectEnd();
    // A top-level `and` is the implicit AND the request already means, so it
    // flattens into the list rather than nesting one level deeper than needed.
    return { nodes: 'all' in node ? node.all : [node] };
  } catch (failure) {
    if (failure instanceof ParseFailure)
      return { error: { message: failure.message, index: failure.index } };
    throw failure;
  }
}

class ParseFailure extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(message);
  }
}

class Parser {
  private at = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly segmentIds: ReadonlyMap<string, number> | undefined,
  ) {}

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'end') this.at += 1;
    return token;
  }

  /** Consumes the token when it is this keyword, case-insensitively. */
  private eatWord(word: string): boolean {
    const token = this.peek();
    if (token.kind === 'word' && token.text.toLowerCase() === word) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private fail(message: string, token: Token = this.peek()): never {
    throw new ParseFailure(message, token.index);
  }

  expectEnd(): void {
    const token = this.peek();
    if (token.kind !== 'end') {
      this.fail(`unexpected ${describe(token)} — expected 'and', 'or', or the end`, token);
    }
  }

  /** or binds loosest, then and, then not — the usual reading. */
  parseExpression(): FilterNode {
    const parts = [this.parseAnd()];
    while (this.eatWord('or')) parts.push(this.parseAnd());
    return parts.length === 1 ? (parts[0] as FilterNode) : { any: parts };
  }

  private parseAnd(): FilterNode {
    const parts = [this.parseUnary()];
    while (this.eatWord('and')) parts.push(this.parseUnary());
    return parts.length === 1 ? (parts[0] as FilterNode) : { all: parts };
  }

  private parseUnary(): FilterNode {
    if (this.eatWord('not')) return { not: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): FilterNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.text === '(') {
      this.next();
      const inner = this.parseExpression();
      const close = this.next();
      if (close.kind !== 'punct' || close.text !== ')') this.fail('expected a closing )', close);
      return inner;
    }
    if (token.kind === 'word' && token.text.toLowerCase() === 'segment') {
      this.next();
      return this.parseSegment();
    }
    return this.parseLeaf();
  }

  private parseSegment(): FilterNode {
    const token = this.next();
    if (token.kind === 'string') {
      const id = this.segmentIds?.get(token.text);
      if (id === undefined) this.fail(`no saved segment named ${token.text}`, token);
      return { segment: id };
    }
    if (token.kind === 'word' && /^[0-9]+$/.test(token.text)) {
      const id = Number(token.text);
      if (id > 0) return { segment: id };
    }
    return this.fail('expected a segment name in quotes, or its id', token);
  }

  private parseLeaf(): FilterNode {
    const scoped = this.eatWord('session');
    const dimToken = this.next();
    if (dimToken.kind !== 'word')
      this.fail(`expected a dimension, got ${describe(dimToken)}`, dimToken);
    const parsed = DimensionSchema.safeParse(dimToken.text);
    if (!parsed.success) {
      this.fail(`'${dimToken.text}' is not a dimension`, dimToken);
    }
    const dim = parsed.data as Dimension;
    const { op, value } = this.parseOperator();
    const leaf: FilterLeaf = op === 'is_null' ? { dim, op } : ({ dim, op, value } as FilterLeaf);
    return scoped ? { ...leaf, scope: 'session' } : leaf;
  }

  private parseOperator(): { op: FilterOp; value?: string | string[] } {
    const token = this.next();
    if (token.kind !== 'word') this.fail(`expected an operator, got ${describe(token)}`, token);
    const word = token.text.toLowerCase();
    if (word === '=') return { op: 'eq', value: this.parseValue() };
    if (word === '!=') return { op: 'neq', value: this.parseValue() };
    if (word === 'contains') return { op: 'contains', value: this.parseValue() };
    if (word === 'glob') return { op: 'glob', value: this.parseValue() };
    if (word === 'starts') {
      this.eatWord('with'); // "starts with" reads better and means the same
      return { op: 'starts', value: this.parseValue() };
    }
    if (word === 'in') return { op: 'in', value: this.parseValueList() };
    if (word === 'is') {
      if (this.eatWord('empty')) return { op: 'is_null' };
      if (this.eatWord('not')) {
        if (this.peek().kind === 'word' && this.peek().text.toLowerCase() === 'empty') {
          this.fail("there is no 'is not empty' — write not (… is empty)");
        }
        return { op: 'neq', value: this.parseValue() };
      }
      return { op: 'eq', value: this.parseValue() };
    }
    return this.fail(`'${token.text}' is not an operator`, token);
  }

  private parseValue(): string {
    const token = this.next();
    if (token.kind === 'string') return token.text;
    if (token.kind === 'word' && !RESERVED.has(token.text.toLowerCase())) return token.text;
    if (token.kind === 'word') {
      this.fail(`'${token.text}' is a keyword — put it in quotes to mean it literally`, token);
    }
    return this.fail(`expected a value, got ${describe(token)}`, token);
  }

  private parseValueList(): string[] {
    const open = this.next();
    if (open.kind !== 'punct' || open.text !== '(') this.fail("expected ( after 'in'", open);
    const values: string[] = [];
    if (this.peek().kind === 'punct' && this.peek().text === ')') {
      this.fail("'in' needs at least one value");
    }
    for (;;) {
      values.push(this.parseValue());
      const token = this.next();
      if (token.kind === 'punct' && token.text === ')') return values;
      if (token.kind !== 'punct' || token.text !== ',') this.fail('expected , or )', token);
    }
  }
}

function describe(token: Token): string {
  if (token.kind === 'end') return 'the end of the expression';
  if (token.kind === 'string') return `the value ${JSON.stringify(token.text)}`;
  return `'${token.text}'`;
}

// ---------------------------------------------------------------------------
// the vocabulary, for the reference the editor shows
// ---------------------------------------------------------------------------

/** Every operator as it is written here — generated from the same table. */
export const OPERATOR_REFERENCE: readonly string[] = [
  ...new Set(Object.values(OP_TEXT)),
  'starts with',
  'in (a, b)',
];
