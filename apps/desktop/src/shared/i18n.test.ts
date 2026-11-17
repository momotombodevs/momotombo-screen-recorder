import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localeOf, resolveLang, translate } from './i18n';
import { EN } from './i18n-en';

/** Strings that read the same in both languages (codec names, units). */
const SAME = new Set(['Momotombo', 'H.264', 'VP9', 'VP8', '30 fps', '60 fps', '1080p', '4K', 'MP4 · H.264', 'MP4 · VP9', 'WebM · VP9', 'WebM · VP8', 'Formato', 'Zoom', 'V / Esc']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [p] : [];
  });
}

/** Every literal passed to t() or tm() in the app. */
function usedKeys(): string[] {
  const keys = new Set<string>();
  const call = /\b(?:tm?|msg)\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  for (const file of sourceFiles(join(import.meta.dirname, '..'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(call)) {
      keys.add(m[1] !== undefined ? (JSON.parse(`"${m[1]}"`) as string) : m[2]!);
    }
  }
  return [...keys];
}

const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('follows the computer language when set to automatic', () => {
    expect(resolveLang('auto', ['es-NI', 'en-US'])).toBe('es');
    expect(resolveLang('auto', ['es-419'])).toBe('es');
    expect(resolveLang('auto', ['ES'])).toBe('es');
    expect(resolveLang('auto', ['en-GB'])).toBe('en');
    expect(resolveLang('auto', ['tr-TR'])).toBe('en');
    expect(resolveLang('auto', ['de-DE', 'es-ES'])).toBe('en');
    expect(resolveLang('auto', [])).toBe('en');
    expect(resolveLang('es', ['en-US'])).toBe('es');
    expect(resolveLang('en', ['es-NI'])).toBe('en');
  });

  it('formats dates and numbers for Latin American Spanish', () => {
    expect(localeOf('es')).toBe('es-419');
    expect(localeOf('en')).toBe('en-US');
  });

  it('fills placeholders and falls back to Spanish', () => {
    expect(translate('en', 'La grabación empieza en {n} segundos', { n: 3 })).toBe('Recording starts in 3 seconds');
    expect(translate('es', 'La grabación empieza en {n} segundos', { n: 3 })).toBe('La grabación empieza en 3 segundos');
    expect(translate('en', 'sin traducción')).toBe('sin traducción');
  });

  it('has an English entry for every string in the app', () => {
    const missing = usedKeys().filter((k) => !(k in EN) && !SAME.has(k));
    expect(missing).toEqual([]);
  });

  it('keeps the same placeholders in both languages', () => {
    const broken = Object.entries(EN).filter(([es, en]) => params(es).join() !== params(en).join()).map(([es]) => es);
    expect(broken).toEqual([]);
  });
});
