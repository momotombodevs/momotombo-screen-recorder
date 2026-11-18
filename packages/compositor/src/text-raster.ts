import { graphemes, type Rect, type TextAnchor, type TextLayer } from '@momotombo/project-model';

export const TEXT_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
export const TEXT_LINE_HEIGHT = 1.2;
const LAYOUT_FONT_PX = 100;

export const fontFor = (weight: number, px: number) => `${weight} ${px}px ${TEXT_FONT_STACK}`;

export interface LineSpan {
  start: number;
  end: number;
}

const offsetAfter = (text: string, count: number) => graphemes(text).slice(0, count).join('').length;

export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): LineSpan[] {
  const lines: LineSpan[] = [];
  let paragraphStart = 0;
  for (const paragraph of text.split('\n')) {
    let start = paragraphStart;
    let end = paragraphStart;
    let wordStart = paragraphStart;
    for (const word of paragraph.split(' ')) {
      const wordEnd = wordStart + word.length;
      if (end === start) {
        start = wordStart;
        end = wordEnd;
      } else if (measure(text.slice(start, wordEnd)) <= maxWidth) {
        end = wordEnd;
      } else {
        lines.push({ start, end });
        start = wordStart;
        end = wordEnd;
      }
      while (measure(text.slice(start, end)) > maxWidth) {
        const parts = graphemes(text.slice(start, end));
        if (parts.length < 2) break;
        let keep = parts.length - 1;
        while (keep > 1 && measure(parts.slice(0, keep).join('')) > maxWidth) keep--;
        const cut = start + parts.slice(0, keep).join('').length;
        lines.push({ start, end: cut });
        start = cut;
      }
      wordStart = wordEnd + 1;
    }
    lines.push({ start, end });
    paragraphStart += paragraph.length + 1;
  }
  return lines;
}

export function revealedLines(text: string, lines: LineSpan[], visibleGraphemes: number): string[] {
  const revealed = offsetAfter(text, visibleGraphemes);
  return lines.map((l) => text.slice(l.start, Math.max(l.start, Math.min(l.end, revealed))));
}

export const MAX_TEXT_PIXELS = 16_000_000;

export function rasterFit(w: number, h: number, maxSide: number, maxPixels: number): number {
  return Math.min(1, maxSide / w, maxSide / h, Math.sqrt(maxPixels / (w * h)));
}

export class RasterCache<T> {
  private entries = new Map<string, T>();
  private used = new Set<string>();

  constructor(private readonly free: (entry: T) => void) {}

  get(key: string, create: () => T): T {
    this.used.add(key);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = create();
      this.entries.set(key, entry);
    }
    return entry;
  }

  endFrame(): void {
    for (const [key, entry] of this.entries) {
      if (this.used.has(key)) continue;
      this.free(entry);
      this.entries.delete(key);
    }
    this.used.clear();
  }

  clear(): void {
    for (const entry of this.entries.values()) this.free(entry);
    this.entries.clear();
    this.used.clear();
  }
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

const wrapCache = new Map<string, LineSpan[]>();
const WRAP_CACHE_SIZE = 64;

function wrapAtReferenceSize(layer: TextLayer): LineSpan[] {
  const key = `${layer.fontWeight}|${layer.maxWidth / layer.fontSize}|${layer.text}`;
  let lines = wrapCache.get(key);
  if (!lines) {
    const m = measurer();
    m.font = fontFor(layer.fontWeight, LAYOUT_FONT_PX);
    lines = wrapText(layer.text, (layer.maxWidth / layer.fontSize) * LAYOUT_FONT_PX, (s) => m.measureText(s).width);
    if (wrapCache.size >= WRAP_CACHE_SIZE) wrapCache.delete(wrapCache.keys().next().value!);
    wrapCache.set(key, lines);
  }
  return lines;
}

/**
 * Rasterises a text layer at its own pixel size. Lines are broken at a fixed reference size, so
 * the preview and an export at another resolution wrap the same words onto the same lines.
 */
export function rasterizeText(layer: TextLayer, maxSide: number): TextRaster {
  const em = layer.fontSize;
  const spans = wrapAtReferenceSize(layer);
  const full = spans.map((l) => layer.text.slice(l.start, l.end));
  const m = measurer();
  m.font = fontFor(layer.fontWeight, em);
  const widths = full.map((l) => m.measureText(l).width);
  const lineH = em * TEXT_LINE_HEIGHT;
  const bg = layer.background && layer.background.opacity > 0 ? layer.background : null;
  const pad = layer.background?.padding ?? 0;
  const strokeW = layer.stroke?.width ?? 0;
  const contentW = Math.max(1, ...widths);
  const boxW = contentW + 2 * pad + strokeW;
  const boxH = full.length * lineH + 2 * pad + strokeW;
  const shadow = layer.shadow;
  const margin = Math.ceil((shadow ? shadow.blur * 2 + Math.abs(shadow.offsetY) : 0) + strokeW + 2);
  const fit = rasterFit(boxW + 2 * margin, boxH + 2 * margin, maxSide, MAX_TEXT_PIXELS);
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
  if (bg) {
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
  revealedLines(layer.text, spans, layer.visibleGraphemes).forEach((shown, i) => {
    if (!shown) return;
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
  const bg = l.background;
  const st = l.stroke;
  const sh = l.shadow;
  return [
    l.text, l.visibleGraphemes, l.align, l.fontSize, l.fontWeight, l.color, l.maxWidth,
    bg ? `${bg.color}/${bg.opacity}/${bg.padding}/${bg.radius}` : '',
    st ? `${st.color}/${st.width}` : '',
    sh ? `${sh.color}/${sh.opacity}/${sh.blur}/${sh.offsetY}` : '',
  ].join('\u0000');
}
