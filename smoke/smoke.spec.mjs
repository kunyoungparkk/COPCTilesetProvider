import { expect, test } from '@playwright/test';

async function run(page, config) {
  const messages = [];
  page.on('console', (m) => messages.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await page.waitForFunction(() => window.smoke !== undefined);
  const result = await page.evaluate((c) => window.smoke.run(c), config);
  return { ...result, messages };
}

test('the packed tarball renders its points', async ({ page }) => {
  const r = await run(page, { withProvider: true });
  console.log(JSON.stringify(r, null, 2));
  expect(r.tilesLoaded).toBe(true);
  expect(r.pointsLength).toBe(47);
  expect(r.litPixels).toBeGreaterThan(0);
});

test('negative control: same scene, no provider, nothing lit', async ({ page }) => {
  const r = await run(page, { withProvider: false });
  console.log(JSON.stringify(r, null, 2));
  // Without this zero the pixel count above means nothing — it would be
  // satisfied by any stray thing the harness itself draws.
  expect(r.litPixels).toBe(0);
});
