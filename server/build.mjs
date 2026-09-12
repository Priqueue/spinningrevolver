/**
 * 服务端构建：用 esbuild 把 TS 打成单个 CJS 文件（含 @zuolun/shared 源码）。
 * 这样生产环境无需再单独构建 shared 包，也不会出现 node_modules 软链问题。
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  alias: {
    '@zuolun/shared': '../shared/src/index.ts',
  },
  banner: {
    js: '/* 翻转左轮 server bundle（esbuild） */',
  },
});

console.log('✓ server built → dist/index.cjs');
