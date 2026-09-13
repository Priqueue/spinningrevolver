import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * 测试直接跑 shared/src 的 TypeScript 源码（无需先构建）。
 * 这里显式给出别名，避免依赖 workspaces 软链是否已建立。
 *
 * tests/ui/** 使用 happy-dom 环境以便渲染 React 组件做 DOM 断言；
 * 其余规则/协议测试跑在 node 环境。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@zuolun/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
      '@client': fileURLToPath(new URL('./client/src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    environmentMatchGlobs: [['tests/ui/**', 'happy-dom']],
    reporters: ['default'],
    testTimeout: 20000,
  },
});
