// Dev-time script, not part of the build: renders public/icon*.svg to PNGs.
// Usage: NODE_PATH=<dir containing playwright-core>/node_modules node scripts/make-icons.cjs
// Needs Chrome installed at the macOS default path.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pub = path.join(__dirname, '..', 'public');
const jobs = [
  ['icon.svg', 'pwa-192x192.png', 192],
  ['icon.svg', 'pwa-512x512.png', 512],
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'pwa-maskable-512x512.png', 512],
];
(async () => {
  const browser = await chromium.launch({ executablePath: chrome });
  for (const [src, out, size] of jobs) {
    const svg = fs
      .readFileSync(path.join(pub, src), 'utf8')
      .replace('<svg ', `<svg width="${size}" height="${size}" `);
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
    fs.writeFileSync(path.join(pub, out), await page.screenshot({ omitBackground: true }));
    await page.close();
  }
  await browser.close();
})();
