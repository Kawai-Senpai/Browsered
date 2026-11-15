/**
 * Human-shaped gestures: page.drag, page.long_press, page.pinch, page.pointer.
 *
 * Every assertion is on what the page's own listeners recorded, not on what
 * the tool said it sent: a slider value, pointer events with buttons and
 * pressure, a real HTML5 drop with its dataTransfer, hold times measured by
 * the page, touch points.
 *
 *   node tests/gesture-check.mjs [--headed]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADED = process.argv.includes('--headed');

const results = [];
let currentArea = '(none)';
const area = (name) => {
  currentArea = name;
  process.stdout.write(`\n\x1b[1m-- ${name} ${'-'.repeat(Math.max(0, 56 - name.length))}\x1b[0m\n`);
};

async function check(label, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ area: currentArea, label, ok: true });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label} \x1b[90m(${Date.now() - started}ms)${detail ? ` ${detail}` : ''}\x1b[0m\n`);
  } catch (err) {
    results.push({ area: currentArea, label, ok: false, error: err.message });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n         ${err.message}\n`);
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

const home = mkdtempSync(join(tmpdir(), 'browserd-gesture-'));

const FIXTURE = `<!doctype html><title>gesture fixture</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  .box { position: absolute; width: 80px; height: 80px; background: #ccd; }
  #range { position: absolute; left: 40px; top: 30px; width: 300px; margin: 0; }
  #pad { position: absolute; left: 40px; top: 80px; width: 400px; height: 120px; background: #eef; touch-action: none; }
  #src { left: 40px; top: 230px; background: #9c9; }
  #dst { left: 300px; top: 230px; background: #c99; }
  #hold { left: 40px; top: 340px; background: #99c; }
  #zoom { position: absolute; left: 500px; top: 80px; width: 300px; height: 300px; background: #eee; touch-action: none; }
</style>
<input id="range" type="range" min="0" max="100" value="0">
<div id="pad"></div>
<div id="src" class="box" draggable="true">drag me</div>
<div id="dst" class="box">drop here</div>
<div id="hold" class="box">hold</div>
<div id="zoom"></div>
<p id="status" style="position:absolute;top:440px;left:40px"></p>
<script>
  window.log = { pad: [], hold: [], touch: [], zoom: { max: 0, first: null, last: null, moves: 0 }, dropped: null, dragstart: 0 };
  const pad = document.getElementById('pad');
  for (const t of ['pointerdown', 'pointermove', 'pointerup']) {
    pad.addEventListener(t, (e) => log.pad.push({ t, x: e.clientX, y: e.clientY, buttons: e.buttons, pressure: e.pressure, type: e.pointerType }));
  }
  for (const t of ['touchstart', 'touchmove', 'touchend']) {
    pad.addEventListener(t, (e) => { const p = e.changedTouches[0]; log.touch.push({ t, x: p.clientX, y: p.clientY }); }, { passive: true });
  }
  const src = document.getElementById('src');
  const dst = document.getElementById('dst');
  src.addEventListener('dragstart', (e) => { log.dragstart++; e.dataTransfer.setData('text/plain', 'payload-42'); });
  dst.addEventListener('dragover', (e) => e.preventDefault());
  dst.addEventListener('drop', (e) => { e.preventDefault(); log.dropped = e.dataTransfer.getData('text/plain'); });
  const hold = document.getElementById('hold');
  hold.addEventListener('pointerdown', () => {
    log.hold.push({ t: 'down', at: performance.now() });
    setTimeout(() => { document.getElementById('status').textContent = 'Verified human'; }, 500);
  });
  hold.addEventListener('pointerup', () => log.hold.push({ t: 'up', at: performance.now() }));
  hold.addEventListener('pointermove', () => log.hold.push({ t: 'move', at: performance.now() }));
  const zoom = document.getElementById('zoom');
  const spread = (e) => e.touches.length < 2 ? null : Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  zoom.addEventListener('touchstart', (e) => { log.zoom.max = Math.max(log.zoom.max, e.touches.length); const d = spread(e); if (d && log.zoom.first === null) log.zoom.first = d; }, { passive: true });
  zoom.addEventListener('touchmove', (e) => { log.zoom.moves++; const d = spread(e); if (d) log.zoom.last = d; }, { passive: true });
</script>`;

async function startFixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
    env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_LOG_LEVEL: 'warn', AGENTBROWSER_HEADLESS: HEADED ? '0' : '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'browserd-gesture-test', version: '1.0.0' });
  await client.connect(transport);
  let browserId = null;
  const call = async (name, args = {}) => {
    const scoped = browserId && name !== 'browser.launch' && args.browser_id === undefined ? { ...args, browser_id: browserId } : args;
    const res = await client.callTool({ name, arguments: scoped });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    if (res.isError) {
      const err = new Error(`${name}: ${payload.message ?? text}`);
      err.payload = payload;
      throw err;
    }
    return payload;
  };
  return { call, use: (id) => (browserId = id), close: () => client.close() };
}

async function live(fixture) {
  const mcp = await connect();
  const read = async (expr) => (await mcp.call('js.evaluate', { expression: expr })).value;
  const reset = () => mcp.call('js.evaluate', { expression: "log.pad = []; log.hold = []; log.touch = []; document.getElementById('status').textContent = ''; 0" });
  try {
    area('setup');
    const launched = await mcp.call('browser.launch', { headless: !HEADED, profile: 'gesture-check' });
    mcp.use(launched.browser_id);
    await mcp.call('device.viewport', { width: 1000, height: 700 });
    await mcp.call('page.navigate', { url: fixture.url });

    area('page.drag');
    await check('slides a native range input by an offset', async () => {
      const res = await mcp.call('page.drag', { selector: '#range', by_x: 100, seed: 1 });
      const value = Number(await read("document.getElementById('range').value"));
      must(value >= 75 && value <= 90, `range value ${value}, expected ~83 (pressed mid-track at 50, dragged +100px of 300)`);
      must(res.timing.steps > 5, `only ${res.timing.steps} intermediate moves`);
      return `value=${value} steps=${res.timing.steps} seed=${res.seed}`;
    });

    await check('pointer events carry buttons=1 and pressure while held, and speed varies along the path', async () => {
      await reset();
      await mcp.call('page.drag', { selector: '#pad', by_x: 150, by_y: 20, seed: 3 });
      const events = await read('log.pad');
      const moves = events.filter((e) => e.t === 'pointermove' && e.buttons === 1);
      must(events.some((e) => e.t === 'pointerdown') && events.some((e) => e.t === 'pointerup'), 'missing pointerdown/up');
      must(moves.length >= 6, `only ${moves.length} held moves`);
      must(moves.every((m) => m.pressure > 0), 'a held move reported pressure 0');
      const steps = moves.slice(1).map((m, i) => Math.hypot(m.x - moves[i].x, m.y - moves[i].y)).filter((d) => d > 0);
      must(Math.max(...steps) > 2.5 * Math.min(...steps), 'step sizes are uniform; expected slow-fast-slow');
      return `${moves.length} moves, step ${Math.min(...steps).toFixed(1)}..${Math.max(...steps).toFixed(1)}px`;
    });

    await check('human:false moves in a straight, even line', async () => {
      await reset();
      await mcp.call('page.drag', { selector: '#pad', by_x: 120, human: false, steps: 6, duration_ms: 120 });
      const moves = (await read('log.pad')).filter((e) => e.t === 'pointermove' && e.buttons === 1);
      const ys = new Set(moves.map((m) => Math.round(m.y)));
      must(ys.size === 1, `y wandered: ${[...ys].join(',')}`);
      return `${moves.length} moves on one row`;
    });

    await check('a native HTML5 draggable is dropped with its dataTransfer intact', async () => {
      const res = await mcp.call('page.drag', { selector: '#src', to_selector: '#dst' });
      const log = await read('({ dropped: log.dropped, dragstart: log.dragstart })');
      must(log.dragstart >= 1, 'dragstart never fired');
      must(log.dropped === 'payload-42', `drop received ${JSON.stringify(log.dropped)}`);
      must(res.html5_drag === true, 'tool did not report html5_drag');
      return 'drop got payload-42';
    });

    await check('a touch swipe sends touchstart, several touchmoves and touchend', async () => {
      await reset();
      const res = await mcp.call('page.drag', { selector: '#pad', direction: 'left', distance: 150, input: 'touch' });
      const touch = await read('log.touch');
      const moves = touch.filter((e) => e.t === 'touchmove');
      must(touch[0]?.t === 'touchstart' && touch.at(-1)?.t === 'touchend', `sequence ${touch.map((e) => e.t).join(',')}`);
      must(moves.length >= 3, `only ${moves.length} touchmoves`);
      must(moves.at(-1).x < touch[0].x - 100, 'finger did not travel left');
      must(res.input === 'touch', `input=${res.input}`);
      // A flick is released while moving: no settle pause, short travel.
      must(res.timing.settle_ms < 20 && res.timing.travel_ms < 600, `settle ${res.timing.settle_ms}ms, travel ${res.timing.travel_ms}ms`);
      return `${moves.length} touchmoves in ${res.timing.travel_ms}ms`;
    });

    area('page.long_press');
    await check('holds for duration_ms, measured by the page', async () => {
      await reset();
      const res = await mcp.call('page.long_press', { selector: '#hold', duration_ms: 900 });
      const log = await read('log.hold');
      const down = log.find((e) => e.t === 'down');
      const up = log.find((e) => e.t === 'up');
      must(down && up, 'missing pointerdown/pointerup');
      const held = up.at - down.at;
      must(held >= 850 && held < 1600, `page measured ${Math.round(held)}ms`);
      return `page saw ${Math.round(held)}ms (tool ${res.held_ms}ms)`;
    });

    await check('until_text releases as soon as the text appears', async () => {
      await reset();
      const res = await mcp.call('page.long_press', { selector: '#hold', until_text: 'Verified human', duration_ms: 8000 });
      must(res.until_met === true, 'until_met is not true');
      must(res.held_ms >= 450 && res.held_ms < 1500, `held ${res.held_ms}ms; the text appears 500ms after the press`);
      return `released after ${res.held_ms}ms`;
    });

    area('page.pointer');
    await check('a press started in one call is released in a later one', async () => {
      await reset();
      const first = await mcp.call('page.pointer', { actions: [{ action: 'move', selector: '#pad' }, { action: 'down' }, { action: 'move', x: 300, y: 150 }] });
      must(first.held?.button === 'left', 'first call did not report the button held');
      const mid = await read('log.pad');
      must(!mid.some((e) => e.t === 'pointerup'), 'released too early');
      await mcp.call('page.pointer', { actions: [{ action: 'move', x: 380, y: 170 }, { action: 'up' }] });
      const log = await read('log.pad');
      const up = log.find((e) => e.t === 'pointerup');
      must(up && Math.abs(up.x - 380) < 1.5, `pointerup at ${up?.x}`);
      return `${log.filter((e) => e.t === 'pointermove').length} moves across two calls`;
    });

    await check('a failed step reports how far it got', async () => {
      try {
        await mcp.call('page.pointer', { actions: [{ action: 'move', x: 100, y: 100 }, { action: 'up' }] });
      } catch (err) {
        must(/Step 1/.test(err.message), err.message);
        return 'refused with step index';
      }
      throw new Error('releasing with nothing held should fail');
    });

    area('page.pinch');
    await check('two fingers spread to twice their distance', async () => {
      await mcp.call('device.viewport', { width: 1000, height: 700, touch: true });
      const res = await mcp.call('page.pinch', { selector: '#zoom', scale: 2, start_distance: 100 });
      const z = await read('log.zoom');
      must(z.max === 2, `max simultaneous touches ${z.max}`);
      must(z.moves >= 5, `only ${z.moves} touchmoves`);
      must(z.first && z.last && Math.abs(z.last / z.first - 2) < 0.1, `spread ${z.first} -> ${z.last}`);
      return `spread ${Math.round(z.first)} -> ${Math.round(z.last)} (seed ${res.seed})`;
    });

    await mcp.call('browser.close').catch(() => {});
  } finally {
    await mcp.close();
  }
}

let fixture;
try {
  fixture = await startFixture();
  await live(fixture);
} catch (err) {
  process.stdout.write(`\n\x1b[31mfatal: ${err.stack ?? err.message}\x1b[0m\n`);
  results.push({ area: 'fatal', label: String(err.message), ok: false });
} finally {
  await fixture?.close().catch(() => {});
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows sometimes holds the profile open a moment longer. */
  }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m\n`);
for (const f of failed) process.stdout.write(`  \x1b[31m${f.area} / ${f.label}\x1b[0m\n`);
process.exit(failed.length ? 1 : 0);
