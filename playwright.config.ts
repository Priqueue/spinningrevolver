import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 双浏览器上下文 E2E 配置。
 *
 * 运行前置：
 *   1. npx playwright install chromium   （需要能访问 Playwright CDN；本机曾因网络超时失败）
 *   2. npm run build                     （产出 client/dist 与 server/dist）
 *   3. npm run e2e
 *
 * webServer 会自动拉起生产服务（同源托管前端与 Socket.IO）。
 * 若浏览器不可用，请改用等价的 Node 双客户端集成测试：npm run test:integration
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3210',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node server/dist/index.cjs',
    url: 'http://127.0.0.1:3210/healthz',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: '3210',
      NODE_ENV: 'production',
    },
  },
});
