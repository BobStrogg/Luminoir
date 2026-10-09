import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function drawLine(png, x0, y0, x1, y1, color) {
  // Simple Bresenham with shallow anti-alias by overdraw
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (true) {
    setPixel(png, x, y, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
  }
}

function setPixel(png, x, y, { r, g, b, a = 255 }) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx + 0] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function drawGrid(png, margin, { xTicks = 10, yTicks = 5 } = {}) {
  const w = png.width - margin.left - margin.right;
  const h = png.height - margin.top - margin.bottom;
  const left = margin.left;
  const top = margin.top;
  const gridColor = { r: 220, g: 220, b: 220, a: 255 };
  // Outer border
  for (let x = left; x < left + w; x++) {
    setPixel(png, x, top, gridColor);
    setPixel(png, x, top + h, gridColor);
  }
  for (let y = top; y <= top + h; y++) {
    setPixel(png, left, y, gridColor);
    setPixel(png, left + w, y, gridColor);
  }
  // Vertical grid
  for (let i = 1; i < xTicks; i++) {
    const x = left + Math.round((i / xTicks) * w);
    for (let y = top; y <= top + h; y += 2) {
      setPixel(png, x, y, gridColor);
    }
  }
  // Horizontal grid
  for (let i = 1; i < yTicks; i++) {
    const y = top + Math.round((i / yTicks) * h);
    for (let x = left; x <= left + w; x += 2) {
      setPixel(png, x, y, gridColor);
    }
  }
}

/**
 * Plot multiple named series onto a PNG file.
 * series: Array<{ name, data: Array<{ t: number, y: number }>, color?: {r,g,b} }>
 */
export function plotSeries({ width = 1200, height = 600, margin = { top: 20, right: 20, bottom: 30, left: 50 } }, series, outPath, yRange = null) {
  const png = new PNG({ width, height });
  // White bg
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = 255;
    png.data[i + 1] = 255;
    png.data[i + 2] = 255;
    png.data[i + 3] = 255;
  }
  drawGrid(png, margin, { xTicks: 10, yTicks: 6 });

  // Compute bounds
  let tMin = Infinity, tMax = -Infinity;
  let yMin = yRange ? yRange[0] : Infinity;
  let yMax = yRange ? yRange[1] : -Infinity;
  for (const s of series) {
    for (const p of s.data) {
      if (!Number.isFinite(p.t) || !Number.isFinite(p.y)) continue;
      tMin = Math.min(tMin, p.t);
      tMax = Math.max(tMax, p.t);
      if (!yRange) {
        yMin = Math.min(yMin, p.y);
        yMax = Math.max(yMax, p.y);
      }
    }
  }
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) {
    throw new Error('No finite data to plot');
  }
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }

  const left = margin.left;
  const top = margin.top;
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;
  const xScale = (t) => left + Math.round(((t - tMin) / (tMax - tMin)) * w);
  const yScale = (y) => top + Math.round((1 - clamp01((y - yMin) / (yMax - yMin))) * h);

  for (const s of series) {
    const color = s.color || { r: 20, g: 20, b: 220, a: 255 };
    for (let i = 1; i < s.data.length; i++) {
      const p0 = s.data[i - 1];
      const p1 = s.data[i];
      drawLine(png, xScale(p0.t), yScale(p0.y), xScale(p1.t), yScale(p1.y), color);
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.sync.write(png));
}

