import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * 测试直接跑 shared/src 的 TypeScript 源码（无需先构建）。
 * 这里显式给出 @zuolun/shared 别名，避免依赖 workspaces 软链是否已建立。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@zuolun/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 20000,
  },
});
