/**
 * Camera, microphone and screen capture.
 *
 * A proctoring or video-call flow stops at browser UI - the getUserMedia
 * permission bubble and the getDisplayMedia source picker - that CDP cannot
 * click through. browser.launch{media} answers both with Chromium switches at
 * process start, and permissions.grant maps the web names (camera, microphone)
 * that CDP otherwise rejects.
 *
 * Part A needs no browser: it checks the switch builder, the permission map and
 * the env parser straight from dist/. Part B drives real headless Chromium with
 * synthetic devices, so it needs no camera, microphone or OS permission.
 *
 *   node tests/media-check.mjs [--headed]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADED = process.argv.includes('--headed');
const dist = (path) => import(pathToFileURL(join(ROOT, 'dist', path)).href);

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
    const ms = Date.now() - started;
    results.push({ area: currentArea, label, ok: true });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label} \x1b[90m(${ms}ms)${detail ? ` ${detail}` : ''}\x1b[0m\n`);
  } catch (err) {
    results.push({ area: currentArea, label, ok: false, error: err.message });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n         ${err.message}\n`);
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

/** The error code a call throws, or null when it does not throw. */
function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code ?? 'error';
  }
}

/* --------------------------------- fixtures ------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'browserd-media-'));
const files = mkdtempSync(join(tmpdir(), 'browserd-media-files-'));

/** A 64x48 YUV 4:2:0 clip of two grey frames: the smallest file Chromium will play as a camera. */
function writeY4m(path) {
  const header = Buffer.from('YUV4MPEG2 W64 H48 F30:1 Ip A1:1 C420jpeg\n', 'ascii');
  const frame = Buffer.concat([Buffer.from('FRAME\n', 'ascii'), Buffer.alloc(64 * 48 * 1.5, 128)]);
  writeFileSync(path, Buffer.concat([header, frame, frame]));
}

/** Half a second of 16-bit mono silence. */
function writeWav(path) {
  const rate = 8000;
  const data = Buffer.alloc(rate); // 0.5s * 2 bytes per sample
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

const videoFile = join(files, 'camera.y4m');
const audioFile = join(files, 'mic.wav');
const badExtension = join(files, 'camera.mp4');
writeY4m(videoFile);
writeWav(audioFile);
writeFileSync(badExtension, 'not a video');

async function startFixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>media fixture</title><button id="go">Start</button>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // 127.0.0.1 is a secure context, which getUserMedia and getDisplayMedia require.
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

/* ------------------------------- MCP plumbing ----------------------------- */

async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
    env: {
      ...process.env,
      AGENTBROWSER_HOME: home,
      AGENTBROWSER_LOG_LEVEL: 'warn',
      AGENTBROWSER_HEADLESS: HEADED ? '0' : '1',
      ...env,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'browserd-media-test', version: '1.0.0' });
  await client.connect(transport);

  let browserId = null;
  const call = async (name, args = {}) => {
    const scoped =
      browserId && name !== 'browser.launch' && args.browser_id === undefined ? { ...args, browser_id: browserId } : args;
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
  const use = (id) => {
    browserId = id;
  };
  const close = async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  };
  return { call, use, close };
}

const GET_USER_MEDIA = `navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(
  (s) => { const out = s.getTracks().map((t) => ({ kind: t.kind, label: t.label, width: t.getSettings().width ?? null })); s.getTracks().forEach((t) => t.stop()); return out; },
  (e) => ({ error: e.name + ': ' + e.message }))`;
const GET_DISPLAY_MEDIA = `navigator.mediaDevices.getDisplayMedia({ video: true }).then(
  (s) => { const t = s.getVideoTracks()[0]; const out = { surface: t.getSettings().displaySurface ?? null, label: t.label }; s.getTracks().forEach((x) => x.stop()); return out; },
  (e) => ({ error: e.name + ': ' + e.message }))`;
const PERMISSION_STATES = `Promise.all(['camera', 'microphone'].map((name) => navigator.permissions.query({ name }).then((p) => p.state)))`;

/* --------------------------------- part A --------------------------------- */

async function pure() {
  const { mediaArgs, mediaPermissions } = await dist('browser/launcher.js');
  const { toProtocolPermissions } = await dist('ops/emulation.js');
  const { parseMediaEnv, DEFAULT_CONFIG } = await dist('config.js');

  area('A: switch builder');

  await check('no media adds no switches, so the default launch is unchanged', async () => {
    must(mediaArgs(undefined).length === 0, 'undefined produced switches');
    must(mediaArgs({}).length === 0, '{} produced switches');
    must(DEFAULT_CONFIG.media === null, `DEFAULT_CONFIG.media is ${JSON.stringify(DEFAULT_CONFIG.media)}`);
    return 'undefined, {} and the default config all empty';
  });

  await check('camera and microphone share one accept switch', async () => {
    for (const media of [{ camera: true }, { microphone: true }, { camera: true, microphone: true }]) {
      const args = mediaArgs(media);
      must(
        JSON.stringify(args) === JSON.stringify(['--auto-accept-camera-and-microphone-capture']),
        `${JSON.stringify(media)} -> ${JSON.stringify(args)}`,
      );
    }
    must(!mediaArgs({ camera: true }).includes('--use-fake-ui-for-media-stream'), 'the old fake-ui switch crept in');
    return '--auto-accept-camera-and-microphone-capture';
  });

  await check('fake devices, video and audio files map to their switches', async () => {
    must(mediaArgs({ fakeDevices: true }).join(' ') === '--use-fake-device-for-media-stream', 'fake_devices');
    const args = mediaArgs({ videoFile, audioFile });
    must(args.includes('--use-fake-device-for-media-stream'), 'files did not imply fake devices');
    must(args.includes(`--use-file-for-fake-video-capture=${videoFile}`), 'video file switch missing');
    must(args.includes(`--use-file-for-fake-audio-capture=${audioFile}`), 'audio file switch missing');
    return `${args.length} switches`;
  });

  await check('screen picks any screen; screen_source picks by title, never both', async () => {
    must(mediaArgs({ screen: true }).join(' ') === '--auto-select-screen-capture-source', 'screen');
    const named = mediaArgs({ screen: true, screenSource: 'Entire screen' });
    must(named.join(' ') === '--auto-select-desktop-capture-source=Entire screen', JSON.stringify(named));
    return named[0];
  });

  await check('bad media input is refused before anything launches', async () => {
    const cases = [
      ['relative video_file', { videoFile: 'camera.y4m' }],
      ['missing video_file', { videoFile: join(files, 'nope.y4m') }],
      ['unsupported video format', { videoFile: badExtension }],
      ['unsupported audio format', { audioFile: videoFile }],
      ['"%" in audio_file', { audioFile: join(files, '100%.wav') }],
      ['files with fake_devices:false', { videoFile, fakeDevices: false }],
      ['empty screen_source', { screenSource: '  ' }],
      ['screen_source with screen:false', { screenSource: 'Entire screen', screen: false }],
      ['origin that is not an origin', { camera: true, origin: 'not a url' }],
    ];
    for (const [label, media] of cases) {
      const code = codeOf(() => mediaArgs(media));
      must(code === 'bad_media', `${label}: expected bad_media, got ${code}`);
    }
    must(codeOf(() => mediaArgs({ camera: true, origin: 'https://app.example.com' })) === null, 'a valid origin was refused');
    return `${cases.length} refused with bad_media`;
  });

  await check('the launch grant covers exactly what was asked for', async () => {
    must(JSON.stringify(mediaPermissions({ camera: true })) === '["videoCapture"]', 'camera');
    must(JSON.stringify(mediaPermissions({ microphone: true })) === '["audioCapture"]', 'microphone');
    must(mediaPermissions({ screen: true, fakeDevices: true }).length === 0, 'screen or fake devices granted something');
    return 'videoCapture, audioCapture';
  });

  area('A: permission names and config');

  await check('web permission names map to CDP types; CDP names pass through', async () => {
    const out = toProtocolPermissions(['camera', 'microphone', 'geolocation', 'videoCapture', 'accelerometer', 'gyroscope']);
    must(
      JSON.stringify(out) === JSON.stringify(['videoCapture', 'audioCapture', 'geolocation', 'sensors']),
      JSON.stringify(out),
    );
    return out.join(', ');
  });

  await check('AGENTBROWSER_MEDIA parses the on/off switches and refuses typos', async () => {
    const media = parseMediaEnv('camera, microphone,screen,fake_devices');
    must(media.camera && media.microphone && media.screen && media.fakeDevices, JSON.stringify(media));
    let message = '';
    try {
      parseMediaEnv('camera,webcam');
    } catch (err) {
      message = err.message;
    }
    must(/unknown entry "webcam"/.test(message), `unhelpful error: ${message}`);
    return 'parsed, and "webcam" refused';
  });
}

/* --------------------------------- part B --------------------------------- */

async function live(fixture) {
  const mcp = await connect();
  try {
    area('B: launch with media, synthetic devices');

    let launched;
    await check('browser.launch{media} reports the switches and the grant', async () => {
      launched = await mcp.call('browser.launch', {
        headless: !HEADED,
        profile: 'media-check',
        media: { camera: true, microphone: true, fake_devices: true, screen: true },
      });
      mcp.use(launched.browser_id);
      const m = launched.media;
      must(m, 'no media block in the result');
      for (const s of [
        '--auto-accept-camera-and-microphone-capture',
        '--use-fake-device-for-media-stream',
        '--auto-select-screen-capture-source',
      ]) {
        must(m.switches.includes(s), `missing ${s}: ${JSON.stringify(m.switches)}`);
      }
      must(JSON.stringify(m.permissions_granted) === '["videoCapture","audioCapture"]', JSON.stringify(m.permissions_granted));
      must(/secure context/i.test(m.secure_context_note ?? ''), 'no secure-context note');
      must(!m.os_note, 'fake devices need no OS permission, but an OS note was attached');
      return m.switches.join(' ');
    });

    await mcp.call('page.navigate', { url: fixture.url });

    await check('the page sees camera and microphone as granted', async () => {
      const r = await mcp.call('js.evaluate', { expression: PERMISSION_STATES, await_promise: true });
      must(JSON.stringify(r.value) === '["granted","granted"]', JSON.stringify(r.value));
      return r.value.join(', ');
    });

    await check('getUserMedia returns fake tracks with no prompt', async () => {
      const r = await mcp.call('js.evaluate', { expression: GET_USER_MEDIA, await_promise: true, timeout_ms: 15_000 });
      must(Array.isArray(r.value), `getUserMedia failed: ${JSON.stringify(r.value)}`);
      const kinds = r.value.map((t) => t.kind).sort();
      must(JSON.stringify(kinds) === '["audio","video"]', JSON.stringify(r.value));
      return r.value.map((t) => `${t.kind}=${t.label}`).join(', ');
    });

    await check('getDisplayMedia auto-selects a screen with no picker', async () => {
      const r = await mcp.call('js.evaluate', { expression: GET_DISPLAY_MEDIA, await_promise: true, timeout_ms: 15_000 });
      must(r.value && !r.value.error, `getDisplayMedia failed: ${JSON.stringify(r.value)}`);
      must(r.value.surface === 'monitor', `captured a ${r.value.surface}, not a screen`);
      return `displaySurface=${r.value.surface}`;
    });

    await check('browser.status reports the media configuration', async () => {
      const r = await mcp.call('browser.status');
      must(r.media?.switches?.includes('--use-fake-device-for-media-stream'), JSON.stringify(r.media));
      return `${r.media.switches.length} switches`;
    });

    await mcp.call('browser.close').catch(() => {});
    mcp.use(null);

    area('B: fake capture from files');

    await check('video_file becomes the camera', async () => {
      const r = await mcp.call('browser.launch', {
        headless: !HEADED,
        profile: 'media-check-files',
        media: { camera: true, microphone: true, video_file: videoFile, audio_file: audioFile },
      });
      mcp.use(r.browser_id);
      must(r.media.switches.includes(`--use-file-for-fake-video-capture=${videoFile}`), JSON.stringify(r.media.switches));
      await mcp.call('page.navigate', { url: fixture.url });
      const g = await mcp.call('js.evaluate', { expression: GET_USER_MEDIA, await_promise: true, timeout_ms: 15_000 });
      must(Array.isArray(g.value), `getUserMedia failed: ${JSON.stringify(g.value)}`);
      const video = g.value.find((t) => t.kind === 'video');
      must(video?.width === 64, `camera is ${video?.width}px wide, not the 64px file`);
      return `camera width ${video.width} from ${videoFile.split(/[\\/]/).pop()}`;
    });

    await mcp.call('browser.close').catch(() => {});
    mcp.use(null);

    area('B: refusals and the default');

    await check('a relative video_file is refused and nothing launches', async () => {
      const before = (await mcp.call('browser.list')).count;
      let payload = null;
      try {
        await mcp.call('browser.launch', { headless: true, profile: 'media-check-bad', media: { video_file: 'camera.y4m' } });
      } catch (err) {
        payload = err.payload;
      }
      must(payload?.code === 'bad_media', `expected bad_media, got ${JSON.stringify(payload)}`);
      must(/absolute path/.test(payload.message), payload.message);
      const after = (await mcp.call('browser.list')).count;
      must(after === before, `${after - before} browser(s) launched anyway`);
      return payload.message.slice(0, 60);
    });

    await check('a plain launch has no media, and permissions.grant maps camera/microphone', async () => {
      const r = await mcp.call('browser.launch', { headless: !HEADED, profile: 'media-check-plain' });
      mcp.use(r.browser_id);
      must(r.media === undefined, `plain launch reported media: ${JSON.stringify(r.media)}`);
      await mcp.call('page.navigate', { url: fixture.url });
      const before = await mcp.call('js.evaluate', { expression: PERMISSION_STATES, await_promise: true });
      must(!before.value.includes('granted'), `already granted: ${JSON.stringify(before.value)}`);
      const grant = await mcp.call('permissions.grant', { permissions: ['camera', 'microphone'] });
      must(JSON.stringify(grant.granted) === '["videoCapture","audioCapture"]', JSON.stringify(grant));
      must(grant.mapped?.camera === 'videoCapture', JSON.stringify(grant.mapped));
      const after = await mcp.call('js.evaluate', { expression: PERMISSION_STATES, await_promise: true });
      must(JSON.stringify(after.value) === '["granted","granted"]', JSON.stringify(after.value));
      return `${before.value.join(',')} -> ${after.value.join(',')}`;
    });

    await check('an unknown permission name is refused with guidance', async () => {
      let payload = null;
      try {
        await mcp.call('permissions.grant', { permissions: ['webcam'] });
      } catch (err) {
        payload = err.payload;
      }
      must(payload?.code === 'bad_permission', `expected bad_permission, got ${JSON.stringify(payload)}`);
      must(/camera/.test(payload.message), 'the error does not name the accepted web names');
      return 'bad_permission';
    });

    await mcp.call('browser.close').catch(() => {});
    mcp.use(null);

    area('B: discoverable');

    await check('the guide has a media topic and orient points at it', async () => {
      const topic = await mcp.call('guide.topic', { name: 'media' });
      for (const term of ['getUserMedia', 'getDisplayMedia', 'fake_devices', 'secure context', 'Let desktop apps access']) {
        must(topic.body.toLowerCase().includes(term.toLowerCase()), `the media topic never mentions ${term}`);
      }
      const orient = JSON.stringify(await mcp.call('guide.orient'));
      must(/browser\.launch\{media/.test(orient), 'guide.orient does not point at browser.launch{media}');
      return `${topic.body.length} chars`;
    });
  } finally {
    await mcp.close();
  }

  area('B: default from AGENTBROWSER_MEDIA');

  const env = await connect({ AGENTBROWSER_MEDIA: 'camera,microphone,fake_devices' });
  try {
    await check('an auto-launched browser takes the configured media', async () => {
      // No browser.launch: page.navigate auto-launches with the daemon's defaults.
      await env.call('page.navigate', { url: fixture.url });
      const status = await env.call('browser.status');
      env.use(status.browser_id);
      must(status.media?.switches?.includes('--auto-accept-camera-and-microphone-capture'), JSON.stringify(status.media));
      const r = await env.call('js.evaluate', { expression: GET_USER_MEDIA, await_promise: true, timeout_ms: 15_000 });
      must(Array.isArray(r.value), `getUserMedia failed: ${JSON.stringify(r.value)}`);
      return status.media.switches.join(' ');
    });
    await env.call('browser.close').catch(() => {});
  } finally {
    await env.close();
  }
}

/* ---------------------------------- main ---------------------------------- */

let fixture;
try {
  await pure();
  fixture = await startFixture();
  await live(fixture);
} catch (err) {
  process.stdout.write(`\n\x1b[31mfatal: ${err.stack ?? err.message}\x1b[0m\n`);
  results.push({ area: 'fatal', label: String(err.message), ok: false });
} finally {
  await fixture?.close().catch(() => {});
  for (const dir of [home, files]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows sometimes holds the profile open a moment longer. */
    }
  }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m\n`);
for (const f of failed) process.stdout.write(`  \x1b[31m${f.area} / ${f.label}\x1b[0m\n`);
process.exit(failed.length ? 1 : 0);
