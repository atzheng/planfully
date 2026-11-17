// Dev-time script, not part of the build: renders public/icon*.svg to PNGs.
// Usage: PLAYWRIGHT_CORE=<abs path to playwright-core/index.mjs> node scripts/make-icons.mjs
// Needs Chrome installed at the macOS default path.
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pub = (name) => new URL(`../public/${name}`, import.meta.url);
const jobs = [
  ['icon.svg', 'pwa-192x192.png', 192],
  ['icon.svg', 'pwa-512x512.png', 512],
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'pwa-maskable-512x512.png', 512],
];
const browser = await chromium.launch({ executablePath: chrome });
for (const [src, out, size] of jobs) {
  const svg = readFileSync(pub(src), 'utf8').replace(
    '<svg ',
    `<svg width="${size}" height="${size}" `,
  );
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
  writeFileSync(pub(out), await page.screenshot({ omitBackground: true }));
  await page.close();
}
await browser.close();
