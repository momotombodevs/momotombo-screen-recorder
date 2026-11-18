import { describe, expect, it } from 'vitest';
import { diskBudget, recordingBytesPerSecond, stopBelowBytes, webVideoBitrate, type BudgetInput } from './recording-budget';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

const input = (extra: Partial<BudgetInput> = {}): BudgetInput => ({
  backend: 'web', quality: 'high', fps: 60, pixels: 2880 * 1800, camera: false, mic: false, systemAudio: false, ...extra,
});

describe('recordingBytesPerSecond', () => {
  it('grows with quality, fps and resolution', () => {
    const base = recordingBytesPerSecond(input({ backend: 'native-macos', fps: 30, quality: 'standard', pixels: 1920 * 1080 }));
    expect(recordingBytesPerSecond(input({ backend: 'native-macos', fps: 60, quality: 'standard', pixels: 1920 * 1080 }))).toBeGreaterThan(base);
    expect(recordingBytesPerSecond(input({ backend: 'native-macos', fps: 30, quality: 'max', pixels: 1920 * 1080 }))).toBeGreaterThan(base);
    expect(recordingBytesPerSecond(input({ backend: 'native-macos', fps: 30, quality: 'standard', pixels: 3840 * 2160 }))).toBeGreaterThanOrEqual(base);
    expect(recordingBytesPerSecond(input({ quality: 'max' }))).toBeGreaterThan(recordingBytesPerSecond(input({ quality: 'standard' })));
  });

  it('adds the camera and audio tracks that are recorded', () => {
    const screen = recordingBytesPerSecond(input());
    expect(recordingBytesPerSecond(input({ camera: true }))).toBeGreaterThan(screen);
    expect(recordingBytesPerSecond(input({ mic: true, systemAudio: true }))).toBe(screen + (2 * 160_000) / 8);
  });

  it('matches the web recorder bitrate for the screen track', () => {
    expect(recordingBytesPerSecond(input())).toBe(webVideoBitrate('screen', 'high', 2880 * 1800) / 8);
  });
});

describe('diskBudget', () => {
  const bps = 4 * MB;

  it('reports the minutes left above the stop threshold', () => {
    const free = stopBelowBytes(bps) + 30 * 60 * bps;
    expect(diskBudget(free, bps)).toEqual({ level: 'ok', minutesLeft: 30 });
  });

  it('warns when less than a comfortable amount of time is left', () => {
    expect(diskBudget(stopBelowBytes(bps) + 10 * 60 * bps, bps).level).toBe('low');
  });

  it('refuses when not even the hard minimum is left', () => {
    expect(diskBudget(stopBelowBytes(bps) + 60 * bps, bps)).toEqual({ level: 'insufficient', minutesLeft: 1 });
    expect(diskBudget(100 * MB, bps)).toEqual({ level: 'insufficient', minutesLeft: 0 });
  });

  it('never stops later than 1.5 GiB before the disk is full, and earlier for heavy takes', () => {
    expect(stopBelowBytes(0.5 * MB)).toBe(1.5 * GB);
    expect(stopBelowBytes(1 * MB)).toBe(1.5 * GB);
    expect(stopBelowBytes(20 * MB)).toBeGreaterThan(1.5 * GB);
    expect(stopBelowBytes(20 * MB)).toBeLessThan(stopBelowBytes(30 * MB));
  });
});
