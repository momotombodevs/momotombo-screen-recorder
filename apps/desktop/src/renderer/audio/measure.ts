import type { Project } from '@momotombo/project-model';
import { AUDIO_KINDS, decodeTimelineAudio, measureSteps, type AudioKind, type DecodedAudio } from '../export/audio-mix';

export type Loudness =
  | { state: 'off' }
  | { state: 'measuring' }
  | { state: 'measured'; lufs: number | null }
  | { state: 'failed' };

const BLOCKS_PER_SLICE = 8;
const MAX_RESULTS = 200;

function loudnessKey(project: Project, kind: AudioKind): string {
  const { highpassHz, compressor: c, gate: g } = project.audio[kind];
  const segments = project.sequence.segments.map((s) => `${s.recordingId}:${s.sourceStart}:${s.sourceEnd}`).join(',');
  const sources = Object.values(project.recordings)
    .map((r) => `${r.id}:${r.sources[kind]?.file}:${r.sources[kind]?.startOffset}:${r.syncOffsets[kind] ?? 0}`)
    .join(',');
  return `${kind}|${highpassHz}|${c.enabled ? `${c.thresholdDb}:${c.ratio}` : '-'}|${g.enabled ? g.thresholdDb : '-'}|${segments}|${sources}`;
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Loudness each normalised channel would have in the export, derived from the project and never
 * stored in it, so it stays out of the undo history. Results are kept per input (undo finds the
 * earlier one at once), each source file is decoded once, and the measurement gives the thread
 * back every few blocks.
 */
export class LoudnessTracker {
  private results = new Map<string, number | null>();
  private failed = new Set<string>();
  private job: { key: string; ctl: AbortController } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private project: Project | null = null;

  constructor(
    private readonly mediaBase: string,
    private readonly debounceMs = 300,
    private readonly decoded = new Map<string, Promise<DecodedAudio>>(),
  ) {}

  get(project: Project, kind: AudioKind): Loudness {
    if (!project.audio[kind].normalize.enabled) return { state: 'off' };
    const key = loudnessKey(project, kind);
    if (this.results.has(key)) return { state: 'measured', lufs: this.results.get(key)! };
    if (this.failed.has(key)) return { state: 'failed' };
    return { state: 'measuring' };
  }

  lufs(project: Project, kind: AudioKind): number | null {
    const l = this.get(project, kind);
    return l.state === 'measured' ? l.lufs : null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(project: Project): void {
    this.project = project;
    this.evictUnused(project);
    clearTimeout(this.timer);
    const next = this.pending(project);
    if (this.job && this.job.key !== next?.key) {
      this.job.ctl.abort();
      this.job = null;
    }
    if (next && !this.job) this.timer = setTimeout(() => void this.run(), this.debounceMs);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.job?.ctl.abort();
    this.listeners.clear();
    this.decoded.clear();
  }

  private pending(project: Project): { kind: AudioKind; key: string } | null {
    for (const kind of AUDIO_KINDS) {
      if (!project.audio[kind].normalize.enabled) continue;
      const key = loudnessKey(project, kind);
      if (!this.results.has(key) && !this.failed.has(key)) return { kind, key };
    }
    return null;
  }

  private async run(): Promise<void> {
    const project = this.project;
    const next = project && this.pending(project);
    if (!project || !next || this.job) return;
    const ctl = new AbortController();
    this.job = { key: next.key, ctl };
    try {
      const decoded = await decodeTimelineAudio(project, this.mediaBase, [next.kind], ctl.signal, this.decoded);
      if (!decoded || ctl.signal.aborted) return;
      const steps = measureSteps(project, next.kind, decoded);
      let step = steps.next();
      for (let n = 1; !step.done; n++) {
        if (n % BLOCKS_PER_SLICE === 0) {
          await yieldToUi();
          if (ctl.signal.aborted) return;
        }
        step = steps.next();
      }
      this.remember(next.key, step.value);
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.warn('Loudness measurement failed', err);
      this.failed.add(next.key);
    } finally {
      if (this.job?.ctl === ctl) this.job = null;
    }
    for (const fn of this.listeners) fn();
    if (this.project) this.update(this.project);
  }

  private remember(key: string, lufs: number | null): void {
    this.results.set(key, lufs);
    if (this.results.size > MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
  }

  private evictUnused(project: Project): void {
    const files = new Set(
      Object.values(project.recordings).flatMap((r) => AUDIO_KINDS.map((k) => r.sources[k]?.file).filter((f): f is string => !!f)),
    );
    for (const url of this.decoded.keys()) {
      const file = decodeURIComponent(url.slice(this.mediaBase.length));
      if (!files.has(file)) this.decoded.delete(url);
    }
  }
}
