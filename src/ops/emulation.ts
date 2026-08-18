import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';

export interface EmulationArgs {
  browser_id?: string;
  target_id?: string;
}

async function pageOf(ctx: OpsContext, args: EmulationArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  return { instance, target };
}

/* -------------------------------- device -------------------------------- */

interface DevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
}

const DEVICE_PRESETS: Record<string, DevicePreset> = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  'desktop-hidpi': { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, touch: false },
  laptop: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
  iphone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  // The modern SE. The 320px original is `phone-small`.
  'iphone-se': { width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true },
  /*
   * 320 is the narrowest width that still turns up in the wild - the original
   * iPhone SE, and the effective width of several email-client webviews. It is
   * also where layouts actually break: bugs that reproduce at 320 are routinely
   * invisible at 390, so leaving it out of the preset list meant it got skipped.
   */
  'phone-small': { width: 320, height: 568, deviceScaleFactor: 2, mobile: true, touch: true },
  pixel: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, touch: true },
  ipad: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
};

export async function devicePreset(
  ctx: OpsContext,
  args: EmulationArgs & { preset: string; orientation?: 'portrait' | 'landscape' },
): Promise<Record<string, unknown>> {
  const preset = DEVICE_PRESETS[args.preset.toLowerCase()];
  if (!preset) {
    throw new AgentBrowserError(
      'unknown_preset',
      `Unknown device preset "${args.preset}". Available: ${Object.keys(DEVICE_PRESETS).join(', ')}.`,
    );
  }
  const landscape = args.orientation === 'landscape';
  return setViewport(ctx, {
    ...args,
    width: landscape ? preset.height : preset.width,
    height: landscape ? preset.width : preset.height,
    device_scale_factor: preset.deviceScaleFactor,
    mobile: preset.mobile,
    touch: preset.touch,
    ...(preset.userAgent ? { user_agent: preset.userAgent } : {}),
    ...(args.orientation ? { orientation: args.orientation } : {}),
  });
}

export async function setViewport(
  ctx: OpsContext,
  args: EmulationArgs & {
    width: number;
    height: number;
    device_scale_factor?: number;
    mobile?: boolean;
    touch?: boolean;
    user_agent?: string;
    orientation?: 'portrait' | 'landscape';
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('device.viewport');

  const metrics: Record<string, unknown> = {
    width: args.width,
    height: args.height,
    deviceScaleFactor: args.device_scale_factor ?? 1,
    mobile: args.mobile ?? false,
  };

  if (args.orientation) {
    metrics.screenOrientation = {
      type: args.orientation === 'landscape' ? 'landscapePrimary' : 'portraitPrimary',
      angle: args.orientation === 'landscape' ? 90 : 0,
    };
  }
  await target.session.send('Emulation.setDeviceMetricsOverride', metrics);

  if (args.touch !== undefined) {
    // Touch emulation makes the page see a touch device (ontouchstart, hover
    // media queries, touch-action). It is deliberately NOT paired with
    // Emulation.setEmitTouchEventsForMouse: that flag makes Chromium stop
    // acknowledging Input.dispatchMouseEvent, which wedges every click tool
    // for the lifetime of the target and is not undone by disabling it again.
    // page.click synthesises touch events itself when touch is active.
    // maxTouchPoints must be 1..16 when enabling and must be omitted when
    // disabling: Chromium rejects 0 outright.
    await target.session.trySend(
      'Emulation.setTouchEmulationEnabled',
      args.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
    );
  }
  if (args.user_agent) {
    await target.session.trySend('Emulation.setUserAgentOverride', { userAgent: args.user_agent });
  }

  instance.emulation.set('device', {
    width: args.width,
    height: args.height,
    device_scale_factor: args.device_scale_factor ?? 1,
    mobile: args.mobile ?? false,
    touch: args.touch ?? false,
  });
  if (args.touch === true) instance.touchTargets.add(target.handle);
  else if (args.touch === false) instance.touchTargets.delete(target.handle);

  return {
    target_id: target.handle,
    viewport: { width: args.width, height: args.height },
    device_scale_factor: args.device_scale_factor ?? 1,
    mobile: args.mobile ?? false,
    touch: args.touch ?? false,
    ...(args.user_agent ? { user_agent: args.user_agent } : {}),
    hint: args.mobile
      ? 'Screen size is emulated. A page without <meta name="viewport"> still lays out at the 980px mobile default, exactly as a real phone renders it, so innerWidth may not equal the width set here.'
      : 'Take a page.screenshot to see the new layout.',
    ...(args.touch
      ? {
          touch_note:
            'navigator.maxTouchPoints is live immediately, but feature checks that read `ontouchstart in window` are decided at document creation: page.reload for those to see the touch device. Clicks are dispatched as taps either way.',
        }
      : {}),
  };
}

export async function setOrientation(
  ctx: OpsContext,
  args: EmulationArgs & { orientation: 'portrait' | 'landscape' },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('device.orientation');
  const current = instance.emulation.get('device') as { width: number; height: number; device_scale_factor: number; mobile: boolean } | undefined;
  if (!current) {
    throw new AgentBrowserError(
      'no_viewport',
      'Set a viewport first (device.preset or device.viewport); orientation rotates an emulated screen.',
    );
  }
  const landscape = args.orientation === 'landscape';
  const long = Math.max(current.width, current.height);
  const short = Math.min(current.width, current.height);
  return setViewport(ctx, {
    ...args,
    width: landscape ? long : short,
    height: landscape ? short : long,
    device_scale_factor: current.device_scale_factor,
    mobile: current.mobile,
  });
}

export async function resetDevice(ctx: OpsContext, args: EmulationArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('device.reset');
  await target.session.trySend('Emulation.clearDeviceMetricsOverride');
  await target.session.trySend('Emulation.setTouchEmulationEnabled', { enabled: false });
  await target.session.trySend('Emulation.setUserAgentOverride', { userAgent: '' });
  instance.emulation.delete('device');
  instance.touchTargets.delete(target.handle);
  // ontouchstart is decided at document creation, so the flag alone does not
  // remove it from an already-loaded page.
  return { target_id: target.handle, reset: true };
}

/* --------------------------------- CPU ---------------------------------- */

export async function throttleCpu(
  ctx: OpsContext,
  args: EmulationArgs & { rate: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('cpu.throttle');
  const rate = Math.min(Math.max(args.rate, 1), 20);
  await target.session.send('Emulation.setCPUThrottlingRate', { rate });
  instance.emulation.set('cpu', rate);
  return {
    target_id: target.handle,
    rate,
    meaning: rate === 1 ? 'normal speed' : `approximately ${rate}x slower than this machine`,
  };
}

export async function resetCpu(ctx: OpsContext, args: EmulationArgs): Promise<Record<string, unknown>> {
  return throttleCpu(ctx, { ...args, rate: 1 });
}

/* ---------------------------- network conditions ------------------------- */

interface NetworkPreset {
  latency: number;
  download: number;
  upload: number;
  offline?: boolean;
}

/** Throughputs are bytes/second, matching CDP. */
const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  'slow-3g': { latency: 400, download: (400 * 1024) / 8, upload: (400 * 1024) / 8 },
  'fast-3g': { latency: 150, download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8 },
  '4g': { latency: 50, download: (9 * 1024 * 1024) / 8, upload: (3 * 1024 * 1024) / 8 },
  'bad-wifi': { latency: 750, download: (1 * 1024 * 1024) / 8, upload: (256 * 1024) / 8 },
  offline: { latency: 0, download: 0, upload: 0, offline: true },
  none: { latency: 0, download: -1, upload: -1 },
};

function parseRate(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)\s*(bps|kbps|mbps|kb\/s|mb\/s)?$/i.exec(value.trim());
  if (!match) throw new AgentBrowserError('bad_rate', `Cannot parse throughput "${value}". Try "750kbps".`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'bps').toLowerCase();
  // CDP wants bytes/second; the human-facing units are bits/second.
  if (unit === 'bps') return amount / 8;
  if (unit === 'kbps' || unit === 'kb/s') return (amount * 1024) / 8;
  return (amount * 1024 * 1024) / 8;
}

function parseLatency(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(value.trim());
  if (!match) throw new AgentBrowserError('bad_latency', `Cannot parse latency "${value}". Try "400ms".`);
  return Number(match[1]) * ((match[2] ?? 'ms').toLowerCase() === 's' ? 1000 : 1);
}

export async function setNetworkConditions(
  ctx: OpsContext,
  args: EmulationArgs & {
    preset?: string;
    offline?: boolean;
    latency?: string | number;
    download?: string | number;
    upload?: string | number;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('network.simulation.set');

  let conditions: NetworkPreset;
  if (args.preset) {
    const found = NETWORK_PRESETS[args.preset.toLowerCase()];
    if (!found) {
      throw new AgentBrowserError(
        'unknown_preset',
        `Unknown network preset "${args.preset}". Available: ${Object.keys(NETWORK_PRESETS).join(', ')}.`,
      );
    }
    conditions = found;
  } else {
    conditions = {
      latency: parseLatency(args.latency, 0),
      download: parseRate(args.download, -1),
      upload: parseRate(args.upload, -1),
    };
  }
  const offline = args.offline ?? conditions.offline ?? false;

  // emulateNetworkConditions is deprecated in tip-of-tree but is still the only
  // command every current Chromium honours; fall back only if it is rejected.
  const params = {
    offline,
    latency: conditions.latency,
    downloadThroughput: conditions.download,
    uploadThroughput: conditions.upload,
  };
  const applied = await target.session.trySend('Network.emulateNetworkConditions', params);
  if (!applied) {
    // Newer Chromium may reject the deprecated command; fall back to the
    // navigator-level state so at least offline/online still works.
    await target.session.send('Network.overrideNetworkState', { online: !offline });
  }

  instance.emulation.set('network', { ...params, preset: args.preset ?? null });

  return {
    target_id: target.handle,
    preset: args.preset ?? null,
    offline,
    latency_ms: conditions.latency,
    download_bytes_per_sec: conditions.download,
    upload_bytes_per_sec: conditions.upload,
    hint: 'Recording continues under these conditions; compare network.summarize before and after.',
  };
}

export async function resetNetworkConditions(
  ctx: OpsContext,
  args: EmulationArgs,
): Promise<Record<string, unknown>> {
  const { instance } = await pageOf(ctx, args);
  instance.emulation.delete('network');
  return setNetworkConditions(ctx, { ...args, preset: 'none', offline: false });
}

export async function setCacheDisabled(
  ctx: OpsContext,
  args: EmulationArgs & { disabled: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('cache.disable');
  await target.session.send('Network.setCacheDisabled', { cacheDisabled: args.disabled });
  instance.emulation.set('cache_disabled', args.disabled);
  return { target_id: target.handle, cache_disabled: args.disabled };
}

export async function bypassServiceWorker(
  ctx: OpsContext,
  args: EmulationArgs & { bypass: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('service_worker.bypass');
  await target.session.send('Network.setBypassServiceWorker', { bypass: args.bypass });
  instance.emulation.set('service_worker_bypass', args.bypass);
  return { target_id: target.handle, bypass: args.bypass };
}

/* ------------------------------ environment ------------------------------ */

export async function setTimezone(
  ctx: OpsContext,
  args: EmulationArgs & { timezone: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('environment.timezone.set');
  try {
    await target.session.send('Emulation.setTimezoneOverride', { timezoneId: args.timezone });
  } catch (err) {
    throw new AgentBrowserError(
      'bad_timezone',
      `Chromium rejected timezone "${args.timezone}". Use an IANA id like "America/New_York". (${(err as Error).message})`,
    );
  }
  instance.emulation.set('timezone', args.timezone);
  return { target_id: target.handle, timezone: args.timezone };
}

export async function setLocale(
  ctx: OpsContext,
  args: EmulationArgs & { locale: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('environment.locale.set');
  await target.session.send('Emulation.setLocaleOverride', { locale: args.locale });
  instance.emulation.set('locale', args.locale);
  return { target_id: target.handle, locale: args.locale };
}

export async function setGeolocation(
  ctx: OpsContext,
  args: EmulationArgs & {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    preset?: string;
    unavailable?: boolean;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('location.set');

  if (args.unavailable) {
    // Empty params is how CDP signals "position unavailable" to the page.
    await target.session.send('Emulation.setGeolocationOverride', {});
    instance.emulation.set('geolocation', 'unavailable');
    return { target_id: target.handle, unavailable: true };
  }

  const PRESETS: Record<string, { latitude: number; longitude: number }> = {
    mumbai: { latitude: 19.076, longitude: 72.8777 },
    'new-york': { latitude: 40.7128, longitude: -74.006 },
    london: { latitude: 51.5074, longitude: -0.1278 },
    tokyo: { latitude: 35.6762, longitude: 139.6503 },
    sydney: { latitude: -33.8688, longitude: 151.2093 },
    'san-francisco': { latitude: 37.7749, longitude: -122.4194 },
  };

  let latitude = args.latitude;
  let longitude = args.longitude;
  if (args.preset) {
    const found = PRESETS[args.preset.toLowerCase()];
    if (!found) {
      throw new AgentBrowserError(
        'unknown_preset',
        `Unknown location preset "${args.preset}". Available: ${Object.keys(PRESETS).join(', ')}.`,
      );
    }
    latitude = found.latitude;
    longitude = found.longitude;
  }
  if (latitude === undefined || longitude === undefined) {
    throw new AgentBrowserError('bad_args', 'Provide latitude and longitude, a preset, or unavailable: true.');
  }

  const accuracy = args.accuracy ?? 100;
  await target.session.send('Emulation.setGeolocationOverride', { latitude, longitude, accuracy });
  instance.emulation.set('geolocation', { latitude, longitude, accuracy });
  return { target_id: target.handle, latitude, longitude, accuracy };
}

export async function setColorScheme(
  ctx: OpsContext,
  args: EmulationArgs & { scheme: 'dark' | 'light' | 'no-preference' },
): Promise<Record<string, unknown>> {
  return setMediaFeatures(ctx, { ...args, features: { 'prefers-color-scheme': args.scheme } });
}

export async function setReducedMotion(
  ctx: OpsContext,
  args: EmulationArgs & { reduced: boolean },
): Promise<Record<string, unknown>> {
  return setMediaFeatures(ctx, {
    ...args,
    features: { 'prefers-reduced-motion': args.reduced ? 'reduce' : 'no-preference' },
  });
}

export async function setMediaFeatures(
  ctx: OpsContext,
  args: EmulationArgs & { features: Record<string, string>; media?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('environment.media');
  // CDP replaces the whole feature list per call, so merge with what is set.
  const previous = (instance.emulation.get('media_features') as Record<string, string>) ?? {};
  const merged = { ...previous, ...args.features };
  await target.session.send('Emulation.setEmulatedMedia', {
    media: args.media ?? '',
    features: Object.entries(merged).map(([name, value]) => ({ name, value })),
  });
  instance.emulation.set('media_features', merged);
  return { target_id: target.handle, media: args.media ?? '(screen)', features: merged };
}

const VISION_DEFICIENCIES = [
  'none',
  'achromatopsia',
  'blurredVision',
  'deuteranopia',
  'protanopia',
  'tritanopia',
  'reducedContrast',
];

export async function setVisionDeficiency(
  ctx: OpsContext,
  args: EmulationArgs & { deficiency: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('environment.vision');
  if (!VISION_DEFICIENCIES.includes(args.deficiency)) {
    throw new AgentBrowserError(
      'unknown_deficiency',
      `Unknown vision deficiency "${args.deficiency}". Available: ${VISION_DEFICIENCIES.join(', ')}.`,
    );
  }
  await target.session.send('Emulation.setEmulatedVisionDeficiency', { type: args.deficiency });
  instance.emulation.set('vision', args.deficiency);
  return {
    target_id: target.handle,
    deficiency: args.deficiency,
    hint: 'Take a page.screenshot to see the page as a user with this condition would.',
  };
}

export async function setIdleState(
  ctx: OpsContext,
  args: EmulationArgs & { user_active?: boolean; screen_unlocked?: boolean; reset?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('user_state.set');
  if (args.reset) {
    await target.session.send('Emulation.clearIdleOverride');
    instance.emulation.delete('idle');
    return { target_id: target.handle, reset: true };
  }
  const isUserActive = args.user_active ?? true;
  const isScreenUnlocked = args.screen_unlocked ?? true;
  await target.session.send('Emulation.setIdleOverride', { isUserActive, isScreenUnlocked });
  instance.emulation.set('idle', { isUserActive, isScreenUnlocked });
  return { target_id: target.handle, user_active: isUserActive, screen_unlocked: isScreenUnlocked };
}

export async function grantPermissions(
  ctx: OpsContext,
  args: EmulationArgs & { permissions: string[]; origin?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('permissions.grant');
  await instance.browserSession.send('Browser.grantPermissions', {
    permissions: args.permissions,
    ...(args.origin ? { origin: args.origin } : {}),
  });
  return { browser_id: instance.id, granted: args.permissions, origin: args.origin ?? '(all origins)' };
}

export async function resetPermissions(
  ctx: OpsContext,
  args: EmulationArgs,
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('permissions.reset');
  await instance.browserSession.send('Browser.resetPermissions');
  return { browser_id: instance.id, reset: true };
}

/* ------------------------------- scenarios ------------------------------- */

interface Scenario {
  description: string;
  device?: string;
  network?: string;
  cpu?: number;
  cacheDisabled?: boolean;
}

const SCENARIOS: Record<string, Scenario> = {
  'slow-mobile': {
    description: 'Mid-range phone on a weak mobile connection.',
    device: 'pixel',
    network: 'slow-3g',
    cpu: 4,
  },
  'terrible-network': {
    description: 'Normal machine, very high latency and low bandwidth.',
    network: 'bad-wifi',
    cpu: 1,
  },
  offline: { description: 'No connectivity at all.', network: 'offline' },
  'cold-load': {
    description: 'Desktop with cache disabled, as a first-time visitor sees it.',
    device: 'desktop',
    network: 'fast-3g',
    cacheDisabled: true,
  },
  'low-end-desktop': { description: 'Desktop viewport with a heavily throttled CPU.', device: 'laptop', cpu: 6 },
};

export async function applyScenario(
  ctx: OpsContext,
  args: EmulationArgs & { scenario: string },
): Promise<Record<string, unknown>> {
  const scenario = SCENARIOS[args.scenario.toLowerCase()];
  if (!scenario) {
    throw new AgentBrowserError(
      'unknown_scenario',
      `Unknown scenario "${args.scenario}". Available: ${Object.keys(SCENARIOS).join(', ')}.`,
    );
  }
  const applied: Record<string, unknown> = {};
  if (scenario.device) applied.device = await devicePreset(ctx, { ...args, preset: scenario.device });
  if (scenario.network) applied.network = await setNetworkConditions(ctx, { ...args, preset: scenario.network });
  if (scenario.cpu !== undefined) applied.cpu = await throttleCpu(ctx, { ...args, rate: scenario.cpu });
  if (scenario.cacheDisabled !== undefined) {
    applied.cache = await setCacheDisabled(ctx, { ...args, disabled: scenario.cacheDisabled });
  }
  return {
    scenario: args.scenario,
    description: scenario.description,
    applied,
    hint: 'Call scenario.reset to put everything back.',
  };
}

export async function listScenarios(): Promise<Record<string, unknown>> {
  return {
    scenarios: Object.entries(SCENARIOS).map(([name, s]) => ({
      name,
      description: s.description,
      device: s.device ?? null,
      network: s.network ?? null,
      cpu_throttle: s.cpu ?? null,
    })),
    device_presets: Object.keys(DEVICE_PRESETS),
    network_presets: Object.keys(NETWORK_PRESETS),
    vision_deficiencies: VISION_DEFICIENCIES,
  };
}

export async function status(ctx: OpsContext, args: EmulationArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  return {
    browser_id: instance.id,
    target_id: target.handle,
    control_mode: instance.controlMode,
    active_overrides: Object.fromEntries(instance.emulation),
    clock_installed_on: [...instance.clockShimTargets],
    active_faults: instance.faults.size,
    hint: 'Anything listed here is currently changing how the page behaves. environment.reset clears it.',
  };
}

/** Put every environment override back to browser defaults. */
export async function resetAll(ctx: OpsContext, args: EmulationArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('environment.reset');
  const cleared: string[] = [];

  const attempts: Array<[string, () => Promise<unknown>]> = [
    ['device', () => target.session.trySend('Emulation.clearDeviceMetricsOverride')],
    [
      'touch',
      async () => {
        instance.touchTargets.delete(target.handle);
        return target.session.trySend('Emulation.setTouchEmulationEnabled', { enabled: false });
      },
    ],
    ['user_agent', () => target.session.trySend('Emulation.setUserAgentOverride', { userAgent: '' })],
    ['cpu', () => target.session.trySend('Emulation.setCPUThrottlingRate', { rate: 1 })],
    ['timezone', () => target.session.trySend('Emulation.setTimezoneOverride', { timezoneId: '' })],
    ['locale', () => target.session.trySend('Emulation.setLocaleOverride', {})],
    ['geolocation', () => target.session.trySend('Emulation.clearGeolocationOverride')],
    ['media', () => target.session.trySend('Emulation.setEmulatedMedia', { media: '', features: [] })],
    ['vision', () => target.session.trySend('Emulation.setEmulatedVisionDeficiency', { type: 'none' })],
    ['idle', () => target.session.trySend('Emulation.clearIdleOverride')],
    ['cache', () => target.session.trySend('Network.setCacheDisabled', { cacheDisabled: false })],
    ['service_worker', () => target.session.trySend('Network.setBypassServiceWorker', { bypass: false })],
    [
      'network',
      () =>
        target.session.trySend('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        }),
    ],
  ];

  for (const [name, run] of attempts) {
    await run();
    cleared.push(name);
  }
  instance.emulation.clear();

  return {
    target_id: target.handle,
    cleared,
    note: 'The fake clock and fault rules are separate: call time.uninstall and fault.clear for those.',
  };
}
