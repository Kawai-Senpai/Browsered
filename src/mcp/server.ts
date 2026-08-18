import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpsContext } from '../ops/context.js';
import { describeError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { TOOLS } from './tools.js';

const log = createLogger('mcp');

/** Content block shapes the MCP SDK accepts back from a tool. */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Screenshots return their bytes under `image`; hand them to the client as a
 * real image block so a vision model actually sees the page, and drop the
 * base64 from the JSON so it is not also spent as text.
 */
function renderResult(payload: Record<string, unknown>): ToolResult {
  const content: ContentBlock[] = [];

  const image = payload._image as { data?: string; mime?: string } | undefined;
  if (image?.data) {
    content.push({ type: 'image', data: image.data, mimeType: image.mime ?? 'image/png' });
    payload = { ...payload };
    delete payload._image;
  }

  content.push({ type: 'text', text: JSON.stringify(payload, null, 2) });
  return { content };
}

function renderError(err: unknown): ToolResult {
  const described = describeError(err);
  return {
    content: [{ type: 'text', text: JSON.stringify(described, null, 2) }],
    isError: true,
  };
}

export function createMcpServer(ctx: OpsContext): McpServer {
  const server = new McpServer(
    { name: 'browserd', version: '0.1.0' },
    {
      instructions:
        'A continuously-recording Chromium with programmable DevTools.\n\n' +
        'Network, console, exceptions and navigations are recorded the whole time, ' +
        'whether or not you asked for them, so queries about the past always work. ' +
        'A browser is launched automatically the first time a tool needs one.\n\n' +
        'Investigating a page: work query-first. dom.summary before dom.get_html, ' +
        'network.summarize before network.list_requests, js.search_source before ' +
        'js.get_source. Large payloads are stored as artifacts and read with ' +
        'artifact.search / artifact.read_lines / artifact.json_query rather than being ' +
        'pulled into context whole. Narrow console.query with fields and stack; the ' +
        'defaults still carry more than most questions need.\n\n' +
        'Driving a flow: page.snapshot to see what is on screen and get refs, then ' +
        'page.click(ref) -> page.wait_for -> page.expect. Prefer refs over text ' +
        'locators: text can resolve to a span inside the button. When an action has ' +
        'more than one outcome, race them with page.wait_for(any_of: [...]) instead of ' +
        'guessing one and eating a full timeout. page.expect asserts and reports the ' +
        'state it saw; page.observe samples over time when the question is "how long ' +
        'was it stuck".\n\n' +
        'Two traps worth knowing. js.evaluate runs in the page, so a dynamic import() ' +
        'can return a module cached from an earlier load and silently report stale ' +
        'values - pass bypass_module_cache:true. And page.reload fires pagehide ' +
        'handlers, so an app that persists state there is not reloaded into the same ' +
        'state; page.navigate to the same URL does not. That makes reload-based loops ' +
        'non-idempotent.\n\n' +
        'Mutating tools respect the control mode (browser.set_control_mode): under ' +
        '"observe" or "paused" they refuse, so a human can take the browser back.',
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          title: tool.name,
          readOnlyHint: tool.readOnly === true,
          openWorldHint: true,
        },
      },
      // The SDK validates against the schema, so args arrive already parsed.
      (async (args: Record<string, unknown>) => {
        const started = Date.now();
        try {
          const payload = await tool.handler(ctx, args ?? {});
          log.debug(`${tool.name} ok in ${Date.now() - started}ms`);
          return renderResult(payload);
        } catch (err) {
          log.warn(`${tool.name} failed in ${Date.now() - started}ms`, err);
          return renderError(err);
        }
      }) as never,
    );
  }

  log.info(`registered ${TOOLS.length} tools`);
  return server;
}

export { TOOLS };
