import { EN } from './i18n-en';

/**
 * Two languages for now. Spanish strings are the source keys (they are what the code
 * contains); English comes from the dictionary. A missing English entry falls back to
 * the Spanish text, so nothing ever renders empty.
 */
export type Lang = 'es' | 'en';
export type LangSetting = 'auto' | Lang;

export interface AppSettings {
  language: LangSetting;
}

export interface SettingsInfo {
  language: LangSetting;
  /** The language actually in use. */
  resolved: Lang;
  /** The operating system's preferred languages, most preferred first. */
  system: string[];
}

export const DEFAULT_SETTINGS: AppSettings = { language: 'auto' };

/** Automatic choice: Spanish if the computer prefers Spanish, otherwise English. */
export function resolveLang(setting: LangSetting, systemLocales: readonly string[]): Lang {
  if (setting !== 'auto') return setting;
  const first = (systemLocales[0] ?? '').toLowerCase();
  return first.startsWith('es') ? 'es' : 'en';
}

export type Params = Record<string, string | number>;

export function translate(lang: Lang, text: string, params?: Params): string {
  const base = lang === 'en' ? (EN[text] ?? text) : text;
  return params ? base.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`)) : base;
}

/** Marks a source string that travels untranslated and is translated where it is shown. */
export function msg(text: string): string {
  return text;
}

/** Locale tag for dates and numbers. */
export function localeOf(lang: Lang): string {
  return lang === 'es' ? 'es-419' : 'en-US';
}
