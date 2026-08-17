import { existsSync, readFileSync } from 'node:fs';
import type { LogLevel } from './util/logger.js';
import { paths } from './util/paths.js';

export type ControlMode = 'observe' | 'shared' | 'agent' | 'paused';

export interface RecorderConfig {
  /** Fetch and persist response bodies as loads finish. */
  captureResponseBodies: boolean;
  /** Skip body capture above this size (bytes). Metadata is still recorded. */
  maxBodyBytes: number;
  /** MIME prefixes never worth storing (media blobs mostly). */
  skipBodyMimePrefixes: string[];
  /** Per-resource CDP network buffer, passed to Network.enable. */
  maxResourceBufferSize: number;
  /** Total CDP network buffer, passed to Network.enable. */
  maxTotalBufferSize: number;
  /** Record WebSocket frames. */
  captureWebSocketFrames: boolean;
  /** Truncate individual WS frames above this size. */
  maxWebSocketFrameBytes: number;
  /** Keep console entries across navigations. */
  captureConsole: boolean;
}

export interface DaemonConfig {
  /** Loopback only. Binding beyond 127.0.0.1 exposes full browser control. */
  host: string;
  /** Control + MCP HTTP port. 0 picks a free port. */
  port: number;
  logLevel: LogLevel;
  logFile: string | null;
  chromiumPath?: string;
  defaultControlMode: ControlMode;
  recorder: RecorderConfig;
  /** Origins accepted by the MCP HTTP transport (DNS-rebinding defense). */
  allowedOrigins: string[];
  /** Drop browsers that stop heartbeating for this long (externally registered only). */
  heartbeatTimeoutMs: number;
  /**
   * Spawn a browser on demand when a tool needs one and none is running, so an
   * agent never has to wait for a human to open a window.
   */
  autoLaunch: boolean;
  /** Profile used by an auto-launched browser. Persistent across runs. */
  autoLaunchProfile: string;
  /** Auto-launched browsers are headed by default: the point is a visible browser. */
  autoLaunchHeadless: boolean;
}

export const DEFAULT_CONFIG: DaemonConfig = {
  host: '127.0.0.1',
  port: 7331,
  logLevel: 'info',
  logFile: null,
  defaultControlMode: 'shared',
  recorder: {
    captureResponseBodies: true,
    maxBodyBytes: 8 * 1024 * 1024,
    skipBodyMimePrefixes: ['video/', 'audio/'],
    maxResourceBufferSize: 100 * 1024 * 1024,
    maxTotalBufferSize: 500 * 1024 * 1024,
    captureWebSocketFrames: true,
    maxWebSocketFrameBytes: 512 * 1024,
    captureConsole: true,
  },
  allowedOrigins: ['http://127.0.0.1', 'http://localhost'],
  heartbeatTimeoutMs: 60_000,
  autoLaunch: true,
  autoLaunchProfile: 'default',
  autoLaunchHeadless: false,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shallow merge, one level deep into `recorder`. */
export function mergeConfig(base: DaemonConfig, patch: unknown): DaemonConfig {
  if (!isRecord(patch)) return base;
  const { recorder, ...rest } = patch;
  const merged: DaemonConfig = { ...base, ...(rest as Partial<DaemonConfig>) };
  if (isRecord(recorder)) {
    merged.recorder = { ...base.recorder, ...(recorder as Partial<RecorderConfig>) };
  }
  return merged;
}

export function loadConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  let config = DEFAULT_CONFIG;
  const file = paths.config();
  if (existsSync(file)) {
    try {
      config = mergeConfig(config, JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      throw new Error(`Failed to parse ${file}: ${(err as Error).message}`);
    }
  }
  if (process.env.AGENTBROWSER_PORT) {
    config = { ...config, port: Number(process.env.AGENTBROWSER_PORT) };
  }
  if (process.env.AGENTBROWSER_LOG_LEVEL) {
    config = { ...config, logLevel: process.env.AGENTBROWSER_LOG_LEVEL as LogLevel };
  }
  // Lets CI and test harnesses run unattended without passing CLI flags through
  // an MCP client's `command`/`args`.
  if (process.env.AGENTBROWSER_HEADLESS) {
    config = { ...config, autoLaunchHeadless: process.env.AGENTBROWSER_HEADLESS !== '0' };
  }
  if (overrides) config = mergeConfig(config, overrides);
  return config;
}

/** Mutating operations are refused unless the human has handed over control. */
export function controlAllowsMutation(mode: ControlMode): boolean {
  return mode === 'agent' || mode === 'shared';
}
