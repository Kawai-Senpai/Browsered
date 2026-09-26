/**
 * browserd as a library.
 *
 * MCP is one interface onto the daemon, not the daemon itself; everything here
 * is usable directly from a CLI, a REST layer or a test harness.
 */
export { BrowserInstance } from './browser/instance.js';
export { BrowserRegistry } from './browser/registry.js';
export { launchBrowser, killBrowserProcess, mediaArgs, type MediaOptions } from './browser/launcher.js';
export { TargetManager, type ManagedTarget } from './browser/target-manager.js';

export { CdpConnection, ROOT_SESSION } from './cdp/connection.js';
export { CdpSession } from './cdp/session.js';

export { loadConfig, DEFAULT_CONFIG, controlAllowsMutation, type DaemonConfig, type ControlMode } from './config.js';
export { createStores, type Stores } from './store/index.js';

export { createMcpServer, TOOLS } from './mcp/server.js';
export type { ToolDef } from './mcp/tools.js';
export type { OpsContext } from './ops/context.js';

export { paths, resolveChromium } from './util/paths.js';
export { AgentBrowserError, ControlDeniedError, NotFoundError, describeError } from './util/errors.js';
