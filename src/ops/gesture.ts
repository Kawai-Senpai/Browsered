/**
 * Human-shaped pointer gestures: drag, slide, swipe, press and hold, pinch,
 * and a raw pointer sequence for anything those do not cover.
 *
 * page.click teleports the cursor and releases in the same millisecond. That
 * is fine for buttons, but sliders, sortable lists, drawing canvases, map
 * pans, long-press menus and press-and-hold controls need the pointer to
 * travel, linger and stay down, and many of them ignore a gesture that has no
 * intermediate moves. Everything here goes through one engine (`Pointer`) so
 * a press started by page.long_press can be finished by page.drag or
 * page.pointer: the held button and cursor position live per target.
 *
 * Motion model, when `human` is on (the default):
 *   - path: a cubic Bezier with a small random bow to one side, flatter while
 *     a button is held (people drag straighter than they point);
 *   - speed: a minimum-jerk profile (slow start, fast middle, slow arrival);
 *   - duration: Fitts's law from distance and target size, +-15%;
 *   - noise: low-passed Gaussian jitter that tapers to zero at both ends, so
 *     the press and release points are exact;
 *   - short random pauses before pressing and before releasing.
 * `seed` makes all of it reproducible and is always reported back.
 *
 * Native HTML5 drag-and-drop (draggable=true) is not driven by mouse events
 * once it starts: Chromium hands the drag to the OS. While a left button is
 * held we keep Input.setInterceptDrags on, and when Input.dragIntercepted
 * fires the rest of the gesture is replayed as dragEnter/dragOver/drop - the
 * same approach Playwright's CRDragDrop takes.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { evaluate, resolveElement, revealCenter, type ElementLocator } from './element.js';
import { modifiersFromNames } from './keys.js';
import { armMutationWatch, locatorNotes, pointReport, readMutationWatch, type PageArgs } from './page.js';
import { gaussian, prng } from './sensors.js';

type Button = 'left' | 'right' | 'middle';
type InputKind = 'mouse' | 'touch';
interface Point {
  x: number;
  y: number;
}

/** Shared by every gesture tool. */
interface MotionArgs {
  input?: 'auto' | InputKind;
  human?: boolean;
  seed?: number;
  jitter_px?: number;
  modifiers?: string[];
  verify?: boolean;
  verify_ms?: number;
}

// ---------------------------------------------------------------- pointer state

/**
 * What the pointer is doing on one target, kept between calls so a press can
 * outlive the tool that started it. Only the gesture tools update it; a
 * page.click elsewhere does not move `at`.
 */
interface PointerState {
  at: Point | null;
  held: { input: InputKind; button: Button } | null;
  /** Set once Chromium intercepted a native drag that this press started. */
  drag: { data: unknown; entered: boolean } | null;
  stopIntercept: (() => void) | null;
}

const pointers = new WeakMap<ManagedTarget, PointerState>();

function stateOf(target: ManagedTarget): PointerState {
  let state = pointers.get(target);
  if (!state) {
    state = { at: null, held: null, drag: null, stopIntercept: null };
    pointers.set(target, state);
  }
  return state;
}

// ---------------------------------------------------------------- motion math

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Position fraction at time fraction t for a minimum-jerk reach. */
const minJerk = (t: number): number => t * t * t * (10 - 15 * t + 6 * t * t);

/** Fitts's law movement time, stretched while dragging. */
function reachMs(distance: number, width: number, dragging: boolean, rand: () => number): number {
  const base = 90 + 130 * Math.log2(distance / Math.max(width, 8) + 1);
  return clamp(base * (dragging ? 1.6 : 1) * (0.85 + 0.3 * rand()), 60, 3_000);
}

/** Random duration in [lo, hi] when human, else 0. */
const humanPause = (human: boolean, rand: () => number, lo: number, hi: number): number =>
  human ? Math.round(lo + (hi - lo) * rand()) : 0;

interface PathPoint extends Point {
  /** Time fraction in (0, 1] at which this point is reached. */
  t: number;
}

function linearPath(from: Point, to: Point, steps: number): PathPoint[] {
  const out: PathPoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, t });
  }
  return out;
}

function humanPath(
  from: Point,
  to: Point,
  steps: number,
  rand: () => number,
  curve: number,
  jitterPx: number,
): PathPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return [{ ...to, t: 1 }];
  const nx = -dy / distance;
  const ny = dx / distance;
  const bow = Math.min(distance * curve, 120) * (rand() < 0.5 ? -1 : 1);
  const at = (f: number, k: number): Point => ({ x: from.x + dx * f + nx * bow * k, y: from.y + dy * f + ny * bow * k });
  const c1 = at(0.2 + 0.2 * rand(), 0.4 + 0.6 * rand());
  const c2 = at(0.6 + 0.2 * rand(), 0.2 + 0.6 * rand());
  let jx = 0;
  let jy = 0;
  const out: PathPoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const s = minJerk(t);
    const u = 1 - s;
    const bx = u * u * u * from.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * to.x;
    const by = u * u * u * from.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * to.y;
    // Low-passed noise reads as a wobbling hand; white noise reads as a sensor fault.
    jx = 0.7 * jx + 0.3 * gaussian(rand);
    jy = 0.7 * jy + 0.3 * gaussian(rand);
    const taper = Math.sin(Math.PI * t);
    out.push({ x: bx + jx * jitterPx * taper, y: by + jy * jitterPx * taper, t });
  }
  out[out.length - 1] = { ...to, t: 1 };
  return out;
}

const round2 = (p: Point): Point => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

// ---------------------------------------------------------------- engine

const BUTTON_MASK: Record<Button, number> = { left: 1, right: 2, middle: 4 };

class Pointer {
  /** Input events sent, for the report. */
  events = 0;
  html5Drag = false;

  constructor(
    private readonly target: ManagedTarget,
    private readonly state: PointerState,
    readonly input: InputKind,
    readonly human: boolean,
    private readonly rand: () => number,
    private readonly jitterPx: number,
    private readonly modifiers: number,
    private readonly html5: boolean,
  ) {}

  get at(): Point | null {
    return this.state.at;
  }

  get held(): boolean {
    return this.state.held !== null;
  }

  private touchPoint(p: Point): Record<string, unknown> {
    return { x: p.x, y: p.y, radiusX: 4, radiusY: 4, force: 0.6, id: 0 };
  }

  private async dispatchAt(p: Point): Promise<void> {
    const session = this.target.session;
    const held = this.state.held;
    this.events++;
    if (this.input === 'touch') {
      // A finger cannot hover: with nothing down, a move only relocates it.
      if (held) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [this.touchPoint(p)], modifiers: this.modifiers });
      return;
    }
    const drag = this.state.drag;
    if (drag) {
      await session.send('Input.dispatchDragEvent', {
        type: drag.entered ? 'dragOver' : 'dragEnter',
        x: p.x,
        y: p.y,
        data: drag.data,
        modifiers: this.modifiers,
      });
      drag.entered = true;
      this.html5Drag = true;
      return;
    }
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      button: held ? held.button : 'none',
      buttons: held ? BUTTON_MASK[held.button] : 0,
      modifiers: this.modifiers,
      pointerType: 'mouse',
      // A real mouse reports pressure 0.5 while a button is down.
      force: held ? 0.5 : 0,
    });
  }

  /** Travel to `to` along a path, or jump there when there is nowhere to come from. */
  async moveTo(to: Point, opts: { durationMs?: number; steps?: number; targetWidth?: number } = {}): Promise<{ steps: number; ms: number }> {
    const from = this.state.at;
    to = round2(to);
    if (!from || (this.input === 'touch' && !this.held)) {
      if (this.input === 'mouse') await this.dispatchAt(to);
      this.state.at = to;
      return { steps: 1, ms: 0 };
    }
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < 0.5) return { steps: 0, ms: 0 };
    const ms = Math.max(0, opts.durationMs ?? reachMs(distance, opts.targetWidth ?? 24, this.held, this.rand));
    // Chromium acknowledges a touch event only after it has been through the
    // renderer (~50ms headless, measured), so a mouse-rate 16ms cadence would
    // stretch a 200ms flick to half a second. Touch moves are spaced to match.
    const steps = clamp(Math.round(opts.steps ?? ms / (this.input === 'touch' ? 45 : 16)), 1, 400);
    const path = this.human
      ? humanPath(from, to, Math.max(steps, 3), this.rand, this.held ? 0.04 : 0.12, this.jitterPx)
      : linearPath(from, to, steps);
    const started = Date.now();
    for (const point of path) {
      const wait = started + point.t * ms - Date.now();
      if (wait > 0) await delay(wait);
      const p = round2(point);
      await this.dispatchAt(p);
      this.state.at = p;
    }
    return { steps: path.length, ms: Date.now() - started };
  }

  async down(button: Button = 'left'): Promise<void> {
    const at = this.state.at;
    if (!at) throw new AgentBrowserError('no_position', 'The pointer has no position yet; move it somewhere before pressing.');
    if (this.state.held) throw new AgentBrowserError('pointer_held', `The ${this.state.held.button} button is already down. Release it first.`);
    const session = this.target.session;
    this.events++;
    if (this.input === 'touch') {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [this.touchPoint(at)], modifiers: this.modifiers });
      this.state.held = { input: 'touch', button: 'left' };
      return;
    }
    if (this.html5 && button === 'left') {
      const state = this.state;
      const off = session.on('Input.dragIntercepted', (params) => {
        if (!state.drag) state.drag = { data: params.data, entered: false };
      });
      await session.send('Input.setInterceptDrags', { enabled: true });
      state.stopIntercept = () => {
        off();
        void session.trySend('Input.setInterceptDrags', { enabled: false });
      };
    }
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: at.x,
      y: at.y,
      button,
      buttons: BUTTON_MASK[button],
      clickCount: 1,
      modifiers: this.modifiers,
      pointerType: 'mouse',
      force: 0.5,
    });
    this.state.held = { input: 'mouse', button };
  }

  async up(): Promise<void> {
    const at = this.state.at;
    const held = this.state.held;
    if (!at || !held) throw new AgentBrowserError('not_held', 'No button or finger is down, so there is nothing to release.');
    const session = this.target.session;
    this.events++;
    try {
      if (held.input === 'touch') {
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers: this.modifiers });
        return;
      }
      // dragIntercepted arrives asynchronously; give a drag begun by the last move a moment to show up.
      if (this.state.stopIntercept && !this.state.drag) await delay(40);
      const drag = this.state.drag;
      if (drag) {
        if (!drag.entered) {
          await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x: at.x, y: at.y, data: drag.data, modifiers: this.modifiers });
        }
        // Chromium ends an intercepted drag with drop; a mouseReleased after it would land on nothing.
        await session.send('Input.dispatchDragEvent', { type: 'drop', x: at.x, y: at.y, data: drag.data, modifiers: this.modifiers });
        this.html5Drag = true;
        return;
      }
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: at.x,
        y: at.y,
        button: held.button,
        buttons: 0,
        clickCount: 1,
        modifiers: this.modifiers,
        pointerType: 'mouse',
      });
    } finally {
      this.state.held = null;
      this.state.drag = null;
      this.state.stopIntercept?.();
      this.state.stopIntercept = null;
    }
  }

  /**
   * Stay put for `ms`. A held mouse in a human hand creeps by a pixel now and
   * then; a finger does not, because Chromium suppresses touchmoves inside the
   * slop region and a page would never see them.
   */
  async pause(ms: number, until?: () => Promise<boolean>): Promise<{ ms: number; until_met?: boolean }> {
    const started = Date.now();
    const anchor = this.state.at;
    const creep = this.human && this.input === 'mouse' && this.held && anchor !== null && this.state.drag === null;
    let nextCreep = started + 150 + 250 * this.rand();
    while (Date.now() - started < ms) {
      if (until && (await until())) return { ms: Date.now() - started, until_met: true };
      if (creep && Date.now() >= nextCreep) {
        const p = round2({ x: anchor.x + clamp(gaussian(this.rand) * 0.5, -1, 1), y: anchor.y + clamp(gaussian(this.rand) * 0.5, -1, 1) });
        await this.dispatchAt(p);
        this.state.at = p;
        nextCreep = Date.now() + 150 + 250 * this.rand();
      }
      await delay(Math.min(until ? 100 : 50, Math.max(0, ms - (Date.now() - started))));
    }
    const met = until ? await until() : undefined;
    return { ms: Date.now() - started, ...(met !== undefined ? { until_met: met } : {}) };
  }

  /** Wheel at the current position; a human wheel arrives in notches, not one jump. */
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    const at = this.state.at ?? { x: 1, y: 1 };
    const notches = this.human ? Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 100)) : 1;
    for (let i = 0; i < notches; i++) {
      this.events++;
      await this.target.session.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: at.x, y: at.y, deltaX: deltaX / notches, deltaY: deltaY / notches, modifiers: this.modifiers, pointerType: 'mouse' },
        5_000,
      );
      if (i < notches - 1) await delay(humanPause(true, this.rand, 25, 70));
    }
  }
}

// ---------------------------------------------------------------- shared plumbing

async function pageOf(ctx: OpsContext, args: { browser_id?: string; target_id?: string }) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = await instance.resolvePageOrOpen(args.target_id);
  return { instance, target };
}

function hasLocator(loc: ElementLocator): boolean {
  return loc.selector !== undefined || loc.xpath !== undefined || loc.text !== undefined || loc.ref !== undefined || loc.backend_node_id !== undefined;
}

interface Located {
  point: Point;
  /** Smaller side of the element box: the Fitts target width. */
  width: number;
  description: string;
  notes: Record<string, unknown>;
  objectId?: string;
}

/** Locator first, then x/y. Scrolls the element into view, like page.click. */
async function locate(
  instance: BrowserInstance,
  target: ManagedTarget,
  loc: ElementLocator & { x?: number; y?: number },
): Promise<Located | null> {
  if (hasLocator(loc)) {
    const element = await resolveElement(instance, target, loc, { preferVisible: true });
    const box = await revealCenter(target.session, element.objectId);
    return {
      point: { x: box.x, y: box.y },
      width: Math.min(box.width, box.height),
      description: element.description,
      notes: { ...locatorNotes(element), ...(box.revealedBy ? { revealed_by_hovering: box.revealedBy } : {}) },
      objectId: element.objectId,
    };
  }
  if (loc.x !== undefined && loc.y !== undefined) {
    const point = { x: Number(loc.x), y: Number(loc.y) };
    return { point, width: 24, description: (await elementAt(instance, target, point)) ?? `point ${point.x},${point.y}`, notes: {} };
  }
  return null;
}

async function viewportSize(target: ManagedTarget): Promise<{ width: number; height: number }> {
  const metrics = await target.session.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics');
  return { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight };
}

/** Short description of whatever is under a viewport point, or null. */
async function elementAt(instance: BrowserInstance, target: ManagedTarget, p: Point): Promise<string | null> {
  try {
    const { result } = await evaluate(instance, target, {
      expression: `(() => {
        const e = document.elementFromPoint(${p.x}, ${p.y});
        if (!e) return null;
        let s = '<' + e.tagName.toLowerCase();
        if (e.id) s += ' #' + e.id;
        const cls = typeof e.className === 'string' ? e.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3) : [];
        if (cls.length) s += (e.id ? '' : ' ') + '.' + cls.join('.');
        return s + '>';
      })()`,
      returnByValue: true,
      awaitPromise: false,
    });
    return typeof result.value === 'string' ? result.value : null;
  } catch {
    return null;
  }
}

function inputFor(instance: BrowserInstance, target: ManagedTarget, state: PointerState, asked?: 'auto' | InputKind): InputKind {
  if (state.held) {
    if (asked && asked !== 'auto' && asked !== state.held.input) {
      throw new AgentBrowserError('pointer_held', `A ${state.held.input} press is still down on this tab; finish it with ${state.held.input} input or release it first.`);
    }
    return state.held.input;
  }
  if (asked === 'mouse' || asked === 'touch') return asked;
  return instance.touchTargets.has(target.handle) ? 'touch' : 'mouse';
}

function engine(target: ManagedTarget, state: PointerState, input: InputKind, args: MotionArgs, html5: boolean) {
  const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31);
  const human = args.human !== false;
  const rand = prng(seed);
  const pointer = new Pointer(target, state, input, human, rand, clamp(args.jitter_px ?? 1.5, 0, 20), modifiersFromNames(args.modifiers), html5);
  return { pointer, seed, human, rand };
}

async function verifyAfter(
  instance: BrowserInstance,
  target: ManagedTarget,
  armed: boolean,
  verifyMs: number,
): Promise<Record<string, unknown>> {
  if (!armed) return {};
  await delay(verifyMs);
  const mutations = await readMutationWatch(instance, target);
  if (mutations === 0) {
    return { observed_change: false, note: `No DOM mutation within ${verifyMs}ms of the gesture. The input was dispatched; whether the page handled it is not shown.` };
  }
  return { observed_change: true, ...(mutations < 0 ? { changed_by: 'navigation' } : { dom_mutations: mutations }) };
}

const verifyMsOf = (args: MotionArgs): number => clamp(args.verify_ms ?? 300, 50, 5_000);

// ---------------------------------------------------------------- page.drag

export interface DragArgs extends PageArgs, MotionArgs {
  x?: number;
  y?: number;
  to_selector?: string;
  to_xpath?: string;
  to_text?: string;
  to_ref?: string;
  to_backend_node_id?: number;
  to_nth?: number;
  to_x?: number;
  to_y?: number;
  by_x?: number;
  by_y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  distance?: number;
  button?: Button;
  duration_ms?: number;
  steps?: number;
  hold_ms?: number;
  settle_ms?: number;
  html5?: boolean;
  release?: boolean;
}

export async function drag(ctx: OpsContext, args: DragArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.drag');
  const state = stateOf(target);
  const input = inputFor(instance, target, state, args.input);
  const continuing = state.held !== null;
  if (continuing && (hasLocator(args) || args.x !== undefined)) {
    throw new AgentBrowserError(
      'pointer_held',
      'A press is still down from an earlier call, so the drag continues from where it is. Drop the source locator/x/y, or release first with page.pointer actions:[{action:"up"}].',
    );
  }

  // Source first (it may scroll), then the destination, then re-measure the
  // source in case bringing the destination into view scrolled it away.
  let from: Located | null = continuing ? { point: state.at!, width: 24, description: 'the held pointer', notes: {} } : await locate(instance, target, args);
  const viewport = await viewportSize(target);
  if (!from && args.direction) {
    from = { point: { x: viewport.width / 2, y: viewport.height / 2 }, width: 24, description: 'viewport centre', notes: {} };
  }
  if (!from) {
    throw new AgentBrowserError('missing_from', 'Say where the drag starts: a locator (selector, ref, text...), or x and y.');
  }

  const toLoc: ElementLocator = {
    selector: args.to_selector,
    xpath: args.to_xpath,
    text: args.to_text,
    ref: args.to_ref,
    backend_node_id: args.to_backend_node_id,
    nth: args.to_nth,
    frame_id: args.frame_id,
  };
  let to: Located;
  const notes: string[] = [];
  if (hasLocator(toLoc)) {
    to = (await locate(instance, target, toLoc))!;
    if (from.objectId) {
      const again = await locate(instance, target, args);
      if (again && Math.hypot(again.point.x - from.point.x, again.point.y - from.point.y) > 1) {
        from = again;
        const toAgain = await locate(instance, target, toLoc);
        if (toAgain && Math.hypot(toAgain.point.x - to.point.x, toAgain.point.y - to.point.y) > 1) {
          notes.push('The source and destination do not fit in the viewport together; the destination point may be off screen. A larger viewport or page.pointer with a wheel step mid-drag will help.');
        }
        if (toAgain) to = toAgain;
      }
    }
  } else if (args.to_x !== undefined && args.to_y !== undefined) {
    to = { point: { x: args.to_x, y: args.to_y }, width: 24, description: `point ${args.to_x},${args.to_y}`, notes: {} };
  } else if (args.by_x !== undefined || args.by_y !== undefined) {
    to = { point: { x: from.point.x + (args.by_x ?? 0), y: from.point.y + (args.by_y ?? 0) }, width: 24, description: 'offset', notes: {} };
  } else if (args.direction) {
    const d = args.distance ?? Math.round((args.direction === 'up' || args.direction === 'down' ? viewport.height : viewport.width) * 0.5);
    const v = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[args.direction];
    to = { point: { x: from.point.x + v[0]! * d, y: from.point.y + v[1]! * d }, width: 24, description: `${args.direction} ${d}px`, notes: {} };
  } else {
    throw new AgentBrowserError('missing_to', 'Say where the drag ends: to_selector/to_ref/to_text, to_x+to_y, by_x/by_y, or direction (+distance).');
  }

  const end = { x: clamp(to.point.x, 1, viewport.width - 2), y: clamp(to.point.y, 1, viewport.height - 2) };
  const clamped = end.x !== to.point.x || end.y !== to.point.y;
  if (clamped) notes.push(`The end point ${Math.round(to.point.x)},${Math.round(to.point.y)} was outside the ${viewport.width}x${viewport.height} viewport and was pulled inside it.`);

  const { pointer, seed, human, rand } = engine(target, state, input, args, args.html5 !== false);
  const verify = args.verify !== false;
  const armed = verify ? await armMutationWatch(instance, target) : false;
  const started = Date.now();

  if (!continuing) {
    if (input === 'mouse') {
      await pointer.moveTo(from.point, { targetWidth: from.width });
      await pointer.pause(humanPause(human, rand, 40, 120));
    } else {
      await pointer.moveTo(from.point);
    }
    await pointer.down(args.button ?? 'left');
  }
  /*
   * A swipe is a flick: quick travel and a release while still moving, which
   * is what gives scrollers and carousels their fling velocity. Pausing before
   * the release, as a drop does, would zero that velocity out.
   */
  const swipe = Boolean(args.direction) && !hasLocator(toLoc) && args.to_x === undefined && args.by_x === undefined && args.by_y === undefined;
  const swipeMs = swipe ? clamp(140 + Math.hypot(end.x - from.point.x, end.y - from.point.y) * 0.4, 150, 500) : undefined;
  const held = await pointer.pause(args.hold_ms ?? humanPause(human, rand, swipe ? 15 : 70, swipe ? 50 : 180));
  const travel = await pointer.moveTo(end, { durationMs: args.duration_ms ?? swipeMs, steps: args.steps, targetWidth: to.width });
  const settle = await pointer.pause(args.settle_ms ?? (swipe ? 0 : humanPause(human, rand, 60, 160)));
  const release = args.release !== false;
  if (release) await pointer.up();
  const elapsed = Date.now() - started;

  return {
    target_id: target.handle,
    dragged: from.description,
    from: await pointReport(instance, target, from.point),
    to: await pointReport(instance, target, end),
    destination: to.description,
    over: await elementAt(instance, target, end),
    input,
    html5_drag: pointer.html5Drag,
    released: release,
    ...(release ? {} : { still_held: 'Finish with page.pointer actions:[{action:"up"}], or keep going with another page.drag.' }),
    timing: { held_ms: held.ms, travel_ms: travel.ms, settle_ms: settle.ms, total_ms: elapsed, steps: travel.steps },
    human,
    seed,
    events: pointer.events,
    ...from.notes,
    ...(notes.length ? { notes } : {}),
    ...(release ? await verifyAfter(instance, target, armed, verifyMsOf(args)) : {}),
  };
}

// ---------------------------------------------------------------- page.long_press

export interface LongPressArgs extends PageArgs, MotionArgs {
  x?: number;
  y?: number;
  button?: Button;
  duration_ms?: number;
  until_selector?: string;
  until_text?: string;
  until_gone?: boolean;
  release?: boolean;
}

export async function longPress(ctx: OpsContext, args: LongPressArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.long_press');
  const state = stateOf(target);
  if (state.held) throw new AgentBrowserError('pointer_held', 'A press is already down on this tab. Release it with page.pointer actions:[{action:"up"}] first.');
  const input = inputFor(instance, target, state, args.input);
  const at = await locate(instance, target, args);
  if (!at) throw new AgentBrowserError('missing_target', 'Say what to press: a locator (selector, ref, text...), or x and y.');

  const watching = args.until_selector !== undefined || args.until_text !== undefined;
  const holdMs = clamp(args.duration_ms ?? (watching ? 15_000 : 800), 0, 120_000);
  const until = watching
    ? async (): Promise<boolean> => {
        const sel = JSON.stringify(args.until_selector ?? null);
        const text = JSON.stringify(args.until_text ?? null);
        try {
          const { result } = await evaluate(instance, target, {
            expression: `(() => {
              const sel = ${sel}, text = ${text};
              const present = sel !== null ? !!document.querySelector(sel) : (document.body ? document.body.innerText.includes(text) : false);
              return ${args.until_gone ? '!present' : 'present'};
            })()`,
            returnByValue: true,
            awaitPromise: false,
          });
          return result.value === true;
        } catch {
          // The context went away: the hold navigated. That counts as done.
          return true;
        }
      }
    : undefined;

  const { pointer, seed, human, rand } = engine(target, state, input, args, false);
  const verify = args.verify !== false;
  const armed = verify ? await armMutationWatch(instance, target) : false;
  if (input === 'mouse') {
    await pointer.moveTo(at.point, { targetWidth: at.width });
    await pointer.pause(humanPause(human, rand, 40, 120));
  } else {
    await pointer.moveTo(at.point);
  }
  await pointer.down(args.button ?? 'left');
  const held = await pointer.pause(holdMs, until);
  const release = args.release !== false;
  if (release) await pointer.up();

  return {
    target_id: target.handle,
    pressed: at.description,
    at: await pointReport(instance, target, at.point),
    input,
    held_ms: held.ms,
    ...(held.until_met !== undefined ? { until_met: held.until_met } : {}),
    ...(watching && held.until_met === false ? { note: `The condition did not come true within ${holdMs}ms; the press was ${release ? 'released anyway' : 'left down'}.` } : {}),
    released: release,
    ...(release ? {} : { still_held: 'Finish with page.pointer actions:[{action:"up"}], or drag on with page.drag (no source locator).' }),
    human,
    seed,
    ...at.notes,
    ...(release ? await verifyAfter(instance, target, armed, verifyMsOf(args)) : {}),
  };
}

// ---------------------------------------------------------------- page.pinch

export interface PinchArgs extends PageArgs, MotionArgs {
  x?: number;
  y?: number;
  scale?: number;
  rotate_deg?: number;
  start_distance?: number;
  angle_deg?: number;
  duration_ms?: number;
}

export async function pinch(ctx: OpsContext, args: PinchArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.pinch');
  const state = stateOf(target);
  if (state.held) throw new AgentBrowserError('pointer_held', 'A press is still down on this tab. Release it with page.pointer actions:[{action:"up"}] first.');
  const scale = args.scale ?? 1;
  const rotate = args.rotate_deg ?? 0;
  if (!(scale > 0)) throw new AgentBrowserError('bad_scale', 'scale must be above 0: under 1 pinches in, over 1 spreads out.');
  if (scale === 1 && rotate === 0) throw new AgentBrowserError('no_gesture', 'Give scale (e.g. 2 to zoom in, 0.5 to zoom out) and/or rotate_deg.');

  const viewport = await viewportSize(target);
  const located = await locate(instance, target, args);
  const centre = located?.point ?? { x: viewport.width / 2, y: viewport.height / 2 };
  const d0 = clamp(args.start_distance ?? 120, 10, 2_000);
  const d1 = Math.max(10, d0 * scale);
  const a0 = ((args.angle_deg ?? 0) * Math.PI) / 180;
  const a1 = a0 + (rotate * Math.PI) / 180;
  const ms = clamp(args.duration_ms ?? 450, 50, 10_000);
  // Touch-rate cadence; see Pointer.moveTo.
  const steps = clamp(Math.round(ms / 45), 3, 400);
  const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rand = prng(seed);
  const human = args.human !== false;
  const jitter = human ? clamp(args.jitter_px ?? 1, 0, 20) : 0;
  const modifiers = modifiersFromNames(args.modifiers);

  const fingers = (d: number, a: number, wobble: number): Array<Record<string, unknown>> => {
    const ox = (Math.cos(a) * d) / 2;
    const oy = (Math.sin(a) * d) / 2;
    return [
      { x: centre.x - ox + gaussian(rand) * wobble, y: centre.y - oy + gaussian(rand) * wobble, id: 0 },
      { x: centre.x + ox + gaussian(rand) * wobble, y: centre.y + oy + gaussian(rand) * wobble, id: 1 },
    ].map((p) => ({ ...round2(p), radiusX: 4, radiusY: 4, force: 0.6, id: p.id }));
  };

  const verify = args.verify !== false;
  const armed = verify ? await armMutationWatch(instance, target) : false;
  const session = target.session;
  const start = fingers(d0, a0, 0);
  // Two fingers rarely land on the same frame.
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start[0]], modifiers });
  if (human) await delay(humanPause(true, rand, 12, 40));
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: start, modifiers });
  const started = Date.now();
  try {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const s = human ? minJerk(t) : t;
      const wait = started + t * ms - Date.now();
      if (wait > 0) await delay(wait);
      const wobble = i === steps ? 0 : jitter * Math.sin(Math.PI * t);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(d0 + (d1 - d0) * s, a0 + (a1 - a0) * s, wobble), modifiers });
    }
  } finally {
    await session.trySend('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers });
  }

  return {
    target_id: target.handle,
    centre: await pointReport(instance, target, centre),
    on: located?.description ?? (await elementAt(instance, target, centre)),
    finger_distance: { from: Math.round(d0), to: Math.round(d1) },
    scale,
    rotate_deg: rotate,
    duration_ms: Date.now() - started,
    steps,
    human,
    seed,
    ...(instance.touchTargets.has(target.handle)
      ? {}
      : { hint: 'Touch emulation is off on this tab, so the page may not listen for touch at all. device.preset or device.viewport with touch:true makes it a touch device.' }),
    ...(located?.notes ?? {}),
    ...(await verifyAfter(instance, target, armed, verifyMsOf(args))),
  };
}

// ---------------------------------------------------------------- page.pointer

export interface PointerAction extends ElementLocator {
  action: 'move' | 'down' | 'up' | 'click' | 'pause' | 'wheel';
  x?: number;
  y?: number;
  button?: Button;
  duration_ms?: number;
  delta_x?: number;
  delta_y?: number;
}

export interface PointerArgs extends MotionArgs {
  browser_id?: string;
  target_id?: string;
  actions: PointerAction[];
  html5?: boolean;
}

export async function pointerSequence(ctx: OpsContext, args: PointerArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.pointer');
  if (!Array.isArray(args.actions) || args.actions.length === 0) {
    throw new AgentBrowserError('no_actions', 'actions is empty. Example: [{action:"move",selector:"#a"},{action:"down"},{action:"move",x:400,y:300},{action:"up"}].');
  }
  if (args.actions.length > 200) throw new AgentBrowserError('too_many_actions', 'At most 200 actions per call; split the sequence.');
  const state = stateOf(target);
  const input = inputFor(instance, target, state, args.input);
  const { pointer, seed, human, rand } = engine(target, state, input, args, args.html5 !== false);
  const verify = args.verify !== false;
  const armed = verify ? await armMutationWatch(instance, target) : false;
  const log: Array<Record<string, unknown>> = [];
  const started = Date.now();

  for (const [index, step] of args.actions.entries()) {
    const t0 = Date.now();
    const located = step.action === 'pause' ? null : await locate(instance, target, step);
    const entry: Record<string, unknown> = { action: step.action };
    if (located) entry.on = located.description;
    try {
      switch (step.action) {
        case 'move': {
          if (!located) throw new AgentBrowserError('missing_target', 'move needs a locator or x and y.');
          const r = await pointer.moveTo(located.point, { durationMs: step.duration_ms, targetWidth: located.width });
          entry.steps = r.steps;
          break;
        }
        case 'down':
        case 'up':
        case 'click': {
          if (located) await pointer.moveTo(located.point, { durationMs: step.duration_ms, targetWidth: located.width });
          if (step.action !== 'up') await pointer.down(step.button ?? 'left');
          if (step.action === 'click') await pointer.pause(humanPause(human, rand, 50, 110));
          if (step.action !== 'down') await pointer.up();
          break;
        }
        case 'pause':
          await pointer.pause(clamp(step.duration_ms ?? 200, 0, 60_000));
          break;
        case 'wheel':
          if (located) await pointer.moveTo(located.point, { targetWidth: located.width });
          await pointer.wheel(step.delta_x ?? 0, step.delta_y ?? 0);
          break;
        default:
          throw new AgentBrowserError('bad_action', `Unknown action "${String((step as { action: unknown }).action)}". Use move, down, up, click, pause or wheel.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentBrowserError('pointer_step_failed', `Step ${index} (${step.action}) failed: ${message}`, {
        completed: log,
        position: state.at,
        held: state.held,
      });
    }
    entry.at = state.at;
    entry.ms = Date.now() - t0;
    log.push(entry);
  }

  return {
    target_id: target.handle,
    input,
    steps: log,
    position: state.at,
    held: state.held,
    ...(state.held ? { still_held: `The ${state.held.button} ${state.held.input === 'touch' ? 'finger' : 'button'} is still down; a later page.pointer or page.drag continues from here.` } : {}),
    html5_drag: pointer.html5Drag,
    total_ms: Date.now() - started,
    human,
    seed,
    events: pointer.events,
    ...(state.held ? {} : await verifyAfter(instance, target, armed, verifyMsOf(args))),
  };
}
