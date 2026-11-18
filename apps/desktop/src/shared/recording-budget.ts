/**
 * How fast a recording fills the disk, and how much recording time the free space allows.
 * The bitrates mirror the encoders: the capture window's MediaRecorder (renderer/capture.ts)
 * and the macOS helper (native/recorder-macos TrackWriter.swift).
 */

export type Quality = 'standard' | 'high' | 'max';
export type TrackKind = 'screen' | 'camera' | 'mic' | 'system';

export interface BudgetInput {
  backend: 'native-macos' | 'native-windows' | 'web';
  quality: Quality;
  fps: number;
  /** Captured screen area in physical pixels. */
  pixels: number;
  camera: boolean;
  mic: boolean;
  systemAudio: boolean;
}

export type DiskLevel = 'ok' | 'low' | 'insufficient';

export interface DiskEstimate {
  level: DiskLevel | 'unknown';
  freeBytes: number | null;
  minutesLeft: number | null;
}

const AUDIO_BPS = 160_000;
const MIB = 1024 ** 2;
const FINISH_RESERVE_BYTES = 512 * MIB;
const FINISH_RESERVE_SECONDS = 60;
const MIN_START_MINUTES = 2;
const COMFORTABLE_MINUTES = 15;

export function webVideoBitrate(kind: TrackKind, quality: Quality, pixels: number): number {
  if (kind === 'mic' || kind === 'system') return AUDIO_BPS;
  if (kind === 'camera') return quality === 'max' ? 10e6 : quality === 'high' ? 7e6 : 4e6;
  const base = pixels > 6e6 ? 30e6 : pixels > 3e6 ? 20e6 : 12e6;
  return quality === 'max' ? base * 1.5 : quality === 'high' ? base : base * 0.6;
}

function nativeVideoBitrate(pixels: number, fps: number, quality: Quality): number {
  const bitsPerPixel = quality === 'max' ? 0.2 : quality === 'high' ? 0.12 : 0.07;
  return Math.min(80e6, Math.max(2e6, pixels * Math.min(fps, 60) * bitsPerPixel));
}

function nativeScreenPixels(pixels: number, quality: Quality): number {
  const cap = quality === 'standard' ? 1920 * 1200 : 3840 * 2400;
  return Math.min(pixels, cap);
}

export function recordingBytesPerSecond(i: BudgetInput): number {
  let bits: number;
  if (i.backend === 'web') {
    bits = webVideoBitrate('screen', i.quality, i.pixels) + (i.camera ? webVideoBitrate('camera', i.quality, 0) : 0);
  } else {
    const cameraPixels = i.quality === 'standard' ? 1280 * 720 : 1920 * 1080;
    bits = nativeVideoBitrate(nativeScreenPixels(i.pixels, i.quality), i.fps, i.quality) + (i.camera ? nativeVideoBitrate(cameraPixels, 30, i.quality) : 0);
  }
  bits += (i.mic ? AUDIO_BPS : 0) + (i.systemAudio ? AUDIO_BPS : 0);
  return bits / 8;
}

/** Below this much free space a running recording stops, leaving room to close its files. */
export function stopBelowBytes(bytesPerSecond: number): number {
  return FINISH_RESERVE_BYTES + FINISH_RESERVE_SECONDS * bytesPerSecond;
}

export function minutesLeft(freeBytes: number, bytesPerSecond: number): number {
  return Math.max(0, Math.floor((freeBytes - stopBelowBytes(bytesPerSecond)) / bytesPerSecond / 60));
}

export function diskBudget(freeBytes: number, bytesPerSecond: number): { level: DiskLevel; minutesLeft: number } {
  const left = minutesLeft(freeBytes, bytesPerSecond);
  const level = left < MIN_START_MINUTES ? 'insufficient' : left < COMFORTABLE_MINUTES ? 'low' : 'ok';
  return { level, minutesLeft: left };
}
