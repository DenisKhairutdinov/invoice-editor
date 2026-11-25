import { defineConfig, devices } from '@playwright/test';

const port = '4183';
const origin = 'http://127.0.0.1:' + port;
const baseURL = origin + '/invoice-editor/';
const installedChannels = (process.env.INVOICE_BROWSER_CHANNELS ?? '')
  .split(',')
  .filter(Boolean);
const yandexPath = process.env.INVOICE_YANDEX_PATH;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    ...installedChannels.map((channel) => ({
      name: channel,
      use: { ...devices['Desktop Chrome'], channel },
    })),
    ...(yandexPath
      ? [
          {
            name: 'yandex',
            use: {
              ...devices['Desktop Chrome'],
              launchOptions: {
                executablePath: yandexPath,
                args: ['--disable-gpu'],
              },
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: `node tests/e2e/server.mjs ${port}`,
    env: { ASTRO_TELEMETRY_DISABLED: '1' },
    url: baseURL,
    timeout: 60_000,
  },
});
