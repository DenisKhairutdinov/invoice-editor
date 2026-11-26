import { rm, writeFile } from 'node:fs/promises';
import { build, preview } from 'astro';
import { createCanvas } from '@napi-rs/canvas';

const config = {
  base: '/invoice-editor/',
  outDir: './.astro/e2e-dist',
  server: { host: '127.0.0.1', port: Number(process.argv[2]) },
};

const fixture = new URL(
  '../../assets/banners/playwright-banner.png',
  import.meta.url,
);
const canvas = createCanvas(1400, 220);
const context = canvas.getContext('2d');
context.fillStyle = '#17366f';
context.fillRect(0, 0, canvas.width, canvas.height);
await writeFile(fixture, canvas.toBuffer('image/png'), { flag: 'wx' });
try {
  await build(config);
} finally {
  await rm(fixture);
}
const server = await preview(config);
if (server.port !== config.server.port) {
  await server.stop();
  throw new Error('The Playwright test port is already in use.');
}
