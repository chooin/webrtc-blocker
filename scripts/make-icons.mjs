// 生成 src/icons/icon-{16,32,48,128}.png。
//
// 图形是 WebRTC 官方标志（五个彩色圆排成正五边形，中间压一个白色对话气泡），
// 外加一道阻断斜杠——这是个拦截器，图标不能只说「这里有 WebRTC」。
//
// 官方标志版权与授权：
//   Copyright The WebRTC project authors.
//   3-clause BSD License —— https://webrtc.org/license/
//   出处 https://webrtc.org/press/
// BSD 允许再分发与修改，条件是保留上面这段声明；README 里另有一份面向使用者的说明。
// 本文件不含官方 SVG 的任何代码，只按其几何参数重建：五个圆的圆心、半径、
// 气泡的圆角矩形与尾巴顶点，都是从官方 SVG 的 path 与 transform 里解出来的。
//
// 不引入任何图形库：这些都是圆、圆角矩形与三角形，用 zlib 手写一份最小合法 PNG
// 比拉一个依赖便宜得多，而且结果可复现。
// 产物已提交进仓库，改动图形时手动跑 `node scripts/make-icons.mjs` 重新生成。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];

/*
 * 以下坐标全部沿用官方 SVG 的单位，原点取五圆簇的形心。
 * 官方文件里每个圆都写成 `m0 0 c…`（圆心在各自局部坐标的 (-13.641, 0)、半径 13.642），
 * 真实位置在父级 <g> 的 matrix 上，这里已经把两级 transform 乘开了。
 */
const CIRCLE_RADIUS = 53.86;
const CIRCLES = [
  // 顺序即绘制顺序，与官方 SVG 一致：后画的压在先画的上面。
  { cx: -40.94, cy: 55.3, color: [0xff, 0x66, 0x00] }, // 橙 #f60
  { cx: 65.59, cy: -20.11, color: [0xff, 0xcc, 0x00] }, // 黄 #fc0
  { cx: -66.07, cy: -21.3, color: [0x00, 0x89, 0xcc] }, // 蓝 #0089cc
  { cx: 41.65, cy: 55.3, color: [0x00, 0x99, 0x39] }, // 绿 #009939
  { cx: -0.24, cy: -69.18, color: [0xbf, 0x00, 0x00] }, // 红 #bf0000
];

// 白色对话气泡：圆角矩形 + 左下角的尾巴。
const BALLOON = { x0: -70.75, y0: -54.54, x1: 61.88, y1: 48.63, radius: 13.42 };
const BALLOON_TAIL = [
  [12.4, 48.63],
  [-59.82, 84.03],
  [-48.84, 48.63],
];
const WHITE = [0xff, 0xff, 0xff];

/*
 * 阻断斜杠。半长刻意收在 100（而不是图形最外沿的 123）：
 * 背景是透明的，斜杠一旦伸出彩色圆之外，那一截在深色工具栏上就消失了。
 * 收进来之后它整条都压在不透明像素上，浅色深色工具栏下都完整。
 */
const SLASH_HALF_LENGTH = 100;
const SLASH_HALF_WIDTH = 13.5;
const SLASH_COLOR = [0x1b, 0x1d, 0x21];

// 图形的包围盒不是以形心对称的（上 123.04、下 109.16），画布要按包围盒居中。
const CENTER_Y = -6.94;
const HALF_EXTENT = 119.69;
/** 图形占画布的比例，两侧各留约 4% 边距。 */
const FILL = 0.46;

const circle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

/** 任意宽高的圆角矩形。 */
function roundedRect(px, py, box) {
  const halfW = (box.x1 - box.x0) / 2;
  const halfH = (box.y1 - box.y0) / 2;
  const qx = Math.abs(px - (box.x0 + halfW)) - (halfW - box.radius);
  const qy = Math.abs(py - (box.y0 + halfH)) - (halfH - box.radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - box.radius;
}

/** 三角形内外判定：三条边的叉积同号即在内部。 */
function inTriangle(px, py, tri) {
  const side = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  const d1 = side(px, py, tri[0][0], tri[0][1], tri[1][0], tri[1][1]);
  const d2 = side(px, py, tri[1][0], tri[1][1], tri[2][0], tri[2][1]);
  const d3 = side(px, py, tri[2][0], tri[2][1], tri[0][0], tri[0][1]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** 45° 斜杠（↘ 方向，标准禁止符的方向）：把坐标转回轴对齐后按矩形算。 */
function inSlash(px, py) {
  const c = Math.SQRT1_2;
  return (
    Math.abs(c * px + c * py) < SLASH_HALF_LENGTH && Math.abs(-c * px + c * py) < SLASH_HALF_WIDTH
  );
}

/*
 * 灰度变体：总开关关闭、或本站在白名单里时，工具栏换成它。
 *
 * 只把五个圆去色，气泡的白与斜杠的近黑原样保留。整张图一起按亮度压灰的话，
 * 深红圆（亮度约 41）会和斜杠（约 29）糊在一起，图形就散了。
 * 压进 [120, 200] 这个窄区间也是同一个理由：留出与白气泡、与深色斜杠的对比。
 */
function toGray(color) {
  const luma = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  const level = Math.round(120 + (luma / 255) * 80);
  return [level, level, level];
}

/** 某个采样点最终是什么颜色；落在图形之外返回 null（透明）。 */
function sampleColor(px, py, gray) {
  let color = null;
  for (const item of CIRCLES) {
    if (circle(px, py, item.cx, item.cy, CIRCLE_RADIUS) < 0) {
      color = gray ? toGray(item.color) : item.color;
    }
  }
  if (roundedRect(px, py, BALLOON) < 0 || inTriangle(px, py, BALLOON_TAIL)) color = WHITE;
  if (inSlash(px, py)) color = SLASH_COLOR;
  return color;
}

/**
 * 每像素 8×8 超采样，纯手工抗锯齿。
 *
 * 背景透明，所以颜色要按**命中的样本**取平均、alpha 按覆盖率取——
 * 拿全部样本去平均的话，边缘会朝黑色渗，深色工具栏上尤其明显。
 */
function renderRgba(size, gray) {
  const S = 8;
  const half = size / 2;
  const scale = (size * FILL) / HALF_EXTENT;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px = (x + (sx + 0.5) / S - half) / scale;
          const py = (y + (sy + 0.5) / S - half) / scale + CENTER_Y;
          const color = sampleColor(px, py, gray);
          if (color === null) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          hits += 1;
        }
      }
      const at = (y * size + x) * 4;
      if (hits > 0) {
        pixels[at] = Math.round(r / hits);
        pixels[at + 1] = Math.round(g / hits);
        pixels[at + 2] = Math.round(b / hits);
      }
      pixels[at + 3] = Math.round((hits / (S * S)) * 255);
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
for (const gray of [false, true]) {
  for (const size of SIZES) {
    // 文件名与 src/core/icon-files.ts 里的路径一一对应，改名两头一起改。
    const file = resolve(outDir, gray ? `icon-gray-${size}.png` : `icon-${size}.png`);
    await writeFile(file, encodePng(size, renderRgba(size, gray)));
    console.log(`wrote ${file}`);
  }
}
