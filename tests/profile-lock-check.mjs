/**
 * A browser that outlives its socket, or that nobody recorded, must never turn
 * into "Chromium exited before the DevTools endpoint appeared". Runs real
 * Chromium on throwaway profiles.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const home = mkdtempSync(join(tmpdir(), 'browserd-profile-lock-'));
const previousHome = process.env.AGENTBROWSER_HOME;
process.env.AGENTBROWSER_HOME = home;

const { BrowserRegistry } = await import('../dist/browser/registry.js');
const { findProfileOwner, ProfileInUseError } = await import('../dist/browser/launcher.js');
const { DEFAULT_CONFIG } = await import('../dist/config.js');
const { createStores } = await import('../dist/store/index.js');
const { discover, withdraw } = await import('../dist/browser/discovery.js');
const { paths, resolveChromium } = await import('../dist/util/paths.js');

const stores = createStores(join(home, 'test.sqlite'), join(home, 'blobs'));
const config = { ...DEFAULT_CONFIG, autoLaunchHeadless: true, autoLaunchProfile: 'auto' };
const launchOptions = (profile) => ({ profile, headless: true, bundledExtensions: false });

/** What the 1006 in the wild looks like from here: the socket dies, chromium does not. */
function dropSocket(browser) {
  browser.connection.ws.terminate();
}

async function pageCount(browser) {
  const { targetInfos } = await browser.browserSession.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page').length;
}

const opened = [];
try {
  {
    const registry = new BrowserRegistry(stores, config);
    const browser = await registry.launch(launchOptions('dropped'));
    opened.push(browser.process);
    const { id, pid } = browser;
    dropSocket(browser);
    await delay(200);
    assert.equal(registry.list().length, 0, 'the dead connection leaves the registry');
    assert.equal(discover().length, 1, 'the record survives a dropped socket');
    const again = await registry.resolve();
    assert.equal(again.id, id, 'the next call gets the same browser id');
    assert.equal(again.pid, pid, 'and the same chromium');
    assert.ok((await again.browserSession.send('Browser.getVersion')).product, 'and it answers');
    console.log('PASS a dropped socket is picked up by the next call');
    withdraw(id);
    again.connection.close();
    await delay(100);
  }

  for (const [name, losePort] of [['no record', false], ['no record and no port file', true]]) {
    const registry = new BrowserRegistry(stores, config);
    const profile = `orphan-${losePort}`;
    const browser = await registry.launch(launchOptions(profile));
    opened.push(browser.process);
    const { pid, id } = browser;
    const pages = await pageCount(browser);
    withdraw(id);
    dropSocket(browser);
    await delay(200);
    if (losePort) rmSync(join(paths.profile(profile), 'DevToolsActivePort'), { force: true });

    const fresh = new BrowserRegistry(stores, config);
    const attached = await fresh.launch(launchOptions(profile));
    assert.equal(attached.managed, false, 'attached, not launched');
    assert.equal(await pageCount(attached), pages, 'no stray tab landed in the window');
    const owner = await findProfileOwner(paths.profile(profile));
    assert.ok(owner?.wsEndpoint, 'the owner is found');
    if (losePort) assert.equal(owner.pid, pid, 'the process scan names the right chromium');
    console.log(`PASS an orphan with ${name} is attached to, with no stray tab`);

    await assert.rejects(
      fresh.launch({ ...launchOptions(profile), args: ['--mute-audio'] }),
      (err) => err instanceof ProfileInUseError && /already using this profile/.test(err.message),
      'a launch needing process-start options is told why it cannot have them',
    );
    console.log('PASS options fixed at start are refused by name, not dropped');
    attached.connection.close();
    await delay(100);
  }

  {
    // A profile held by a Chromium with no debugging port cannot be attached to.
    const { executablePath } = resolveChromium();
    const held = paths.profile('auto');
    const child = spawn(executablePath, ['--headless=new', `--user-data-dir=${held}`, '--no-first-run', 'about:blank'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    opened.push(child);
    const deadline = Date.now() + 15_000;
    while (!(await findProfileOwner(held)) && Date.now() < deadline) await delay(200);
    const owner = await findProfileOwner(held);
    assert.equal(owner?.wsEndpoint, null, 'locked, with nothing to attach to');
    assert.ok(owner?.pid, 'but the holder is named');

    const registry = new BrowserRegistry(stores, config);
    const browser = await registry.resolve();
    opened.push(browser.process);
    assert.equal(browser.profile, 'auto-2', 'auto-launch moves to the next profile');
    console.log('PASS auto-launch steps past a profile it cannot use');
    await browser.close();
  }

  {
    const clean = paths.profile('clean');
    assert.equal(existsSync(clean) ? await findProfileOwner(clean) : null, null);
    const registry = new BrowserRegistry(stores, config);
    const browser = await registry.launch(launchOptions('clean'));
    opened.push(browser.process);
    assert.equal(browser.managed, true);
    await browser.close();
    assert.equal(await findProfileOwner(clean), null, 'a closed browser leaves no owner');
    const relaunched = await registry.launch(launchOptions('clean'));
    opened.push(relaunched.process);
    assert.equal(relaunched.managed, true, 'and the profile launches again');
    await relaunched.close();
    console.log('PASS a normal launch, close and relaunch still work');
  }
} finally {
  for (const child of opened) {
    if (child?.pid) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  await delay(800);
  stores.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (previousHome === undefined) delete process.env.AGENTBROWSER_HOME;
  else process.env.AGENTBROWSER_HOME = previousHome;
}
