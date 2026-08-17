/**
 * A focused JSONPath subset, enough to interrogate a large API response
 * without shipping it into a model's context.
 *
 * Supported:
 *   $.a.b.c          child access
 *   $['a b']         quoted child
 *   $.a[0]  $.a[-1]  index (negative counts from the end)
 *   $.a[1:5]         slice
 *   $.a[*]  $.*      wildcard
 *   $..key           recursive descent
 *   $.a[?(@.x == 'y')]   filter: == != > >= < <= =~ , plus bare @.x for existence
 *
 * Deliberately not supported: script expressions, unions, parent refs. Those
 * belong in `artifact.search` or a real query language, not here.
 */

export interface JsonMatch {
  path: string;
  value: unknown;
}

type Segment =
  | { kind: 'child'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'slice'; start: number | null; end: number | null }
  | { kind: 'wildcard' }
  | { kind: 'descend'; name: string | null }
  | { kind: 'filter'; expr: FilterExpr };

interface FilterExpr {
  left: string[];
  op: '==' | '!=' | '>' | '>=' | '<' | '<=' | '=~' | 'exists';
  right?: unknown;
}

export class JsonPathError extends Error {}

function parseFilter(raw: string): FilterExpr {
  const body = raw.trim();
  const match = /^@((?:\.[A-Za-z_$][\w$]*|\['[^']*'\]|\["[^"]*"\])*)\s*(==|!=|>=|<=|>|<|=~)?\s*(.*)$/.exec(
    body,
  );
  if (!match) throw new JsonPathError(`Unsupported filter expression: ${raw}`);
  const [, pathPart, op, rightRaw] = match;
  const left = (pathPart ?? '')
    .split(/\.|\[|\]/)
    .map((s) => s.replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
  if (!op) return { left, op: 'exists' };

  let right: unknown = (rightRaw ?? '').trim();
  const text = right as string;
  if (/^'.*'$/.test(text) || /^".*"$/.test(text)) right = text.slice(1, -1);
  else if (text === 'true') right = true;
  else if (text === 'false') right = false;
  else if (text === 'null') right = null;
  else if (text !== '' && !Number.isNaN(Number(text))) right = Number(text);

  return { left, op: op as FilterExpr['op'], right };
}

function tokenize(path: string): Segment[] {
  let rest = path.trim();
  if (rest.startsWith('$')) rest = rest.slice(1);
  const segments: Segment[] = [];

  while (rest.length > 0) {
    if (rest.startsWith('..')) {
      rest = rest.slice(2);
      const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(rest);
      if (nameMatch?.[1]) {
        segments.push({ kind: 'descend', name: nameMatch[1] });
        rest = rest.slice(nameMatch[1].length);
      } else {
        segments.push({ kind: 'descend', name: null });
      }
      continue;
    }
    if (rest.startsWith('.')) {
      rest = rest.slice(1);
      if (rest.startsWith('*')) {
        segments.push({ kind: 'wildcard' });
        rest = rest.slice(1);
        continue;
      }
      const nameMatch = /^([A-Za-z_$][\w$-]*)/.exec(rest);
      if (!nameMatch?.[1]) throw new JsonPathError(`Expected a property name at "${rest}"`);
      segments.push({ kind: 'child', name: nameMatch[1] });
      rest = rest.slice(nameMatch[1].length);
      continue;
    }
    if (rest.startsWith('[')) {
      const end = findClosingBracket(rest);
      const inner = rest.slice(1, end).trim();
      rest = rest.slice(end + 1);

      if (inner === '*') {
        segments.push({ kind: 'wildcard' });
      } else if (inner.startsWith('?')) {
        const exprMatch = /^\?\((.*)\)$/.exec(inner);
        if (!exprMatch?.[1]) throw new JsonPathError(`Malformed filter: ${inner}`);
        segments.push({ kind: 'filter', expr: parseFilter(exprMatch[1]) });
      } else if (/^'.*'$|^".*"$/.test(inner)) {
        segments.push({ kind: 'child', name: inner.slice(1, -1) });
      } else if (inner.includes(':')) {
        const [s, e] = inner.split(':');
        segments.push({
          kind: 'slice',
          start: s && s.trim() ? Number(s) : null,
          end: e && e.trim() ? Number(e) : null,
        });
      } else {
        const index = Number(inner);
        if (Number.isNaN(index)) throw new JsonPathError(`Bad index: ${inner}`);
        segments.push({ kind: 'index', index });
      }
      continue;
    }
    throw new JsonPathError(`Unexpected character at "${rest}"`);
  }
  return segments;
}

function findClosingBracket(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new JsonPathError('Unbalanced [ in path');
}

function readPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function matchesFilter(value: unknown, expr: FilterExpr): boolean {
  const actual = expr.left.length === 0 ? value : readPath(value, expr.left);
  switch (expr.op) {
    case 'exists':
      return actual !== undefined;
    case '==':
      return actual === expr.right;
    case '!=':
      return actual !== expr.right;
    case '>':
      return typeof actual === 'number' && typeof expr.right === 'number' && actual > expr.right;
    case '>=':
      return typeof actual === 'number' && typeof expr.right === 'number' && actual >= expr.right;
    case '<':
      return typeof actual === 'number' && typeof expr.right === 'number' && actual < expr.right;
    case '<=':
      return typeof actual === 'number' && typeof expr.right === 'number' && actual <= expr.right;
    case '=~':
      if (typeof actual !== 'string' || typeof expr.right !== 'string') return false;
      try {
        return new RegExp(expr.right).test(actual);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}['${key}']`;
}

function collectDescendants(node: JsonMatch, name: string | null, out: JsonMatch[]): void {
  const { value, path } = node;
  if (name === null) out.push(node);
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectDescendants({ path: joinPath(path, i), value: item }, name, out));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = joinPath(path, key);
    if (name !== null && key === name) out.push({ path: childPath, value: child });
    collectDescendants({ path: childPath, value: child }, name, out);
  }
}

export function jsonPath(root: unknown, path: string, limit = 200): JsonMatch[] {
  const segments = tokenize(path);
  let current: JsonMatch[] = [{ path: '$', value: root }];

  for (const segment of segments) {
    const next: JsonMatch[] = [];
    for (const node of current) {
      const { value, path: nodePath } = node;
      switch (segment.kind) {
        case 'child': {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const child = (value as Record<string, unknown>)[segment.name];
            if (child !== undefined) next.push({ path: joinPath(nodePath, segment.name), value: child });
          } else if (Array.isArray(value)) {
            // Reading a property off an array maps over its elements, which is
            // what people expect from `$.items.name`-style paths.
            value.forEach((item, i) => {
              if (item && typeof item === 'object') {
                const child = (item as Record<string, unknown>)[segment.name];
                if (child !== undefined) {
                  next.push({ path: joinPath(joinPath(nodePath, i), segment.name), value: child });
                }
              }
            });
          }
          break;
        }
        case 'index': {
          if (!Array.isArray(value)) break;
          const idx = segment.index < 0 ? value.length + segment.index : segment.index;
          if (idx >= 0 && idx < value.length) {
            next.push({ path: joinPath(nodePath, idx), value: value[idx] });
          }
          break;
        }
        case 'slice': {
          if (!Array.isArray(value)) break;
          const start = segment.start ?? 0;
          const end = segment.end ?? value.length;
          value.slice(start, end).forEach((item, offset) => {
            next.push({ path: joinPath(nodePath, (start < 0 ? value.length + start : start) + offset), value: item });
          });
          break;
        }
        case 'wildcard': {
          if (Array.isArray(value)) {
            value.forEach((item, i) => next.push({ path: joinPath(nodePath, i), value: item }));
          } else if (value && typeof value === 'object') {
            for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
              next.push({ path: joinPath(nodePath, key), value: child });
            }
          }
          break;
        }
        case 'descend': {
          collectDescendants(node, segment.name, next);
          break;
        }
        case 'filter': {
          const items = Array.isArray(value)
            ? value.map((item, i) => ({ path: joinPath(nodePath, i), value: item }))
            : value && typeof value === 'object'
              ? Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
                  path: joinPath(nodePath, k),
                  value: v,
                }))
              : [];
          for (const item of items) {
            if (matchesFilter(item.value, segment.expr)) next.push(item);
          }
          break;
        }
      }
    }
    current = next;
    if (current.length > limit * 10) current = current.slice(0, limit * 10);
  }
  return current.slice(0, limit);
}
