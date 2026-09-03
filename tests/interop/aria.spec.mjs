/**
 * Does `page.snapshot { format: "aria" }` emit something Playwright accepts as
 * an aria-snapshot expectation?
 *
 * This is not a formatting nicety. A snapshot carrying Chrome's own node names
 * fails to PARSE, so the assertion errors out before comparing anything - and
 * an agent reading only browserd's own output cannot tell the difference
 * between that and a passing test. Hence checking it against the real matcher.
 *
 * Driven by tests/playwright-interop.mjs, which supplies ARIA_HANDOFF: a JSON
 * file holding the live fixture URL and the snapshot browserd produced for it.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const handoff = JSON.parse(readFileSync(process.env.ARIA_HANDOFF, 'utf8'));

test('browserd format:aria parses and matches as a Playwright expectation', async ({ page }) => {
  await page.goto(handoff.url);
  await expect(page.locator('body')).toMatchAriaSnapshot(handoff.snapshot);
});
