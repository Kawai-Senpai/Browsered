/**
 * Motion and orientation sensors.
 *
 * A page that reads the gyroscope never receives an event on a desktop, so its
 * tracking code cannot be exercised. sensor.* virtualises the sensors behind
 * deviceorientation, devicemotion and the Generic Sensor API.
 *
 * Part A needs no browser: it checks the angle-to-quaternion maths straight
 * from dist/. Part B drives real headless Chromium and asserts on the events
 * the page actually received, not on what the tool said it sent.
 *
 *   node tests/sensor-check.mjs [--headed]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const home = mkdtempSync(join(tmpdir(), 'browserd-sensor-'));

async function startFixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>sensor fixture</title><p>sensors</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // 127.0.0.1 is a secure context, which the sensor APIs require.
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
    env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_LOG_LEVEL: 'warn', AGENTBROWSER_HEADLESS: HEADED ? '0' : '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'browserd-sensor-test', version: '1.0.0' });
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
  return { call, use: (id) => (browserId = id), tools: async () => (await client.listTools()).tools, close: () => client.close() };
}

/** Collects every deviceorientation / devicemotion event the page receives. */
const INSTALL_LISTENERS = `(() => {
  window.__o = []; window.__m = [];
  addEventListener('deviceorientation', (e) => window.__o.push([e.alpha, e.beta, e.gamma]));
  addEventListener('devicemotion', (e) => window.__m.push({
    a: e.acceleration && [e.acceleration.x, e.acceleration.y, e.acceleration.z],
    g: e.accelerationIncludingGravity && [e.accelerationIncludingGravity.x, e.accelerationIncludingGravity.y, e.accelerationIncludingGravity.z],
    r: e.rotationRate && [e.rotationRate.alpha, e.rotationRate.beta, e.rotationRate.gamma],
  }));
  return 'ok';
})()`;
const settle = (ms = 400) => `new Promise((r) => setTimeout(() => r({ o: window.__o, m: window.__m.slice(-3) }), ${ms}))`;

/* --------------------------------- part A --------------------------------- */

async function pure() {
  const { orientationToQuaternion, slerp, SENSOR_TYPES } = await dist('ops/sensors.js');

  area('A: angle maths (no browser)');

  await check('zero angles are the identity rotation', async () => {
    const q = orientationToQuaternion(0, 0, 0);
    must(near(q.w, 1, 1e-12) && near(q.x, 0, 1e-12) && near(q.y, 0, 1e-12) && near(q.z, 0, 1e-12), JSON.stringify(q));
  });

  await check('each angle rotates about its own axis (alpha:z, beta:x, gamma:y)', async () => {
    const s = Math.sin(Math.PI / 4);
    const a = orientationToQuaternion(90, 0, 0);
    const b = orientationToQuaternion(0, 90, 0);
    const g = orientationToQuaternion(0, 0, 90);
    must(near(a.z, s, 1e-9) && near(a.x, 0, 1e-9) && near(a.y, 0, 1e-9), `alpha: ${JSON.stringify(a)}`);
    must(near(b.x, s, 1e-9) && near(b.y, 0, 1e-9) && near(b.z, 0, 1e-9), `beta: ${JSON.stringify(b)}`);
    must(near(g.y, s, 1e-9) && near(g.x, 0, 1e-9) && near(g.z, 0, 1e-9), `gamma: ${JSON.stringify(g)}`);
  });

  await check('quaternions are unit length for arbitrary angles', async () => {
    for (const [al, be, ga] of [[40, 70, 0], [200, -30, 45], [359, 10, -80]]) {
      const q = orientationToQuaternion(al, be, ga);
      must(near(Math.hypot(q.x, q.y, q.z, q.w), 1, 1e-9), `${al},${be},${ga}`);
    }
  });

  await check('slerp hits both ends and takes the short way round', async () => {
    const a = orientationToQuaternion(0, 0, 0);
    const b = orientationToQuaternion(90, 0, 0);
    const mid = slerp(a, b, 0.5);
    const want = orientationToQuaternion(45, 0, 0);
    must(near(mid.z, want.z, 1e-9) && near(mid.w, want.w, 1e-9), JSON.stringify(mid));
    const flipped = slerp(a, { x: -b.x, y: -b.y, z: -b.z, w: -b.w }, 0.5);
    must(near(Math.abs(flipped.z), want.z, 1e-9), 'went the long way');
  });

  await check('all eight CDP sensor types are offered', async () => {
    must(SENSOR_TYPES.length === 8, String(SENSOR_TYPES.length));
    return SENSOR_TYPES.join(', ');
  });

  const { headQuaternion, rotate } = await dist('ops/sensors.js');
  const base = { alpha: 0, beta: 0, gamma: -85 }; // landscape-left
  // The view direction is the device -z axis; its elevation and azimuth in the
  // Earth frame (z up) are what a VR scene turns into the camera direction.
  const view = (q) => {
    const [x, y, z] = rotate(q, [0, 0, -1]);
    return { el: (Math.asin(z) * 180) / Math.PI, az: (Math.atan2(y, x) * 180) / Math.PI };
  };

  await check('head turn of zero is the base pose', async () => {
    const q = headQuaternion(base, {});
    const want = orientationToQuaternion(0, 0, -85);
    must(near(q.x, want.x, 1e-12) && near(q.y, want.y, 1e-12) && near(q.z, want.z, 1e-12) && near(q.w, want.w, 1e-12), JSON.stringify(q));
  });

  await check('pitch -30 lowers the gaze by 30 degrees and keeps its heading', async () => {
    const level = view(headQuaternion(base, {}));
    const down = view(headQuaternion(base, { pitch: -30 }));
    must(near(down.el - level.el, -30, 1e-6), `elevation ${level.el} -> ${down.el}`);
    must(near(down.az, level.az, 1e-6), `heading moved ${level.az} -> ${down.az}`);
    return `elevation ${level.el.toFixed(1)} -> ${down.el.toFixed(1)}`;
  });

  await check('yaw +20 turns the gaze 20 degrees left; roll leaves the gaze where it is', async () => {
    const level = view(headQuaternion(base, {}));
    const left = view(headQuaternion(base, { yaw: 20 }));
    must(near(left.az - level.az, 20, 1e-6) && near(left.el, level.el, 1e-6), JSON.stringify({ level, left }));
    const rolled = view(headQuaternion(base, { roll: 25 }));
    must(near(rolled.az, level.az, 1e-6) && near(rolled.el, level.el, 1e-6), JSON.stringify({ level, rolled }));
    // Roll toward the right ear tips the head's up direction to the right.
    const up = rotate(headQuaternion(base, { roll: 25 }), [1, 0, 0]); // device +x is up in landscape-left
    const right = rotate(headQuaternion(base, {}), [0, -1, 0]); // and -y is to the right
    must(up[0] * right[0] + up[1] * right[1] + up[2] * right[2] > 0.4, `up after roll ${JSON.stringify(up)}`);
  });
}

/* --------------------------------- part B --------------------------------- */

async function live(fixture) {
  const mcp = await connect();
  try {
    area('B: the page receives what was set');

    await check('the six sensor tools are advertised', async () => {
      const names = (await mcp.tools()).map((t) => t.name).filter((n) => n.startsWith('sensor'));
      must(names.length === 6, names.join(', '));
      return names.join(', ');
    });

    const launched = await mcp.call('browser.launch', { headless: !HEADED, profile: 'sensor-check' });
    mcp.use(launched.browser_id);
    await mcp.call('page.navigate', { url: fixture.url });
    await mcp.call('js.evaluate', { expression: INSTALL_LISTENERS });
    // The case under test is a page that is ALREADY listening, which on a
    // desktop means it has been told "no sensor" (one all-null event) and its
    // event pump has stopped. Let that happen before overriding anything.
    await mcp.call('js.evaluate', { expression: settle(400), await_promise: true });

    await check('before any override, the page was told there is no sensor', async () => {
      const { value } = await mcp.call('js.evaluate', { expression: settle(50), await_promise: true });
      must(value.o.length >= 1 && value.o.every((e) => e[0] === null), JSON.stringify(value.o));
      return `${value.o.length} null event`;
    });

    await check('sensor.orientation: deviceorientation carries the angles', async () => {
      const res = await mcp.call('sensor.orientation', { alpha: 40, beta: 70, gamma: 0 });
      must(res.quaternion && near(Math.hypot(res.quaternion.x, res.quaternion.y, res.quaternion.z, res.quaternion.w), 1, 1e-9), 'no unit quaternion');
      const { value } = await mcp.call('js.evaluate', { expression: settle(), await_promise: true });
      const last = value.o[value.o.length - 1];
      must(last, 'the page received no deviceorientation event');
      must(near(last[0], 40, 0.5) && near(last[1], 70, 0.5) && near(last[2], 0, 0.5), `page saw ${JSON.stringify(last)}`);
      return `page saw alpha ${last[0].toFixed(1)}, beta ${last[1].toFixed(1)}, gamma ${last[2].toFixed(1)}`;
    });

    await check('a named pose sets the angles; explicit angles override it', async () => {
      const res = await mcp.call('sensor.orientation', { pose: 'landscape-left', alpha: 30 });
      must(res.gamma === -85 && res.alpha === 30 && res.beta === 0, JSON.stringify(res));
      const { value } = await mcp.call('js.evaluate', { expression: settle(), await_promise: true });
      const last = value.o[value.o.length - 1];
      must(near(last[2], -85, 0.5) && near(last[0], 30, 0.5), `page saw ${JSON.stringify(last)}`);
      return 'landscape-left, alpha 30';
    });

    await check('beta of exactly 90 comes back with a gimbal-lock warning', async () => {
      const res = await mcp.call('sensor.orientation', { alpha: 0, beta: 90, gamma: 0 });
      must(/gimbal/i.test(res.warning ?? ''), 'no warning');
    });

    await check('sensor.path: smooth motion, many samples, ends on the last keyframe', async () => {
      await mcp.call('js.evaluate', { expression: 'window.__o = []; 0' });
      const res = await mcp.call('sensor.path', {
        pose: 'portrait-upright',
        keyframes: [
          { at_ms: 0, alpha: 0 },
          { at_ms: 600, alpha: 60 },
        ],
        hz: 60,
      });
      must(res.samples >= 10, `only ${res.samples} samples`);
      const { value } = await mcp.call('js.evaluate', { expression: settle(), await_promise: true });
      const alphas = value.o.map((e) => e[0]);
      must(alphas.length >= 8, `page saw only ${alphas.length} events`);
      // Monotonic sweep, allowing sensor-frequency coalescing but not reversal.
      for (let i = 1; i < alphas.length; i++) must(alphas[i] >= alphas[i - 1] - 0.01, `went backwards at ${i}: ${alphas[i - 1]} -> ${alphas[i]}`);
      must(near(alphas[alphas.length - 1], 60, 1), `ended at ${alphas[alphas.length - 1]}`);
      const mids = alphas.filter((a) => a > 5 && a < 55).length;
      must(mids >= 4, `no intermediate samples (${mids}): the motion was not interpolated`);
      return `${res.samples} sent, ${alphas.length} received, ${mids} mid-sweep`;
    });

    await check('a path preset runs and reports what it played', async () => {
      const res = await mcp.call('sensor.path', { preset: 'look-around', amplitude: 30, duration_ms: 500 });
      must(res.keyframes === 4 && res.played_ms >= 450, JSON.stringify(res));
      return `${res.played_ms}ms`;
    });

    area('B: VR head aiming and a realistic phone');

    const { orientationToQuaternion, rotate } = await dist('ops/sensors.js');
    const elevationOf = ([alpha, beta, gamma]) => {
      const [, , z] = rotate(orientationToQuaternion(alpha, beta, gamma), [0, 0, -1]);
      return (Math.asin(z) * 180) / Math.PI;
    };

    await check('sensor.orientation pitch:-30 is a head looking 30 degrees further down, as the page sees it', async () => {
      await mcp.call('sensor.orientation', { pitch: 0 });
      const level = (await mcp.call('js.evaluate', { expression: settle(), await_promise: true })).value.o.at(-1);
      const res = await mcp.call('sensor.orientation', { pitch: -30 });
      must(res.head?.pitch === -30 && res.base?.gamma === -85, JSON.stringify(res));
      const down = (await mcp.call('js.evaluate', { expression: settle(), await_promise: true })).value.o.at(-1);
      const drop = elevationOf(down) - elevationOf(level);
      must(near(drop, -30, 0.5), `page angles ${JSON.stringify(level)} -> ${JSON.stringify(down)}: elevation moved ${drop.toFixed(2)}`);
      return `elevation moved ${drop.toFixed(2)} deg`;
    });

    await check('a perfectly still virtual phone goes quiet (Chrome drops changes under 0.1 deg)', async () => {
      await mcp.call('sensor.orientation', { pitch: -10 });
      await mcp.call('js.evaluate', { expression: settle(200), await_promise: true });
      await mcp.call('js.evaluate', { expression: 'window.__o = []; 0' });
      const { value } = await mcp.call('js.evaluate', { expression: settle(600), await_promise: true });
      must(value.o.length <= 1, `${value.o.length} events while still`);
      return `${value.o.length} events in 600ms`;
    });

    await check('sensor.path hold + jitter + motion: a live, shaking phone with a steady devicemotion stream', async () => {
      await mcp.call('js.evaluate', { expression: 'window.__o = []; window.__m = []; 0' });
      const res = await mcp.call('sensor.path', { preset: 'hold', duration_ms: 1000, jitter_deg: 0.3, motion: true, seed: 7 });
      must(res.noise?.jitter_deg === 0.3 && res.drives.includes('devicemotion'), JSON.stringify(res));
      const { value } = await mcp.call('js.evaluate', { expression: 'new Promise((r) => setTimeout(() => r({ o: window.__o.length, m: window.__m }), 100))', await_promise: true });
      must(value.o >= 20, `only ${value.o} deviceorientation events`);
      const motion = value.m.filter((m) => m.g && m.g.every(Number.isFinite));
      must(motion.length >= 10, `only ${motion.length} devicemotion events with numbers`);
      const g = motion.at(-1).g;
      // Chromium rounds accelerometer readings to 0.1 m/s^2 before a page sees
      // them (the page got [9.8, 0, 0.9] for 9.769, 0, 0.855), so up to
      // 0.05 per axis: 0.09 on the magnitude.
      must(near(Math.hypot(...g), 9.80665, 0.09), `gravity magnitude ${Math.hypot(...g)} from ${JSON.stringify(g)}`);
      // landscape-left: device +x points up, so gravity reads mostly on x.
      must(g[0] > 9, `gravity along device x ${JSON.stringify(g)}`);
      must(motion.some((m) => m.r && m.r.some((v) => Math.abs(v) > 0.5)), 'jitter produced no rotation rate');
      return `${value.o} orientation, ${motion.length} motion events; g ${g.map((v) => v.toFixed(2)).join(',')}`;
    });

    await check('drift turns the heading at the given rate', async () => {
      const res = await mcp.call('sensor.path', { preset: 'hold', duration_ms: 1200, drift_deg_per_min: 600 });
      must(res.noise?.drift_deg_per_min === 600, JSON.stringify(res));
      const { value } = await mcp.call('js.evaluate', { expression: settle(150), await_promise: true });
      const alphas = value.o.slice(-1);
      // 600 deg/min = 10 deg/s, for 1.2 s from the landscape-left base (alpha 0).
      const a = ((alphas[0][0] + 540) % 360) - 180;
      must(near(a, 12, 1.5), `ended at alpha ${alphas[0][0]}`);
      return `alpha ${a.toFixed(1)} after 1.2 s`;
    });

    await check('head keyframes hold a gaze, then return', async () => {
      await mcp.call('js.evaluate', { expression: 'window.__o = []; 0' });
      const res = await mcp.call('sensor.path', {
        keyframes: [
          { at_ms: 0, pitch: 0 },
          { at_ms: 200, pitch: -25 },
          { at_ms: 600, pitch: -25 },
          { at_ms: 800, pitch: 0 },
        ],
      });
      must(res.keyframes === 4, JSON.stringify(res));
      const { value } = await mcp.call('js.evaluate', { expression: settle(150), await_promise: true });
      const els = value.o.map(elevationOf);
      const lowest = Math.min(...els);
      const levelEl = elevationOf([0, 0, -85]);
      must(near(lowest - levelEl, -25, 0.6), `lowest ${lowest} vs level ${levelEl}`);
      must(near(els.at(-1), levelEl, 0.6), `ended at ${els.at(-1)}`);
      return `dipped ${(lowest - levelEl).toFixed(1)} deg`;
    });

    await check('sensor.motion: devicemotion carries acceleration and rotation rate', async () => {
      await mcp.call('sensor.motion', {
        acceleration: { x: 1, y: 2, z: 3 },
        acceleration_including_gravity: { x: 0, y: 9.8, z: 0 },
        rotation_rate: { x: 0.5, y: 0, z: 0 },
      });
      const { value } = await mcp.call('js.evaluate', { expression: settle(700), await_promise: true });
      const m = value.m[value.m.length - 1];
      must(m, 'the page received no devicemotion event');
      must(m.a && near(m.a[0], 1, 0.01) && near(m.a[2], 3, 0.01), `acceleration ${JSON.stringify(m.a)}`);
      must(m.g && near(m.g[1], 9.8, 0.01), `with gravity ${JSON.stringify(m.g)}`);
      // The event reports rotation rate in degrees per second.
      must(m.r && near(m.r[0], (0.5 * 180) / Math.PI, 0.1), `rotation rate ${JSON.stringify(m.r)}`);
      return `rotation ${m.r[0].toFixed(1)} deg/s`;
    });

    area('B: status, missing sensors, reset');

    await check('sensor.status lists what is overridden and what cannot be emulated', async () => {
      const res = await mcp.call('sensor.status');
      must('relative-orientation' in res.overridden && 'gyroscope' in res.overridden, JSON.stringify(res.overridden));
      must(/no proximity/i.test(res.not_available.proximity), 'proximity not explained');
      return Object.keys(res.overridden).join(', ');
    });

    await check('available:false makes the Generic Sensor API report the sensor as unreadable', async () => {
      await mcp.call('sensor.set', { type: 'ambient-light', available: false });
      const res = await mcp.call('sensor.set', { type: 'magnetometer', x: 10, y: 20, z: 30 });
      must(res.reading.xyz.y === 20, JSON.stringify(res));
    });

    await check('bad input is refused with a reason', async () => {
      const cases = [
        ['sensor.set', { type: 'proximity', value: 1 }, /unknown sensor/i],
        ['sensor.set', { type: 'gyroscope', x: 1 }, /x, y and z/i],
        ['sensor.orientation', {}, /alpha\/beta\/gamma/i],
        ['sensor.orientation', { pose: 'upside-down' }, /unknown pose/i],
        ['sensor.path', {}, /keyframes, or a preset/i],
        ['sensor.path', { keyframes: [{ at_ms: 0 }, { at_ms: 120000 }] }, /at most 60/i],
        ['sensor.path', { keyframes: [{ at_ms: 0, alpha: 10, yaw: 5 }, { at_ms: 100 }] }, /mixes/i],
        ['sensor.path', { preset: 'hold', duration_ms: 100, jitter_deg: 9 }, /jitter_deg/i],
      ];
      for (const [tool, args, pattern] of cases) {
        let message = '';
        try {
          await mcp.call(tool, args);
        } catch (err) {
          message = err.message;
        }
        must(pattern.test(message), `${tool} ${JSON.stringify(args)}: ${message || 'did not throw'}`);
      }
      return `${cases.length} refused`;
    });

    await check('sensor.reset clears one type, then everything', async () => {
      const one = await mcp.call('sensor.reset', { type: 'gyroscope' });
      must(JSON.stringify(one.cleared) === '["gyroscope"]', JSON.stringify(one.cleared));
      const all = await mcp.call('sensor.reset');
      must(all.cleared.includes('relative-orientation'), JSON.stringify(all.cleared));
      const status = await mcp.call('sensor.status');
      must(Object.keys(status.overridden).length === 0, JSON.stringify(status.overridden));
      return `${all.cleared.length} cleared`;
    });

    await check('environment.reset also clears sensor overrides', async () => {
      await mcp.call('sensor.orientation', { pose: 'flat-face-up' });
      const res = await mcp.call('environment.reset');
      must(res.cleared.includes('sensors'), JSON.stringify(res.cleared));
      const status = await mcp.call('sensor.status');
      must(Object.keys(status.overridden).length === 0, JSON.stringify(status.overridden));
    });

    await mcp.call('browser.close').catch(() => {});
  } finally {
    await mcp.close();
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
