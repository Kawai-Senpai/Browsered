import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

let threshold = ORDER.info;
let logFile: string | null = null;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level] ?? ORDER.info;
}

export function setLogFile(file: string | null): void {
  logFile = file;
  if (file) mkdirSync(dirname(file), { recursive: true });
}

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    let rendered: string;
    if (extra instanceof Error) rendered = extra.stack ?? extra.message;
    else {
      try {
        rendered = JSON.stringify(extra);
      } catch {
        rendered = String(extra);
      }
    }
    line += ` ${rendered}`;
  }
  // Never stdout: that channel belongs to the MCP stdio transport.
  process.stderr.write(line + '\n');
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      /* logging must never take the daemon down */
    }
  }
}

export interface Logger {
  trace(msg: string, extra?: unknown): void;
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(sub: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    trace: (m, e) => emit('trace', scope, m, e),
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
