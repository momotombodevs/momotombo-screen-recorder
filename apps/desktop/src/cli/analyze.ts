import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { layoutSegments, parseCursorLog, sequenceDuration, type Project, type Recording, type SourceKind } from '@momotombo/project-model';
import { secondsToTicks, ticksToSeconds } from '@momotombo/timing';
import { safeJoin } from '../main/fsutil';
import type { Op } from './ops';

export const SILENCE_BELOW_LOUDNESS_DB = 18;
export const SILENCE_ABOVE_NOISE_DB = 10;
export const SILENCE_THRESHOLD_MAX_DB = -35;
export const SILENCE_MIN_SECONDS = 0.6;
export const SILENCE_MERGE_GAP_SECONDS = 0.2;
export const BLACK_MIN_SECONDS = 0.5;
export const BLACK_PIXEL_THRESHOLD = 0.1;
export const FREEZE_NOISE_DB = -60;
export const FREEZE_MIN_SECONDS = 2;
export const BRIGHTNESS_SAMPLE_FPS = 1;
export const ANALYSIS_WIDTH = 960;
export const CURSOR_IDLE_SECONDS = 3;
export const DEAD_TIME_CUT_SECONDS = 2;
export const CUT_PADDING_SECONDS = 0.25;
export const DEAD_TIME_WARNING_SECONDS = 8;
export const DEAD_TIME_WARNING_SHARE = 0.15;
export const TARGET_LUFS = -16;
export const MAX_TRUE_PEAK_DBTP = -1;
export const MIC_GAIN_MAX = 1;
export const NORMALIZE_MAX_BOOST_DB = 30;
export const VOICE_HIGHPASS_HZ = 80;
export const LEVEL_CHANGE_MIN_DB = 1;
export const EBUR128_SILENT_LUFS = -70;
export const MIC_SILENT_SHARE = 0.95;
export const MIC_QUIET_LUFS = -30;
export const MIC_MIN_SNR_DB = 20;
export const MIC_NOISY_SNR_DB = 30;
export const CLIP_SAMPLE_PEAK_DBFS = -0.1;
export const CLIP_HOT_LUFS = -14;
export const CAMERA_DARK_YAVG = 60;
export const MIN_SCREEN_HEIGHT = 1080;
export const MIN_FPS = 24;
export const DURATION_MISMATCH_SECONDS = 0.5;
export const SCREEN_STATIC_SECONDS = 10;
export const MAX_PARALLEL_PASSES = 4;
export const PROBE_TIMEOUT_SECONDS = 30;
export const PASS_TIMEOUT_BASE_SECONDS = 60;
export const PASS_TIMEOUT_PER_MEDIA_SECOND = 1;
export const MAX_TOOL_STDOUT_BYTES = 4 * 1024 * 1024;

const THRESHOLDS = {
  silenceBelowLoudnessDb: SILENCE_BELOW_LOUDNESS_DB, silenceAboveNoiseDb: SILENCE_ABOVE_NOISE_DB, silenceThresholdMaxDb: SILENCE_THRESHOLD_MAX_DB,
  silenceMinSeconds: SILENCE_MIN_SECONDS, blackMinSeconds: BLACK_MIN_SECONDS, blackPixelThreshold: BLACK_PIXEL_THRESHOLD, freezeNoiseDb: FREEZE_NOISE_DB,
  freezeMinSeconds: FREEZE_MIN_SECONDS, cursorIdleSeconds: CURSOR_IDLE_SECONDS, deadTimeCutSeconds: DEAD_TIME_CUT_SECONDS, cutPaddingSeconds: CUT_PADDING_SECONDS,
  targetLufs: TARGET_LUFS, maxTruePeakDbtp: MAX_TRUE_PEAK_DBTP, micGainMax: MIC_GAIN_MAX, normalizeMaxBoostDb: NORMALIZE_MAX_BOOST_DB,
  micQuietLufs: MIC_QUIET_LUFS, micMinSnrDb: MIC_MIN_SNR_DB, micNoisySnrDb: MIC_NOISY_SNR_DB, cameraDarkYavg: CAMERA_DARK_YAVG,
  minScreenHeight: MIN_SCREEN_HEIGHT, minFps: MIN_FPS,
};

export type Tool = 'ffmpeg' | 'ffprobe';
export type Run = (tool: Tool, args: string[], timeoutSeconds?: number) => Promise<string>;

export class ToolsMissingError extends Error {
  constructor() {
    super('analyze needs ffmpeg and ffprobe on PATH (macOS: brew install ffmpeg).');
  }
}

export class ToolError extends Error {
  constructor(readonly tool: Tool, readonly reason: 'failed' | 'stopped' | 'too much output', detail: string) {
    super(`${tool} ${reason}: ${detail}`);
  }
}

const KEPT_STDERR = /^\[Parsed_(?!metadata.*frame:)|Summary:|Integrated loudness:|Loudness range:|True peak:|^\s+(I|LRA|Threshold|LRA low|LRA high|Peak):/;

export function toolRunner(env: NodeJS.ProcessEnv = process.env): Run {
  return (tool, args, timeoutSeconds = PROBE_TIMEOUT_SECONDS) =>
    new Promise((done, fail) => {
      const child = spawn(tool, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutSeconds * 1000, killSignal: 'SIGKILL' });
      let stdout = '';
      let overflow = false;
      let partial = '';
      const kept: string[] = [];
      const tail: string[] = [];
      const take = (line: string) => {
        if (KEPT_STDERR.test(line)) kept.push(line);
        else if (line.trim()) tail.splice(0, tail.length, ...tail.slice(-4), line);
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (stdout.length + chunk.length > MAX_TOOL_STDOUT_BYTES) overflow = true;
        else stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        const lines = (partial + chunk).split('\n');
        partial = lines.pop() ?? '';
        lines.forEach(take);
      });
      child.once('error', (e: NodeJS.ErrnoException) => fail(e.code === 'ENOENT' ? new ToolsMissingError() : new ToolError(tool, 'failed', e.message)));
      child.once('close', (code, signal) => {
        take(partial);
        if (signal) fail(new ToolError(tool, 'stopped', `no result after ${timeoutSeconds} s (${signal})`));
        else if (overflow) fail(new ToolError(tool, 'too much output', `more than ${MAX_TOOL_STDOUT_BYTES} bytes`));
        else if (code !== 0) fail(new ToolError(tool, 'failed', tail[tail.length - 1] ?? `exit ${code}`));
        else done(tool === 'ffprobe' || args[0] === '-version' ? stdout : kept.join('\n'));
      });
    });
}

export interface Range { start: number; end: number }

export interface MediaFacts {
  codec: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  nominalFrameRate: number | null;
  bitrateKbps: number | null;
  durationSeconds: number | null;
  sampleRate: number | null;
  channels: number | null;
}

export interface Loudness {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
  samplePeakDbfs: number | null;
  noiseFloorDb: number | null;
}

export interface AudioStats extends Loudness {
  clipping: boolean;
  silenceThresholdDb: number;
  silenceShare: number;
  silences: Range[];
}

export interface VideoStats { black: Range[]; frozen: Range[]; meanBrightness: number | null }
export interface CursorStats { clickCount: number; idle: Range[]; idleSeconds: number }
export interface DeadTime { ranges: (Range & { timeline: Range[] })[]; totalSeconds: number }

export type Track = SourceKind | 'cursor';
export interface Problem {
  track: Track;
  problem: 'missing' | 'outside' | 'unreadable' | 'analysis-failed';
  file: string;
  error: string;
}

export interface RecordingAnalysis {
  id: string;
  durationSeconds: number;
  missing: Track[];
  problems: Problem[];
  media: Partial<Record<SourceKind, MediaFacts & { file: string }>>;
  durationMismatchSeconds: number | null;
  audio: { mic: AudioStats | null; system: AudioStats | null };
  video: { screen: VideoStats | null; camera: VideoStats | null };
  cursor: CursorStats | null;
  deadTime: DeadTime | null;
}

export interface Finding {
  severity: 'blocker' | 'warning' | 'info';
  code: string;
  message: string;
  evidence: Record<string, unknown>;
  advice: string;
  recordingId: string;
}

export type Verdict = 'edit' | 'edit-with-fixes' | 're-record';

export interface LevelSuggestion {
  method: 'normalize' | 'gain';
  currentGain: number;
  measuredLufs: number;
  targetLufs: number;
  neededGain: number;
  suggestedGain: number | null;
  expectedLufs: number;
  limitedBy: 'max-gain' | 'true-peak' | 'max-normalize' | null;
  op: Op | null;
}

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
const finite = (n: number) => (Number.isFinite(n) ? n : null);
const num = (text: string | undefined) => (text === undefined ? null : finite(Number.parseFloat(text)));
const rounded = (n: number | null) => (n === null ? null : round(n));
const rate = (fraction: string | undefined) => {
  const [a, b] = (fraction ?? '').split('/').map(Number);
  return a && b ? round(a / b) : null;
};
const total = (ranges: Range[]) => round(ranges.reduce((sum, r) => sum + r.end - r.start, 0));
const longest = (ranges: Range[]) => ranges.reduce((max, r) => Math.max(max, r.end - r.start), 0);
const shift = (ranges: Range[], by: number) => ranges.map((r) => ({ start: round(r.start + by), end: round(r.end + by) }));

export function parseProbe(json: string): MediaFacts {
  const data = JSON.parse(json) as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  const stream = data.streams?.find((s) => s.codec_type === 'video') ?? data.streams?.find((s) => s.codec_type === 'audio') ?? {};
  const field = (key: string) => (typeof stream[key] === 'string' || typeof stream[key] === 'number' ? String(stream[key]) : undefined);
  const video = stream.codec_type === 'video';
  const bitrate = num(field('bit_rate')) ?? num(data.format?.bit_rate as string | undefined);
  const duration = num(field('duration')) ?? num(data.format?.duration as string | undefined);
  return {
    codec: field('codec_name') ?? null,
    width: video ? num(field('width')) : null,
    height: video ? num(field('height')) : null,
    frameRate: video ? rate(field('avg_frame_rate')) : null,
    nominalFrameRate: video ? rate(field('r_frame_rate')) : null,
    bitrateKbps: bitrate === null ? null : Math.round(bitrate / 1000),
    durationSeconds: duration === null ? null : round(duration),
    sampleRate: video ? null : num(field('sample_rate')),
    channels: video ? null : num(field('channels')),
  };
}

function ranges(text: string, startKey: string, endKey: string, duration: number): Range[] {
  const out: Range[] = [];
  let open: number | null = null;
  for (const m of text.matchAll(new RegExp(`(${startKey}|${endKey})\\s*:\\s*(-?[\\d.]+)`, 'g'))) {
    const at = Number(m[2]);
    if (m[1] === startKey) open = at;
    else if (open !== null) {
      out.push({ start: round(open), end: round(at) });
      open = null;
    }
  }
  if (open !== null && duration > open) out.push({ start: round(open), end: round(duration) });
  return out;
}

export function parseLoudnessLog(stderr: string): Loudness {
  const summary = stderr.slice(Math.max(0, stderr.indexOf('Summary:')));
  return {
    integratedLufs: num(/\bI:\s*(\S+) LUFS/.exec(summary)?.[1]),
    loudnessRangeLu: num(/\bLRA:\s*(\S+) LU\b/.exec(summary)?.[1]),
    truePeakDbtp: num(/True peak:\s*Peak:\s*(\S+) dBFS/.exec(summary)?.[1]),
    samplePeakDbfs: rounded(num(/Peak level dB:\s*(\S+)/.exec(stderr)?.[1])),
    noiseFloorDb: rounded(num(/Noise floor dB:\s*(\S+)/.exec(stderr)?.[1])),
  };
}

export function silenceThresholdDb(level: Loudness): number {
  const candidates = [
    ...(level.integratedLufs !== null && level.integratedLufs > EBUR128_SILENT_LUFS ? [level.integratedLufs - SILENCE_BELOW_LOUDNESS_DB] : []),
    ...(level.noiseFloorDb !== null ? [level.noiseFloorDb + SILENCE_ABOVE_NOISE_DB] : []),
  ];
  return round(Math.min(SILENCE_THRESHOLD_MAX_DB, candidates.length ? Math.max(...candidates) : SILENCE_THRESHOLD_MAX_DB), 1);
}

export function parseSilenceLog(stderr: string, durationSeconds: number): Range[] {
  return ranges(stderr, 'silence_start', 'silence_end', durationSeconds);
}

export function audioStats(level: Loudness, thresholdDb: number, silences: Range[], durationSeconds: number): AudioStats {
  return {
    ...level,
    clipping: level.samplePeakDbfs !== null && level.samplePeakDbfs >= CLIP_SAMPLE_PEAK_DBFS,
    silenceThresholdDb: thresholdDb,
    silenceShare: durationSeconds > 0 ? round(Math.min(1, total(silences) / durationSeconds)) : 0,
    silences,
  };
}

export function parseAudioLog(stderr: string, durationSeconds: number): AudioStats {
  const level = parseLoudnessLog(stderr);
  return audioStats(level, SILENCE_THRESHOLD_MAX_DB, parseSilenceLog(stderr, durationSeconds), durationSeconds);
}

export function parseVideoLog(stderr: string, durationSeconds: number): VideoStats {
  const black = [...stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)].map((m) => ({ start: round(Number(m[1])), end: round(Number(m[2])) }));
  const brightness = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return {
    black,
    frozen: ranges(stderr, 'lavfi.freezedetect.freeze_start', 'lavfi.freezedetect.freeze_end', durationSeconds),
    meanBrightness: brightness.length ? round(brightness.reduce((a, b) => a + b, 0) / brightness.length) : null,
  };
}

export function cursorActivity(text: string, recordingSeconds: number): CursorStats {
  const track = parseCursorLog(text);
  const times = [...track.samples, ...track.clicks, ...track.scrolls].map((e) => ticksToSeconds(e.t)).filter((t) => t >= 0 && t <= recordingSeconds).sort((a, b) => a - b);
  if (times.length === 0 && text.trim()) throw new Error('no valid cursor events');
  const edges = [0, ...times, recordingSeconds];
  const idle: Range[] = [];
  for (let i = 1; i < edges.length; i++) {
    if (edges[i]! - edges[i - 1]! >= CURSOR_IDLE_SECONDS) idle.push({ start: round(edges[i - 1]!), end: round(edges[i]!) });
  }
  return { clickCount: track.clicks.filter((c) => c.kind === 'down').length, idle, idleSeconds: total(idle) };
}

function merge(list: Range[], gap: number): Range[] {
  const out: Range[] = [];
  for (const r of [...list].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function intersect(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start: round(start), end: round(end) });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

export function deadTimeRanges(rec: Pick<RecordingAnalysis, 'audio' | 'video' | 'cursor'>): Range[] | null {
  if (!rec.cursor || !rec.audio.mic) return null;
  const quiet = [rec.audio.system?.silences, rec.video.screen?.frozen]
    .filter((r): r is Range[] => r !== undefined)
    .reduce((acc, r) => intersect(acc, merge(r, SILENCE_MERGE_GAP_SECONDS)), intersect(merge(rec.audio.mic.silences, SILENCE_MERGE_GAP_SECONDS), rec.cursor.idle));
  return quiet;
}

function toTimeline(project: Project, recordingId: string, range: Range): Range[] {
  return layoutSegments(project).flatMap((p) => {
    if (p.segment.recordingId !== recordingId) return [];
    const start = Math.max(secondsToTicks(range.start), p.segment.sourceStart);
    const end = Math.min(secondsToTicks(range.end), p.segment.sourceEnd);
    if (end <= start) return [];
    return [{ start: round(ticksToSeconds(p.timelineStart + start - p.segment.sourceStart)), end: round(ticksToSeconds(p.timelineStart + end - p.segment.sourceStart)) }];
  });
}

export function suggestCuts(project: Project, dead: (Range & { recordingId: string })[]): Op[] {
  const timeline = dead
    .filter((r) => r.end - r.start >= DEAD_TIME_CUT_SECONDS)
    .flatMap((r) => toTimeline(project, r.recordingId, { start: r.start + CUT_PADDING_SECONDS, end: r.end - CUT_PADDING_SECONDS }));
  return merge(timeline, 0)
    .sort((a, b) => b.start - a.start)
    .map((r): Op => ({ op: 'cut', start: r.start, end: r.end }));
}

interface MicChannel { gain: number; highpassHz?: number; normalize?: { enabled: boolean; targetLufs: number } }

export function micLevelSuggestion(project: Project, recordings: RecordingAnalysis[]): LevelSuggestion | null {
  const measured = recordings.flatMap((r) => {
    const mic = r.audio.mic;
    return mic?.integratedLufs != null && mic.integratedLufs > EBUR128_SILENT_LUFS ? [{ lufs: mic.integratedLufs, peak: mic.truePeakDbtp, weight: r.durationSeconds }] : [];
  });
  if (measured.length === 0) return null;
  const weight = measured.reduce((s, m) => s + m.weight, 0) || 1;
  const measuredLufs = round(10 * Math.log10(measured.reduce((s, m) => s + m.weight * 10 ** (m.lufs / 10), 0) / weight), 1);
  const channel = project.audio.mic as MicChannel;
  const currentGain = channel.gain;

  if (channel.normalize && typeof channel.highpassHz === 'number') {
    const targetLufs = channel.normalize.targetLufs;
    const neededDb = targetLufs - measuredLufs;
    const capped = neededDb > NORMALIZE_MAX_BOOST_DB;
    const done = channel.normalize.enabled && channel.highpassHz > 0;
    return {
      method: 'normalize', currentGain, measuredLufs, targetLufs,
      neededGain: round(10 ** (neededDb / 20), 2),
      suggestedGain: null,
      expectedLufs: round(capped ? measuredLufs + NORMALIZE_MAX_BOOST_DB : targetLufs, 1),
      limitedBy: capped ? 'max-normalize' : null,
      op: done || Math.abs(neededDb) < LEVEL_CHANGE_MIN_DB ? null : { op: 'setAudio', patch: { mic: { highpassHz: VOICE_HIGHPASS_HZ, normalize: { enabled: true } } } },
    };
  }

  const peaks = measured.flatMap((m) => (m.peak === null ? [] : [m.peak]));
  const neededDb = TARGET_LUFS - measuredLufs;
  const headroomDb = peaks.length ? MAX_TRUE_PEAK_DBTP - Math.max(...peaks) : Infinity;
  const allowed = 10 ** (Math.min(neededDb, headroomDb) / 20);
  const suggestedGain = round(Math.min(MIC_GAIN_MAX, allowed), 2);
  const changeDb = Math.abs(20 * Math.log10(suggestedGain / currentGain));
  return {
    method: 'gain', currentGain, measuredLufs, targetLufs: TARGET_LUFS,
    neededGain: round(10 ** (neededDb / 20), 2),
    suggestedGain,
    expectedLufs: round(measuredLufs + 20 * Math.log10(suggestedGain), 1),
    limitedBy: allowed > MIC_GAIN_MAX ? 'max-gain' : headroomDb < neededDb ? 'true-peak' : null,
    op: suggestedGain > 0 && changeDb >= LEVEL_CHANGE_MIN_DB ? { op: 'setAudio', patch: { mic: { gain: suggestedGain } } } : null,
  };
}

const FILE_SEVERITY: Record<SourceKind, Finding['severity']> = { screen: 'blocker', mic: 'blocker', camera: 'warning', system: 'warning' };
const TRACK_NAME: Record<Track, string> = { screen: 'screen video', mic: 'microphone track', camera: 'camera video', system: 'system audio track', cursor: 'cursor log' };
const CODE_PREFIX: Record<SourceKind, string> = { screen: 'SCREEN', mic: 'MIC', camera: 'CAMERA', system: 'SYSTEM_AUDIO' };

function problemFinding(p: Problem): Omit<Finding, 'recordingId'> {
  const evidence = { track: p.track, file: p.file, error: p.error };
  if (p.problem === 'analysis-failed')
    return { severity: 'warning', code: 'ANALYSIS_FAILED', message: `The ${TRACK_NAME[p.track]} could not be analyzed (${p.error}); its checks are missing from this report.`, evidence,
      advice: 'This is a problem with the analysis tools, not the take: update ffmpeg (brew upgrade ffmpeg) and run analyze again.' };
  if (p.track === 'cursor')
    return { severity: 'info', code: 'CURSOR_UNREADABLE', message: `The cursor log cannot be used (${p.error}), so dead time is not measured.`, evidence,
      advice: 'Record with the native recorder so cursor moves and clicks are logged.' };
  const prefix = CODE_PREFIX[p.track];
  if (p.problem === 'unreadable')
    return { severity: FILE_SEVERITY[p.track], code: `${prefix}_UNREADABLE`, message: `The ${TRACK_NAME[p.track]} cannot be decoded (${p.error}).`, evidence,
      advice: 'Let the recording finish saving before closing the app, and keep enough free disk space while recording.' };
  return { severity: FILE_SEVERITY[p.track], code: p.problem === 'outside' ? `${prefix}_FILE_OUTSIDE_PROJECT` : `${prefix}_FILE_MISSING`,
    message: p.problem === 'outside' ? `The ${TRACK_NAME[p.track]} path points outside the project folder.` : `The ${TRACK_NAME[p.track]} is listed in the project but its file is gone.`,
    evidence, advice: 'Do not move or rename files inside the project folder; record the take again if the file is lost.' };
}

export function findingsFor(rec: RecordingAnalysis): Finding[] {
  const out: Finding[] = rec.problems.map((p) => ({ ...problemFinding(p), recordingId: rec.id }));
  const add = (severity: Finding['severity'], code: string, message: string, evidence: Record<string, unknown>, advice: string) =>
    out.push({ severity, code, message, evidence, advice, recordingId: rec.id });

  if (rec.missing.includes('mic'))
    add('warning', 'MIC_MISSING', 'The take has no microphone track.', {}, 'If you meant to narrate, turn on the microphone in the recorder and pick your mic before you start; a silent demo is fine as it is.');
  if (rec.missing.includes('screen'))
    add('warning', 'SCREEN_MISSING', 'The take has no screen video.', {}, 'Pick a display or window in the recorder before you start if the video should show your screen.');
  if (rec.missing.includes('camera')) add('info', 'CAMERA_MISSING', 'The take has no camera video.', {}, 'Turn on the camera in the recorder if you want your face on screen.');
  if (rec.missing.includes('system')) add('info', 'SYSTEM_AUDIO_MISSING', 'The take has no system audio track.', {}, 'Turn on system audio in the recorder if the demo plays sound.');
  if (rec.missing.includes('cursor')) add('info', 'CURSOR_MISSING', 'The take has no cursor log, so dead time cannot be measured.', {}, 'Record with the native recorder so cursor moves and clicks are logged.');

  const mic = rec.audio.mic;
  if (mic) {
    const lufs = mic.integratedLufs;
    const snrDb = lufs !== null && mic.noiseFloorDb !== null ? round(lufs - mic.noiseFloorDb, 1) : null;
    const boostDb = lufs === null ? 0 : TARGET_LUFS - lufs;
    const level = { integratedLufs: lufs, truePeakDbtp: mic.truePeakDbtp, noiseFloorDb: mic.noiseFloorDb, snrDb, silenceShare: mic.silenceShare, silenceThresholdDb: mic.silenceThresholdDb };
    const quiet = lufs !== null && lufs < MIC_QUIET_LUFS;
    if (lufs === null || lufs <= EBUR128_SILENT_LUFS || mic.silenceShare >= MIC_SILENT_SHARE)
      add('blocker', 'MIC_SILENT', `The microphone picked up no voice: ${Math.round(mic.silenceShare * 100)}% of the take is at the room-noise level.`, level,
        'Check that the right microphone is selected and not muted, speak within a hand span of it, and raise its input level in System Settings > Sound.');
    else if (snrDb !== null && snrDb < MIC_MIN_SNR_DB)
      add('blocker', quiet ? 'MIC_TOO_QUIET' : 'MIC_NOISY',
        `The voice is only ${snrDb} dB above the room noise${quiet ? ` (${lufs} LUFS)` : ''}; bringing it to ${TARGET_LUFS} LUFS would make the noise about ${round((mic.noiseFloorDb ?? 0) + boostDb, 1)} dB.`, level,
        quiet ? 'Move much closer to the microphone and raise its input level; a boost this large in the edit makes the noise as loud as the voice.' : 'Record in a quieter room: close windows, turn off fans or AC, and close noisy apps.');
    else {
      if (quiet)
        add(boostDb > NORMALIZE_MAX_BOOST_DB ? 'blocker' : 'warning', 'MIC_TOO_QUIET',
          `The voice is quiet (${lufs} LUFS; aim for about ${TARGET_LUFS}). ${boostDb > NORMALIZE_MAX_BOOST_DB ? 'It needs more boost than the editor can give.' : 'Normalizing it in the edit is enough.'}`, level,
          'Move closer to the microphone or raise its input level for the next take.');
      if (snrDb !== null && snrDb < MIC_NOISY_SNR_DB)
        add('warning', 'MIC_NOISY', `The room noise is noticeable: the voice is ${snrDb} dB above it.`, level,
          'Close noisy apps and windows, turn off fans or AC, and get closer to the mic so you can lower its input level.');
    }
    if (mic.clipping) {
      const hot = lufs !== null && lufs > CLIP_HOT_LUFS;
      add(hot ? 'blocker' : 'warning', 'MIC_CLIPPING', `The microphone clips (sample peak ${mic.samplePeakDbfs} dBFS${hot ? ' while running hot' : ''}).`, level,
        'Lower the microphone input level or sit a little farther away so your loudest words stay below the top of the meter.');
    } else if (mic.truePeakDbtp !== null && mic.truePeakDbtp > MAX_TRUE_PEAK_DBTP)
      add('info', 'MIC_PEAKS_HIGH', `The loudest peaks reach ${mic.truePeakDbtp} dBTP, close to clipping.`, level, 'Lower the microphone input level slightly for the next take.');
  }

  const system = rec.audio.system;
  if (system?.clipping)
    add('warning', 'SYSTEM_AUDIO_CLIPPING', `The system audio clips (sample peak ${system.samplePeakDbfs} dBFS).`, { samplePeakDbfs: system.samplePeakDbfs },
      'Lower the volume of the app you are demoing before you record.');
  else if (system && (system.integratedLufs === null || system.integratedLufs <= EBUR128_SILENT_LUFS || system.silenceShare >= MIC_SILENT_SHARE))
    add('info', 'SYSTEM_AUDIO_SILENT', 'The system audio track is silent.', { integratedLufs: system.integratedLufs, silenceShare: system.silenceShare },
      'Turn system audio off when the demo makes no sound, or mute it in the edit.');

  const screen = rec.media.screen;
  if (screen) {
    if (screen.height !== null && screen.height < MIN_SCREEN_HEIGHT && (screen.width ?? 0) < 1920)
      add('warning', 'SCREEN_LOW_RESOLUTION', `The screen was recorded at ${screen.width}x${screen.height}, below 1080p.`, { width: screen.width, height: screen.height },
        'Record the full display or a larger window, and use a display set to at least 1920x1080.');
    if (screen.nominalFrameRate !== null && screen.nominalFrameRate < MIN_FPS)
      add('warning', 'SCREEN_LOW_FPS', `The screen was recorded at ${screen.nominalFrameRate} fps.`, { nominalFrameRate: screen.nominalFrameRate },
        'Set the recording to 30 or 60 fps and close heavy apps so the computer keeps up.');
  }
  const camera = rec.media.camera;
  if (camera && camera.frameRate !== null && camera.frameRate < MIN_FPS)
    add('warning', 'CAMERA_LOW_FPS', `The camera delivered only ${camera.frameRate} fps.`, { frameRate: camera.frameRate },
      'Add light in front of you (low light slows webcams down) and close other apps that use the camera.');

  const sv = rec.video.screen;
  if (sv?.black.length)
    add('warning', 'SCREEN_BLACK', `The screen video is black for ${total(sv.black)} s.`, { ranges: sv.black },
      'Check the screen-recording permission and that the recorded window stays on screen and is not minimized.');
  if (sv && longest(sv.frozen) >= SCREEN_STATIC_SECONDS)
    add('info', 'SCREEN_STATIC', `The screen does not change for ${round(longest(sv.frozen), 1)} s at a stretch.`, { ranges: sv.frozen },
      'Keep the screen moving with what you explain, or plan a zoom on what matters during long static parts.');
  const cv = rec.video.camera;
  if (cv?.black.length)
    add('warning', 'CAMERA_BLACK', `The camera video is black for ${total(cv.black)} s.`, { ranges: cv.black }, 'Uncover the camera and check it is not used by another app.');
  if (cv?.frozen.length)
    add('warning', 'CAMERA_FROZEN', `The camera image freezes for ${total(cv.frozen)} s.`, { ranges: cv.frozen },
      'Close other apps that use the camera, use a direct USB port, and add light so the camera needs less processing.');
  if (cv?.meanBrightness != null && cv.meanBrightness < CAMERA_DARK_YAVG)
    add('warning', 'CAMERA_DARK', `The camera image is too dark (mean brightness ${cv.meanBrightness} of 255).`, { meanBrightness: cv.meanBrightness },
      'Add a light in front of you, facing you, and avoid a bright window behind you.');

  if (rec.durationMismatchSeconds !== null && rec.durationMismatchSeconds > DURATION_MISMATCH_SECONDS)
    add('warning', 'DURATION_MISMATCH', `The tracks differ in length by ${rec.durationMismatchSeconds} s, so they may drift out of sync.`,
      Object.fromEntries(Object.entries(rec.media).map(([k, m]) => [k, m.durationSeconds])),
      'Close heavy apps while recording and stop the recording from the recorder, not by quitting the app.');

  const dead = rec.deadTime;
  if (dead && dead.ranges.length) {
    const long = longest(dead.ranges);
    const severe = long >= DEAD_TIME_WARNING_SECONDS || dead.totalSeconds >= DEAD_TIME_WARNING_SHARE * rec.durationSeconds;
    if (severe || long >= DEAD_TIME_CUT_SECONDS)
      add(severe ? 'warning' : 'info', 'DEAD_TIME', `${dead.totalSeconds} s of the take has no voice, no cursor activity and nothing changing on screen (longest ${round(long, 1)} s).`,
        { totalSeconds: dead.totalSeconds, longestSeconds: round(long), count: dead.ranges.length },
        'Plan the next step before you record it, and pause the recording while you look something up.');
  }
  return out;
}

export function verdictFor(findings: Finding[]): { verdict: Verdict; verdictReasons: string[] } {
  const of = (severity: Finding['severity']) => findings.filter((f) => f.severity === severity).map((f) => f.message);
  const blockers = of('blocker');
  if (blockers.length) return { verdict: 're-record', verdictReasons: blockers };
  const warnings = of('warning');
  if (warnings.length) return { verdict: 'edit-with-fixes', verdictReasons: warnings };
  return { verdict: 'edit', verdictReasons: ['No blockers or warnings.'] };
}

function limiter(size: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= size) await new Promise<void>((go) => queue.push(go));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const KINDS: SourceKind[] = ['screen', 'camera', 'mic', 'system'];
const AUDIO = (kind: SourceKind) => kind === 'mic' || kind === 'system';
const INPUT = (file: string) => ['-hide_banner', '-nostats', '-nostdin', '-i', file];

const loudnessArgs = (file: string) => [...INPUT(file), '-vn', '-af',
  'ebur128=peak=true:framelog=verbose,astats=measure_perchannel=none:measure_overall=Peak_level+Noise_floor', '-f', 'null', '-'];
const silenceArgs = (file: string, thresholdDb: number) => [...INPUT(file), '-vn', '-af', `silencedetect=noise=${thresholdDb}dB:d=${SILENCE_MIN_SECONDS}`, '-f', 'null', '-'];
const videoArgs = (kind: SourceKind, file: string) => {
  const detect = `scale=w='min(${ANALYSIS_WIDTH},iw)':h=-2,blackdetect=d=${BLACK_MIN_SECONDS}:pix_th=${BLACK_PIXEL_THRESHOLD},freezedetect=n=${FREEZE_NOISE_DB}dB:d=${FREEZE_MIN_SECONDS}`;
  const brightness = kind === 'camera' ? `,fps=${BRIGHTNESS_SAMPLE_FPS},signalstats,metadata=print:key=lavfi.signalstats.YAVG` : '';
  return [...INPUT(file), '-an', '-vf', detect + brightness, '-f', 'null', '-'];
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const passTimeout = (seconds: number) => PASS_TIMEOUT_BASE_SECONDS + PASS_TIMEOUT_PER_MEDIA_SECOND * seconds;

type Pass =
  | { kind: SourceKind; facts: MediaFacts; audio?: AudioStats; video?: VideoStats }
  | { kind: SourceKind; problem: Problem; facts?: MediaFacts };

async function analyzeSource(dir: string, rec: Recording, kind: SourceKind, run: Run, slot: ReturnType<typeof limiter>): Promise<Pass> {
  const source = rec.sources[kind]!;
  const fail = (problem: Problem['problem'], error: string, facts?: MediaFacts): Pass => ({ kind, problem: { track: kind, problem, file: source.file, error }, ...(facts ? { facts } : {}) });
  const path = safeJoin(dir, source.file);
  if (!path) return fail('outside', 'path outside the project folder');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return fail('missing', 'file not found');

  let facts: MediaFacts;
  try {
    facts = parseProbe(await run('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', path], PROBE_TIMEOUT_SECONDS));
  } catch (e) {
    if (e instanceof ToolsMissingError) throw e;
    return fail(e instanceof ToolError && e.reason === 'failed' ? 'unreadable' : 'analysis-failed', errorText(e));
  }
  const wanted = AUDIO(kind) ? facts.sampleRate !== null : facts.width !== null;
  if (!facts.codec || !wanted) return fail('unreadable', `no ${AUDIO(kind) ? 'audio' : 'video'} stream`, facts);

  const length = facts.durationSeconds ?? ticksToSeconds(source.duration);
  const offset = ticksToSeconds(source.startOffset + (rec.syncOffsets[kind] ?? 0));
  const timeout = passTimeout(length);
  try {
    if (AUDIO(kind)) {
      const level = parseLoudnessLog(await slot(() => run('ffmpeg', loudnessArgs(path), timeout)));
      const threshold = silenceThresholdDb(level);
      const silences = parseSilenceLog(await slot(() => run('ffmpeg', silenceArgs(path, threshold), timeout)), length);
      const audio = audioStats(level, threshold, silences, length);
      return { kind, facts, audio: { ...audio, silences: shift(audio.silences, offset) } };
    }
    const video = parseVideoLog(await slot(() => run('ffmpeg', videoArgs(kind, path), timeout)), length);
    return { kind, facts, video: { ...video, black: shift(video.black, offset), frozen: shift(video.frozen, offset) } };
  } catch (e) {
    if (e instanceof ToolsMissingError) throw e;
    return fail('analysis-failed', errorText(e), facts);
  }
}

async function analyzeCursor(dir: string, rec: Recording, recordingSeconds: number): Promise<{ cursor: CursorStats | null; problem: Problem | null }> {
  if (!rec.cursorFile) return { cursor: null, problem: null };
  const problem = (error: string): Problem => ({ track: 'cursor', problem: 'unreadable', file: rec.cursorFile!, error });
  const path = safeJoin(dir, rec.cursorFile);
  if (!path) return { cursor: null, problem: { ...problem('path outside the project folder'), problem: 'outside' } };
  try {
    return { cursor: cursorActivity(await readFile(path, 'utf8'), recordingSeconds), problem: null };
  } catch (e) {
    return { cursor: null, problem: problem(errorText(e)) };
  }
}

async function analyzeRecording(dir: string, project: Project, rec: Recording, run: Run, slot: ReturnType<typeof limiter>): Promise<RecordingAnalysis> {
  const durationSeconds = round(ticksToSeconds(rec.duration));
  const missing: Track[] = KINDS.filter((k) => !rec.sources[k]);
  if (!rec.cursorFile) missing.push('cursor');

  const [passes, cursorResult] = await Promise.all([
    Promise.all(KINDS.filter((k) => rec.sources[k]).map((k) => analyzeSource(dir, rec, k, run, slot))),
    analyzeCursor(dir, rec, durationSeconds),
  ]);

  const problems: Problem[] = [];
  const media: RecordingAnalysis['media'] = {};
  const audio: RecordingAnalysis['audio'] = { mic: null, system: null };
  const video: RecordingAnalysis['video'] = { screen: null, camera: null };
  for (const pass of passes) {
    if (pass.facts) media[pass.kind] = { file: rec.sources[pass.kind]!.file, ...pass.facts };
    if ('problem' in pass) problems.push(pass.problem);
    else if (pass.audio) audio[pass.kind as 'mic' | 'system'] = pass.audio;
    else if (pass.video) video[pass.kind as 'screen' | 'camera'] = pass.video;
  }
  if (cursorResult.problem) problems.push(cursorResult.problem);

  const lengths = Object.values(media).flatMap((m) => (m.durationSeconds === null ? [] : [m.durationSeconds]));
  const cursor = cursorResult.cursor;
  const deadRanges = deadTimeRanges({ audio, video, cursor });

  return {
    id: rec.id,
    durationSeconds,
    missing,
    problems,
    media,
    durationMismatchSeconds: lengths.length > 1 ? round(Math.max(...lengths) - Math.min(...lengths)) : null,
    audio,
    video,
    cursor,
    deadTime: deadRanges && {
      ranges: deadRanges.map((r) => ({ ...r, timeline: toTimeline(project, rec.id, r) })),
      totalSeconds: total(deadRanges),
    },
  };
}

export async function analyzeProject(dir: string, project: Project, run: Run = toolRunner()) {
  const began = Date.now();
  const [ffmpegVersion] = await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
  const slot = limiter(MAX_PARALLEL_PASSES);
  const used = new Set(project.sequence.segments.map((s) => s.recordingId));
  const recordings = await Promise.all(Object.values(project.recordings).filter((r) => used.has(r.id)).map((r) => analyzeRecording(dir, project, r, run, slot)));
  const findings = recordings.flatMap(findingsFor);
  const order = { blocker: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const micLevel = micLevelSuggestion(project, recordings);
  const cuts = suggestCuts(project, recordings.flatMap((r) => (r.deadTime?.ranges ?? []).map((d) => ({ ...d, recordingId: r.id }))));
  const count = (severity: Finding['severity']) => findings.filter((f) => f.severity === severity).length;
  return {
    id: project.id,
    name: project.name,
    dir,
    ffmpeg: ffmpegVersion.split('\n')[0]?.trim() ?? null,
    ...verdictFor(findings),
    overall: {
      timelineSeconds: round(ticksToSeconds(sequenceDuration(project))),
      recordings: recordings.length,
      blockers: count('blocker'),
      warnings: count('warning'),
      infos: count('info'),
      deadTimeSeconds: round(recordings.reduce((s, r) => s + (r.deadTime?.totalSeconds ?? 0), 0)),
      suggestedCutSeconds: round(cuts.reduce((s, op) => s + (op.op === 'cut' ? op.end - op.start : 0), 0)),
      elapsedSeconds: round((Date.now() - began) / 1000, 2),
    },
    findings,
    suggestedOps: [...cuts, ...(micLevel?.op ? [micLevel.op] : [])],
    micLevel,
    recordings,
    thresholds: THRESHOLDS,
  };
}
