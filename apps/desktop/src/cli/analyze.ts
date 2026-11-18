import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { layoutSegments, parseCursorLog, sequenceDuration, type Project, type Recording, type SourceKind } from '@momotombo/project-model';
import { secondsToTicks, ticksToSeconds } from '@momotombo/timing';
import type { Op } from './ops';

export const SILENCE_NOISE_DB = -35;
export const SILENCE_MIN_SECONDS = 0.6;
export const SILENCE_MERGE_GAP_SECONDS = 0.2;
export const BLACK_MIN_SECONDS = 0.5;
export const BLACK_PIXEL_THRESHOLD = 0.1;
export const FREEZE_NOISE_DB = -60;
export const FREEZE_MIN_SECONDS = 2;
export const BRIGHTNESS_SAMPLE_FPS = 1;
export const CURSOR_IDLE_SECONDS = 3;
export const DEAD_TIME_CUT_SECONDS = 2;
export const CUT_PADDING_SECONDS = 0.25;
export const DEAD_TIME_WARNING_SECONDS = 8;
export const DEAD_TIME_WARNING_SHARE = 0.15;
export const TARGET_LUFS = -16;
export const MAX_TRUE_PEAK_DBTP = -1;
export const MIC_GAIN_MAX = 1;
export const GAIN_CHANGE_MIN_DB = 1;
export const MIC_SILENT_SHARE = 0.95;
export const MIC_QUIET_LUFS = -30;
export const MIC_UNRESCUABLE_LUFS = -45;
export const MIC_NOISE_FLOOR_DB = -45;
export const CLIP_SAMPLE_PEAK_DBFS = -0.1;
export const CLIP_HOT_LUFS = -14;
export const CAMERA_DARK_YAVG = 60;
export const MIN_SCREEN_HEIGHT = 1080;
export const MIN_FPS = 24;
export const DURATION_MISMATCH_SECONDS = 0.5;
export const SCREEN_STATIC_SECONDS = 10;
export const MAX_PARALLEL_PASSES = 4;
export const ANALYSIS_WIDTH = 960;
export const EBUR128_SILENT_LUFS = -70;
export const EXIT_TOOLS_MISSING = 3;

const THRESHOLDS = {
  silenceNoiseDb: SILENCE_NOISE_DB, silenceMinSeconds: SILENCE_MIN_SECONDS, blackMinSeconds: BLACK_MIN_SECONDS, blackPixelThreshold: BLACK_PIXEL_THRESHOLD,
  freezeNoiseDb: FREEZE_NOISE_DB, freezeMinSeconds: FREEZE_MIN_SECONDS, cursorIdleSeconds: CURSOR_IDLE_SECONDS, deadTimeCutSeconds: DEAD_TIME_CUT_SECONDS,
  cutPaddingSeconds: CUT_PADDING_SECONDS, targetLufs: TARGET_LUFS, maxTruePeakDbtp: MAX_TRUE_PEAK_DBTP, micGainMax: MIC_GAIN_MAX,
  micQuietLufs: MIC_QUIET_LUFS, micUnrescuableLufs: MIC_UNRESCUABLE_LUFS, micNoiseFloorDb: MIC_NOISE_FLOOR_DB, cameraDarkYavg: CAMERA_DARK_YAVG,
  minScreenHeight: MIN_SCREEN_HEIGHT, minFps: MIN_FPS,
};

export type Tool = 'ffmpeg' | 'ffprobe';
export type Run = (tool: Tool, args: string[]) => Promise<string>;

export class ToolsMissingError extends Error {
  constructor() {
    super('ffmpeg and ffprobe must be on PATH to analyze a recording (macOS: brew install ffmpeg).');
  }
}

export const runTool: Run = (tool, args) =>
  new Promise((done, fail) => {
    execFile(tool, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') fail(new ToolsMissingError());
      else if (error) fail(new Error(`${tool} failed: ${stderr.trim().split('\n').pop() ?? error.message}`));
      else done(tool === 'ffprobe' || args[0] === '-version' ? stdout : stderr);
    });
  });

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

export interface AudioStats {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
  samplePeakDbfs: number | null;
  noiseFloorDb: number | null;
  clipping: boolean;
  silenceShare: number;
  silences: Range[];
}

export interface VideoStats { black: Range[]; frozen: Range[]; meanBrightness: number | null }
export interface CursorStats { clickCount: number; idle: Range[]; idleSeconds: number }
export interface DeadTime { ranges: (Range & { timeline: Range[] })[]; totalSeconds: number }

type MediaEntry = (MediaFacts & { file: string }) | { file: string; error: string };

export interface RecordingAnalysis {
  id: string;
  durationSeconds: number;
  missing: (SourceKind | 'cursor')[];
  media: Partial<Record<SourceKind, MediaEntry>>;
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

export interface GainSuggestion {
  currentGain: number;
  measuredLufs: number;
  targetLufs: number;
  neededGain: number;
  suggestedGain: number;
  expectedLufs: number;
  limitedBy: 'max-gain' | 'true-peak' | null;
  op: Op | null;
}

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
const finite = (n: number) => (Number.isFinite(n) ? n : null);
const num = (text: string | undefined) => (text === undefined ? null : finite(Number.parseFloat(text)));
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

export function parseAudioLog(stderr: string, durationSeconds: number): AudioStats {
  const summary = stderr.slice(Math.max(0, stderr.indexOf('Summary:')));
  const samplePeakDbfs = num(/Peak level dB:\s*(\S+)/.exec(stderr)?.[1]);
  const noiseFloorDb = num(/Noise floor dB:\s*(\S+)/.exec(stderr)?.[1]);
  const silences = ranges(stderr, 'silence_start', 'silence_end', durationSeconds);
  return {
    integratedLufs: num(/\bI:\s*(\S+) LUFS/.exec(summary)?.[1]),
    loudnessRangeLu: num(/\bLRA:\s*(\S+) LU\b/.exec(summary)?.[1]),
    truePeakDbtp: num(/True peak:\s*Peak:\s*(\S+) dBFS/.exec(summary)?.[1]),
    samplePeakDbfs: samplePeakDbfs === null ? null : round(samplePeakDbfs),
    noiseFloorDb: noiseFloorDb === null ? null : round(noiseFloorDb),
    clipping: samplePeakDbfs !== null && samplePeakDbfs >= CLIP_SAMPLE_PEAK_DBFS,
    silenceShare: durationSeconds > 0 ? round(Math.min(1, total(silences) / durationSeconds)) : 0,
    silences,
  };
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

export function micGainSuggestion(project: Project, recordings: RecordingAnalysis[]): GainSuggestion | null {
  const measured = recordings.flatMap((r) => {
    const mic = r.audio.mic;
    return mic?.integratedLufs != null && mic.integratedLufs > EBUR128_SILENT_LUFS ? [{ lufs: mic.integratedLufs, peak: mic.truePeakDbtp, weight: r.durationSeconds }] : [];
  });
  if (measured.length === 0) return null;
  const weight = measured.reduce((s, m) => s + m.weight, 0) || 1;
  const measuredLufs = round(10 * Math.log10(measured.reduce((s, m) => s + m.weight * 10 ** (m.lufs / 10), 0) / weight), 1);
  const peaks = measured.flatMap((m) => (m.peak === null ? [] : [m.peak]));
  const neededDb = TARGET_LUFS - measuredLufs;
  const headroomDb = peaks.length ? MAX_TRUE_PEAK_DBTP - Math.max(...peaks) : Infinity;
  const allowedDb = Math.min(neededDb, headroomDb);
  const allowed = 10 ** (allowedDb / 20);
  const suggestedGain = round(Math.min(MIC_GAIN_MAX, allowed), 2);
  const limitedBy = allowed > MIC_GAIN_MAX ? 'max-gain' : headroomDb < neededDb ? 'true-peak' : null;
  const currentGain = project.audio.mic.gain;
  const changeDb = Math.abs(20 * Math.log10(suggestedGain / currentGain));
  return {
    currentGain,
    measuredLufs,
    targetLufs: TARGET_LUFS,
    neededGain: round(10 ** (neededDb / 20), 2),
    suggestedGain,
    expectedLufs: round(measuredLufs + 20 * Math.log10(suggestedGain), 1),
    limitedBy,
    op: suggestedGain > 0 && changeDb >= GAIN_CHANGE_MIN_DB ? { op: 'setAudio', patch: { mic: { gain: suggestedGain } } } : null,
  };
}

const FILE_SEVERITY: Record<SourceKind, Finding['severity']> = { screen: 'blocker', mic: 'blocker', camera: 'warning', system: 'warning' };
const TRACK_NAME: Record<SourceKind, string> = { screen: 'screen video', mic: 'microphone track', camera: 'camera video', system: 'system audio track' };
const CODE_PREFIX: Record<SourceKind, string> = { screen: 'SCREEN', mic: 'MIC', camera: 'CAMERA', system: 'SYSTEM_AUDIO' };

export function findingsFor(rec: RecordingAnalysis): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Finding['severity'], code: string, message: string, evidence: Record<string, unknown>, advice: string) =>
    out.push({ severity, code, message, evidence, advice, recordingId: rec.id });

  for (const [kind, entry] of Object.entries(rec.media) as [SourceKind, MediaEntry][]) {
    if (!('error' in entry)) continue;
    const missing = entry.error === 'file not found';
    add(FILE_SEVERITY[kind], `${CODE_PREFIX[kind]}_${missing ? 'FILE_MISSING' : 'UNREADABLE'}`,
      `The ${TRACK_NAME[kind]} ${missing ? 'is listed in the project but its file is gone' : 'could not be read'}.`,
      { file: entry.file, error: entry.error },
      missing ? 'Do not move or delete files inside the project folder; record the take again if the file is lost.' : 'Let the recording finish saving before closing the app, and keep enough free disk space while recording.');
  }

  if (rec.missing.includes('mic'))
    add('blocker', 'MIC_MISSING', 'The take has no microphone track.', {}, 'Turn on the microphone in the recorder and pick your mic before you start.');
  if (rec.missing.includes('camera')) add('info', 'CAMERA_MISSING', 'The take has no camera video.', {}, 'Turn on the camera in the recorder if you want your face on screen.');
  if (rec.missing.includes('system')) add('info', 'SYSTEM_AUDIO_MISSING', 'The take has no system audio track.', {}, 'Turn on system audio in the recorder if the demo plays sound.');
  if (rec.missing.includes('cursor')) add('info', 'CURSOR_MISSING', 'The take has no cursor log, so dead time cannot be measured.', {}, 'Record with the native recorder so cursor moves and clicks are logged.');

  const mic = rec.audio.mic;
  if (mic) {
    const level = { integratedLufs: mic.integratedLufs, truePeakDbtp: mic.truePeakDbtp, silenceShare: mic.silenceShare };
    if (mic.silenceShare >= MIC_SILENT_SHARE)
      add('blocker', 'MIC_SILENT', `The microphone is silent or far too quiet for ${Math.round(mic.silenceShare * 100)}% of the take.`, level,
        'Check that the right microphone is selected and not muted, speak within a hand span of it, and raise its input level in System Settings > Sound.');
    else if (mic.integratedLufs !== null && mic.integratedLufs < MIC_QUIET_LUFS) {
      const lost = mic.integratedLufs < MIC_UNRESCUABLE_LUFS;
      add(lost ? 'blocker' : 'warning', 'MIC_TOO_QUIET', `The voice is quiet (${mic.integratedLufs} LUFS; aim for about ${TARGET_LUFS}).`, level,
        lost ? 'Move much closer to the microphone and raise its input level; boosting this much in the edit would make the noise as loud as the voice.' : 'Move closer to the microphone or raise its input level a little.');
    }
    if (mic.clipping) {
      const hot = mic.integratedLufs !== null && mic.integratedLufs > CLIP_HOT_LUFS;
      add(hot ? 'blocker' : 'warning', 'MIC_CLIPPING', `The microphone clips (sample peak ${mic.samplePeakDbfs} dBFS${hot ? ' while running hot' : ''}).`, level,
        'Lower the microphone input level or sit a little farther away so your loudest words stay below the top of the meter.');
    } else if (mic.truePeakDbtp !== null && mic.truePeakDbtp > MAX_TRUE_PEAK_DBTP)
      add('info', 'MIC_PEAKS_HIGH', `The loudest peaks reach ${mic.truePeakDbtp} dBTP, close to clipping.`, level, 'Lower the microphone input level slightly for the next take.');
    if (mic.noiseFloorDb !== null && mic.noiseFloorDb > MIC_NOISE_FLOOR_DB)
      add('warning', 'MIC_NOISY', `The room noise under the voice is high (noise floor ${mic.noiseFloorDb} dB).`, { noiseFloorDb: mic.noiseFloorDb },
        'Close noisy apps and windows, turn off fans or AC, and get closer to the mic so you can lower its input level.');
  }

  const system = rec.audio.system;
  if (system?.clipping)
    add('warning', 'SYSTEM_AUDIO_CLIPPING', `The system audio clips (sample peak ${system.samplePeakDbfs} dBFS).`, { samplePeakDbfs: system.samplePeakDbfs },
      'Lower the volume of the app you are demoing before you record.');
  else if (system && system.silenceShare >= MIC_SILENT_SHARE)
    add('info', 'SYSTEM_AUDIO_SILENT', 'The system audio track is silent.', { silenceShare: system.silenceShare },
      'Turn system audio off when the demo makes no sound, or mute it in the edit.');

  const screen = rec.media.screen;
  if (screen && !('error' in screen)) {
    if (screen.height !== null && screen.height < MIN_SCREEN_HEIGHT && (screen.width ?? 0) < 1920)
      add('warning', 'SCREEN_LOW_RESOLUTION', `The screen was recorded at ${screen.width}x${screen.height}, below 1080p.`, { width: screen.width, height: screen.height },
        'Record the full display or a larger window, and use a display set to at least 1920x1080.');
    if (screen.nominalFrameRate !== null && screen.nominalFrameRate < MIN_FPS)
      add('warning', 'SCREEN_LOW_FPS', `The screen was recorded at ${screen.nominalFrameRate} fps.`, { nominalFrameRate: screen.nominalFrameRate },
        'Set the recording to 30 or 60 fps and close heavy apps so the computer keeps up.');
  }
  const camera = rec.media.camera;
  if (camera && !('error' in camera) && camera.frameRate !== null && camera.frameRate < MIN_FPS)
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
      Object.fromEntries(Object.entries(rec.media).map(([k, m]) => [k, 'error' in m ? null : m.durationSeconds])),
      'Close heavy apps while recording and stop the recording from the recorder, not by quitting the app.');

  const dead = rec.deadTime;
  if (dead && dead.ranges.length) {
    const long = longest(dead.ranges);
    const severe = long >= DEAD_TIME_WARNING_SECONDS || dead.totalSeconds >= DEAD_TIME_WARNING_SHARE * rec.durationSeconds;
    if (severe || long >= DEAD_TIME_CUT_SECONDS)
      add(severe ? 'warning' : 'info', 'DEAD_TIME', `${dead.totalSeconds} s of the take has no voice and no cursor activity (longest ${round(long, 1)} s).`,
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

function passArgs(kind: SourceKind, file: string): string[] {
  const common = ['-hide_banner', '-nostats', '-nostdin', '-i', file];
  if (kind === 'mic' || kind === 'system') {
    return [...common, '-vn', '-af',
      `ebur128=peak=true:framelog=verbose,astats=measure_perchannel=none:measure_overall=Peak_level+Noise_floor,silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
      '-f', 'null', '-'];
  }
  const detect = `scale=w='min(${ANALYSIS_WIDTH},iw)':h=-2,blackdetect=d=${BLACK_MIN_SECONDS}:pix_th=${BLACK_PIXEL_THRESHOLD},freezedetect=n=${FREEZE_NOISE_DB}dB:d=${FREEZE_MIN_SECONDS}`;
  const brightness = kind === 'camera' ? `,fps=${BRIGHTNESS_SAMPLE_FPS},signalstats,metadata=print:key=lavfi.signalstats.YAVG` : '';
  return [...common, '-an', '-vf', detect + brightness, '-f', 'null', '-'];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function analyzeRecording(dir: string, project: Project, rec: Recording, run: Run, slot: ReturnType<typeof limiter>): Promise<RecordingAnalysis> {
  const durationSeconds = round(ticksToSeconds(rec.duration));
  const missing: RecordingAnalysis['missing'] = KINDS.filter((k) => !rec.sources[k]);
  if (!rec.cursorFile) missing.push('cursor');

  const passes = await Promise.all(KINDS.flatMap((kind) => {
    const source = rec.sources[kind];
    if (!source) return [];
    const path = join(dir, source.file);
    return [(async () => {
      try {
        await access(path);
      } catch {
        return { kind, entry: { file: source.file, error: 'file not found' } as MediaEntry, log: null };
      }
      try {
        const [probe, log] = await Promise.all([run('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', path]), slot(() => run('ffmpeg', passArgs(kind, path)))]);
        return { kind, entry: { file: source.file, ...parseProbe(probe) } as MediaEntry, log };
      } catch (e) {
        if (e instanceof ToolsMissingError) throw e;
        return { kind, entry: { file: source.file, error: errorText(e) } as MediaEntry, log: null };
      }
    })()];
  }));

  const media: RecordingAnalysis['media'] = {};
  const audio: RecordingAnalysis['audio'] = { mic: null, system: null };
  const video: RecordingAnalysis['video'] = { screen: null, camera: null };
  for (const { kind, entry, log } of passes) {
    media[kind] = entry;
    if (log === null || 'error' in entry) continue;
    const length = entry.durationSeconds ?? ticksToSeconds(rec.sources[kind]!.duration);
    const offset = ticksToSeconds(rec.sources[kind]!.startOffset + (rec.syncOffsets[kind] ?? 0));
    if (kind === 'mic' || kind === 'system') {
      const stats = parseAudioLog(log, length);
      audio[kind] = { ...stats, silences: shift(stats.silences, offset) };
    } else {
      const stats = parseVideoLog(log, length);
      video[kind] = { ...stats, black: shift(stats.black, offset), frozen: shift(stats.frozen, offset) };
    }
  }

  const lengths = Object.values(media).flatMap((m) => ('error' in m || m.durationSeconds === null ? [] : [m.durationSeconds]));
  const cursorText = rec.cursorFile ? await readFile(join(dir, rec.cursorFile), 'utf8').catch(() => null) : null;
  if (rec.cursorFile && cursorText === null) missing.push('cursor');
  const cursor = cursorText === null ? null : cursorActivity(cursorText, durationSeconds);
  const deadRanges = cursor && audio.mic ? intersect(merge(audio.mic.silences, SILENCE_MERGE_GAP_SECONDS), cursor.idle) : null;

  return {
    id: rec.id,
    durationSeconds,
    missing,
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

export async function analyzeProject(dir: string, project: Project, run: Run = runTool) {
  const began = Date.now();
  const [ffmpegVersion] = await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
  const slot = limiter(MAX_PARALLEL_PASSES);
  const used = new Set(project.sequence.segments.map((s) => s.recordingId));
  const recordings = await Promise.all(Object.values(project.recordings).filter((r) => used.has(r.id)).map((r) => analyzeRecording(dir, project, r, run, slot)));
  const findings = recordings.flatMap(findingsFor);
  const order = { blocker: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const micGain = micGainSuggestion(project, recordings);
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
    suggestedOps: [...cuts, ...(micGain?.op ? [micGain.op] : [])],
    micGain,
    recordings,
    thresholds: THRESHOLDS,
  };
}

export async function analyzeCommand(dir: string, project: Project) {
  try {
    return await analyzeProject(dir, project);
  } catch (e) {
    if (!(e instanceof ToolsMissingError)) throw e;
    process.stderr.write(`momotombo-edit: ${e.message}\n`);
    process.exit(EXIT_TOOLS_MISSING);
  }
}
