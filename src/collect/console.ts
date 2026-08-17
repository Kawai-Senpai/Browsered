import type { ManagedTarget } from '../browser/target-manager.js';
import type {
  ConsoleApiCalledEvent,
  ExceptionThrownEvent,
  LogEntryAddedEvent,
} from '../cdp/types.js';
import type { RecorderConfig } from '../config.js';
import type { Stores } from '../store/index.js';
import type { Logger } from '../util/logger.js';
import { flattenStack, renderConsoleArgs, renderRemoteObject, summarizeArgs } from '../util/remote-object.js';

/** Map console API call types onto a stable level vocabulary. */
const LEVEL_BY_TYPE: Record<string, string> = {
  log: 'info',
  debug: 'debug',
  info: 'info',
  error: 'error',
  warning: 'warning',
  dir: 'info',
  dirxml: 'info',
  table: 'info',
  trace: 'debug',
  clear: 'info',
  startGroup: 'info',
  startGroupCollapsed: 'info',
  endGroup: 'info',
  assert: 'error',
  profile: 'debug',
  profileEnd: 'debug',
  count: 'info',
  timeEnd: 'info',
};

/**
 * Console output and uncaught exceptions from every target, retained across
 * navigation. Runtime gives console API calls and thrown exceptions; Log adds
 * browser-generated entries (CSP violations, deprecations, network errors)
 * that never touch a `console.*` call.
 */
export class ConsoleCollector {
  constructor(
    private readonly browserId: string,
    private readonly stores: Stores,
    private readonly config: RecorderConfig,
    private readonly log: Logger,
  ) {}

  async attach(target: ManagedTarget): Promise<void> {
    if (!this.config.captureConsole) return;
    const { session } = target;

    // Handlers first: Runtime.enable replays existing contexts and Log.enable
    // replays buffered entries immediately, so subscribing afterwards loses
    // everything the page logged before instrumentation finished.
    session.on('Runtime.consoleAPICalled', (params) =>
      this.onConsoleApi(target, params as unknown as ConsoleApiCalledEvent),
    );
    session.on('Runtime.exceptionThrown', (params) =>
      this.onExceptionThrown(target, params as unknown as ExceptionThrownEvent),
    );
    session.on('Log.entryAdded', (params) =>
      this.onLogEntry(target, params as unknown as LogEntryAddedEvent),
    );

    const runtimeOk = await session.trySend('Runtime.enable');
    if (!runtimeOk) {
      this.log.debug(`Runtime.enable unsupported on ${target.type} ${target.handle}`);
    }
    // Log is unavailable on some worker types; failure is not fatal.
    await session.trySend('Log.enable');
  }

  private onConsoleApi(target: ManagedTarget, event: ConsoleApiCalledEvent): void {
    const stack = flattenStack(event.stackTrace);
    const top = stack[0];
    this.stores.console.addEntry({
      browserId: this.browserId,
      targetHandle: target.handle,
      source: 'console-api',
      level: LEVEL_BY_TYPE[event.type] ?? 'info',
      text: renderConsoleArgs(event.args),
      args: summarizeArgs(event.args),
      url: top?.url ?? null,
      lineNumber: top?.line ?? null,
      columnNumber: top?.column ?? null,
      stack: stack.length ? stack : null,
      // CDP timestamps here are epoch milliseconds as a float.
      ts: Math.round(event.timestamp) || Date.now(),
    });
  }

  private onExceptionThrown(target: ManagedTarget, event: ExceptionThrownEvent): void {
    const details = event.exceptionDetails;
    const stack = flattenStack(details.stackTrace);
    this.stores.console.addException({
      browserId: this.browserId,
      targetHandle: target.handle,
      text: details.text || renderRemoteObject(details.exception) || 'Uncaught exception',
      description: details.exception ? renderRemoteObject(details.exception) : null,
      url: details.url ?? stack[0]?.url ?? null,
      lineNumber: details.lineNumber + 1,
      columnNumber: details.columnNumber + 1,
      stack: stack.length ? stack : null,
      ts: Math.round(event.timestamp) || Date.now(),
    });
    // Mirror into the console stream so one query shows everything a developer
    // would see in the DevTools console.
    this.stores.console.addEntry({
      browserId: this.browserId,
      targetHandle: target.handle,
      source: 'exception',
      level: 'error',
      text: details.text || renderRemoteObject(details.exception),
      args: details.exception ? summarizeArgs([details.exception]) : [],
      url: details.url ?? null,
      lineNumber: details.lineNumber + 1,
      columnNumber: details.columnNumber + 1,
      stack: stack.length ? stack : null,
      ts: Math.round(event.timestamp) || Date.now(),
    });
  }

  private onLogEntry(target: ManagedTarget, event: LogEntryAddedEvent): void {
    const entry = event.entry;
    const stack = flattenStack(entry.stackTrace);
    this.stores.console.addEntry({
      browserId: this.browserId,
      targetHandle: target.handle,
      source: entry.source,
      level: entry.level === 'warning' ? 'warning' : entry.level,
      text: entry.text,
      args: summarizeArgs(entry.args),
      url: entry.url ?? null,
      lineNumber: entry.lineNumber === undefined ? null : entry.lineNumber + 1,
      columnNumber: null,
      stack: stack.length ? stack : null,
      networkRequest: entry.networkRequestId ?? null,
      ts: Math.round(entry.timestamp) || Date.now(),
    });
  }
}
