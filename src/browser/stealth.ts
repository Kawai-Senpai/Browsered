import type { CdpSession } from '../cdp/session.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('stealth');

/**
 * Chrome launch flags that reduce bot-detection surface.
 *
 * --disable-blink-features=AutomationControlled stops Blink from advertising
 * the automation flag via navigator.webdriver and the "Chrome is being
 * controlled" infobar.
 * --excludeSwitches=enable-automation removes the automation switch that some
 * detectors read through window.chrome internals.
 * --disable-infobars prevents the "Chrome is being controlled" banner.
 */
export const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--disable-features=ChromeWhatsNewUI',
];

/**
 * JavaScript injected before any page script runs via
 * Page.addScriptToEvaluateOnNewDocument.
 *
 * Covers every detection vector encountered in practice:
 *
 *  1.  navigator.webdriver              -- highest-signal single flag
 *  2.  User-agent string cleanup        -- removes HeadlessChrome / CfT
 *  3.  navigator.plugins                -- non-empty plugin array
 *  4.  navigator.languages              -- non-empty language list
 *  5.  chrome.runtime + chrome.app      -- complete chrome object
 *  6.  Permissions.query notifications  -- "prompt" not "denied"
 *  7.  WebGL vendor / renderer          -- non-null fallback strings (WebGL1+2)
 *  8.  Error.prepareStackTrace          -- strip Runtime.evaluate frames
 *  9.  Function.prototype.toString      -- mask CDP source markers
 * 10.  window.outerWidth/outerHeight    -- DevTools-open dimension spoof
 * 11.  console.log getter trap          -- defeat getter-based DevTools detection
 * 12.  navigator.connection             -- non-null network info
 * 13.  Automation globals cleanup       -- cdc_* and $cdc_* vars
 * 14.  screen.colorDepth/pixelDepth     -- 24 not 0 in headless
 * 15.  navigator.hardwareConcurrency    -- non-1 fallback
 * 16.  navigator.deviceMemory           -- non-undefined fallback
 * 17.  navigator.maxTouchPoints         -- 0 for desktop
 */
const STEALTH_SCRIPT = `
(() => {
  // 1. navigator.webdriver -> undefined (the single highest-signal flag)
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch {}

  // 2. Hide the Headless/Automation user-agent substring if present
  try {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    if (desc && desc.get) {
      const origGet = desc.get;
      Object.defineProperty(Navigator.prototype, 'userAgent', {
        get() {
          return origGet.call(this)
            .replace(/HeadlessChrome/gi, 'Chrome')
            .replace(/Chrome for Testing/gi, 'Chrome');
        },
        configurable: true,
      });
    }
  } catch {}

  // 3. navigator.plugins should not be empty (headless/automation leaves it at 0)
  try {
    if (navigator.plugins.length === 0) {
      const fakePlugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer',
          description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
          description: '', length: 1 },
        { name: 'Native Client', filename: 'internal-nacl-plugin',
          description: '', length: 2 },
      ];
      fakePlugins.item = (i) => fakePlugins[i] || null;
      fakePlugins.namedItem = (n) => fakePlugins.find((p) => p.name === n) || null;
      fakePlugins.refresh = () => {};
      Object.defineProperty(navigator, 'plugins', {
        get: () => fakePlugins,
        configurable: true,
      });
    }
  } catch {}

  // 4. navigator.languages fallback
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });
    }
  } catch {}

  // 5. Patch chrome.runtime and chrome.app to look like a normal browser
  try {
    if (typeof window.chrome === 'undefined') {
      Object.defineProperty(window, 'chrome', { value: {}, configurable: true, writable: true });
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
        connect: () => undefined,
        sendMessage: () => undefined,
        id: undefined,
      };
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        getDetails: () => null,
        getIsInstalled: () => false,
        installState: () => {},
        runningState: () => 'cannot_run',
      };
    }
  } catch {}

  // 6. Permission query for notifications: "prompt" not "denied"
  try {
    const origQuery = Permissions.prototype.query;
    Permissions.prototype.query = function(desc) {
      if (desc && desc.name === 'notifications') {
        return Promise.resolve(
          Object.setPrototypeOf({ state: 'prompt', onchange: null }, PermissionStatus.prototype)
        );
      }
      return origQuery.call(this, desc);
    };
  } catch {}

  // 7. WebGL vendor and renderer: keep the real ones but ensure they exist.
  try {
    const _getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      const val = _getParam.call(this, param);
      if (param === 0x9245 && !val) return 'Google Inc. (ANGLE)';
      if (param === 0x9246 && !val) return 'ANGLE (Direct3D11 vs_5_0 ps_5_0)';
      return val;
    };
  } catch {}
  try {
    const _getParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      const val = _getParam2.call(this, param);
      if (param === 0x9245 && !val) return 'Google Inc. (ANGLE)';
      if (param === 0x9246 && !val) return 'ANGLE (Direct3D11 vs_5_0 ps_5_0)';
      return val;
    };
  } catch {}

  // 8. Strip CDP Runtime.evaluate frames from Error stacks
  try {
    const _prepare = Error.prepareStackTrace;
    Error.prepareStackTrace = function(err, stack) {
      const filtered = stack.filter((f) => {
        const fn = f.getFunctionName() || '';
        const file = f.getFileName() || '';
        return !fn.includes('Runtime.evaluate') &&
               !file.includes('__puppeteer') &&
               !file.includes('__cdp') &&
               !file.includes('pptr:') &&
               !file.includes('playwright');
      });
      if (_prepare) return _prepare(err, filtered);
      return err.toString() + '\\n' + filtered.map((f) => '    at ' + f).join('\\n');
    };
  } catch {}

  // 9. Mask CDP source markers in Function.toString
  try {
    const _toString = Function.prototype.toString;
    Object.defineProperty(Function.prototype, 'toString', {
      value: function() {
        const str = _toString.call(this);
        if (str.includes('__puppeteer') || str.includes('__selenium') ||
            str.includes('__cdp_binding') || str.includes('__playwright')) {
          return 'function () { [native code] }';
        }
        return str;
      },
      writable: true,
      configurable: true,
    });
  } catch {}

  // 10. DevTools-open detection via window dimension differential.
  //     The common check: outerWidth - innerWidth > 160 means DevTools is docked.
  //     We return outerWidth == innerWidth so that differential is always 0.
  try {
    const _innerWidthDesc = Object.getOwnPropertyDescriptor(window, 'innerWidth') ||
                            Object.getOwnPropertyDescriptor(Window.prototype, 'innerWidth');
    const _innerHeightDesc = Object.getOwnPropertyDescriptor(window, 'innerHeight') ||
                             Object.getOwnPropertyDescriptor(Window.prototype, 'innerHeight');
    if (_innerWidthDesc) {
      Object.defineProperty(window, 'outerWidth', {
        get() {
          const iw = _innerWidthDesc.get ? _innerWidthDesc.get.call(this) : 1280;
          return iw;
        },
        configurable: true,
      });
    }
    if (_innerHeightDesc) {
      Object.defineProperty(window, 'outerHeight', {
        get() {
          const ih = _innerHeightDesc.get ? _innerHeightDesc.get.call(this) : 800;
          // +85 accounts for a typical browser toolbar height so the ratio looks real
          return ih + 85;
        },
        configurable: true,
      });
    }
  } catch {}

  // 11. Console-getter DevTools detection.
  //     Some detectors define an object whose toString/valueOf getter fires only
  //     when DevTools expands it. We intercept console.log calls that match the
  //     pattern ('%c', object) and swallow them so the getter never fires.
  try {
    const _log = console.log.bind(console);
    console.log = function(...args) {
      if (args.length === 2 && args[0] === '%c' && typeof args[1] === 'object' && args[1] !== null) {
        return;
      }
      return _log(...args);
    };
  } catch {}

  // 12. navigator.connection - some detectors flag automation when this is absent
  try {
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          onchange: null,
        }),
        configurable: true,
      });
    }
  } catch {}

  // 13. Remove Chromium automation globals (cdc_* and $cdc_* driver artifacts)
  try {
    for (const key of Object.keys(window)) {
      if (/^(\\$?cdc_)/.test(key) || key === 'domAutomation' || key === 'domAutomationController') {
        try { delete window[key]; } catch {}
      }
    }
    if (typeof document !== 'undefined') {
      for (const key of Object.keys(document)) {
        if (/^\\$cdc_/.test(key)) {
          try { delete document[key]; } catch {}
        }
      }
    }
  } catch {}

  // 14. screen.colorDepth/pixelDepth - headless Chromium can report 0 or 1
  try {
    if (!screen.colorDepth || screen.colorDepth < 24) {
      Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
      Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: true });
    }
  } catch {}

  // 15. navigator.hardwareConcurrency - headless sometimes reports 1
  try {
    if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency < 2) {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 4,
        configurable: true,
      });
    }
  } catch {}

  // 16. navigator.deviceMemory - should be defined for a real browser
  try {
    if (navigator.deviceMemory === undefined) {
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
        configurable: true,
      });
    }
  } catch {}

  // 17. navigator.maxTouchPoints - desktop is 0; some headless builds return
  //     unexpected values that signal automation.
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: () => 0,
      configurable: true,
    });
  } catch {}
})();
`;

/**
 * Inject stealth patches into a single CDP target session.
 *
 * Uses Page.addScriptToEvaluateOnNewDocument so the patches run before any
 * page script on every navigation, including same-origin ones.
 */
export async function injectStealth(session: CdpSession): Promise<void> {
  try {
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: STEALTH_SCRIPT,
      worldName: '',
      runImmediately: true,
    });
    log.debug(`stealth injected into ${session.targetId}`);
  } catch (err) {
    log.debug(`stealth injection failed for ${session.targetId}`, err);
  }
}

/**
 * Override the browser-level user-agent so it does not advertise
 * "Chrome for Testing" or "HeadlessChrome" in HTTP request headers or
 * in the Client Hints (Sec-CH-UA-*) headers that modern Chromium sends.
 *
 * Network.setUserAgentOverride accepts an optional userAgentMetadata object
 * that controls the Sec-CH-UA-* client hints separately from the UA string.
 * Without it, the UA string is patched but the hints still say "Chrome for
 * Testing", and any server that reads the hints instead of the UA string
 * still sees the automation marker.
 */
export async function patchUserAgent(session: CdpSession): Promise<void> {
  try {
    const { userAgent } = await session.send<{ userAgent: string }>('Browser.getVersion');
    const cleaned = userAgent
      .replace(/HeadlessChrome/g, 'Chrome')
      .replace(/Chrome for Testing/g, 'Chrome');

    // Extract the Chrome major version from the UA string so we can build
    // matching Sec-CH-UA hints that do not mention "Chrome for Testing".
    const versionMatch = cleaned.match(/Chrome\/([\d]+)\.([\d.]+)/);
    const fullVersion = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : '120.0.0.0';
    const majorVersion = versionMatch ? versionMatch[1] : '120';

    const overrideParams: Record<string, unknown> = { userAgent: cleaned };

    // userAgentMetadata controls Sec-CH-UA-* headers. Omitting the "Chrome for
    // Testing" brand from brandVersionList prevents it appearing in those hints.
    overrideParams.userAgentMetadata = {
      brands: [
        { brand: 'Not A(Brand', version: '99' },
        { brand: 'Google Chrome', version: majorVersion },
        { brand: 'Chromium', version: majorVersion },
      ],
      fullVersionList: [
        { brand: 'Not A(Brand', version: '99.0.0.0' },
        { brand: 'Google Chrome', version: fullVersion },
        { brand: 'Chromium', version: fullVersion },
      ],
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
    };

    await session.send('Network.setUserAgentOverride', overrideParams);
    log.debug(`user-agent patched: ${cleaned}`);
  } catch (err) {
    log.debug('user-agent patch failed', err);
  }
}
