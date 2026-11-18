import { FPS_30, secondsToTicks } from '@momotombo/timing';
import { presetTransition } from './easing';
import type {
  AudioChannel, AudioMix, Background, CameraLayout, ID, ItemBase, MagnifierStyle, PrivacyItem, Project, Recording, Segment, Style, TextItem, Variant,
} from './types';
import { SCHEMA_VERSION } from './types';

export function newId(prefix = ''): ID {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

/** Background presets designed for this product. */
export const BACKGROUND_PRESETS: { id: string; name: string; background: Background }[] = [
  { id: 'derin', name: 'Azul profundo', background: { kind: 'aurora', colors: ['#0B0F1C', '#0D1326', '#0C79FF', '#F1F3F7'], seed: 9, grain: 0.03 } },
  { id: 'kor', name: 'Brasa', background: { kind: 'aurora', colors: ['#0E0E0F', '#2A1606', '#AD5200', '#FF940C'], seed: 4, grain: 0.035 } },
  { id: 'gece', name: 'Azul noche', background: { kind: 'aurora', colors: ['#0E1A2B', '#1F3B5C', '#3C6E91', '#C9A66B'], seed: 3, grain: 0.035 } },
  { id: 'tungsten', name: 'Tungsten', background: { kind: 'aurora', colors: ['#1A1206', '#5A3A0E', '#C8862A', '#F4D28A'], seed: 7, grain: 0.035 } },
  { id: 'okyanus', name: 'Océano', background: { kind: 'aurora', colors: ['#06161A', '#0C3B42', '#1F7A7A', '#9AD1C4'], seed: 11, grain: 0.03 } },
  { id: 'lavanta', name: 'Niebla lavanda', background: { kind: 'aurora', colors: ['#18162A', '#3B3466', '#9C8FE0', '#E6DDF7'], seed: 5, grain: 0.03 } },
  { id: 'mercan', name: 'Atardecer coral', background: { kind: 'aurora', colors: ['#2A1418', '#6B2B35', '#D07A6A', '#F2C6A0'], seed: 2, grain: 0.035 } },
  { id: 'adacayi', name: 'Salvia', background: { kind: 'gradient', from: '#1F2B24', to: '#7FB08E', angle: 135 } },
  { id: 'buzul', name: 'Glaciar', background: { kind: 'gradient', from: '#DDE6EE', to: '#9FB6CC', angle: 160 } },
  { id: 'col', name: 'Desierto', background: { kind: 'gradient', from: '#E9D8BD', to: '#B9875A', angle: 120 } },
  { id: 'grafit', name: 'Grafito', background: { kind: 'solid', color: '#17181C' } },
  { id: 'kagit', name: 'Papel', background: { kind: 'solid', color: '#EFEBE4' } },
];

export function defaultCameraLayout(): CameraLayout {
  return {
    visible: true,
    position: { x: 0.885, y: 0.8 },
    size: 0.27,
    shape: 'circle',
    aspect: 16 / 9,
    cornerRadius: 0.22,
    border: { width: 0, color: '#FFFFFF' },
    shadow: { opacity: 0.35, blur: 28 },
    mirror: true,
    zoom: 1,
  };
}

/** Allowed ranges of the magnifier settings (sliders and evaluation both use them). */
export const MAGNIFIER_LIMITS = {
  size: { min: 120, max: 560 },
  zoom: { min: 1.25, max: 4 },
  border: { min: 0, max: 8 },
} as const;

export function defaultMagnifier(): MagnifierStyle {
  return { size: 280, zoom: 2, shape: 'circle', border: { width: 3, color: '#FFFFFF' }, hideWhenIdle: false };
}

function plainChannel(gain: number): AudioChannel {
  return {
    gain,
    muted: false,
    highpassHz: 0,
    compressor: { enabled: false, thresholdDb: -24, ratio: 3 },
    gate: { enabled: false, thresholdDb: -50 },
    normalize: { enabled: false, targetLufs: -16 },
  };
}

/** Every enhancement off: the mix sounds exactly as files from before enhancement existed. */
export function defaultAudio(): AudioMix {
  return { mic: plainChannel(1), system: plainChannel(0.8) };
}

export function defaultStyle(): Style {
  return {
    background: BACKGROUND_PRESETS[0]!.background,
    frame: {
      padding: 0.065,
      radius: 14,
      shadow: { opacity: 0.4, blur: 48, offsetY: 18 },
      border: { width: 0, color: '#FFFFFF' },
      aspectMode: 'source',
      area: { x: 0, y: 0, w: 1, h: 1 },
    },
    camera: defaultCameraLayout(),
    cursor: { visible: true, scale: 1.25, smoothing: 0.5, clickEffect: 'ring', hideWhenIdle: true },
    magnifier: defaultMagnifier(),
    zoomDefaults: { scale: 1.8, enter: presetTransition('smooth'), exit: presetTransition('smooth') },
  };
}

export function defaultVariants(): Variant[] {
  return [
    { id: 'v_16x9', name: '16:9', width: 1920, height: 1080 },
    {
      id: 'v_9x16', name: '9:16', width: 1080, height: 1920, zoomStrength: 0.55,
      frameOverride: { aspectMode: 'fill', padding: 0.05, area: { x: 0, y: 0, w: 1, h: 0.66 } },
      cameraOverride: { position: { x: 0.5, y: 0.835 }, size: 0.24, shape: 'circle' },
    },
    {
      id: 'v_1x1', name: '1:1', width: 1080, height: 1080,
      frameOverride: { padding: 0.06 },
      cameraOverride: { position: { x: 0.84, y: 0.84 }, size: 0.24 },
    },
    {
      id: 'v_4x5', name: '4:5', width: 1080, height: 1350, zoomStrength: 0.7,
      frameOverride: { aspectMode: 'fill', padding: 0.055, area: { x: 0, y: 0, w: 1, h: 0.76 } },
      cameraOverride: { position: { x: 0.5, y: 0.87 }, size: 0.2, shape: 'rounded' },
    },
  ];
}

export function createProject(name: string, now = new Date()): Project {
  const ts = now.toISOString();
  return {
    schema: SCHEMA_VERSION,
    id: newId('prj'),
    name,
    createdAt: ts,
    updatedAt: ts,
    recordings: {},
    sequence: { fps: FPS_30, segments: [] },
    zooms: [],
    cameraLayouts: [],
    privacy: [],
    magnifiers: [],
    texts: [],
    style: defaultStyle(),
    variants: defaultVariants(),
    activeVariantId: 'v_16x9',
    audio: defaultAudio(),
    zoomEngine: { sensitivity: 'medium' },
  };
}

/** Adds a recording and appends it to the end of the timeline as one segment. */
export function addRecording(project: Project, recording: Recording): Project {
  const segment: Segment = {
    id: newId('seg'),
    recordingId: recording.id,
    sourceStart: 0,
    sourceEnd: recording.duration,
  };
  const screenFps = recording.sources.screen?.fps;
  const fps = screenFps && screenFps >= 50 ? { num: 60, den: 1 } : project.sequence.fps;
  return {
    ...project,
    recordings: { ...project.recordings, [recording.id]: recording },
    sequence: {
      fps: project.sequence.segments.length === 0 ? fps : project.sequence.fps,
      segments: [...project.sequence.segments, segment],
    },
  };
}

export const DEFAULT_PRIVACY_DURATION = secondsToTicks(3);

export function defaultPrivacyLook(): Pick<PrivacyItem, 'keyframes' | 'effect' | 'cornerRadius' | 'padFrames'> {
  return { keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2 };
}
export const DEFAULT_MAGNIFIER_DURATION = secondsToTicks(3);

/** Allowed ranges of the text settings; validation, the CLI and the sliders share them. */
export const TEXT_LIMITS = {
  length: 500,
  fontSize: { min: 0.01, max: 0.3 },
  maxWidth: { min: 0.1, max: 1 },
  padding: { min: 0, max: 2 },
  radius: { min: 0, max: 2 },
  stroke: { min: 0, max: 0.3 },
  blur: { min: 0, max: 1 },
  offsetY: { min: -0.5, max: 0.5 },
  animation: { min: 0, max: secondsToTicks(5) },
} as const;

export type TextLook = Omit<TextItem, keyof ItemBase | 'type' | 'text'>;
export const TEXT_PRESET_IDS = ['title', 'lower-third', 'caption', 'callout', 'chapter'] as const;
export type TextPresetId = (typeof TEXT_PRESET_IDS)[number];

const anim = (kind: TextItem['enter']['kind'], seconds: number) => ({ kind, duration: secondsToTicks(seconds) });
const SOFT_SHADOW = { color: '#000000', opacity: 0.45, blur: 0.25, offsetY: 0.05 };

/** Looks shared by the editor's preset picker and the CLI's addText. */
export const TEXT_PRESETS: Record<TextPresetId, TextLook> = {
  title: {
    position: { x: 0.5, y: 0.5 }, anchor: 'center', align: 'center', fontSize: 0.09, fontWeight: 800, color: '#FFFFFF', maxWidth: 0.8,
    shadow: SOFT_SHADOW, enter: anim('pop', 0.5), exit: anim('fade', 0.4),
  },
  'lower-third': {
    position: { x: 0.06, y: 0.88 }, anchor: 'bottom-left', align: 'left', fontSize: 0.045, fontWeight: 600, color: '#FFFFFF', maxWidth: 0.6,
    background: { color: '#111318', opacity: 0.82, padding: 0.55, radius: 0.3 }, enter: anim('slide-right', 0.45), exit: anim('fade', 0.3),
  },
  caption: {
    position: { x: 0.5, y: 0.93 }, anchor: 'bottom', align: 'center', fontSize: 0.042, fontWeight: 500, color: '#FFFFFF', maxWidth: 0.84,
    background: { color: '#000000', opacity: 0.6, padding: 0.35, radius: 0.2 }, enter: anim('fade', 0.2), exit: anim('fade', 0.2),
  },
  callout: {
    position: { x: 0.5, y: 0.18 }, anchor: 'center', align: 'center', fontSize: 0.05, fontWeight: 700, color: '#16171B', maxWidth: 0.5,
    background: { color: '#FFD44D', opacity: 1, padding: 0.5, radius: 0.35 }, enter: anim('pop', 0.35), exit: anim('pop', 0.25),
  },
  chapter: {
    position: { x: 0.08, y: 0.12 }, anchor: 'top-left', align: 'left', fontSize: 0.07, fontWeight: 800, color: '#FFFFFF', maxWidth: 0.7,
    shadow: SOFT_SHADOW, enter: anim('typewriter', 0.9), exit: anim('slide-up', 0.4),
  },
};

export const DEFAULT_TEXT_DURATION = secondsToTicks(3);
