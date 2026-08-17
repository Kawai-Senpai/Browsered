import type { RemoteObject, StackTrace } from '../cdp/types.js';

/**
 * Render a CDP RemoteObject the way DevTools' console would, without a live
 * round-trip. Objects arrive with a `preview` when Runtime is enabled; when
 * they do not, the class name is still more useful than "[object Object]".
 */
export function renderRemoteObject(obj: RemoteObject | undefined): string {
  if (!obj) return 'undefined';
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'string') return String(obj.value ?? obj.description ?? '');
  if (obj.type === 'number' || obj.type === 'boolean' || obj.type === 'bigint') {
    return String(obj.value ?? obj.unserializableValue ?? obj.description ?? '');
  }
  if (obj.subtype === 'null') return 'null';
  if (obj.type === 'symbol' || obj.type === 'function') {
    return obj.description ?? obj.type;
  }
  if (obj.subtype === 'error') return obj.description ?? 'Error';
  if (obj.value !== undefined) {
    try {
      return JSON.stringify(obj.value);
    } catch {
      return String(obj.value);
    }
  }
  const preview = obj.preview as
    | { properties?: Array<{ name: string; value?: string; type: string }>; overflow?: boolean; subtype?: string }
    | undefined;
  if (preview?.properties) {
    const parts = preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`);
    if (preview.overflow) parts.push('…');
    const body = parts.join(', ');
    return preview.subtype === 'array' ? `[${body}]` : `{${body}}`;
  }
  return obj.description ?? obj.className ?? obj.type;
}

export function renderConsoleArgs(args: RemoteObject[] | undefined): string {
  if (!args?.length) return '';
  return args.map(renderRemoteObject).join(' ');
}

/** Structured form kept alongside the text so agents can filter on shape. */
export function summarizeArgs(args: RemoteObject[] | undefined): unknown[] {
  if (!args?.length) return [];
  return args.map((arg) => ({
    type: arg.type,
    subtype: arg.subtype,
    value: arg.value,
    description: arg.description ?? undefined,
    className: arg.className ?? undefined,
    rendered: renderRemoteObject(arg),
  }));
}

export interface FlatFrame {
  function: string;
  url: string;
  line: number;
  column: number;
}

export function flattenStack(stack: StackTrace | undefined, depth = 0): FlatFrame[] {
  if (!stack || depth > 4) return [];
  const frames: FlatFrame[] = stack.callFrames.map((f) => ({
    function: f.functionName || '(anonymous)',
    url: f.url,
    line: f.lineNumber + 1,
    column: f.columnNumber + 1,
  }));
  if (stack.parent) frames.push(...flattenStack(stack.parent, depth + 1));
  return frames;
}
