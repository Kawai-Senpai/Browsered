import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext, ToolRun } from './context.js';
import type { BrowserInstance } from '../browser/instance.js';
import type { CdpSession } from '../cdp/session.js';

/**
 * Motion and orientation sensors: what a phone feels, fed to a desktop tab.
 *
 * A page that reads the gyroscope (a VR viewer, a compass, a tilt game, a
 * shake-to-undo handler) cannot be exercised on a desktop at all: the events
 * never fire. Chromium can virtualise the sensors behind them, and once it
 * does, `deviceorientation`, `devicemotion` and the Generic Sensor API classes
 * all report whatever is set here.
 *
 * Everything goes through Emulation.setSensorOverrideEnabled/Readings. The
 * older DeviceOrientation.setDeviceOrientationOverride is deliberately not
 * used: current Chromium builds answer it with "wasn't found".
 *
 * There is no proximity sensor here because there is nothing to drive:
 * Chromium ships no proximity API to pages and CDP has no override for one.
 */

export interface SensorArgs {
  browser_id?: string;
  target_id?: string;
}

/** CDP Emulation.SensorType, and the shape of reading each one takes. */
const SENSOR_SHAPES = {
  accelerometer: 'xyz',
  'linear-acceleration': 'xyz',
  gravity: 'xyz',
  gyroscope: 'xyz',
  magnetometer: 'xyz',
  'absolute-orientation': 'quaternion',
  'relative-orientation': 'quaternion',
  'ambient-light': 'single',
} as const;

export type SensorType = keyof typeof SENSOR_SHAPES;
export const SENSOR_TYPES = Object.keys(SENSOR_SHAPES) as SensorType[];

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

const DEG = Math.PI / 180;

/**
 * DeviceOrientation angles to a quaternion. The spec defines the rotation as
 * intrinsic Z-X'-Y'' (alpha about z, then beta about the new x, then gamma
 * about the new y), which is the product qz(alpha) * qx(beta) * qy(gamma).
 */
export function orientationToQuaternion(alpha: number, beta: number, gamma: number): Quaternion {
  const [a, b, g] = [alpha * DEG, beta * DEG, gamma * DEG];
  const [cz, sz] = [Math.cos(a / 2), Math.sin(a / 2)];
  const [cx, sx] = [Math.cos(b / 2), Math.sin(b / 2)];
  const [cy, sy] = [Math.cos(g / 2), Math.sin(g / 2)];
  return {
    x: cz * sx * cy - sz * cx * sy,
    y: cz * cx * sy + sz * sx * cy,
    z: sz * cx * cy + cz * sx * sy,
    w: cz * cx * cy - sz * sx * sy,
  };
}

export function slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  let { x, y, z, w } = b;
  let cos = a.x * x + a.y * y + a.z * z + a.w * w;
  if (cos < 0) {
    // Same rotation, opposite sign: take the short way round.
    x = -x;
    y = -y;
    z = -z;
    w = -w;
    cos = -cos;
  }
  if (cos > 0.9995) {
    const q = { x: a.x + (x - a.x) * t, y: a.y + (y - a.y) * t, z: a.z + (z - a.z) * t, w: a.w + (w - a.w) * t };
    const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return { x: a.x * wa + x * wb, y: a.y * wa + y * wb, z: a.z * wa + z * wb, w: a.w * wa + w * wb };
}

/** Hamilton product a * b: rotate by b, then by a (both in the outer frame). */
export function qmul(a: Quaternion, b: Quaternion): Quaternion {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

const conj = (q: Quaternion): Quaternion => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/** Rotation of `deg` degrees about a unit `axis`. */
export function axisAngle(axis: [number, number, number], deg: number): Quaternion {
  const h = (deg * DEG) / 2;
  const s = Math.sin(h);
  return { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(h) };
}

/** v rotated by q. */
export function rotate(q: Quaternion, v: [number, number, number]): [number, number, number] {
  const r = qmul(qmul(q, { x: v[0], y: v[1], z: v[2], w: 0 }), conj(q));
  return [r.x, r.y, r.z];
}

/** Head movement, in degrees: yaw left, pitch up and roll toward the right ear are positive. */
export interface HeadOffset {
  yaw?: number;
  pitch?: number;
  roll?: number;
}

/**
 * The device orientation for a head turned by `head` from a base pose, as a
 * phone strapped in front of the eyes sees it. The screen faces the eyes, so
 * the view direction is the device's -z axis whatever the pose; the head's
 * right axis is horizontal and perpendicular to it. Yaw turns about the
 * world's vertical (Earth z), pitch about the head's right axis, roll about
 * the view direction, in that order.
 *
 * Euler offsets on alpha/beta/gamma only approximate this, and badly once the
 * head is pitched: in landscape, "look down" is not a change of gamma alone.
 */
export function headQuaternion(base: { alpha: number; beta: number; gamma: number }, head: HeadOffset): Quaternion {
  const q0 = orientationToQuaternion(base.alpha, base.beta, base.gamma);
  // World up expressed in device coordinates.
  const up = rotate(conj(q0), [0, 0, 1]);
  // Right = up x back (back is +z, toward the eyes). Looking straight up or
  // down (flat poses) leaves it undefined; the device x axis stands in.
  let right: [number, number, number] = [up[1], -up[0], 0];
  const len = Math.hypot(right[0], right[1]);
  right = len > 1e-6 ? [right[0] / len, right[1] / len, 0] : [1, 0, 0];
  const yaw = axisAngle([0, 0, 1], head.yaw ?? 0);
  const pitch = axisAngle(right, head.pitch ?? 0);
  const roll = axisAngle([0, 0, -1], head.roll ?? 0);
  return qmul(qmul(qmul(yaw, q0), pitch), roll);
}

/** Standard gravity, m/s^2. */
const G = 9.80665;

/**
 * What the motion sensors read for a device at rest in orientation q:
 * the accelerometer feels the reaction to gravity (+g along Earth up), linear
 * acceleration is zero. Rotation rate comes from consecutive orientations.
 */
function restingMotion(q: Quaternion, prev: Quaternion | null, dtMs: number) {
  const [x, y, z] = rotate(conj(q), [0, 0, G]);
  let rate = { x: 0, y: 0, z: 0 };
  if (prev && dtMs > 0) {
    // Body-frame delta rotation, as angle * axis per second.
    let d = qmul(conj(prev), q);
    if (d.w < 0) d = { x: -d.x, y: -d.y, z: -d.z, w: -d.w };
    const angle = 2 * Math.acos(Math.min(1, d.w));
    const s = Math.sqrt(Math.max(0, 1 - d.w * d.w));
    if (s > 1e-9) {
      const k = angle / s / (dtMs / 1000);
      rate = { x: d.x * k, y: d.y * k, z: d.z * k };
    }
  }
  return { accelerometer: { x, y, z }, linear: { x: 0, y: 0, z: 0 }, gyroscope: rate };
}

/** Small seeded PRNG (mulberry32), so a noisy path replays identically. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box-Muller). */
function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

async function pageOf(ctx: OpsContext, args: SensorArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  return { instance, target };
}

/** Which sensors are overridden on which target, for status and reset. */
function overridden(instance: BrowserInstance): Record<string, Record<string, unknown>> {
  let state = instance.emulation.get('sensors') as Record<string, Record<string, unknown>> | undefined;
  if (!state) {
    state = {};
    instance.emulation.set('sensors', state);
  }
  return state;
}

function remember(instance: BrowserInstance, targetHandle: string, type: string, value: unknown): void {
  const state = overridden(instance);
  (state[targetHandle] ??= {})[type] = value;
}

function assertType(type: string): asserts type is SensorType {
  if (!(type in SENSOR_SHAPES)) {
    throw new AgentBrowserError('unknown_sensor', `Unknown sensor "${type}". Available: ${SENSOR_TYPES.join(', ')}.`);
  }
}

/** Which DOM event each virtual sensor feeds. */
const EVENT_OF: Partial<Record<SensorType, string>> = {
  'relative-orientation': 'deviceorientation',
  'absolute-orientation': 'deviceorientationabsolute',
  accelerometer: 'devicemotion',
  'linear-acceleration': 'devicemotion',
  gyroscope: 'devicemotion',
};

/**
 * Turn an override on. Two Chromium behaviours are absorbed here so callers
 * do not have to know them:
 *
 *  - Enabling a sensor that is already overridden is an error, not a no-op.
 *  - A page that started listening before the override exists has already
 *    been told "no sensor" (one all-null event) and its event pump has
 *    stopped. Readings set afterwards never arrive. See restartPump().
 */
async function enable(session: CdpSession, type: SensorType, available = true): Promise<void> {
  try {
    await session.send('Emulation.setSensorOverrideEnabled', { enabled: true, type, metadata: { available } });
  } catch (err) {
    const message = (err as Error).message;
    if (/already overridden/i.test(message)) {
      if (available) return;
      // Switching an overridden sensor to "missing" needs a fresh override.
      await session.trySend('Emulation.setSensorOverrideEnabled', { enabled: false, type });
      await session.send('Emulation.setSensorOverrideEnabled', { enabled: true, type, metadata: { available } });
    } else {
      throw new AgentBrowserError(
        'sensor_unsupported',
        `This Chromium refused to virtualise the ${type} sensor: ${message}. Sensor overrides need Chromium 127 or newer.`,
      );
    }
  }
}

/**
 * Restart the page's event pump for a sensor's DOM event by registering a
 * listener. It must run AFTER the first reading is written: a pump that
 * starts while the virtual sensor has no reading reports "no sensor" and
 * stops again. Started with a reading in place, it delivers that reading to
 * every listener, including the ones that were there before. Without this the
 * tools work only when called before the page starts listening.
 */
async function restartPump(session: CdpSession, types: SensorType[]): Promise<void> {
  const events = [...new Set(types.map((t) => EVENT_OF[t]).filter((e): e is string => Boolean(e)))];
  for (const event of events) {
    await session.trySend('Runtime.evaluate', {
      expression: `(() => { const k = '__browserdSensorPump_${event}'; if (window[k]) removeEventListener('${event}', window[k]); window[k] = () => {}; addEventListener('${event}', window[k]); })()`,
    });
  }
}

async function write(session: CdpSession, type: SensorType, reading: Record<string, unknown>): Promise<void> {
  await session.send('Emulation.setSensorOverrideReadings', { type, reading });
}

/* ------------------------------ orientation ------------------------------ */

/** A pose worth naming: what the device is doing, not three angles. */
const POSES: Record<string, { alpha: number; beta: number; gamma: number; meaning: string }> = {
  'flat-face-up': { alpha: 0, beta: 0, gamma: 0, meaning: 'Lying on a table, screen up.' },
  'portrait-upright': { alpha: 0, beta: 85, gamma: 0, meaning: 'Held upright in portrait, like reading a message.' },
  'landscape-left': { alpha: 0, beta: 0, gamma: -85, meaning: 'Upright in landscape, top of the phone to the left: how a phone sits in a VR headset.' },
  'landscape-right': { alpha: 0, beta: 0, gamma: 85, meaning: 'Upright in landscape, top of the phone to the right.' },
};

interface OrientationArgs extends SensorArgs, HeadOffset {
  alpha?: number;
  beta?: number;
  gamma?: number;
  pose?: string;
  absolute?: boolean;
}

const hasHead = (h: HeadOffset) => h.yaw !== undefined || h.pitch !== undefined || h.roll !== undefined;

function checkHead(h: HeadOffset): void {
  for (const name of ['yaw', 'pitch', 'roll'] as const) {
    const v = h[name];
    if (v !== undefined && !Number.isFinite(v)) throw new AgentBrowserError('bad_args', `${name} must be a number of degrees.`);
  }
}

function resolveAngles(args: { alpha?: number; beta?: number; gamma?: number; pose?: string }) {
  let base = { alpha: 0, beta: 0, gamma: 0 };
  if (args.pose !== undefined) {
    const pose = POSES[args.pose];
    if (!pose) {
      throw new AgentBrowserError('unknown_pose', `Unknown pose "${args.pose}". Available: ${Object.keys(POSES).join(', ')}.`);
    }
    base = { alpha: pose.alpha, beta: pose.beta, gamma: pose.gamma };
  }
  const angles = {
    alpha: args.alpha ?? base.alpha,
    beta: args.beta ?? base.beta,
    gamma: args.gamma ?? base.gamma,
  };
  for (const [name, value] of Object.entries(angles)) {
    if (!Number.isFinite(value)) throw new AgentBrowserError('bad_args', `${name} must be a number of degrees.`);
  }
  return angles;
}

async function writeOrientation(session: CdpSession, q: Quaternion, absolute: boolean): Promise<void> {
  await write(session, 'relative-orientation', { quaternion: q });
  if (absolute) await write(session, 'absolute-orientation', { quaternion: q });
}

export async function setOrientation(ctx: OpsContext, args: OrientationArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('sensor.orientation');
  const head = hasHead(args);
  if (args.alpha === undefined && args.beta === undefined && args.gamma === undefined && args.pose === undefined && !head) {
    throw new AgentBrowserError('bad_args', `Give alpha/beta/gamma in degrees, a pose (${Object.keys(POSES).join(', ')}), or a head turn (yaw/pitch/roll).`);
  }
  checkHead(args);
  // A head turn with no explicit pose is a head in a VR viewer.
  const angles = resolveAngles(head && args.pose === undefined && args.alpha === undefined && args.beta === undefined && args.gamma === undefined ? { pose: 'landscape-left' } : args);
  const quaternion = head ? headQuaternion(angles, args) : orientationToQuaternion(angles.alpha, angles.beta, angles.gamma);
  const absolute = args.absolute ?? false;

  await enable(target.session, 'relative-orientation');
  if (absolute) await enable(target.session, 'absolute-orientation');
  await writeOrientation(target.session, quaternion, absolute);
  await restartPump(target.session, absolute ? ['relative-orientation', 'absolute-orientation'] : ['relative-orientation']);
  const held = head ? { base: angles, yaw: args.yaw ?? 0, pitch: args.pitch ?? 0, roll: args.roll ?? 0 } : angles;
  remember(instance, target.handle, 'relative-orientation', held);
  if (absolute) remember(instance, target.handle, 'absolute-orientation', held);

  // Chromium converts the quaternion back to angles for deviceorientation, and
  // at exactly +-90 degrees beta that conversion is singular.
  const singular = !head && Math.abs(Math.abs(angles.beta) - 90) < 1e-6;
  return {
    target_id: target.handle,
    ...(head ? { base: angles, head: { yaw: args.yaw ?? 0, pitch: args.pitch ?? 0, roll: args.roll ?? 0 } } : angles),
    quaternion,
    drives: absolute ? ['deviceorientation', 'deviceorientationabsolute', 'RelativeOrientationSensor', 'AbsoluteOrientationSensor'] : ['deviceorientation', 'RelativeOrientationSensor'],
    ...(singular
      ? { warning: 'beta is exactly +-90: the page will see beta as null (gimbal lock in the quaternion-to-angle conversion). Use 89 or the portrait-upright pose.' }
      : {}),
    hint: 'The event fires when the reading changes. A page that only listens after this call still gets the current value on its first sample. Call sensor.reset when done.',
  };
}

/* --------------------------------- motion -------------------------------- */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function vec(name: string, v: unknown): Vec3 {
  const o = v as Partial<Vec3> | undefined;
  if (!o || ![o.x, o.y, o.z].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new AgentBrowserError('bad_args', `${name} needs numeric x, y and z.`);
  }
  return { x: o.x!, y: o.y!, z: o.z! };
}

/**
 * devicemotion is assembled from three sensors: linear acceleration,
 * acceleration including gravity, and rotation rate.
 */
export async function setMotion(
  ctx: OpsContext,
  args: SensorArgs & { acceleration?: Vec3; acceleration_including_gravity?: Vec3; rotation_rate?: Vec3 },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('sensor.motion');
  const parts: Array<[SensorType, string, Vec3 | undefined]> = [
    ['linear-acceleration', 'acceleration', args.acceleration],
    ['accelerometer', 'acceleration_including_gravity', args.acceleration_including_gravity],
    ['gyroscope', 'rotation_rate', args.rotation_rate],
  ];
  if (parts.every(([, , v]) => v === undefined)) {
    throw new AgentBrowserError('bad_args', 'Give at least one of acceleration, acceleration_including_gravity (m/s^2) or rotation_rate (rad/s).');
  }
  const set: Record<string, Vec3> = {};
  for (const [type, name, value] of parts) {
    if (value === undefined) continue;
    const xyz = vec(name, value);
    await enable(target.session, type);
    await write(target.session, type, { xyz });
    remember(instance, target.handle, type, xyz);
    set[name] = xyz;
  }
  await restartPump(target.session, ['accelerometer']);
  return {
    target_id: target.handle,
    set,
    units: { acceleration: 'm/s^2', acceleration_including_gravity: 'm/s^2', rotation_rate: 'rad/s (the devicemotion event reports it in deg/s)' },
    drives: ['devicemotion', 'LinearAccelerationSensor', 'Accelerometer', 'Gyroscope'],
  };
}

/* --------------------------------- generic ------------------------------- */

export async function setSensor(
  ctx: OpsContext,
  args: SensorArgs & { type: string; x?: number; y?: number; z?: number; w?: number; value?: number; available?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('sensor.set');
  assertType(args.type);
  const type = args.type;

  if (args.available === false) {
    // "This device has no such sensor": the page's start() fails with NotReadableError.
    await enable(target.session, type, false);
    remember(instance, target.handle, type, 'unavailable');
    return { target_id: target.handle, type, available: false, hint: 'The page now sees this sensor as missing. sensor.reset restores the real one.' };
  }

  const shape = SENSOR_SHAPES[type];
  let reading: Record<string, unknown>;
  if (shape === 'xyz') {
    reading = { xyz: vec(type, { x: args.x, y: args.y, z: args.z }) };
  } else if (shape === 'quaternion') {
    const q = { x: args.x, y: args.y, z: args.z, w: args.w };
    if (!Object.values(q).every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new AgentBrowserError('bad_args', `${type} needs a quaternion: numeric x, y, z and w. For angles, use sensor.orientation.`);
    }
    reading = { quaternion: q };
  } else {
    if (typeof args.value !== 'number' || !Number.isFinite(args.value)) {
      throw new AgentBrowserError('bad_args', `${type} needs a numeric value (lux).`);
    }
    reading = { single: { value: args.value } };
  }
  await enable(target.session, type);
  await write(target.session, type, reading);
  await restartPump(target.session, [type]);
  remember(instance, target.handle, type, Object.values(reading)[0]);
  return { target_id: target.handle, type, reading };
}

/* ---------------------------------- path --------------------------------- */

interface Keyframe extends HeadOffset {
  at_ms: number;
  alpha?: number;
  beta?: number;
  gamma?: number;
}

/** A preset frame: head turn in degrees, relative to the base pose. */
interface HeadFrame extends HeadOffset {
  at_ms: number;
}

/** Scripted head movements, as offsets from a base pose. Negative pitch looks down. */
const PATH_PRESETS: Record<string, { meaning: string; frames: (amplitude: number, duration: number) => HeadFrame[] }> = {
  'look-around': {
    meaning: 'Turn left, then right, then back to centre (yaw sweep).',
    frames: (a, d) => [
      { at_ms: 0, yaw: 0 },
      { at_ms: d * 0.25, yaw: a },
      { at_ms: d * 0.75, yaw: -a },
      { at_ms: d, yaw: 0 },
    ],
  },
  nod: {
    meaning: 'Look down, then up, then level (pitch).',
    frames: (a, d) => [
      { at_ms: 0, pitch: 0 },
      { at_ms: d * 0.25, pitch: -a },
      { at_ms: d * 0.75, pitch: a },
      { at_ms: d, pitch: 0 },
    ],
  },
  spin: {
    meaning: 'One full turn about the vertical axis.',
    frames: (_a, d) => [
      { at_ms: 0, yaw: 0 },
      { at_ms: d / 3, yaw: 120 },
      { at_ms: (2 * d) / 3, yaw: 240 },
      { at_ms: d, yaw: 359.9 },
    ],
  },
  hold: {
    meaning: 'Keep the base pose for the whole duration. With jitter_deg / drift_deg_per_min this is a phone lying still, as a sensor check or a recentre test sees it.',
    frames: (_a, d) => [{ at_ms: 0 }, { at_ms: d }],
  },
};

const MAX_PATH_MS = 60_000;

/**
 * Play an orientation path in real time: keyframes are slerped at `hz` so the
 * page sees smooth motion, which is what smoothing filters, dead zones and
 * "recentre" logic need in order to be tested at all.
 *
 * A real phone is never still: its reading shakes (jitter) and slowly turns
 * (gyro drift), and Chrome only fires deviceorientation when an angle moves
 * 0.1 degree or more, so a perfectly constant virtual pose looks like a dead
 * sensor to anything that counts events. jitter_deg and drift_deg_per_min put
 * that back; motion:true also streams devicemotion (gravity and rotation rate
 * consistent with the path), which Chrome fires at a fixed rate either way.
 */
export async function playPath(
  ctx: OpsContext,
  args: SensorArgs & {
    keyframes?: Keyframe[];
    preset?: string;
    pose?: string;
    amplitude?: number;
    duration_ms?: number;
    hz?: number;
    absolute?: boolean;
    jitter_deg?: number;
    drift_deg_per_min?: number;
    motion?: boolean;
    seed?: number;
  },
  run?: ToolRun,
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('sensor.path');
  const base = resolveAngles({ pose: args.pose ?? 'landscape-left' });
  const absolute = args.absolute ?? false;
  const hz = Math.min(Math.max(args.hz ?? 60, 1), 120);
  const jitter = args.jitter_deg ?? 0;
  const drift = args.drift_deg_per_min ?? 0;
  const motion = args.motion ?? false;
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 5) {
    throw new AgentBrowserError('bad_args', 'jitter_deg is the RMS shake in degrees, 0-5. Real phones sit around 0.02-0.3.');
  }
  if (!Number.isFinite(drift) || Math.abs(drift) > 600) {
    throw new AgentBrowserError('bad_args', 'drift_deg_per_min must be between -600 and 600. Real gyros drift about 0.1-10.');
  }

  let frames: Array<{ at_ms: number; q: Quaternion }>;
  if (args.keyframes?.length) {
    const sorted = [...args.keyframes].sort((a, b) => a.at_ms - b.at_ms);
    if (sorted.some((f) => !Number.isFinite(f.at_ms) || f.at_ms < 0)) {
      throw new AgentBrowserError('bad_args', 'Every keyframe needs a non-negative at_ms.');
    }
    // A keyframe is either absolute angles (a missing angle keeps the base
    // pose's) or a head turn from the base pose; both in one frame is ambiguous.
    frames = sorted.map((f) => {
      const angled = f.alpha !== undefined || f.beta !== undefined || f.gamma !== undefined;
      if (angled && hasHead(f)) {
        throw new AgentBrowserError('bad_args', `Keyframe at ${f.at_ms} ms mixes alpha/beta/gamma with yaw/pitch/roll; use one or the other.`);
      }
      checkHead(f);
      const q = hasHead(f)
        ? headQuaternion(base, f)
        : orientationToQuaternion(f.alpha ?? base.alpha, f.beta ?? base.beta, f.gamma ?? base.gamma);
      return { at_ms: f.at_ms, q };
    });
  } else if (args.preset) {
    const preset = PATH_PRESETS[args.preset];
    if (!preset) {
      throw new AgentBrowserError('unknown_preset', `Unknown path preset "${args.preset}". Available: ${Object.keys(PATH_PRESETS).join(', ')}.`);
    }
    frames = preset.frames(args.amplitude ?? 45, args.duration_ms ?? 4000).map((f) => ({ at_ms: f.at_ms, q: headQuaternion(base, f) }));
  } else {
    throw new AgentBrowserError('bad_args', `Give keyframes, or a preset (${Object.keys(PATH_PRESETS).join(', ')}).`);
  }
  const duration = frames[frames.length - 1]!.at_ms;
  if (duration > MAX_PATH_MS) {
    throw new AgentBrowserError('path_too_long', `A path may run for at most ${MAX_PATH_MS / 1000} seconds; this one is ${Math.round(duration / 1000)}.`);
  }

  const motionTypes: SensorType[] = ['accelerometer', 'linear-acceleration', 'gyroscope'];
  await enable(target.session, 'relative-orientation');
  if (absolute) await enable(target.session, 'absolute-orientation');
  // devicemotion is null while any overridden motion sensor has no reading, so
  // all three are enabled and written together.
  if (motion) for (const type of motionTypes) await enable(target.session, type);
  const label = args.preset ?? 'keyframes';
  remember(instance, target.handle, 'relative-orientation', { path: label, jitter_deg: jitter, drift_deg_per_min: drift });
  if (absolute) remember(instance, target.handle, 'absolute-orientation', { path: label });
  if (motion) for (const type of motionTypes) remember(instance, target.handle, type, { path: label });

  const rand = prng(args.seed ?? 1);
  /** The path's pose at time t, with drift and jitter applied. */
  const sample = (t: number): Quaternion => {
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1]!.at_ms <= t) i++;
    const a = frames[i]!;
    const b = frames[Math.min(i + 1, frames.length - 1)]!;
    const span = b.at_ms - a.at_ms;
    let q = span > 0 ? slerp(a.q, b.q, Math.min(1, Math.max(0, (t - a.at_ms) / span))) : a.q;
    // Drift: a slow turn about the vertical, as a gyro without a compass does.
    if (drift) q = qmul(axisAngle([0, 0, 1], (drift * t) / 60_000), q);
    if (jitter) {
      // Shake: a small rotation about a random device axis.
      const v: [number, number, number] = [gaussian(rand), gaussian(rand), gaussian(rand)];
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      q = qmul(q, axisAngle([v[0] / l, v[1] / l, v[2] / l], gaussian(rand) * jitter));
    }
    return q;
  };

  let prevQ: Quaternion | null = null;
  let prevAt = 0;
  const emit = async (q: Quaternion, at: number) => {
    await writeOrientation(target.session, q, absolute);
    if (motion) {
      const m = restingMotion(q, prevQ, at - prevAt);
      await write(target.session, 'accelerometer', { xyz: m.accelerometer });
      await write(target.session, 'linear-acceleration', { xyz: m.linear });
      await write(target.session, 'gyroscope', { xyz: m.gyroscope });
    }
    prevQ = q;
    prevAt = at;
  };

  await emit(sample(0), Date.now());
  const pumps: SensorType[] = ['relative-orientation'];
  if (absolute) pumps.push('absolute-orientation');
  if (motion) pumps.push('accelerometer');
  await restartPump(target.session, pumps);

  const started = Date.now();
  const interval = 1000 / hz;
  let samples = 0;
  let cancelled = false;
  for (;;) {
    if (run?.signal?.aborted) {
      cancelled = true;
      break;
    }
    const now = Date.now();
    const t = Math.min(now - started, duration);
    await emit(sample(t), now);
    samples++;
    run?.progress?.(t, duration);
    if (t >= duration) break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  // Leave the head at rest on the end pose: a rotation rate left over from the
  // last step would read as the head still turning.
  if (motion) await write(target.session, 'gyroscope', { xyz: { x: 0, y: 0, z: 0 } });

  return {
    target_id: target.handle,
    played_ms: Date.now() - started,
    samples,
    hz_requested: hz,
    keyframes: frames.length,
    ...(cancelled ? { cancelled: true } : {}),
    base_pose: args.pose ?? 'landscape-left',
    ...(jitter || drift ? { noise: { jitter_deg: jitter, drift_deg_per_min: drift, seed: args.seed ?? 1 } } : {}),
    drives: motion ? ['deviceorientation', 'devicemotion'] : ['deviceorientation'],
    hint: 'The last sample stays in effect until the next call or sensor.reset.',
  };
}

/* ------------------------------ status / reset --------------------------- */

export async function status(ctx: OpsContext, args: SensorArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const state = (instance.emulation.get('sensors') as Record<string, Record<string, unknown>> | undefined) ?? {};
  return {
    target_id: target.handle,
    overridden: state[target.handle] ?? {},
    sensor_types: SENSOR_TYPES,
    poses: Object.fromEntries(Object.entries(POSES).map(([name, p]) => [name, p.meaning])),
    path_presets: Object.fromEntries(Object.entries(PATH_PRESETS).map(([name, p]) => [name, p.meaning])),
    not_available: {
      proximity: 'Chromium exposes no proximity sensor to pages and CDP cannot override one.',
      camera: 'A camera feed is a launch option, not a sensor: browser.launch{media:{video_file}} plays a .y4m or .mjpeg file as the camera.',
    },
  };
}

/** Disable every sensor override on one target. Used by sensor.reset and environment.reset. */
export async function clearSensors(instance: BrowserInstance, target: { handle: string; session: CdpSession }, only?: SensorType): Promise<string[]> {
  const state = instance.emulation.get('sensors') as Record<string, Record<string, unknown>> | undefined;
  const mine = state?.[target.handle] ?? {};
  const types = (only ? [only] : (Object.keys(mine) as SensorType[])).filter((t) => t in SENSOR_SHAPES);
  for (const type of types) {
    await target.session.trySend('Emulation.setSensorOverrideEnabled', { enabled: false, type });
    delete mine[type];
  }
  if (state && Object.keys(mine).length === 0) {
    delete state[target.handle];
    if (Object.keys(state).length === 0) instance.emulation.delete('sensors');
  }
  return types;
}

export async function reset(ctx: OpsContext, args: SensorArgs & { type?: string }): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('sensor.reset');
  if (args.type !== undefined) assertType(args.type);
  const cleared = await clearSensors(instance, target, args.type as SensorType | undefined);
  return { target_id: target.handle, cleared, note: cleared.length ? 'The page is back on the real sensors (on a desktop: none).' : 'Nothing was overridden.' };
}
