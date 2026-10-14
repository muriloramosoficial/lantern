#!/usr/bin/env node
'use strict';

/**
 * Generates resources/icon.png (512x512, for macOS and Linux) and
 * resources/icon.ico (256x256 PNG-in-ICO, for Windows) without any dependency.
 *
 * macOS refuses app icons smaller than 512px, so the PNG is rendered at that
 * size while the ICO keeps the Windows-friendly 256px canvas.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BASE = 256;
const PNG_SIZE = 512;
const ICO_SIZE = 256;
const OUT_DIR = path.join(__dirname, '..', 'resources');

/* --------------------------------------------------------------- drawing */

function createCanvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) };
}

function blend(canvas, x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size || alpha <= 0) return;
  const index = (y * canvas.size + x) * 4;
  const a = Math.min(1, alpha);
  const dst = canvas.data;
  dst[index] = dst[index] * (1 - a) + r * a;
  dst[index + 1] = dst[index + 1] * (1 - a) + g * a;
  dst[index + 2] = dst[index + 2] * (1 - a) + b * a;
  dst[index + 3] = Math.min(255, dst[index + 3] * (1 - a) + 255 * a);
}

function roundedRect(canvas, scale, x0, y0, x1, y1, radius, color, alpha = 1) {
  const s = scale;
  const [X0, Y0, X1, Y1, R] = [x0 * s, y0 * s, x1 * s, y1 * s, radius * s];
  for (let y = Math.floor(Y0); y < Y1; y += 1) {
    for (let x = Math.floor(X0); x < X1; x += 1) {
      const dx = Math.max(X0 + R - x, 0, x - (X1 - R - 1));
      const dy = Math.max(Y0 + R - y, 0, y - (Y1 - R - 1));
      const distance = Math.hypot(dx, dy);
      if (distance <= R) blend(canvas, x, y, color, alpha);
      else if (distance <= R + 1) blend(canvas, x, y, color, alpha * (R + 1 - distance));
    }
  }
}

function radialGlow(canvas, scale, cx, cy, radius, color, strength) {
  const [CX, CY, R] = [cx * scale, cy * scale, radius * scale];
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      const distance = Math.hypot(x - CX, y - CY);
      if (distance > R) continue;
      const falloff = 1 - distance / R;
      blend(canvas, x, y, color, falloff * falloff * strength);
    }
  }
}

/** Draws the lantern mark into a square canvas of the requested size. */
function draw(size) {
  const scale = size / BASE;
  const canvas = createCanvas(size);
  const cx = BASE / 2;
  const frame = [24, 27, 33];

  radialGlow(canvas, scale, cx, 140, 118, [245, 166, 35], 0.32);
  radialGlow(canvas, scale, cx, 138, 74, [255, 214, 130], 0.4);

  roundedRect(canvas, scale, 78, 62, 178, 84, 6, frame);
  roundedRect(canvas, scale, 86, 84, 170, 196, 10, frame);

  for (let y = 88; y < 192; y += 1) {
    const t = (y - 88) / (192 - 88);
    const color = [255 - 30 * t, Math.round(196 - 60 * t), Math.round(96 - 60 * t)];
    roundedRect(canvas, scale, 92, y, 164, y + 1, 0, color, 0.95);
  }

  for (let y = 108; y < 176; y += 1) {
    const t = (y - 108) / 68;
    const width = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 22 + 4;
    const left = Math.round((cx - width / 2) * scale);
    const right = Math.round((cx + width / 2) * scale);
    for (let x = left; x <= right; x += 1) {
      const edge = 1 - Math.abs(x - cx * scale) / ((width / 2 + 1) * scale);
      const rowTop = Math.round(y * scale);
      const rowBottom = Math.round((y + 1) * scale);
      for (let ry = rowTop; ry < rowBottom; ry += 1) {
        blend(canvas, x, ry, [255, 250, 232], Math.max(0, edge) * 0.55 * (1 - t * 0.35));
      }
    }
  }
  radialGlow(canvas, scale, cx, 142, 40, [255, 244, 214], 0.5);

  roundedRect(canvas, scale, 88, 196, 168, 210, 5, frame);
  roundedRect(canvas, scale, 116, 40, 140, 66, 4, frame);
  roundedRect(canvas, scale, 108, 30, 148, 44, 8, frame);

  return canvas.data;
}

/* ------------------------------------------------------------------ png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // bytes in resource
  entry.writeUInt32LE(6 + 16, 12); // image offset

  return Buffer.concat([header, entry, pngBuffer]);
}

const png = encodePng(draw(PNG_SIZE), PNG_SIZE);
const ico = encodeIco(encodePng(draw(ICO_SIZE), ICO_SIZE), ICO_SIZE);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

console.log(`wrote resources/icon.png (${PNG_SIZE}x${PNG_SIZE}, ${(png.length / 1024).toFixed(1)} kB)`);
console.log(`wrote resources/icon.ico (${ICO_SIZE}x${ICO_SIZE}, ${(ico.length / 1024).toFixed(1)} kB)`);
