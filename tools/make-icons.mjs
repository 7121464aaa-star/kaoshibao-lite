/* make-icons.mjs —— 生成 PWA 图标（纯 Node，零依赖：手写 PNG 编码 + 软边光栅化）。
   用法：node tools/make-icons.mjs [outDir]     默认输出到 dist/icons/
   产物：icon-192.png / icon-512.png / maskable-512.png / apple-touch-icon.png (180x180)
   图形：蓝底圆角方块 + 白色对勾（判分正确）＋答题卡横线，内容居中并按安全区缩放。 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGBA
  // 每行前导 filter byte=0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy ? rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
              : Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 软边几何（alpha 抗锯齿） ---------- */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(wx - vx * t, wy - vy * t);
}
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
/* 覆盖率：d 为有符号距离，内部(<0)覆盖 1，外部(>aa)覆盖 0，边缘平滑过渡 */
const coverage = (d, aa) => clamp01(0.5 - d / aa);

function makeIcon(size, opts = {}) {
  const pad = opts.pad ?? 0.04;          // 背景相对画布外边距（any 图标留白边；maskable 为 0）
  const contentScale = opts.contentScale ?? (opts.maskable ? 0.78 : 0.86); // 内容安全区
  const bg = opts.bg || [37, 99, 235];   // #2563eb
  const fg = [255, 255, 255, 255];
  const aa = Math.max(1, size / 96);     // 抗锯齿宽度

  const C = new Float32Array(size * size * 4); // 预乘? 直接用直写
  const out = Buffer.alloc(size * size * 4);

  const half = (size * (1 - pad * 2)) / 2;
  const ccx = size / 2, ccy = size / 2;
  const rad = half * 0.5;                 // 圆角半径

  // 内容坐标系：中心在 c 处，半宽为 half*contentScale
  const cs = half * contentScale;

  const setPix = (x, y, a, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const na = (a * (color[3] ?? 255)) / 255;
    const da = out[i + 3] / 255;
    const oa = na + da * (1 - na);
    if (oa <= 0) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; return; }
    for (let cI = 0; cI < 3; cI++) {
      out[i + cI] = Math.round((color[cI] * na + out[i + cI] * da * (1 - na)) / oa);
    }
    out[i + 3] = Math.round(oa * 255);
  };

  // 1) 背景圆角矩形
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, ccx, ccy, half, half, rad);
      const a = coverage(d, aa);
      if (a > 0.003) setPix(x, y, a, bg.concat(255));
    }
  }

  // 2) 白色内容（相对内容框的归一化坐标 u,v ∈[-1,1]，y 向下）
  //    对勾折线：左上起笔 → 中下尖 → 右上收笔（标准 ✓）
  //    答题卡：勾下方两条横线
  const drawSeg = (ax, ay, bx, by, halfW) => {
    const axx = ccx + ax * cs, ayy = ccy + ay * cs;
    const bxx = ccx + bx * cs, byy = ccy + by * cs;
    const hw = halfW || (0.07 * cs);
    const x0 = Math.max(0, Math.floor(Math.min(axx, bxx) - hw - 1));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(axx, bxx) + hw + 1));
    const y0 = Math.max(0, Math.floor(Math.min(ayy, byy) - hw - 1));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(ayy, byy) + hw + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = sdSegment(x + 0.5, y + 0.5, axx, ayy, bxx, byy);
        const a = coverage(d - hw, aa * 0.8);
        if (a > 0.003) setPix(x, y, a, fg);
      }
    }
  };
  const check = [[-0.42, 0.02], [-0.04, 0.42], [0.50, -0.28]];
  drawSeg(check[0][0], check[0][1], check[1][0], check[1][1], 0.075 * cs);
  drawSeg(check[1][0], check[1][1], check[2][0], check[2][1], 0.075 * cs);
  // 圆头：两折点补圆
  for (const [px, py] of check) {
    const pxx = ccx + px * cs, pyy = ccy + py * cs;
    const r0 = Math.max(0, Math.floor(pxx - 0.08 * cs)), r1 = Math.min(size - 1, Math.ceil(pxx + 0.08 * cs));
    const s0 = Math.max(0, Math.floor(pyy - 0.08 * cs)), s1 = Math.min(size - 1, Math.ceil(pyy + 0.08 * cs));
    for (let y = s0; y <= s1; y++) {
      for (let x = r0; x <= r1; x++) {
        const d = Math.hypot(x + 0.5 - pxx, y + 0.5 - pyy);
        const a = coverage(d - 0.08 * cs, aa * 0.8);
        if (a > 0.003) setPix(x, y, a, fg);
      }
    }
  }
  // 答题卡横线（细）
  drawSeg(-0.42, 0.66, 0.42, 0.66, 0.035 * cs);
  drawSeg(-0.42, 0.82, 0.28, 0.82, 0.035 * cs);

  return encodePng(size, size, out);
}

/* ---------- main ---------- */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || join(root, 'app', 'icons');
mkdirSync(outDir, { recursive: true });

const jobs = [
  ['icon-192.png', makeIcon(192, {})],
  ['icon-512.png', makeIcon(512, {})],
  ['maskable-512.png', makeIcon(512, { pad: 0, contentScale: 0.68, maskable: true })],
  ['apple-touch-icon.png', makeIcon(180, { pad: 0, contentScale: 0.8 })]
];
for (const [name, buf] of jobs) {
  writeFileSync(join(outDir, name), buf);
  console.log('✔ 已生成: ' + join(outDir, name) + ' (' + buf.length + ' B)');
}
