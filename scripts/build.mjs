import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'src');
const outDir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

// Rollup 的 iife 格式不允许多入口（"IIFE output formats are not supported for
// code-splitting builds"），而 content script 又必须是自包含单文件，
// 所以每个注入脚本各构建一次。
const iifeTargets = [
  { entry: 'src/injected/rtc.ts', out: 'injected/rtc.js' },
  { entry: 'src/injected/media.ts', out: 'injected/media.js' },
  { entry: 'src/relay/isolated.ts', out: 'relay/isolated.js' },
];

async function writeManifest() {
  // Node 24 原生支持 TypeScript 类型剥离，可直接 import .ts。
  const { manifest } = await import(pathToFileURL(resolve(srcDir, 'manifest.ts')).href);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    resolve(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

// root 设为 src，好让 popup/index.html 输出到 dist/popup/index.html
// 而不是 dist/src/popup/index.html。
async function buildEsm() {
  await build({
    root: srcDir,
    configFile: false,
    plugins: [react()],
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome119',
      minify: false,
      sourcemap: false,
      watch: watch ? {} : null,
      rollupOptions: {
        input: {
          'background/index': resolve(srcDir, 'background/index.ts'),
          'popup/index': resolve(srcDir, 'popup/index.html'),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
}

async function buildIife({ entry, out }) {
  await build({
    root,
    configFile: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome119',
      minify: false,
      sourcemap: false,
      watch: watch ? {} : null,
      lib: {
        entry: resolve(root, entry),
        formats: ['iife'],
        name: '__webrtcBlocker',
        fileName: () => out,
      },
    },
  });
}

if (!watch) {
  await rm(outDir, { recursive: true, force: true });
}
await writeManifest();
await buildEsm();
for (const target of iifeTargets) {
  await buildIife(target);
}
