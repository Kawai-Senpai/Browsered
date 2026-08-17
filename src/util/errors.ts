/**
 * Errors that are meaningful to a caller across the MCP/CLI boundary. Anything
 * else is a genuine bug and propagates as-is.
 */
export class AgentBrowserError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AgentBrowserError';
    this.code = code;
    if (details) this.details = details;
  }
}

export class NotFoundError extends AgentBrowserError {
  constructor(what: string, id: string) {
    super('not_found', `${what} not found: ${id}`, { what, id });
    this.name = 'NotFoundError';
  }
}

export class ControlDeniedError extends AgentBrowserError {
  constructor(mode: string, operation: string) {
    super(
      'control_denied',
      `Operation "${operation}" is blocked: browser control mode is "${mode}". ` +
        `Switch it with browser.set_control_mode (agent or shared) to allow mutating operations.`,
      { mode, operation },
    );
    this.name = 'ControlDeniedError';
  }
}

export class CdpError extends AgentBrowserError {
  constructor(method: string, message: string, cdpCode?: number) {
    super('cdp_error', `${method}: ${message}`, { method, cdpCode });
    this.name = 'CdpError';
  }
}

export class TimeoutError extends AgentBrowserError {
  constructor(operation: string, ms: number) {
    super('timeout', `${operation} timed out after ${ms}ms`, { operation, ms });
    this.name = 'TimeoutError';
  }
}

export function describeError(err: unknown): { code: string; message: string; details?: unknown } {
  if (err instanceof AgentBrowserError) {
    const out: { code: string; message: string; details?: unknown } = {
      code: err.code,
      message: err.message,
    };
    if (err.details) out.details = err.details;
    return out;
  }
  if (err instanceof Error) return { code: 'error', message: err.message };
  return { code: 'error', message: String(err) };
}
