/**
 * Skeleton capture, emit and preview.
 *
 * The fixture is deliberately responsive: one card is display:none below 700px
 * and the avatar changes size across widths. That is the case a naive capture
 * gets wrong, by shifting every later bone into the wrong slot, and it is the
 * whole reason bones are keyed by DOM position rather than by index.
 *
 *   node tests/skeleton-check.mjs [--headed] [--keep]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

const results = [];
let currentArea = '(none)';
const area = (name) => {
  currentArea = name;
  process.stdout.write(`\n\x1b[1m── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}\x1b[0m\n`);
};

let client;

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
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
}

async function check(label, fn) {
  try {
    const detail = await fn();
    results.push({ label, ok: true, area: currentArea });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}\n`);
  } catch (err) {
    results.push({ label, ok: false, area: currentArea, err });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n       ${err.message}\n`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/* ------------------------------- fixture --------------------------------- */

const PAGE = `<!doctype html><meta charset=utf-8><title>Skeleton Fixture</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 16px/1.4 system-ui, sans-serif; padding: 16px; }
  .feed { max-width: 960px; margin: 0 auto; }
  /* A white card: no background colour, only a visible border and a radius.
     This is the case captureRoundedBorders exists for. */
  .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .avatar { width: 40px; height: 40px; border-radius: 999px; background: #ccc; }
  .title { font-size: 20px; font-weight: 700; }
  .body { margin-top: 8px; }
  .cta { margin-top: 12px; padding: 8px 16px; border-radius: 9999px; }
  .icon { display: inline-block; width: 16px; height: 16px; background: #eee; }
  .notch { border-radius: 8px 8px 0 0; background: #eee; height: 12px; }
  .desktop-only { display: none; }
  @media (min-width: 700px) {
    .desktop-only { display: block; }
    .avatar { width: 64px; height: 64px; }
  }
</style>
<div class="feed" id="feed">
  <article class="card" data-skeleton="card">
    <div class="avatar"></div>
    <span class="icon"></span>
    <div class="notch"></div>
    <h2 class="title">A reasonably long headline that will wrap on a phone screen</h2>
    <p class="body">Body copy that runs to more than one line at every tested width, so the capture has to split it into separate line bones rather than one tall block.</p>
    <button class="cta">Read more</button>
  </article>
  <article class="card desktop-only" data-skeleton="sidebar-card">
    <h2 class="title">Desktop only</h2>
    <p class="body">This card does not exist below 700px.</p>
  </article>
</div>`;

function startServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/* --------------------------------- main ---------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'browserd-skeleton-'));
let fixture;
let transport;

async function main() {
  fixture = await startServer();
  process.stdout.write(`fixture on ${fixture.base}\ndaemon home ${home}\n`);

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
    env: {
      ...process.env,
      AGENTBROWSER_HOME: home,
      AGENTBROWSER_LOG_LEVEL: 'warn',
      AGENTBROWSER_HEADLESS: HEADED ? '0' : '1',
    },
    stderr: 'pipe',
  });

  client = new Client({ name: 'skeleton-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const skeletonTools = tools.filter((t) => t.name.startsWith('skeleton.')).map((t) => t.name);
  process.stdout.write(`connected: ${tools.length} tools, ${skeletonTools.length} of them skeleton.*\n`);

  await runSuite(fixture.base, skeletonTools);
  await client.close();
}

async function runSuite(base, skeletonTools) {
  /* ------------------------------ A: capture ----------------------------- */
  area('A: capture measures the real layout');

  await check('the whole skeleton family is advertised', async () => {
    for (const name of ['capture', 'emit', 'preview', 'list', 'show', 'delete']) {
      assert(skeletonTools.includes(`skeleton.${name}`), `skeleton.${name} is not advertised`);
    }
    return skeletonTools.join(', ');
  });

  await check('marked elements are measured at every width', async () => {
    const res = await call('skeleton.capture', {
      name: 'feed',
      url: base,
      selector: '#feed',
      widths: [375, 768, 1280],
    });
    assert(res.source === 'marker:data-skeleton', `expected marker capture, got ${res.source}`);
    assert(res.bones === 2, `expected 2 marked bones, got ${res.bones}`);
    assert(res.sizes['375'].width < res.sizes['1280'].width, 'the root did not widen with the viewport');
    return `${res.bones} bones across ${res.widths.join('/')}`;
  });

  await check('a desktop-only element is recorded as absent on mobile, not shifted', async () => {
    const skeleton = await call('skeleton.show', { name: 'feed' });
    const sidebar = skeleton.bones.find((b) => b.name === 'sidebar-card');
    assert(sidebar, 'the desktop-only card was not captured at all');
    assert(!sidebar.at['375'], 'the desktop-only card was measured at 375px, where it is display:none');
    assert(sidebar.at['1280'], 'the desktop-only card is missing at 1280px');
    const card = skeleton.bones.find((b) => b.name === 'card');
    assert(card.at['375'] && card.at['1280'], 'the always-present card lost a width');
    return 'per-width presence tracked per bone';
  });

  await check('auto decomposition splits wrapped text into line bones', async () => {
    const res = await call('skeleton.capture', {
      name: 'auto',
      selector: '.card',
      marker: 'data-no-such-attribute',
      widths: [375, 1280],
    });
    assert(res.source === 'auto', `expected auto decomposition, got ${res.source}`);
    assert(res.by_shape.text >= 3, `expected several text lines, got ${JSON.stringify(res.by_shape)}`);
    assert(res.by_shape.control >= 1, 'the button was not captured as a control');
    return `${res.bones} bones: ${JSON.stringify(res.by_shape)}`;
  });

  await check('geometry is real: the avatar grows between 375 and 1280', async () => {
    const narrow = await call('skeleton.show', { name: 'auto', width: 375 });
    const wide = await call('skeleton.show', { name: 'auto', width: 1280 });
    const pick = (r) => r.bones.find((b) => b.name === 'div.avatar');
    const a = pick(narrow);
    const b = pick(wide);
    assert(a && b, 'the avatar was not captured at both widths');
    assert(a.w === 40 && b.w === 64, `expected 40px then 64px, got ${a.w} then ${b.w}`);
    return `${a.w}px -> ${b.w}px`;
  });

  await check('a round element is recorded as a circle, a pill as a pill', async () => {
    const shown = await call('skeleton.show', { name: 'auto', width: 375 });
    const avatar = shown.bones.find((b) => b.name === 'div.avatar');
    assert(avatar.radius === '50%', `the square rounded avatar is ${JSON.stringify(avatar.radius)}, not a circle`);
    const button = shown.bones.find((b) => b.name === 'button.cta');
    assert(button, 'the button was not captured');
    assert(button.radius !== '50%', 'a wide pill button was mistaken for a circle');
    return `avatar ${avatar.radius}, button ${JSON.stringify(button.radius)}`;
  });

  await check('asymmetric corners survive as a four-corner value', async () => {
    const shown = await call('skeleton.show', { name: 'auto', width: 1280 });
    const notch = shown.bones.find((b) => b.name === 'div.notch');
    assert(notch, 'the asymmetric element was not captured');
    assert(/^\d+px \d+px \d+px \d+px$/.test(String(notch.radius)),
      `expected a four-corner radius, got ${JSON.stringify(notch.radius)}`);
    return notch.radius;
  });

  await check('a white card with only a border becomes a container bone', async () => {
    const res = await call('skeleton.capture', {
      name: 'surfaces',
      selector: '#feed',
      marker: 'data-no-such-attribute',
      widths: [1280],
    });
    assert(res.by_shape.container >= 1, `no container bone: ${JSON.stringify(res.by_shape)}`);
    const shown = await call('skeleton.show', { name: 'surfaces', width: 1280 });
    const card = shown.bones.find((b) => b.container);
    assert(card, 'the container bone is not flagged');
    const children = shown.bones.filter((b) => !b.container && b.y >= card.y && b.y < card.y + card.h);
    assert(children.length >= 2, 'the card has no children drawn on top of it');
    const cardIndex = shown.bones.indexOf(card);
    assert(shown.bones.indexOf(children[0]) > cardIndex, 'a container bone is painted after its children');
    return `${res.by_shape.container} container bones, each before its children`;
  });

  await check('containers:false drops the surface bones', async () => {
    const withThem = await call('skeleton.capture', { name: 'surfaces', selector: '#feed', marker: 'x', widths: [1280], replace: true });
    const without = await call('skeleton.capture', { name: 'flat', selector: '#feed', marker: 'x', widths: [1280], containers: false });
    assert(!without.by_shape.container, 'container bones survived containers:false');
    assert(withThem.bones > without.bones, 'disabling containers changed nothing');
    await call('skeleton.delete', { name: 'flat' });
    return `${withThem.bones} with, ${without.bones} without`;
  });

  await check('exclude_selectors removes an element and its subtree', async () => {
    const before = await call('skeleton.capture', { name: 'excl', selector: '.card', marker: 'x', widths: [1280] });
    const shownBefore = await call('skeleton.show', { name: 'excl', width: 1280 });
    const doomed = shownBefore.bones.filter((b) => b.name === 'span.icon' || b.name === 'div.notch');
    assert(doomed.length === 2, `the fixture should offer 2 excludable bones, found ${doomed.length}`);

    const after = await call('skeleton.capture', {
      name: 'excl',
      selector: '.card',
      marker: 'x',
      widths: [1280],
      exclude_selectors: ['.icon', '.notch'],
      replace: true,
    });
    assert(after.bones === before.bones - doomed.length, `expected ${doomed.length} fewer bones, went ${before.bones} -> ${after.bones}`);
    const shown = await call('skeleton.show', { name: 'excl', width: 1280 });
    assert(!shown.bones.find((b) => b.name === 'span.icon' || b.name === 'div.notch'), 'an excluded element is still there');
    await call('skeleton.delete', { name: 'excl' });
    return `${before.bones} -> ${after.bones}`;
  });

  await check('an invalid exclude selector is ignored, not fatal', async () => {
    const res = await call('skeleton.capture', {
      name: 'badsel',
      selector: '.card',
      marker: 'x',
      widths: [1280],
      exclude_selectors: ['this is not a selector', '.icon'],
    });
    assert(res.bones > 0, 'the capture died on an invalid selector');
    await call('skeleton.delete', { name: 'badsel' });
    return `${res.bones} bones captured anyway`;
  });

  await check('re-capturing one width keeps the widths captured earlier', async () => {
    const first = await call('skeleton.capture', { name: 'merge', selector: '.card', marker: 'x', widths: [375, 1280] });
    assert(first.widths.length === 2, 'setup failed');
    const second = await call('skeleton.capture', { name: 'merge', selector: '.card', marker: 'x', widths: [768] });
    assert(
      JSON.stringify(second.widths) === JSON.stringify([375, 768, 1280]),
      `expected all three widths preserved, got ${JSON.stringify(second.widths)}`,
    );
    assert(JSON.stringify(second.widths_captured_now) === JSON.stringify([768]), 'it re-measured more than asked');
    const replaced = await call('skeleton.capture', { name: 'merge', selector: '.card', marker: 'x', widths: [768], replace: true });
    assert(JSON.stringify(replaced.widths) === JSON.stringify([768]), 'replace:true did not discard the old widths');
    await call('skeleton.delete', { name: 'merge' });
    return 'merged by default, discarded on replace:true';
  });

  await check('the bones file is written where the daemon says it is', async () => {
    const list = await call('skeleton.list', {});
    assert(list.skeletons.find((s) => s.name === 'feed'), 'the feed skeleton is not listed');
    const file = join(list.directory, 'feed.bones.json');
    assert(existsSync(file), `no bones file at ${file}`);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert(parsed.bones.length === 2, 'the file disagrees with the capture');
    return `${list.count} skeletons in ${list.directory}`;
  });

  await check('viewport emulation is cleared after a capture', async () => {
    const res = await call('js.evaluate', { expression: 'window.innerWidth' });
    const width = res.value ?? res.result?.value;
    assert(Number(width) > 0, 'no viewport width readable after capture');
    return `back to ${width}px`;
  });

  /* -------------------------------- B: emit ------------------------------ */
  area('B: emit produces usable source');

  await check('breakpoints ask the container by default, and the viewport on request', async () => {
    const res = await call('skeleton.emit', { name: 'feed', format: 'css' });
    assert(res.breakpoints === 'container', `default mode is ${res.breakpoints}`);
    assert(res.source.includes('container-type: inline-size'), 'the root is not a query container');
    assert(res.source.includes('@container (min-width: 768px)'), 'no 768px breakpoint');
    assert(res.source.includes('@container (min-width: 1280px)'), 'no 1280px breakpoint');
    assert(!res.source.includes('(min-width: 375px)'), 'the base width should not be a breakpoint');

    const media = await call('skeleton.emit', { name: 'feed', format: 'css', breakpoints: 'media' });
    assert(media.source.includes('@media (min-width: 768px)'), 'media mode emitted no media query');
    assert(!media.source.includes('@container'), 'media mode still emitted a container query');
    assert(!media.source.includes('container-type'), 'media mode still declared a container');
    return `${res.bytes} bytes, both modes`;
  });

  await check('per-bone rules out-specify the shared rule they override', async () => {
    const res = await call('skeleton.emit', { name: 'feed', format: 'css' });
    const shared = res.source.match(/\.[\w-]+__in > i \{/);
    assert(shared, 'no shared bone rule');
    const perBone = res.source.match(/\.[\w-]+__in > i\.[\w-]+__b0 \{/);
    assert(perBone, 'per-bone rules are not qualified by the shared selector, so they lose the cascade');
    return 'overrides win';
  });

  await check('a bone absent at a width is hidden there and shown where it exists', async () => {
    const res = await call('skeleton.emit', { name: 'feed', format: 'css' });
    // The reduced-motion guard is also an at-rule, so cut on the first breakpoint.
    const base = res.source.split('@container (min-width:')[0];
    const desktop = res.source
      .slice(res.source.indexOf('@container (min-width: 768px)'))
      .split('@container (min-width: 1280px)')[0];
    const hiddenAtBase = [...base.matchAll(/> i\.[\w-]+__b(\d+) \{ display: none; \}/g)].map((m) => m[1]);
    assert(hiddenAtBase.length === 1, `expected exactly one bone hidden on mobile, got ${hiddenAtBase.length}`);
    const shown = new RegExp("> i\\.[\\w-]+__b" + hiddenAtBase[0] + " \\{ display: block;");
    assert(shown.test(desktop), 'the desktop-only bone is hidden on mobile and never shown at 768px');
    return `bone ${hiddenAtBase[0]} hidden below 768px, drawn above it`;
  });

  await check('a circle keeps a pixel width so it cannot become an ellipse', async () => {
    const res = await call('skeleton.emit', { name: 'auto', format: 'css' });
    const circleRule = res.source.split('\n').find((line) => line.includes('border-radius: 50%'));
    assert(circleRule, 'no circular bone in the emitted css');
    assert(/width: \d+px;/.test(circleRule), `a circle was emitted with a percentage width: ${circleRule}`);
    const others = res.source.split('\n').filter((l) => l.includes('width:') && !l.includes('border-radius: 50%'));
    assert(others.some((l) => l.includes('%')), 'nothing scales with the container any more');
    return 'circles in px, everything else in %';
  });

  await check('container bones are emitted lighter and never shimmer', async () => {
    const res = await call('skeleton.emit', { name: 'surfaces', format: 'html', animation: 'shimmer' });
    assert(res.container_bones >= 1, 'no container bones to emit');
    assert(res.source.includes('--surface'), 'container bones carry no surface class');
    assert(/--surface \{ background:/.test(res.source), 'the surface class sets no distinct background');
    assert(/:not\(\.[\w-]+--surface\)::after/.test(res.source), 'the shimmer sweep is not excluded from surfaces');
    return `${res.container_bones} surface bones`;
  });

  await check('a custom colour drives the container colour too', async () => {
    const res = await call('skeleton.emit', { name: 'surfaces', format: 'css', color: '#3366cc' });
    assert(res.source.includes('#3366cc'), 'the custom colour was ignored');
    assert(/--surface \{ background: rgba\(51, 102, 204/.test(res.source), 'the container colour was not derived from it');
    return 'derived rgba surface';
  });

  await check('html output is self-contained and accessible', async () => {
    const res = await call('skeleton.emit', { name: 'feed', format: 'html', animation: 'pulse' });
    assert(res.source.includes('<style>'), 'no inline style block');
    assert(res.source.includes('aria-busy="true"'), 'no aria-busy on the container');
    assert(res.source.includes('prefers-reduced-motion'), 'motion is not reduced on request');
    assert(res.source.includes('-pulse'), 'the pulse animation was not emitted');
    return `${res.bones} bones, ${res.bytes} bytes`;
  });

  await check('react output uses className and self-closing bones', async () => {
    const res = await call('skeleton.emit', { name: 'feed', format: 'react' });
    assert(res.source.includes('export function FeedSkeleton()'), `unexpected component name: ${res.component}`);
    assert(res.source.includes('className='), 'react output still uses class=');
    assert(!/<i [^>]*><\/i>/.test(res.source), 'react output has non-self-closing bones');
    return res.component;
  });

  await check('vue and svelte output carry both markup and styles', async () => {
    for (const format of ['vue', 'svelte']) {
      const res = await call('skeleton.emit', { name: 'feed', format });
      assert(res.source.includes('<style'), `${format}: no style block`);
      assert(res.source.includes('data-bone='), `${format}: no bones in the markup`);
    }
    return 'vue, svelte';
  });

  await check('emit writes an artifact that can be read back', async () => {
    const res = await call('skeleton.emit', { name: 'feed', format: 'css' });
    const read = await call('artifact.read', { artifact_id: res.artifact.artifact_id ?? res.artifact.id ?? res.artifact.handle });
    const text = read.content ?? read.text ?? '';
    assert(text.includes('__b0'), 'the artifact does not contain the emitted css');
    return `${res.artifact.bytes ?? res.bytes} bytes stored`;
  });

  /* ------------------------------ C: preview ----------------------------- */
  area('C: preview draws it over the live page');

  await check('the overlay lands in a shadow root outside the app tree', async () => {
    const res = await call('skeleton.preview', { name: 'feed' });
    assert(res.shown === true, 'preview reported nothing shown');
    assert(res.bones === 2, `expected 2 drawn bones, got ${res.bones}`);
    const probe = await call('js.evaluate', {
      expression:
        "(() => { const h = document.getElementById('browserd-skeleton-overlay');" +
        " return h ? { shadow: !!h.shadowRoot, inFeed: !!document.getElementById('feed').contains(h) } : null; })()",
    });
    const value = probe.value ?? probe.result?.value;
    assert(value && value.shadow === true, 'the overlay has no shadow root');
    assert(value.inFeed === false, 'the overlay was injected inside the app tree');
    return `${res.bones} bones anchored to ${res.anchored_to}`;
  });

  await check('the rendered overlay obeys the breakpoint, not just the stylesheet', async () => {
    // The bug this exists for: the shared `.p__in > i` rule is specificity
    // (0,1,1) and a bare per-bone `.p__b7` is (0,1,0), so every breakpoint
    // override lost to the base rule and the skeleton rendered at the wrong
    // width. Reading the CSS text cannot see that; only the computed style can.
    await call('skeleton.preview', { name: 'feed' });
    const probe = await call('js.evaluate', {
      expression:
        "(() => { const sr = document.getElementById('browserd-skeleton-overlay').shadowRoot;" +
        " const inner = sr.querySelector('.sk__in'); const top = inner.getBoundingClientRect().top;" +
        " const bones = [...inner.children];" +
        " const bottoms = bones.filter(b => getComputedStyle(b).display !== 'none')" +
        "   .map(b => b.getBoundingClientRect().bottom - top);" +
        " return JSON.stringify({ containerWidth: sr.querySelector('.sk').getBoundingClientRect().width," +
        "   innerHeight: parseFloat(getComputedStyle(inner).height)," +
        "   visible: bottoms.length, hidden: bones.length - bottoms.length," +
        "   lowest: Math.max(...bottoms) }); })()",
    });
    const seen = JSON.parse(probe.value ?? probe.result?.value);

    const skeleton = await call('skeleton.show', { name: 'feed' });
    const applicable = skeleton.widths.filter((w) => w <= seen.containerWidth);
    const bucket = String(applicable.length ? Math.max(...applicable) : Math.min(...skeleton.widths));
    assert(
      seen.innerHeight === skeleton.sizes[bucket].height,
      `rendered ${seen.innerHeight}px but the ${bucket}px capture is ${skeleton.sizes[bucket].height}px tall`,
    );

    const absent = skeleton.bones.filter((b) => !b.at[bucket]).length;
    assert(seen.hidden === absent, `${absent} bones do not exist at ${bucket}px but ${seen.hidden} are hidden`);
    assert(
      seen.lowest <= seen.innerHeight + 1,
      `a bone is drawn ${Math.round(seen.lowest - seen.innerHeight)}px past the end of the skeleton`,
    );
    return `${seen.containerWidth}px container -> ${bucket}px bones, ${seen.visible} drawn, ${seen.hidden} hidden`;
  });

  await check('preview is idempotent: a second call replaces rather than stacks', async () => {
    await call('skeleton.preview', { name: 'feed', animation: 'pulse' });
    const probe = await call('js.evaluate', {
      expression: "document.querySelectorAll('#browserd-skeleton-overlay').length",
    });
    const count = probe.value ?? probe.result?.value;
    assert(Number(count) === 1, `expected exactly one overlay, found ${count}`);
    return 'one overlay';
  });

  await check('preview{remove:true} takes it down', async () => {
    const res = await call('skeleton.preview', { name: 'feed', remove: true });
    assert(res.removed === true, 'nothing was removed');
    const probe = await call('js.evaluate', {
      expression: "document.querySelectorAll('#browserd-skeleton-overlay').length",
    });
    const count = probe.value ?? probe.result?.value;
    assert(Number(count) === 0, `the overlay survived removal (${count} left)`);
    return 'page is clean';
  });

  /* ----------------------------- D: guardrails --------------------------- */
  area('D: guardrails');

  await check('a traversing name is refused', async () => {
    let threw = false;
    try {
      await call('skeleton.capture', { name: '../escape', selector: '#feed', widths: [375] });
    } catch (err) {
      threw = /bad_name|1-64 chars/.test(err.message);
    }
    assert(threw, 'a name with path separators was accepted');
    return "'../escape' refused";
  });

  await check('an unknown skeleton names the ones that exist', async () => {
    let message = '';
    try {
      await call('skeleton.emit', { name: 'nope' });
    } catch (err) {
      message = err.message;
    }
    assert(/no skeleton named/i.test(message), `unhelpful error: ${message}`);
    assert(/feed/.test(message), 'the error does not list what is actually saved');
    return 'error lists saved skeletons';
  });

  await check('an empty root fails loudly instead of saving an empty skeleton', async () => {
    let message = '';
    try {
      await call('skeleton.capture', { name: 'empty', selector: '#no-such-element', widths: [375] });
    } catch (err) {
      message = err.message;
    }
    // A missing selector falls back to body, which is not empty, so target a
    // real but genuinely empty container instead.
    if (!message) {
      await call('js.evaluate', {
        expression: "document.body.insertAdjacentHTML('beforeend', '<div id=hollow></div>')",
      });
      try {
        await call('skeleton.capture', { name: 'empty', selector: '#hollow', widths: [375] });
      } catch (err) {
        message = err.message;
      }
    }
    assert(/no_bones|nothing measurable/i.test(message), `expected a no_bones error, got: ${message}`);
    return 'empty captures refused';
  });

  await check('skeleton.delete removes it', async () => {
    await call('skeleton.delete', { name: 'auto' });
    const list = await call('skeleton.list', {});
    assert(!list.skeletons.find((s) => s.name === 'auto'), 'still listed after delete');
    return `${list.count} left`;
  });
}

function report() {
  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;
  process.stdout.write(`\n\x1b[1m${passed} passed, ${failed.length} failed\x1b[0m\n`);
  for (const f of failed) process.stdout.write(`  \x1b[31m${f.area}: ${f.label}\x1b[0m\n`);
  return failed.length;
}

let exitCode = 1;
try {
  await main();
  exitCode = report() === 0 ? 0 : 1;
} catch (err) {
  process.stderr.write(`\nHARNESS ERROR: ${err.stack ?? err}\n`);
  report();
  exitCode = 1;
} finally {
  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}
  try { await fixture?.close(); } catch {}
  if (!KEEP) { try { rmSync(home, { recursive: true, force: true }); } catch {} }
  process.exit(exitCode);
}
