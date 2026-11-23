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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const angle = (e) => Math.atan2(e.touches[1].clientY - e.touches[0].clientY, e.touches[1].clientX - e.touches[0].clientX) * 180 / Math.PI;
  zoom.addEventListener('touchstart', (e) => { log.zoom.max = Math.max(log.zoom.max, e.touches.length); const d = spread(e); if (d && log.zoom.first === null) log.zoom.first = d; }, { passive: true });
  zoom.addEventListener('touchmove', (e) => { log.zoom.moves++; const d = spread(e); if (d) { log.zoom.last = d; log.zoom.angle = angle(e); } }, { passive: true });
</script>`;

const MOBILE_FIXTURE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; min-height: 2200px; }
  canvas { display: block; width: 100%; height: 500px; background: #eef; }
  input { position: absolute; left: 260px; top: 60px; width: 24px; height: 24px; margin: 0; }
  #far { position: absolute; top: 1750px; }
</style>
<canvas width="320" height="500" aria-label="Gesture target"></canvas>
<input type="checkbox">
<div id="far">Offscreen drop target</div>
<script>
  const canvas = document.querySelector('canvas');
  window.trace = [];
  let started = 0;
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'touchstart']) {
    canvas.addEventListener(type, e => trace.push({
      type, target: e.target.tagName, input: e.pointerType, x: e.clientX, y: e.clientY, trusted: e.isTrusted,
    }));
  }
  canvas.addEventListener('touchstart', () => { started = performance.now(); }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    if (performance.now() - started >= 300 && e.cancelable) {
      e.preventDefault();
      trace.push({ type: 'drag', trusted: e.isTrusted });
    }
  }, { passive: false });
</script>`;

const LAYER_FIXTURE = `<!doctype html><meta charset="utf-8"><title>Project tasks</title>
<style>
body{margin:0;background:#142232;color:white;font:16px system-ui}
main{position:relative;z-index:1;margin:76px 38px 0;width:352px;padding:20px;background:#223957;border-radius:12px;box-sizing:border-box}
header{position:fixed;inset:0 0 auto;height:136px;z-index:10;background:#3e507d;padding:20px;box-sizing:border-box}
#menu{position:absolute;z-index:999;right:18px;top:27px;width:145px;height:100px;background:#13665a;padding:12px;will-change:transform}
</style>
<header id="header">Projects / April release</header>
<main id="board"><h1>Tasks</h1><button id="filter">Filter tasks</button>
<aside id="menu">To do<br>Doing<br>Done</aside></main>`;

async function startFixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/layers' ? LAYER_FIXTURE : req.url?.startsWith('/mobile?') ? MOBILE_FIXTURE : FIXTURE);
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
  let targetId = null;
  const call = async (name, args = {}) => {
    const scoped = browserId && name !== 'browser.launch' && args.browser_id === undefined ? { ...args, browser_id: browserId } : args;
    if (targetId && args.target_id === undefined && (name.startsWith('page.') || name === 'device.viewport' || name === 'js.evaluate')) {
      scoped.target_id = targetId;
    }
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
    const image = res.content.find((c) => c.type === 'image');
    if (image) payload.image_data = image.data;
    return payload;
  };
  return { call, use: (id) => (browserId = id), useTarget: (id) => (targetId = id), close: () => client.close() };
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
    await mcp.call('device.viewport', { width: 1000, height: 700, touch: true });
    await check('two fingers spread to twice their distance and rotate around viewport coordinates', async () => {
      const res = await mcp.call('page.pinch', { x: 650, y: 230, scale: 2, start_distance: 100, rotate_deg: 45 });
      const z = await read('log.zoom');
      must(z.max === 2, `max simultaneous touches ${z.max}`);
      must(z.moves >= 5, `only ${z.moves} touchmoves`);
      must(z.first && z.last && Math.abs(z.last / z.first - 2) < 0.1, `spread ${z.first} -> ${z.last}`);
      must(Math.abs(z.angle - 45) < 3, `final angle ${z.angle}°`);
      await reset();
      await mcp.call('page.drag', { selector: '#pad', input: 'touch', by_x: -80, duration_ms: 250, verify: false });
      must(await read("log.touch.some(e => e.t === 'touchmove')"), 'the first touch drag after a pinch did not reach the page');
      return `spread ${Math.round(z.first)} -> ${Math.round(z.last)} (seed ${res.seed})`;
    });

    area('mobile screen coordinates');
    const mobileTab = await mcp.call('page.new_tab');
    mcp.useTarget(mobileTab.target_id);
    await mcp.call('page.activate_tab');
    await mcp.call('device.viewport', { width: 320, height: 640, mobile: true, touch: true, device_scale_factor: 3 });
    let mobileRun = 0;
    const mobile = async () => {
      await mcp.call('page.navigate', { url: new URL(`/mobile?run=${++mobileRun}`, fixture.url).href });
      must(await read('Array.isArray(window.trace) && scrollY === 0'), 'fixture was not ready at the top of the page');
      must(await read("navigator.maxTouchPoints === 5"), 'page did not detect five emulated touch contacts');
    };
    await check('click and tap exact CSS coordinates on canvas at 3x DPR', async () => {
      await mobile();
      must((await read('devicePixelRatio')) === 3, 'fixture did not use 3x DPR');
      for (const [spacing, maxWidth] of [[40, undefined], [20, 160]]) {
        const shot = await mcp.call('page.screenshot', { grid: { spacing }, max_width: maxWidth });
        must(shot.grid.spacing === spacing && shot.grid.width === 320 && shot.grid.units === 'viewport_css_px', JSON.stringify(shot.grid));
        const line = await read(`(async () => {
          const img = new Image();
          img.src = 'data:image/png;base64,${shot.image_data}';
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          const x = Math.round(${spacing} * c.width / 320);
          const y = Math.round(235 * c.height / 640);
          const unmarked = g.getImageData(x + 9, y, 1, 1).data[0];
          return Math.min(g.getImageData(x - 1, y, 1, 1).data[0], g.getImageData(x, y, 1, 1).data[0]) < unmarked - 30;
        })()`);
        must(line, `image was missing its vertical grid line at x=${spacing}`);
      }
      for (const [input, x, y] of [['mouse', 52, 73], ['touch', 187, 114]]) {
        await mcp.call('page.click', { x, y, input, verify: false });
        const last = await read("trace.filter(e => e.type === 'click').at(-1)");
        must(last?.x === x && last?.y === y && last.input === input && last.trusted, JSON.stringify(last));
      }
      await mcp.call('page.click', { x: 280, y: 80, input: 'touch', verify: false });
      must(await read("document.querySelector('input').checked"), 'coordinate tap did not toggle the unnamed checkbox');
    });
    await check('mouse drag follows arbitrary coordinates without a locator', async () => {
      await mobile();
      await mcp.call('page.pointer', {
        input: 'mouse', human: false, html5: false, verify: false,
        actions: [{ action: 'down', x: 53, y: 40 }, { action: 'move', x: 140, y: 85 }, { action: 'up', x: 180, y: 130 }],
      });
      const events = await read("trace.filter(e => e.type === 'pointerdown' || e.type === 'pointerup')");
      must(events.length === 2 && events.every(e => e.input === 'mouse' && e.trusted), JSON.stringify(events));
      must(events[0].x === 53 && events[0].y === 40 && events[1].x === 180 && events[1].y === 130, JSON.stringify(events));
    });
    await check('a quick touch swipe scrolls through Chromium and cancels the page pointer', async () => {
      await mobile();
      await mcp.call('page.drag', { x: 140, y: 180, direction: 'up', distance: 145, input: 'touch', seed: 10, verify: false })
        .catch(async error => { throw new Error(`${error.message} trace: ${JSON.stringify(await read('trace'))}`); });
      const result = await read("({ y: scrollY, trace })");
      must(result.y >= 100 && result.trace.some(e => e.type === 'pointercancel') && !result.trace.some(e => e.type === 'drag'), JSON.stringify(result));
    });
    await check('a touch hold and drag drops at the requested coordinates without scrolling', async () => {
      await mobile();
      const res = await mcp.call('page.drag', { x: 140, y: 180, to_x: 160, to_y: 45, hold_ms: 500, seed: 10, verify: false })
        .catch(async error => { throw new Error(`${error.message} trace: ${JSON.stringify(await read('trace'))}`); });
      const result = await read("({ y: scrollY, trace })");
      const last = result.trace.at(-1);
      must(res.input === 'touch' && result.y === 0 && result.trace.some(e => e.type === 'drag' && e.trusted), JSON.stringify(result));
      must(last?.type === 'pointerup' && last.x === 160 && last.y === 45, JSON.stringify(last));
    });
    await check('a locator drag with no shared viewport refuses before pressing', async () => {
      await mobile();
      try {
        await mcp.call('page.drag', { selector: 'canvas', to_selector: '#far', verify: false });
      } catch (error) {
        must(error.payload?.code === 'source_offscreen' && (await read('trace.length')) === 0, error.message);
        return;
      }
      throw new Error('offscreen source should fail');
    });

    area('exploded layer inspection');
    await mcp.call('page.navigate', { url: new URL('/layers', fixture.url).href });
    let viewer;
    await check('DOM view sends a PNG and keeps the menu under its DOM parent', async () => {
      const view = await mcp.call('inspector.layer_view', { target_id: mobileTab.target_id, mode: 'dom' });
      const menu = view.layers.find(layer => layer.label === 'aside#menu');
      const board = view.layers.find(layer => layer.label === 'main#board');
      must(menu && board && menu.parent_backend_node_id === board.backend_node_id && menu.level > board.level, JSON.stringify(view.layers));
      const png = Buffer.from(view.image_data, 'base64');
      must(png.readUInt32BE(16) === 1150 && png.readUInt32BE(20) === 620, 'missing or invalid PNG');
    });
    await check('stacking view shows a high local z-index painting below the header', async () => {
      const view = await mcp.call('inspector.layer_view', { target_id: mobileTab.target_id, mode: 'z_index', explode: 96 });
      const menu = view.layers.find(layer => layer.label === 'aside#menu');
      const header = view.layers.find(layer => layer.label === 'header#header');
      must(menu?.z_index === '999' && header?.z_index === '10' && menu.paint_order < header.paint_order, JSON.stringify(view.layers));
      viewer = readFileSync(view.interactive_viewer.path, 'utf8');
    });
    await check('composited view reports Chromium layers and replays their paint', async () => {
      const view = await mcp.call('inspector.layer_view', { target_id: mobileTab.target_id, mode: 'composited' });
      must(view.layers.some(layer => layer.layer_id && layer.draws_content && layer.paint_replayed), JSON.stringify(view.layers));
      must(view.layers.some(layer => layer.reasons?.length), 'missing compositor reasons');
    });
    await check('focus crops the scene and reports the actual hit stack', async () => {
      const view = await mcp.call('inspector.layer_view', {
        target_id: mobileTab.target_id, mode: 'z_index', selector: '#menu',
        point: { x: 240, y: 117 }, radius: 60, max_layers: 4,
      });
      must(view.region[2] === 120 && view.layers.some(layer => layer.backend_node_id === view.focus_backend_node_id), JSON.stringify(view.region));
      must(view.hit_test_front_to_back[0]?.id === 'header' && view.hit_test_front_to_back.some(element => element.id === 'menu'), JSON.stringify(view.hit_test_front_to_back));
      const isolated = await mcp.call('inspector.layer_view', {
        target_id: mobileTab.target_id, mode: 'z_index', selector: '#menu', isolate: true,
      });
      must(isolated.diagram.plates.length === 1 && isolated.layers[isolated.diagram.plates[0].number - 1].label === 'aside#menu', JSON.stringify(isolated.diagram));
    });
    await check('standalone viewer redraws and supports selecting and isolating a layer', async () => {
      must(viewer, 'viewer was not exported');
      await mcp.call('page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(viewer) });
      const changed = await read(`(async () => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const canvas = document.querySelector('canvas');
        const before = canvas.toDataURL();
        const control = document.querySelector('#explode');
        control.value = 30;
        control.dispatchEvent(new Event('input'));
        const moved = before !== canvas.toDataURL();
        const rect = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new MouseEvent('click', { clientX: rect.x + rect.width * 0.82, clientY: rect.y + rect.height * 0.23 }));
        const focused = document.querySelector('#focus').value !== '-1';
        const all = canvas.toDataURL();
        const isolate = document.querySelector('#isolate');
        isolate.checked = true;
        isolate.dispatchEvent(new Event('input'));
        return moved && focused && all !== canvas.toDataURL();
      })()`);
      must(changed, 'viewer did not redraw, focus a legend row, or isolate its layer');
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
