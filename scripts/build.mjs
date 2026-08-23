import { strict as assert } from 'node:assert';
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'src');
const outDir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const importTs = (relative) => import(pathToFileURL(resolve(root, relative)).href);

// Node 24 原生支持 TypeScript 类型剥离，可直接 import .ts。
// 类型剥离不会改写模块说明符，所以只有"自身没有 import"的模块才加载得进来——
// manifest.ts 与 core/script-files.ts 都是为此刻意保持无依赖的。
// 从它们读路径而不是在这里重抄一遍，是这份构建脚本与运行时不会各说各话的唯一保证。
const { manifest } = await importTs('src/manifest.ts');
const { RTC_SCRIPT_FILE, MEDIA_SCRIPT_FILE } = await importTs('src/core/script-files.ts');

// Rollup 的 iife 格式不允许多入口（"IIFE output formats are not supported for
// code-splitting builds"），而 content script 又必须是自包含单文件，
// 所以每个注入脚本各构建一次。
const iifeTargets = [
  { entry: 'src/injected/rtc.ts', out: RTC_SCRIPT_FILE },
  { entry: 'src/injected/media.ts', out: MEDIA_SCRIPT_FILE },
  { entry: 'src/relay/isolated.ts', out: manifest.content_scripts[0].js[0] },
];

async function writeManifest() {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    resolve(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

async function copyIcons() {
  await cp(resolve(srcDir, 'icons'), resolve(outDir, 'icons'), { recursive: true });
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
      // popup 打包了整个 React，不压缩接近 500KB。它不是注入到页面里的代码，
      // 没有可审计性诉求，压就是了。
      // 用 'oxc' 而不是 'esbuild'：Vite 8 走的是 rolldown，esbuild 并不在依赖里，
      // 指定 'esbuild' 会在构建时报 Cannot find package 'esbuild'。
      minify: 'oxc',
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
      // 注入脚本刻意不压缩。它们各自只有 2.5～3.8KB，压缩省不下什么；
      // 而对一个隐私扩展来说，任何人都能打开 dist/injected/*.js 逐行读懂
      // "到底往我每个页面里注入了什么"，本身就是这个扩展值得被信任的理由之一。
      // 不要为了"统一风格"把这里也改成压缩。
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

/**
 * 扩展会去加载哪些文件，是散落在 manifest.ts 与 core/script-files.ts 里的字符串。
 * 名字一改而构建产物没跟上，Chrome 只会在运行时抛
 * "Could not load javascript ... for content script"——而且是静默的。
 * 构建期把它们逐个落地核对一遍，几乎不要钱，却能把这类错误挡在发布之前。
 */
async function assertArtifacts() {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    RTC_SCRIPT_FILE,
    MEDIA_SCRIPT_FILE,
  ];

  const missing = [];
  for (const file of new Set(referenced)) {
    try {
      await access(resolve(outDir, file));
    } catch {
      missing.push(file);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `构建产物缺失，扩展装上去会在运行时失败：${missing.join(', ')}`,
  );
}

if (!watch) {
  await rm(outDir, { recursive: true, force: true });
}
await writeManifest();
await copyIcons();
await buildEsm();
for (const target of iifeTargets) {
  await buildIife(target);
}
// watch 模式下构建是持续进行的，此时断言没有意义。
if (!watch) {
  await assertArtifacts();
  console.log('产物校验通过：manifest 与注册策略引用的文件都已生成。');
}
