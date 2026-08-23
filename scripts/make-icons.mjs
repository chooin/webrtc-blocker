// 生成 src/icons/icon-{16,32,48,128}.png。
//
// 不引入任何图形库：图标是四个固定尺寸的纯色圆角方块加一个禁止符号，
// 用 zlib 手写一份最小合法 PNG 比拉一个依赖便宜得多，而且结果可复现。
// 产物已提交进仓库，改动图形时手动跑 `node scripts/make-icons.mjs` 重新生成。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];

const BG = [0x16, 0x21, 0x3e]; // 深藏蓝：浅色与深色工具栏上都站得住
const FG = [0xff, 0xff, 0xff];

/** 圆角矩形的有符号距离场，p 为相对中心的坐标。 */
function roundedRect(px, py, half, radius) {
  const qx = Math.abs(px) - (half - radius);
  const qy = Math.abs(py) - (half - radius);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 圆环。 */
function ring(px, py, radius, halfThickness) {
  return Math.abs(Math.hypot(px, py) - radius) - halfThickness;
}

/** 45° 斜杠：把坐标转回轴对齐后按矩形算。 */
function slash(px, py, halfLength, halfWidth) {
  const c = Math.SQRT1_2;
  const rx = c * px + c * py;
  const ry = -c * px + c * py;
  return Math.max(Math.abs(rx) - halfLength, Math.abs(ry) - halfWidth);
}

/** 每像素 8×8 超采样，纯手工抗锯齿。 */
function renderRgba(size) {
  const S = 8;
  const half = size / 2;
  const radius = size * 0.22;
  const ringRadius = size * 0.32;
  const stroke = Math.max(size * 0.095, 1) / 2;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px = x + (sx + 0.5) / S - half;
          const py = y + (sy + 0.5) / S - half;
          if (roundedRect(px, py, half, radius) < 0) bgHits += 1;
          const inMark =
            ring(px, py, ringRadius, stroke) < 0 ||
            slash(px, py, ringRadius + stroke, stroke) < 0;
          if (inMark) fgHits += 1;
        }
      }
      const total = S * S;
      const bg = bgHits / total;
      const fg = Math.min(fgHits / total, bg);
      const alpha = bg;
      // 先把前景合成到背景上，再整体乘 alpha，避免圆角外缘出现白边。
      const mix = alpha === 0 ? 0 : fg / alpha;
      const at = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        pixels[at + c] = Math.round(BG[c] * (1 - mix) + FG[c] * mix);
      }
      pixels[at + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  // 10..12 = 压缩 / 滤波 / 隔行，全部为 0

  // 每条扫描线前置一个滤波器字节，这里一律用 0（None）。
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const file = resolve(outDir, `icon-${size}.png`);
  await writeFile(file, encodePng(size, renderRgba(size)));
  console.log(`wrote ${file}`);
}
