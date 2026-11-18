import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRecording, createProject, removeTimelineRange, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks } from '@momotombo/timing';
import { describe, expect, it } from 'vitest';
import {
  ToolsMissingError, analyzeProject, cursorActivity, findingsFor, micGainSuggestion, parseAudioLog, parseProbe, parseVideoLog,
  suggestCuts, verdictFor, type Finding, type RecordingAnalysis, type Run,
} from './analyze';
import { applyOps, parseOps } from './ops';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'analyze', name), 'utf8');

const recording = (seconds: number, sources: Recording['sources'] = {}, cursorFile?: string): Recording => ({
  id: 'r1',
  createdAt: '2026-11-17T00:00:00Z',
  duration: secondsToTicks(seconds),
  sources,
  ...(cursorFile ? { cursorFile } : {}),
  capture: {
    backend: 'native-macos', platform: 'test',
    target: { kind: 'display', label: 'Display', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 1 },
    cursorInFrames: false, hasClicks: true,
  },
  syncOffsets: {},
  markers: [],
});

const source = (kind: 'screen' | 'camera' | 'mic' | 'system', seconds: number, startOffset = 0) => ({
  kind, file: `media/r1/${kind}.${kind === 'mic' || kind === 'system' ? 'm4a' : 'mp4'}`,
  mime: 'video/mp4', startOffset: secondsToTicks(startOffset), duration: secondsToTicks(seconds),
});

const cleanAudio = { integratedLufs: -18, loudnessRangeLu: 6, truePeakDbtp: -3, samplePeakDbfs: -3.5, noiseFloorDb: -60, clipping: false, silenceShare: 0.1, silences: [] };
const goodScreen = { file: 'media/r1/screen.mp4', codec: 'h264', width: 1920, height: 1080, frameRate: 60, nominalFrameRate: 60, bitrateKbps: 8000, durationSeconds: 60, sampleRate: null, channels: null };

const healthy = (): RecordingAnalysis => ({
  id: 'r1',
  durationSeconds: 60,
  missing: [],
  media: { screen: goodScreen, mic: { ...goodScreen, file: 'media/r1/mic.m4a', codec: 'opus', width: null, height: null, frameRate: null, nominalFrameRate: null, bitrateKbps: 128, sampleRate: 48000, channels: 1 } },
  durationMismatchSeconds: 0,
  audio: { mic: cleanAudio, system: null },
  video: { screen: { black: [], frozen: [], meanBrightness: null }, camera: null },
  cursor: { clickCount: 5, idle: [], idleSeconds: 0 },
  deadTime: { ranges: [], totalSeconds: 0 },
});

const codes = (findings: Finding[]) => findings.map((f) => `${f.severity}:${f.code}`);

describe('parseProbe', () => {
  it('reads codec, size, real and nominal frame rate, bitrate and duration of a video', () => {
    expect(parseProbe(fixture('ffprobe-screen.json'))).toEqual({
      codec: 'h264', width: 3840, height: 2160, frameRate: 41.827, nominalFrameRate: 60, bitrateKbps: 6505, durationSeconds: 19.477, sampleRate: null, channels: null,
    });
  });

  it('reads sample rate and channels of an audio file', () => {
    expect(parseProbe(fixture('ffprobe-mic.json'))).toMatchObject({ codec: 'opus', sampleRate: 48000, channels: 1, width: null, frameRate: null, durationSeconds: 19.468 });
  });
});

describe('parseAudioLog', () => {
  it('reads loudness, peaks, noise floor and silences of a quiet mic', () => {
    const stats = parseAudioLog(fixture('ffmpeg-mic-quiet.txt'), 19.468);
    expect(stats).toMatchObject({ integratedLufs: -53.9, loudnessRangeLu: 1.6, truePeakDbtp: -33.3, samplePeakDbfs: -33.295, noiseFloorDb: -50.798, clipping: false });
    expect(stats.silences).toEqual([{ start: 0, end: 6.917 }, { start: 6.926, end: 9.156 }, { start: 9.156, end: 19.468 }]);
    expect(stats.silenceShare).toBeGreaterThan(0.99);
  });

  it('reports digital silence as no peak and no noise floor', () => {
    expect(parseAudioLog(fixture('ffmpeg-system-silent.txt'), 19.474)).toMatchObject({
      integratedLufs: -70, truePeakDbtp: null, samplePeakDbfs: null, noiseFloorDb: null, clipping: false, silenceShare: 1,
    });
  });

  it('flags clipping when the sample peak reaches full scale', () => {
    expect(parseAudioLog(fixture('ffmpeg-mic-clipping.txt'), 7)).toMatchObject({ integratedLufs: -3.9, truePeakDbtp: 0.1, clipping: true });
  });

  it('closes a silence still open at the end of the file', () => {
    expect(parseAudioLog('silence_start: 4.5\n', 10).silences).toEqual([{ start: 4.5, end: 10 }]);
  });
});

describe('parseVideoLog', () => {
  it('reads black and frozen ranges and the mean sampled brightness', () => {
    expect(parseVideoLog(fixture('ffmpeg-video-black-frozen.txt'), 6)).toEqual({
      black: [{ start: 0, end: 1 }], frozen: [{ start: 1, end: 4 }], meanBrightness: 107.015,
    });
  });

  it('closes a freeze still open at the end and leaves brightness out when not sampled', () => {
    expect(parseVideoLog(fixture('ffmpeg-screen.txt'), 19.477)).toEqual({
      black: [], frozen: [{ start: 2.718, end: 4.752 }, { start: 10.435, end: 19.477 }], meanBrightness: null,
    });
  });

  it('averages the brightness of a real camera take', () => {
    expect(parseVideoLog(fixture('ffmpeg-camera.txt'), 19.44).meanBrightness).toBeGreaterThan(150);
  });
});

describe('cursorActivity', () => {
  it('finds idle stretches, including before the first and after the last event, and counts clicks', () => {
    const t = (s: number) => secondsToTicks(s);
    const log = [
      { e: 'm', t: t(1), x: 0.1, y: 0.1 },
      { e: 'd', t: t(2), x: 0.1, y: 0.1 },
      { e: 'u', t: t(2.1), x: 0.1, y: 0.1 },
      { e: 's', t: t(9), x: 0.1, y: 0.1, dy: 3 },
      { e: 'm', t: t(10), x: 0.2, y: 0.1 },
    ].map((e) => JSON.stringify(e)).join('\n');
    expect(cursorActivity(log, 20)).toEqual({ clickCount: 1, idle: [{ start: 2.1, end: 9 }, { start: 10, end: 20 }], idleSeconds: 16.9 });
  });
});

describe('findingsFor', () => {
  it('finds nothing wrong with a clean take', () => {
    expect(findingsFor(healthy())).toEqual([]);
  });

  it('blocks a take without a mic or with a silent mic', () => {
    expect(codes(findingsFor({ ...healthy(), missing: ['mic'], audio: { mic: null, system: null } }))).toContain('blocker:MIC_MISSING');
    expect(codes(findingsFor({ ...healthy(), audio: { mic: { ...cleanAudio, silenceShare: 0.99, integratedLufs: -70 }, system: null } }))).toEqual(['blocker:MIC_SILENT']);
  });

  it('warns about a quiet mic and blocks one too quiet to rescue', () => {
    const at = (integratedLufs: number) => codes(findingsFor({ ...healthy(), audio: { mic: { ...cleanAudio, integratedLufs }, system: null } }));
    expect(at(-34)).toEqual(['warning:MIC_TOO_QUIET']);
    expect(at(-50)).toEqual(['blocker:MIC_TOO_QUIET']);
  });

  it('warns about clipping and blocks a mic that clips while running hot', () => {
    const mic = { ...cleanAudio, truePeakDbtp: 0.4, samplePeakDbfs: 0, clipping: true };
    expect(codes(findingsFor({ ...healthy(), audio: { mic, system: null } }))).toEqual(['warning:MIC_CLIPPING']);
    expect(codes(findingsFor({ ...healthy(), audio: { mic: { ...mic, integratedLufs: -9 }, system: null } }))).toEqual(['blocker:MIC_CLIPPING']);
  });

  it('flags a noisy room, a dark camera, a small or slow screen and long dead time', () => {
    const found = codes(findingsFor({
      ...healthy(),
      missing: ['system'],
      media: { ...healthy().media, screen: { ...goodScreen, width: 1280, height: 720, nominalFrameRate: 15 } },
      audio: { mic: { ...cleanAudio, noiseFloorDb: -38 }, system: null },
      video: { screen: { black: [], frozen: [], meanBrightness: null }, camera: { black: [], frozen: [], meanBrightness: 40 } },
      deadTime: { ranges: [{ start: 10, end: 22, timeline: [{ start: 10, end: 22 }] }], totalSeconds: 12 },
    }));
    expect(found).toEqual(expect.arrayContaining([
      'warning:MIC_NOISY', 'warning:CAMERA_DARK', 'warning:SCREEN_LOW_RESOLUTION', 'warning:SCREEN_LOW_FPS', 'warning:DEAD_TIME', 'info:SYSTEM_AUDIO_MISSING',
    ]));
  });

  it('gives every finding evidence and a concrete tip', () => {
    for (const f of findingsFor({ ...healthy(), missing: ['mic', 'camera', 'cursor'], audio: { mic: null, system: null } })) {
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.advice.length).toBeGreaterThan(10);
      expect(f.recordingId).toBe('r1');
    }
  });
});

describe('verdictFor', () => {
  const finding = (severity: Finding['severity']): Finding => ({ severity, code: 'X', message: `${severity} message`, evidence: {}, advice: 'tip', recordingId: 'r1' });

  it('asks for a re-record when anything blocks', () => {
    expect(verdictFor([finding('warning'), finding('blocker')])).toEqual({ verdict: 're-record', verdictReasons: ['blocker message'] });
  });

  it('asks for fixes on warnings and plain editing otherwise', () => {
    expect(verdictFor([finding('info'), finding('warning')])).toEqual({ verdict: 'edit-with-fixes', verdictReasons: ['warning message'] });
    expect(verdictFor([finding('info')]).verdict).toBe('edit');
  });
});

describe('suggestCuts', () => {
  const project = (): Project => addRecording(createProject('Demo'), recording(60, { screen: source('screen', 60) }));

  it('turns long dead time into padded timeline cuts, latest first, skipping short gaps', () => {
    const cuts = suggestCuts(project(), [{ start: 5, end: 10 }, { start: 20, end: 21 }, { start: 40, end: 50 }].map((r) => ({ ...r, recordingId: 'r1' })));
    expect(cuts).toEqual([{ op: 'cut', start: 40.25, end: 49.75 }, { op: 'cut', start: 5.25, end: 9.75 }]);
  });

  it('maps source time onto a timeline that was already cut and skips what is gone', () => {
    const cut = removeTimelineRange(project(), secondsToTicks(0), secondsToTicks(8));
    const cuts = suggestCuts(cut, [{ start: 5, end: 10, recordingId: 'r1' }, { start: 40, end: 50, recordingId: 'r1' }]);
    expect(cuts).toEqual([{ op: 'cut', start: 32.25, end: 41.75 }, { op: 'cut', start: 0, end: 1.75 }]);
  });

  it('produces ops the CLI applies in order', () => {
    const cuts = suggestCuts(project(), [{ start: 5, end: 10, recordingId: 'r1' }, { start: 40, end: 50, recordingId: 'r1' }]);
    const after = applyOps(project(), parseOps(cuts)).project;
    expect(after.sequence.segments.map((s) => [s.sourceStart, s.sourceEnd].map((t) => Math.round(t / secondsToTicks(0.01)) / 100))).toEqual([[0, 5.25], [9.75, 40.25], [49.75, 60]]);
  });
});

describe('micGainSuggestion', () => {
  const project = (gain = 1): Project => {
    const p = addRecording(createProject('Demo'), recording(60, { mic: source('mic', 60) }));
    return { ...p, audio: { ...p.audio, mic: { ...p.audio.mic, gain } } };
  };
  const mic = (integratedLufs: number, truePeakDbtp: number) => ({ ...healthy(), audio: { mic: { ...cleanAudio, integratedLufs, truePeakDbtp }, system: null } });

  it('lowers a loud mic toward -16 LUFS', () => {
    const s = micGainSuggestion(project(), [mic(-10, -0.5)]);
    expect(s).toMatchObject({ suggestedGain: 0.5, limitedBy: null, op: { op: 'setAudio', patch: { mic: { gain: 0.5 } } } });
    expect(s!.expectedLufs).toBeCloseTo(-16, 0);
  });

  it('cannot raise the gain past the editor maximum and says so', () => {
    expect(micGainSuggestion(project(), [mic(-26, -12)])).toMatchObject({ suggestedGain: 1, limitedBy: 'max-gain', op: null });
    expect(micGainSuggestion(project(0.5), [mic(-26, -12)])).toMatchObject({ suggestedGain: 1, limitedBy: 'max-gain', op: { op: 'setAudio', patch: { mic: { gain: 1 } } } });
  });

  it('suggests nothing without measured mic audio', () => {
    expect(micGainSuggestion(project(), [{ ...healthy(), audio: { mic: null, system: null } }])).toBeNull();
  });

  it('still reports the boost a barely audible mic would need, but not for a dead one', () => {
    expect(micGainSuggestion(project(), [mic(-53.9, -33.3)])).toMatchObject({ neededGain: 78.52, suggestedGain: 1, limitedBy: 'max-gain', op: null });
    expect(micGainSuggestion(project(), [mic(-70, -60)])).toBeNull();
  });
});

describe('analyzeProject', () => {
  const fakeRun = (calls: string[][]): Run => async (tool, args) => {
    calls.push([tool, ...args]);
    if (args[0] === '-version') return `${tool} version 9`;
    const file = tool === 'ffprobe' ? args[args.length - 1]! : args[args.indexOf('-i') + 1]!;
    const mic = file.endsWith('mic.m4a');
    if (tool === 'ffprobe') return fixture(mic ? 'ffprobe-mic.json' : 'ffprobe-screen.json');
    return fixture(mic ? 'ffmpeg-mic-quiet.txt' : 'ffmpeg-screen.txt');
  };

  const folder = async (withCursor: boolean) => {
    const dir = await mkdtemp(join(tmpdir(), 'momotombo analyze '));
    await mkdir(join(dir, 'media', 'r1'), { recursive: true });
    await writeFile(join(dir, 'media', 'r1', 'screen.mp4'), '');
    await writeFile(join(dir, 'media', 'r1', 'mic.m4a'), '');
    if (withCursor) await writeFile(join(dir, 'media', 'r1', 'cursor.jsonl'), `${JSON.stringify({ e: 'm', t: secondsToTicks(1), x: 0.5, y: 0.5 })}\n`);
    return dir;
  };

  it('reports missing optional tracks instead of failing, and blocks the silent mic', async () => {
    const dir = await folder(true);
    const project = addRecording(createProject('Demo'), recording(19.477, { screen: source('screen', 19.477), mic: source('mic', 19.468) }, 'media/r1/cursor.jsonl'));
    const calls: string[][] = [];
    const report = await analyzeProject(dir, project, fakeRun(calls));
    expect(report.recordings[0]!.missing).toEqual(['camera', 'system']);
    expect(report.recordings[0]!.cursor).toMatchObject({ clickCount: 0 });
    expect(report.recordings[0]!.deadTime!.totalSeconds).toBeGreaterThan(15);
    expect(codes(report.findings)).toEqual(expect.arrayContaining(['blocker:MIC_SILENT', 'info:CAMERA_MISSING', 'info:SYSTEM_AUDIO_MISSING']));
    expect(report.verdict).toBe('re-record');
    expect(report.suggestedOps.every((op) => op.op === 'cut' || op.op === 'setAudio')).toBe(true);
    expect(calls.filter(([tool]) => tool === 'ffmpeg').some((c) => c.includes(join(dir, 'media', 'r1', 'mic.m4a')))).toBe(true);
  });

  it('blocks a declared screen file that is not on disk', async () => {
    const dir = await folder(false);
    const project = addRecording(createProject('Demo'), recording(19.477, { screen: { ...source('screen', 19.477), file: 'media/r1/gone.mp4' }, mic: source('mic', 19.468) }));
    const report = await analyzeProject(dir, project, fakeRun([]));
    expect(codes(report.findings)).toEqual(expect.arrayContaining(['blocker:SCREEN_FILE_MISSING', 'info:CURSOR_MISSING']));
    expect(report.recordings[0]!.deadTime).toBeNull();
  });

  it('fails with ToolsMissingError when ffmpeg is not installed', async () => {
    const dir = await folder(false);
    const project = addRecording(createProject('Demo'), recording(10, { screen: source('screen', 10) }));
    const run: Run = async () => { throw new ToolsMissingError(); };
    await expect(analyzeProject(dir, project, run)).rejects.toBeInstanceOf(ToolsMissingError);
  });
});
