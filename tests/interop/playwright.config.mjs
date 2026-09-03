/**
 * Exists for exactly one assertion. toMatchAriaSnapshot refuses to run outside
 * the Playwright runner (it can generate baselines, so it needs the test
 * context), and it is the assertion that actually proves page.snapshot
 * format:aria emits a parseable expectation. tests/playwright-interop.mjs
 * shells out to this config; nothing else should invoke it directly.
 */
import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: '.',
  // Out of the repo: a failed run must not leave a test-results/ directory behind.
  outputDir: join(tmpdir(), 'browserd-interop-artifacts'),
  reporter: [['line']],
  // A dialect error fails instantly; a real mismatch should not sit and retry.
  expect: { timeout: 2_000 },
  timeout: 20_000,
  use: { headless: process.env.INTEROP_HEADED !== '1' },
});
