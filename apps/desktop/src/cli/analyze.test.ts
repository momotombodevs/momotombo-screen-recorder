import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { MAX_AUDIO_GAIN, addRecording, createProject, removeTimelineRange, serializeProject, type AudioChannel, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks } from '@momotombo/timing';
import { describe, expect, it } from 'vitest';
import {
  ToolError, ToolsMissingError, analyzeProject, audioStats, cursorActivity, deadTimeRanges, findingsFor, micLevelSuggestion, parseAudioLog,
  parseLoudnessLog, parseProbe, parseSilenceLog, parseVideoLog, silenceThresholdDb, suggestCuts, toolRunner, verdictFor,
  type AudioStats, type Finding, type RecordingAnalysis, type Run,
} from './analyze';
import { EXIT, run as cli } from './momotombo-edit';
import { applyOps, parseOps } from './ops';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'analyze', name), 'utf8');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

const recording = (seconds: number, sources: Recording['sources'] = {}, cursorFile?: string, extra: Partial<Recording> = {}): Recording => ({
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
  ...extra,
});

const source = (kind: 'screen' | 'camera' | 'mic' | 'system', seconds: number, startOffset = 0) => ({
  kind, file: `media/r1/${kind}.${kind === 'mic' || kind === 'system' ? 'm4a' : 'mp4'}`,
  mime: 'video/mp4', startOffset: secondsToTicks(startOffset), duration: secondsToTicks(seconds),
});

const cleanAudio: AudioStats = {
  integratedLufs: -18, loudnessRangeLu: 6, truePeakDbtp: -3, samplePeakDbfs: -3.5, noiseFloorDb: -65, clipping: false, silenceThresholdDb: -36, silenceShare: 0.1, silences: [],
};
const goodScreen = { file: 'media/r1/screen.mp4', codec: 'h264', width: 1920, height: 1080, frameRate: 60, nominalFrameRate: 60, bitrateKbps: 8000, durationSeconds: 60, sampleRate: null, channels: null };

const healthy = (): RecordingAnalysis => ({
  id: 'r1',
  durationSeconds: 60,
  missing: [],
  problems: [],
  media: { screen: goodScreen, mic: { ...goodScreen, file: 'media/r1/mic.m4a', codec: 'opus', width: null, height: null, frameRate: null, nominalFrameRate: null, bitrateKbps: 128, sampleRate: 48000, channels: 1 } },
  durationMismatchSeconds: 0,
  audio: { mic: cleanAudio, system: null },
  video: { screen: { black: [], frozen: [], meanBrightness: null }, camera: null },
  cursor: { clickCount: 5, idle: [], idleSeconds: 0 },
  deadTime: { ranges: [], totalSeconds: 0 },
});

const withMic = (mic: Partial<AudioStats>): RecordingAnalysis => ({ ...healthy(), audio: { mic: { ...cleanAudio, ...mic }, system: null } });
const codes = (findings: Finding[]) => findings.map((f) => `${f.severity}:${f.code}`);
const shortTake = (): Project => addRecording(createProject('Demo'), recording(10, { screen: source('screen', 10) }));

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

describe('audio parsing', () => {
  it('reads loudness, peaks, noise floor and silences of a quiet mic', () => {
    expect(parseLoudnessLog(fixture('ffmpeg-mic-quiet.txt'))).toEqual({ integratedLufs: -53.9, loudnessRangeLu: 1.6, truePeakDbtp: -33.3, samplePeakDbfs: -33.295, noiseFloorDb: -50.798 });
    expect(parseSilenceLog(fixture('ffmpeg-mic-quiet.txt'), 19.468)).toEqual([{ start: 0, end: 6.917 }, { start: 6.926, end: 9.156 }, { start: 9.156, end: 19.468 }]);
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
    expect(parseSilenceLog('silence_start: 4.5\n', 10)).toEqual([{ start: 4.5, end: 10 }]);
  });

  it('measures the silence share against the given threshold', () => {
    expect(audioStats(parseLoudnessLog(''), -50, [{ start: 0, end: 5 }], 10)).toMatchObject({ silenceThresholdDb: -50, silenceShare: 0.5 });
  });
});

describe('silenceThresholdDb', () => {
  const level = (integratedLufs: number | null, noiseFloorDb: number | null) => ({ integratedLufs, noiseFloorDb, loudnessRangeLu: null, truePeakDbtp: null, samplePeakDbfs: null });

  it('follows a quiet voice instead of the absolute -35 dB', () => {
    expect(silenceThresholdDb(level(-38, -75))).toBe(-56);
  });

  it('never calls anything louder than the room noise silence', () => {
    expect(silenceThresholdDb(level(-53.9, -50.8))).toBe(-40.8);
  });

  it('caps the threshold for loud voices and falls back for digital silence', () => {
    expect(silenceThresholdDb(level(-10, -60))).toBe(-35);
    expect(silenceThresholdDb(level(-70, null))).toBe(-35);
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

  it('rejects a log with content but no usable events', () => {
    expect(() => cursorActivity('not json\n{"e":"m"}\n', 20)).toThrow(/no valid cursor events/);
  });
});

describe('findingsFor', () => {
  it('finds nothing wrong with a clean take', () => {
    expect(findingsFor(healthy())).toEqual([]);
  });

  it('warns, without blocking, about a take with no mic or no screen', () => {
    expect(codes(findingsFor({ ...healthy(), missing: ['mic'], audio: { mic: null, system: null } }))).toEqual(['warning:MIC_MISSING']);
    expect(codes(findingsFor({ ...healthy(), missing: ['screen'], media: {}, video: { screen: null, camera: null } }))).toEqual(['warning:SCREEN_MISSING']);
  });

  it('blocks a mic that only picked up room noise', () => {
    expect(codes(findingsFor(withMic({ silenceShare: 0.99, integratedLufs: -60 })))).toEqual(['blocker:MIC_SILENT']);
    expect(codes(findingsFor(withMic({ integratedLufs: -70 })))).toEqual(['blocker:MIC_SILENT']);
  });

  it('lets normalization rescue a quiet but clean mic', () => {
    const found = findingsFor(withMic({ integratedLufs: -38, noiseFloorDb: -75, silenceShare: 0.4 }));
    expect(codes(found)).toEqual(['warning:MIC_TOO_QUIET']);
    expect(verdictFor(found).verdict).toBe('edit-with-fixes');
  });

  it('says no usable voice was recorded when the mic stays near its own noise floor', () => {
    const [finding, ...rest] = findingsFor(withMic({ integratedLufs: -53.9, noiseFloorDb: -50.798, silenceShare: 0.808 }));
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ severity: 'blocker', code: 'MIC_NO_VOICE', evidence: { marginDb: 3.1 } });
    expect(finding!.message).toBe('The microphone track stays within 3.1 dB of its own noise floor (loudness -53.9 LUFS, noise floor -50.8 dBFS): no usable voice was recorded.');
    expect(finding!.advice).toMatch(/right microphone/);
  });

  it('never reports a negative margin when the noise floor is above the loudness', () => {
    const [finding] = findingsFor(withMic({ integratedLufs: -60, noiseFloorDb: -48, silenceShare: 0.5 }));
    expect(finding).toMatchObject({ code: 'MIC_NO_VOICE', evidence: { marginDb: 0 } });
    expect(finding!.message).toBe('The microphone track never rises above its own noise floor (loudness -60 LUFS, noise floor -48 dBFS): no usable voice was recorded.');
  });

  it('blocks a quiet mic whose boost would make the noise too loud, with a positive margin', () => {
    const [finding] = findingsFor(withMic({ integratedLufs: -40, noiseFloorDb: -52, silenceShare: 0.5 }));
    expect(finding).toMatchObject({ severity: 'blocker', code: 'MIC_TOO_QUIET', evidence: { marginDb: 12 } });
    expect(finding!.message).toBe('The voice is only 12 dB above the room noise (loudness -40 LUFS); bringing it to -16 LUFS would raise the noise floor to about -28 dBFS.');
  });

  it('blocks a quiet mic that needs more boost than normalization gives', () => {
    expect(codes(findingsFor(withMic({ integratedLufs: -50, noiseFloorDb: -100, silenceShare: 0.4 })))).toEqual(['blocker:MIC_TOO_QUIET']);
  });

  it('rates room noise against the voice level', () => {
    expect(codes(findingsFor(withMic({ integratedLufs: -18, noiseFloorDb: -33 })))).toEqual(['blocker:MIC_NOISY']);
    expect(codes(findingsFor(withMic({ integratedLufs: -18, noiseFloorDb: -43 })))).toEqual(['warning:MIC_NOISY']);
  });

  it('warns about clipping and blocks a mic that clips while running hot', () => {
    const clipping = { truePeakDbtp: 0.4, samplePeakDbfs: 0, clipping: true };
    expect(codes(findingsFor(withMic(clipping)))).toEqual(['warning:MIC_CLIPPING']);
    expect(codes(findingsFor(withMic({ ...clipping, integratedLufs: -9 })))).toEqual(['blocker:MIC_CLIPPING']);
  });

  it('reports a tool failure without ever asking for a re-record', () => {
    const found = findingsFor({ ...healthy(), audio: { mic: null, system: null }, problems: [{ track: 'mic', problem: 'analysis-failed', file: 'media/r1/mic.m4a', error: 'ffmpeg failed: No such filter' }] });
    expect(codes(found)).toEqual(['warning:ANALYSIS_FAILED']);
    expect(verdictFor(found).verdict).not.toBe('re-record');
  });

  it('blocks a mic or screen file that cannot be decoded or is gone, and flags paths outside the project', () => {
    const problem = (track: 'mic' | 'screen' | 'camera', kind: 'unreadable' | 'missing' | 'outside') => ({ track, problem: kind, file: 'x', error: 'e' });
    expect(codes(findingsFor({ ...healthy(), problems: [problem('mic', 'unreadable'), problem('screen', 'missing'), problem('camera', 'outside')] })))
      .toEqual(['blocker:MIC_UNREADABLE', 'blocker:SCREEN_FILE_MISSING', 'warning:CAMERA_FILE_OUTSIDE_PROJECT']);
  });

  it('notes an unusable cursor log', () => {
    expect(codes(findingsFor({ ...healthy(), cursor: null, problems: [{ track: 'cursor', problem: 'unreadable', file: 'c', error: 'no valid cursor events' }] }))).toEqual(['info:CURSOR_UNREADABLE']);
  });

  it('flags a dark camera, a small or slow screen and long dead time', () => {
    const found = codes(findingsFor({
      ...healthy(),
      missing: ['system'],
      media: { ...healthy().media, screen: { ...goodScreen, width: 1280, height: 720, nominalFrameRate: 15 } },
      video: { screen: { black: [], frozen: [], meanBrightness: null }, camera: { black: [], frozen: [], meanBrightness: 40 } },
      deadTime: { ranges: [{ start: 10, end: 22, timeline: [{ start: 10, end: 22 }] }], totalSeconds: 12 },
    }));
    expect(found).toEqual(expect.arrayContaining([
      'warning:CAMERA_DARK', 'warning:SCREEN_LOW_RESOLUTION', 'warning:SCREEN_LOW_FPS', 'warning:DEAD_TIME', 'info:SYSTEM_AUDIO_MISSING',
    ]));
  });

  it('gives every finding evidence and a concrete tip', () => {
    for (const f of findingsFor({ ...healthy(), missing: ['mic', 'camera', 'cursor', 'screen'], audio: { mic: null, system: null } })) {
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.advice.length).toBeGreaterThan(10);
      expect(f.recordingId).toBe('r1');
    }
  });
});

describe('deadTimeRanges', () => {
  const base = { ...healthy(), audio: { mic: { ...cleanAudio, silences: [{ start: 0, end: 30 }] }, system: null }, cursor: { clickCount: 0, idle: [{ start: 5, end: 25 }], idleSeconds: 20 } };

  it('is mic silence while the cursor is idle and the screen does not change', () => {
    expect(deadTimeRanges({ ...base, video: { screen: { black: [], frozen: [{ start: 10, end: 40 }], meanBrightness: null }, camera: null } })).toEqual([{ start: 10, end: 25 }]);
  });

  it('keeps a playing video or a running build out of dead time', () => {
    expect(deadTimeRanges({ ...base, video: { screen: { black: [], frozen: [], meanBrightness: null }, camera: null } })).toEqual([]);
    const sound = { ...cleanAudio, silences: [{ start: 0, end: 12 }] };
    expect(deadTimeRanges({ ...base, audio: { ...base.audio, system: sound }, video: { screen: null, camera: null } })).toEqual([{ start: 5, end: 12 }]);
  });

  it('cannot be measured without a cursor log or a mic', () => {
    expect(deadTimeRanges({ ...base, cursor: null })).toBeNull();
    expect(deadTimeRanges({ ...base, audio: { mic: null, system: null } })).toBeNull();
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
  const seconds = (p: Project) => p.sequence.segments.map((s) => [s.sourceStart, s.sourceEnd].map((t) => Math.round(t / secondsToTicks(0.01)) / 100));

  it('turns long dead time into padded timeline cuts, latest first, skipping short gaps', () => {
    const cuts = suggestCuts(project(), [{ start: 5, end: 10 }, { start: 20, end: 21 }, { start: 40, end: 50 }].map((r) => ({ ...r, recordingId: 'r1' })));
    expect(cuts).toEqual([{ op: 'cut', start: 40.25, end: 49.75 }, { op: 'cut', start: 5.25, end: 9.75 }]);
  });

  it('maps source time onto a timeline that was already cut and skips what is gone', () => {
    const cut = removeTimelineRange(project(), secondsToTicks(0), secondsToTicks(8));
    const cuts = suggestCuts(cut, [{ start: 5, end: 10, recordingId: 'r1' }, { start: 40, end: 50, recordingId: 'r1' }]);
    expect(cuts).toEqual([{ op: 'cut', start: 32.25, end: 41.75 }, { op: 'cut', start: 0, end: 1.75 }]);
  });

  it('cuts every place a source range shows on reordered and duplicated segments', () => {
    const p = project();
    const seg = (id: string, from: number, to: number) => ({ id, recordingId: 'r1', sourceStart: secondsToTicks(from), sourceEnd: secondsToTicks(to) });
    const shuffled: Project = { ...p, sequence: { ...p.sequence, segments: [seg('a', 30, 60), seg('b', 0, 30), seg('c', 0, 30)] } };
    const cuts = suggestCuts(shuffled, [{ start: 10, end: 15, recordingId: 'r1' }, { start: 40, end: 45, recordingId: 'r1' }]);
    expect(cuts).toEqual([
      { op: 'cut', start: 70.25, end: 74.75 },
      { op: 'cut', start: 40.25, end: 44.75 },
      { op: 'cut', start: 10.25, end: 14.75 },
    ]);
    expect(seconds(applyOps(shuffled, parseOps(cuts)).project)).toEqual([[30, 40.25], [44.75, 60], [0, 10.25], [14.75, 30], [0, 10.25], [14.75, 30]]);
  });

  it('produces ops the CLI applies in order', () => {
    const cuts = suggestCuts(project(), [{ start: 5, end: 10, recordingId: 'r1' }, { start: 40, end: 50, recordingId: 'r1' }]);
    expect(seconds(applyOps(project(), parseOps(cuts)).project)).toEqual([[0, 5.25], [9.75, 40.25], [49.75, 60]]);
  });
});

describe('micLevelSuggestion', () => {
  const voiceProject = (mic: Partial<AudioChannel> = {}): Project => {
    const p = addRecording(createProject('Demo'), recording(60, { mic: source('mic', 60) }));
    return { ...p, audio: { ...p.audio, mic: { ...p.audio.mic, ...mic } } };
  };
  const plainProject = (gain = 1): Project => {
    const p = voiceProject();
    return { ...p, audio: { ...p.audio, mic: { gain, muted: false } as AudioChannel } };
  };
  const mic = (integratedLufs: number, truePeakDbtp: number) => withMic({ integratedLufs, truePeakDbtp });
  const blocker = (code: string): Finding => ({ severity: 'blocker', code, message: 'm', evidence: {}, advice: 'a', recordingId: 'r1' });

  it('lowers a loud mic toward -16 LUFS with the gain when the project has no voice enhancement', () => {
    const s = micLevelSuggestion(plainProject(), [mic(-10, -0.5)], []);
    expect(s).toMatchObject({ method: 'gain', suggestedGain: 0.5, limitedBy: null, op: { op: 'setAudio', patch: { mic: { gain: 0.5 } } } });
    expect(s!.expectedLufs).toBeCloseTo(-16, 0);
  });

  it('raises the gain up to the model maximum and says when that is not enough', () => {
    expect(micLevelSuggestion(plainProject(), [mic(-24, -12)], [])).toMatchObject({ suggestedGain: 2.51, limitedBy: null, op: { patch: { mic: { gain: 2.51 } } } });
    expect(micLevelSuggestion(plainProject(), [mic(-30, -20)], [])).toMatchObject({ suggestedGain: MAX_AUDIO_GAIN, limitedBy: 'max-gain', op: { patch: { mic: { gain: MAX_AUDIO_GAIN } } } });
    expect(micLevelSuggestion(plainProject(MAX_AUDIO_GAIN), [mic(-30, -20)], [])).toMatchObject({ limitedBy: 'max-gain', op: null });
  });

  it('stops the gain where the peaks would pass -1 dBTP', () => {
    expect(micLevelSuggestion(plainProject(), [mic(-24, -4)], [])).toMatchObject({ suggestedGain: 1.41, limitedBy: 'true-peak' });
  });

  it('turns on voice normalization when the project supports it', () => {
    expect(micLevelSuggestion(voiceProject(), [mic(-38, -20)], [])).toEqual({
      method: 'normalize', currentGain: 1, measuredLufs: -38, targetLufs: -16, neededGain: 12.59, suggestedGain: null, expectedLufs: -16, limitedBy: null, withheldBy: [],
      op: { op: 'setAudio', patch: { mic: { highpassHz: 80, normalize: { enabled: true } } } },
    });
    expect(micLevelSuggestion(voiceProject(), [mic(-50, -30)], [])).toMatchObject({ limitedBy: 'max-normalize', expectedLufs: -20 });
    expect(micLevelSuggestion(voiceProject({ highpassHz: 80, normalize: { enabled: true, targetLufs: -16 } }), [mic(-38, -20)], [])!.op).toBeNull();
  });

  it('withholds the audio op when a mic finding rules it out', () => {
    expect(micLevelSuggestion(voiceProject(), [mic(-53.9, -33.3)], [blocker('MIC_NO_VOICE')])).toMatchObject({ op: null, withheldBy: ['MIC_NO_VOICE'] });
    expect(micLevelSuggestion(plainProject(), [mic(-30, -20)], [blocker('SCREEN_FILE_MISSING')])!.op).not.toBeNull();
  });

  it('suggests nothing without measured mic audio', () => {
    expect(micLevelSuggestion(voiceProject(), [{ ...healthy(), audio: { mic: null, system: null } }], [])).toBeNull();
    expect(micLevelSuggestion(voiceProject(), [mic(-70, -60)], [])).toBeNull();
  });
});

describe('analyzeProject with a fake ffmpeg', () => {
  const fakeRun = (calls: string[][], fail: (tool: string, args: string[]) => Error | null = () => null): Run => async (tool, args) => {
    calls.push([tool, ...args]);
    if (args[0] === '-version') return `${tool} version 9`;
    const error = fail(tool, args);
    if (error) throw error;
    const file = tool === 'ffprobe' ? args[args.length - 1]! : args[args.indexOf('-i') + 1]!;
    const mic = file.endsWith('mic.m4a');
    if (tool === 'ffprobe') return fixture(mic ? 'ffprobe-mic.json' : 'ffprobe-screen.json');
    return fixture(mic ? 'ffmpeg-mic-quiet.txt' : 'ffmpeg-screen.txt');
  };

  const folder = async (cursor: string | null = JSON.stringify({ e: 'm', t: secondsToTicks(1), x: 0.5, y: 0.5 })) => {
    const dir = await mkdtemp(join(tmpdir(), 'momotombo analyze '));
    await mkdir(join(dir, 'media', 'r1'), { recursive: true });
    await writeFile(join(dir, 'media', 'r1', 'screen.mp4'), '');
    await writeFile(join(dir, 'media', 'r1', 'mic.m4a'), '');
    if (cursor !== null) await writeFile(join(dir, 'media', 'r1', 'cursor.jsonl'), `${cursor}\n`);
    return dir;
  };
  const take = (sources: Recording['sources'] = { screen: source('screen', 19.477), mic: source('mic', 19.468) }, extra: Partial<Recording> = {}) =>
    addRecording(createProject('Demo'), recording(19.477, sources, 'media/r1/cursor.jsonl', extra));

  it('reports missing optional tracks instead of failing', async () => {
    const dir = await folder();
    const calls: string[][] = [];
    const report = await analyzeProject(dir, take(), fakeRun(calls));
    expect(report.recordings[0]!.missing).toEqual(['camera', 'system']);
    expect(report.recordings[0]!.cursor).toMatchObject({ clickCount: 0 });
    expect(codes(report.findings)).toEqual(expect.arrayContaining(['info:CAMERA_MISSING', 'info:SYSTEM_AUDIO_MISSING']));
    expect(calls.some((c) => c.includes(join(dir, 'media', 'r1', 'mic.m4a')))).toBe(true);
  });

  it('derives the mic silence threshold from the measured level', async () => {
    const calls: string[][] = [];
    const report = await analyzeProject(await folder(), take(), fakeRun(calls));
    expect(calls.flat().find((a) => a.startsWith('silencedetect'))).toBe('silencedetect=noise=-40.8dB:d=0.6');
    expect(report.recordings[0]!.audio.mic!.silenceThresholdDb).toBe(-40.8);
    expect(report.suggestedOps.filter((op) => op.op === 'setAudio')).toEqual([]);
  });

  it('places silences in recording time using the start offset and sync offset', async () => {
    const report = await analyzeProject(await folder(), take(
      { screen: source('screen', 19.477), mic: source('mic', 19.468, 2) },
      { syncOffsets: { mic: secondsToTicks(1) } },
    ), fakeRun([]));
    expect(report.recordings[0]!.audio.mic!.silences[0]).toEqual({ start: 3, end: 9.917 });
  });

  it('blocks a declared screen file that is not on disk and reports a missing cursor log as unusable', async () => {
    const report = await analyzeProject(await folder(null), take({ screen: { ...source('screen', 19.477), file: 'media/r1/gone.mp4' }, mic: source('mic', 19.468) }), fakeRun([]));
    expect(codes(report.findings)).toEqual(expect.arrayContaining(['blocker:SCREEN_FILE_MISSING', 'info:CURSOR_UNREADABLE']));
    expect(report.recordings[0]!.deadTime).toBeNull();
  });

  it('never reads a source or cursor path that leaves the project folder', async () => {
    const calls: string[][] = [];
    const project = take({ screen: source('screen', 19.477), mic: { ...source('mic', 19.468), file: '../outside/mic.m4a' } }, { cursorFile: '../../etc/passwd' });
    const report = await analyzeProject(await folder(), project, fakeRun(calls));
    expect(calls.flat().some((a) => a.includes('outside') || a.includes('passwd'))).toBe(false);
    expect(codes(report.findings)).toEqual(expect.arrayContaining(['blocker:MIC_FILE_OUTSIDE_PROJECT', 'info:CURSOR_UNREADABLE']));
  });

  it('keeps going past a malformed cursor log', async () => {
    const report = await analyzeProject(await folder('{{{ not a cursor log'), take(), fakeRun([]));
    expect(codes(report.findings)).toContain('info:CURSOR_UNREADABLE');
    expect(report.recordings[0]!.audio.mic).not.toBeNull();
  });

  it('reports an ffmpeg failure on a readable file as an analysis failure, not a reason to re-record', async () => {
    const report = await analyzeProject(await folder(), take(), fakeRun([], (tool, args) =>
      tool === 'ffmpeg' && args.some((a) => a.includes('ebur128')) ? new ToolError('ffmpeg', 'failed', 'No such filter: ebur128') : null));
    expect(codes(report.findings)).toContain('warning:ANALYSIS_FAILED');
    expect(report.findings.map((f) => f.code)).not.toContain('MIC_UNREADABLE');
    expect(report.recordings[0]!.media.mic).toMatchObject({ codec: 'opus' });
  });

  it('reports a timed-out probe as an analysis failure and a rejected probe as an undecodable file', async () => {
    const onMic = (error: Error) => (tool: string, args: string[]) => (tool === 'ffprobe' && args[args.length - 1]!.endsWith('mic.m4a') ? error : null);
    const stopped = await analyzeProject(await folder(), take(), fakeRun([], onMic(new ToolError('ffprobe', 'stopped', 'no result after 30 s'))));
    expect(codes(stopped.findings)).toContain('warning:ANALYSIS_FAILED');
    const broken = await analyzeProject(await folder(), take(), fakeRun([], onMic(new ToolError('ffprobe', 'failed', 'Invalid data found'))));
    expect(codes(broken.findings)).toContain('blocker:MIC_UNREADABLE');
  });

  it('fails with ToolsMissingError when ffmpeg is not installed', async () => {
    const run: Run = async () => { throw new ToolsMissingError(); };
    await expect(analyzeProject(await folder(), take(), run)).rejects.toBeInstanceOf(ToolsMissingError);
  });
});

describe('momotombo-edit analyze', () => {
  it('exits with its own code and one line when ffmpeg is not on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'momotombo cli '));
    await mkdir(join(root, 'Demo'));
    await writeFile(join(root, 'Demo', 'project.json'), serializeProject(shortTake(), new Date()));
    let err = '';
    const code = await cli(['analyze', 'latest', '--root', root], { out: () => {}, err: (t) => { err += t; }, stdin: async () => '', env: { PATH: root } });
    expect(code).toBe(EXIT.toolsMissing);
    expect(err.trim().split('\n')).toEqual(['momotombo-edit: analyze needs ffmpeg and ffprobe on PATH (macOS: brew install ffmpeg).']);
  });
});

describe.skipIf(!hasFfmpeg)('analyzeProject with the real ffmpeg', () => {
  const snapshot = async (dir: string) => {
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          const s = await stat(p);
          out.push(`${relative(dir, p)} ${s.size} ${s.mtimeMs}`);
        }
      }
    };
    await walk(dir);
    return out.sort();
  };

  it('probes a file whose path has spaces', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'momotombo spaced path '));
    const file = join(dir, 'a clip with spaces.m4a');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=1', '-c:a', 'aac', file]);
    expect(parseProbe(await toolRunner()('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', file]))).toMatchObject({ codec: 'aac', channels: 1 });
  });

  it('stops a pass that runs past its timeout', async () => {
    await expect(toolRunner()('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc', '-f', 'null', '-'], 0.5)).rejects.toMatchObject({ reason: 'stopped' });
  });

  it('rates a quiet but clean voice as fixable and writes nothing into the project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'momotombo real take '));
    await mkdir(join(dir, 'media', 'r1'), { recursive: true });
    const media = (name: string) => join(dir, 'media', 'r1', name);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1920x1080:r=30:d=12', '-c:v', 'mpeg4', '-q:v', '10', media('screen.mp4')]);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=180:r=48000:d=12', '-f', 'lavfi', '-i', 'anoisesrc=r=48000:a=0.0001:d=12', '-filter_complex',
      "[0]volume='0.13*gt(sin(2*PI*t*0.5),0)*(0.6+0.4*sin(2*PI*t*4))':eval=frame[v];[v][1]amix=inputs=2:normalize=0,aformat=channel_layouts=mono", '-c:a', 'aac', media('mic.m4a')]);
    const project = addRecording(createProject('Quiet'), recording(12, { screen: source('screen', 12), mic: source('mic', 12) }));
    const before = await snapshot(dir);
    const report = await analyzeProject(dir, project);
    expect(await snapshot(dir)).toEqual(before);
    const mic = report.recordings[0]!.audio.mic!;
    expect(mic.integratedLufs).toBeLessThan(-40);
    expect(mic.silenceShare).toBeLessThan(0.7);
    expect(codes(report.findings)).toContain('warning:MIC_TOO_QUIET');
    expect(report.findings.map((f) => f.code)).not.toContain('MIC_SILENT');
    expect(report.verdict).toBe('edit-with-fixes');
  }, 30_000);
});
