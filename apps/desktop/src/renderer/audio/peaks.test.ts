import { describe, expect, it } from 'vitest';
import { addRecording, createProject, defaultAudio, layoutSegments, removeSegment, splitAt, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks as sec } from '@momotombo/timing';
import {
  FULL_SCALE, audioSlices, waveGain, waveHeight, columnLevel, computePeaks, decodePeaks, encodePeaks, peakDecodeRate, silentRanges, type Peaks,
} from './peaks';

const level = (v: number) => v / FULL_SCALE;

describe('computePeaks', () => {
  it('reports zero peak and rms for silence', () => {
    const p = computePeaks([new Float32Array(48_000)], 48_000, 100);
    expect(p.peak.length).toBe(100);
    expect(Math.max(...p.peak)).toBe(0);
    expect(Math.max(...p.rms)).toBe(0);
  });

  it('reaches full scale for a full-scale square wave and clamps louder samples', () => {
    const s = Float32Array.from({ length: 4800 }, (_, i) => (i % 2 ? 1 : -1.5));
    const p = computePeaks([s], 48_000, 100);
    expect([...p.peak].every((v) => v === FULL_SCALE)).toBe(true);
    expect([...p.rms].every((v) => v === FULL_SCALE)).toBe(true);
  });

  it('keeps a last partial bucket for lengths that do not divide evenly', () => {
    const s = new Float32Array(1000).fill(0.5);
    const p = computePeaks([s], 44_100, 100);
    expect(p.peak.length).toBe(3);
    expect(level(p.peak[2]!)).toBeCloseTo(0.5, 3);
  });

  it('measures a sine at its amplitude and rms', () => {
    const s = Float32Array.from({ length: 48_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48_000));
    const p = computePeaks([s], 48_000, 100);
    expect(level(p.peak[50]!)).toBeCloseTo(0.5, 2);
    expect(level(p.rms[50]!)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('takes the louder channel of a stereo pair for the peak and both for the rms', () => {
    const left = new Float32Array(480).fill(0.2);
    const right = new Float32Array(480).fill(-0.6);
    const p = computePeaks([left, right], 48_000, 100);
    expect(level(p.peak[0]!)).toBeCloseTo(0.6, 3);
    expect(level(p.rms[0]!)).toBeCloseTo(Math.sqrt((0.04 + 0.36) / 2), 3);
  });

  it('places loud material in the bucket where it happens', () => {
    const s = new Float32Array(48_000);
    s.fill(0.9, 24_000, 24_480);
    const p = computePeaks([s], 48_000, 100);
    expect(level(p.peak[50]!)).toBeCloseTo(0.9, 3);
    expect(p.peak[49]).toBe(0);
    expect(p.peak[51]).toBe(0);
  });
});

describe('peaks payload', () => {
  it('round-trips and rejects a payload of the wrong length', () => {
    const p = computePeaks([Float32Array.from({ length: 4321 }, (_, i) => Math.sin(i))], 48_000, 100);
    const back = decodePeaks(encodePeaks(p))!;
    expect(back.bucketsPerSecond).toBe(100);
    expect([...back.peak]).toEqual([...p.peak]);
    expect([...back.rms]).toEqual([...p.rms]);
    expect(decodePeaks(encodePeaks(p).subarray(0, 12))).toBeNull();
    expect(decodePeaks(new Uint8Array(3))).toBeNull();
  });
});

describe('columnLevel', () => {
  const peaks: Peaks = { bucketsPerSecond: 100, peak: Uint16Array.from([0, 1000, 30000, 500]), rms: Uint16Array.from([0, 500, 9000, 100]) };

  it('takes the loudest bucket a column covers', () => {
    expect(columnLevel(peaks, 0, 0.04)).toEqual({ peak: level(30000), rms: level(9000) });
    expect(columnLevel(peaks, 0.031, 0.04)).toEqual({ peak: level(500), rms: level(100) });
  });

  it('reads at least one bucket for a column narrower than a bucket and nothing outside the file', () => {
    expect(columnLevel(peaks, 0.0101, 0.0102)).toEqual({ peak: level(1000), rms: level(500) });
    expect(columnLevel(peaks, -1, -0.5)).toBeNull();
    expect(columnLevel(peaks, 0.05, 0.1)).toBeNull();
  });
});

describe('silentRanges', () => {
  const peaks = (values: number[]): Peaks => ({ bucketsPerSecond: 10, peak: Uint16Array.from(values.map((v) => v * FULL_SCALE)), rms: new Uint16Array(values.length) });

  it('finds quiet stretches at least the minimum length, in seconds', () => {
    const p = peaks([0.5, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0]);
    expect(silentRanges(p, 0.01, 0.6)).toEqual([[0.1, 0.7], [1.1, 1.8]]);
  });

  it('judges quiet after the gain, so a boosted channel has fewer pauses', () => {
    const p = peaks([0.5, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.5]);
    expect(silentRanges(p, 0.01, 0.6)).toEqual([[0.1, 0.7]]);
    expect(silentRanges(p, 0.01 / 4, 0.6)).toEqual([]);
  });
});

describe('waveHeight', () => {
  it('maps level to height on a 60 dB scale, raised by the gain and capped at full height', () => {
    expect(waveHeight(0, 1)).toBe(0);
    expect(waveHeight(0.001, 1)).toBe(0);
    expect(waveHeight(1, 1)).toBe(1);
    expect(waveHeight(0.1, 1)).toBeCloseTo(2 / 3, 6);
    expect(waveHeight(0.1, 2)).toBeGreaterThan(waveHeight(0.1, 1));
    expect(waveHeight(0.5, 3)).toBe(1);
    expect(waveHeight(0.5, 0)).toBe(0);
  });
});

describe('waveGain', () => {
  const mic = defaultAudio().mic;
  const normalized = { ...mic, gain: 2, normalize: { enabled: true, targetLufs: -16 } };

  it('is the channel gain while normalisation is off or still measuring', () => {
    expect(waveGain({ ...mic, gain: 1.5 }, { state: 'off' })).toBe(1.5);
    expect(waveGain(normalized, { state: 'measuring' })).toBe(2);
    expect(waveGain(normalized, { state: 'failed' })).toBe(2);
  });

  it('adds the normalisation gain the preview applies, with its boost cap', () => {
    expect(waveGain(normalized, { state: 'measured', lufs: -22 })).toBeCloseTo(2 * 10 ** (6 / 20), 6);
    expect(waveGain(normalized, { state: 'measured', lufs: -60 })).toBeCloseTo(2 * 10, 6);
    expect(waveGain(normalized, { state: 'measured', lufs: null })).toBe(2);
  });
});

describe('peakDecodeRate', () => {
  it('decodes at the full rate while the decoded audio fits the budget, else lower, never under 8 kHz', () => {
    const budget = 512 * 1024 * 1024;
    expect(peakDecodeRate(20, 2, budget)).toBe(48_000);
    expect(peakDecodeRate(3600, 1, budget)).toBe(37_282);
    expect(peakDecodeRate(7200, 2, budget)).toBe(9_320);
    expect(peakDecodeRate(10 * 3600, 2, budget)).toBe(8_000);
  });
});

function recording(id: string, seconds: number, micOffset = 0): Recording {
  return {
    id, createdAt: '2026-10-16T00:00:00Z', duration: sec(seconds),
    sources: {
      screen: { kind: 'screen', file: `media/${id}/screen.mp4`, mime: 'video/mp4', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: sec(seconds) },
      mic: { kind: 'mic', file: `media/${id}/mic.m4a`, mime: 'audio/mp4', startOffset: sec(micOffset), duration: sec(seconds) },
    },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'P', bounds: { x: 0, y: 0, w: 10, h: 10 }, scaleFactor: 1 }, cursorInFrames: false, hasClicks: false },
    syncOffsets: {}, markers: [],
  };
}

const slicesOf = (p: Project, from = 0, to = sec(1000)) =>
  audioSlices(p, layoutSegments(p), 'mic', from, to).map((s) => ({ ...s, timelineStart: s.timelineStart / sec(1), timelineEnd: s.timelineEnd / sec(1) }));

describe('audioSlices', () => {
  it('maps each segment to its own range of the source file, including the start offset', () => {
    const p = addRecording(createProject('A'), recording('r1', 10, 0.5));
    expect(slicesOf(p)).toEqual([{ file: 'media/r1/mic.m4a', timelineStart: 0, timelineEnd: 10, fileStart: -0.5 }]);
  });

  it('follows a cut: the material after a removed section moves left but keeps its file time', () => {
    let p = addRecording(createProject('A'), recording('r1', 10));
    p = splitAt(splitAt(p, sec(2)), sec(5));
    p = removeSegment(p, p.sequence.segments[1]!.id);
    expect(slicesOf(p)).toEqual([
      { file: 'media/r1/mic.m4a', timelineStart: 0, timelineEnd: 2, fileStart: 0 },
      { file: 'media/r1/mic.m4a', timelineStart: 2, timelineEnd: 7, fileStart: 5 },
    ]);
  });

  it('follows reordered segments and a second recording, and skips segments outside the asked range', () => {
    let p = addRecording(addRecording(createProject('A'), recording('r1', 4)), recording('r2', 3));
    const [a, b] = p.sequence.segments;
    p = { ...p, sequence: { ...p.sequence, segments: [b!, a!] } };
    expect(slicesOf(p)).toEqual([
      { file: 'media/r2/mic.m4a', timelineStart: 0, timelineEnd: 3, fileStart: 0 },
      { file: 'media/r1/mic.m4a', timelineStart: 3, timelineEnd: 7, fileStart: 0 },
    ]);
    expect(slicesOf(p, sec(3.5), sec(5)).map((s) => s.file)).toEqual(['media/r1/mic.m4a']);
  });

  it('applies the manual sync offset like the export does', () => {
    const r = recording('r1', 10, 1);
    const p = addRecording(createProject('A'), { ...r, syncOffsets: { mic: sec(0.25) } });
    expect(slicesOf(p)[0]!.fileStart).toBeCloseTo(-1.25, 6);
  });
});
