// 生成 src/icons/icon-{16,32,48,128}.png。
//
// 不引入任何图形库：图标是四个固定尺寸的纯色圆角方块加一个「被切断的对等连接」，
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

/** 实心圆。 */
function circle(px, py, cx, cy, radius) {
  return Math.hypot(px - cx, py - cy) - radius;
}

/** 胶囊：从 a 到 b 的线段外扩 halfWidth，两端是圆头。 */
function capsule(px, py, ax, ay, bx, by, halfWidth) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0), 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - halfWidth;
}

/** 45° 斜杠：把坐标转回轴对齐后按矩形算。 */
function slash(px, py, halfLength, halfWidth) {
  const c = Math.SQRT1_2;
  const rx = c * px + c * py;
  const ry = -c * px + c * py;
  return Math.max(Math.abs(rx) - halfLength, Math.abs(ry) - halfWidth);
}

/*
 * 图形：两个对等节点连成一条线，被一道 45° 斜杠切断。
 *
 * 连线走 ↗ 对角线、斜杠走 ↘ 对角线，两者正交——这是这块画布上能给到的最大角度差。
 * 之前把连线放在水平方向试过，与斜杠只差 45°，16px 上两条线糊成一团分不出谁是谁。
 * 节点也因此能沿对角线放到更外面：正方形的对角比水平方向长 41%，那段余量本来是浪费的。
 *
 * 连线不画成整条再挖背景色，而是直接画成断开的两截——几何结果一样，
 * 但不需要「背景色」这个概念，App.tsx 里的 SVG 版才能照抄同一组坐标。
 * 所有长度都按 size 取比例，四个尺寸出来的是同一个图形，不是四张各画各的。
 */
const NODE_DISTANCE = 0.4; // 节点圆心沿 ↗ 对角线到中心的距离
const NODE_RADIUS = 0.105;
const LINK_HALF_WIDTH = 0.042;
const LINK_INNER = 0.105; // 连线内端到中心的距离：正好给斜杠让出断口
const SLASH_HALF_LENGTH = 0.36;
const SLASH_HALF_WIDTH = 0.058;

/** 每像素 8×8 超采样，纯手工抗锯齿。 */
function renderRgba(size) {
  const S = 8;
  const half = size / 2;
  const radius = size * 0.22;
  // ↗ 方向上的单位分量：y 轴向下，所以往右上走是 x 加、y 减。
  const nodeX = size * NODE_DISTANCE * Math.SQRT1_2;
  const linkX = size * LINK_INNER * Math.SQRT1_2;
  const nodeRadius = size * NODE_RADIUS;
  const linkHalfWidth = size * LINK_HALF_WIDTH;
  const slashHalfLength = size * SLASH_HALF_LENGTH;
  const slashHalfWidth = size * SLASH_HALF_WIDTH;
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
            circle(px, py, -nodeX, nodeX, nodeRadius) < 0 ||
            circle(px, py, nodeX, -nodeX, nodeRadius) < 0 ||
            capsule(px, py, -nodeX, nodeX, -linkX, linkX, linkHalfWidth) < 0 ||
            capsule(px, py, linkX, -linkX, nodeX, -nodeX, linkHalfWidth) < 0 ||
            slash(px, py, slashHalfLength, slashHalfWidth) < 0;
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
