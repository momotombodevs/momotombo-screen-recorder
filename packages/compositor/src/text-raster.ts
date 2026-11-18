import type { Rect, TextAnchor, TextLayer } from '@momotombo/project-model';

export const TEXT_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
export const TEXT_LINE_HEIGHT = 1.2;
const LAYOUT_FONT_PX = 100;

export const fontFor = (weight: number, px: number) => `${weight} ${px}px ${TEXT_FONT_STACK}`;

export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
      while (measure(line) > maxWidth && Array.from(line).length > 1) {
        const chars = Array.from(line);
        let n = chars.length - 1;
        while (n > 1 && measure(chars.slice(0, n).join('')) > maxWidth) n--;
        lines.push(chars.slice(0, n).join(''));
        line = chars.slice(n).join('');
      }
    }
    lines.push(line);
  }
  return lines;
}

const ANCHOR_FRACTION: Record<TextAnchor, [number, number]> = {
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
};

export function anchoredBox(anchor: TextAnchor, at: { x: number; y: number }, w: number, h: number): Rect {
  const [fx, fy] = ANCHOR_FRACTION[anchor];
  return { x: at.x - fx * w, y: at.y - fy * h, w, h };
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface TextRaster {
  image: HTMLCanvasElement | OffscreenCanvas;
  boxInImage: Rect;
  pixelScale: number;
}

function newCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

let measureCtx: Ctx2D | null = null;
function measurer(): Ctx2D {
  measureCtx ??= newCanvas(1, 1).getContext('2d') as Ctx2D;
  return measureCtx;
}

/**
 * Rasterises a text layer at its own pixel size. Lines are broken at a fixed reference size, so
 * the preview and an export at another resolution wrap the same words onto the same lines.
 */
export function rasterizeText(layer: TextLayer, maxSide: number): TextRaster {
  const em = layer.fontSize;
  const m = measurer();
  m.font = fontFor(layer.fontWeight, LAYOUT_FONT_PX);
  const lines = wrapText(layer.text, (layer.maxWidth / em) * LAYOUT_FONT_PX, (s) => m.measureText(s).width);
  m.font = fontFor(layer.fontWeight, em);
  const widths = lines.map((l) => m.measureText(l).width);
  const lineH = em * TEXT_LINE_HEIGHT;
  const pad = layer.background?.padding ?? 0;
  const strokeW = layer.stroke?.width ?? 0;
  const contentW = Math.max(1, ...widths);
  const boxW = contentW + 2 * pad + strokeW;
  const boxH = lines.length * lineH + 2 * pad + strokeW;
  const shadow = layer.shadow;
  const margin = Math.ceil((shadow ? shadow.blur * 2 + Math.abs(shadow.offsetY) : 0) + strokeW + 2);
  const fit = Math.min(1, maxSide / (boxW + 2 * margin), maxSide / (boxH + 2 * margin));
  const w = Math.max(1, Math.ceil((boxW + 2 * margin) * fit));
  const h = Math.max(1, Math.ceil((boxH + 2 * margin) * fit));
  const image = newCanvas(w, h);
  const ctx = image.getContext('2d') as Ctx2D;
  ctx.scale(fit, fit);
  const applyShadow = (on: boolean) => {
    ctx.shadowColor = on && shadow ? withAlpha(shadow.color, shadow.opacity) : 'transparent';
    ctx.shadowBlur = on && shadow ? shadow.blur * fit : 0;
    ctx.shadowOffsetY = on && shadow ? shadow.offsetY * fit : 0;
  };
  const bg = layer.background;
  if (bg && bg.opacity > 0) {
    applyShadow(true);
    ctx.fillStyle = withAlpha(bg.color, bg.opacity);
    ctx.beginPath();
    ctx.roundRect(margin, margin, boxW, boxH, Math.min(bg.radius, boxW / 2, boxH / 2));
    ctx.fill();
  }
  ctx.font = fontFor(layer.fontWeight, em);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  let budget = layer.visibleChars;
  lines.forEach((line, i) => {
    if (budget <= 0) return;
    const chars = Array.from(line);
    const shown = chars.slice(0, budget).join('');
    budget -= chars.length;
    const free = contentW - widths[i]!;
    const x = margin + pad + strokeW / 2 + (layer.align === 'center' ? free / 2 : layer.align === 'right' ? free : 0);
    const y = margin + pad + strokeW / 2 + (i + 0.5) * lineH;
    if (layer.stroke) {
      applyShadow(!bg);
      ctx.strokeStyle = layer.stroke.color;
      ctx.lineWidth = strokeW * 2;
      ctx.strokeText(shown, x, y);
    }
    applyShadow(!bg && !layer.stroke);
    ctx.fillStyle = layer.color;
    ctx.fillText(shown, x, y);
  });
  return { image, boxInImage: { x: margin * fit, y: margin * fit, w: boxW * fit, h: boxH * fit }, pixelScale: fit };
}

function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function rasterKey(l: TextLayer): string {
  return JSON.stringify([l.text, l.visibleChars, l.align, l.fontSize, l.fontWeight, l.color, l.maxWidth, l.background, l.stroke, l.shadow]);
}
