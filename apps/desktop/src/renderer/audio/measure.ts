import type { Project } from '@momotombo/project-model';
import { decodeTimelineAudio, processedTrack, trackLoudness, type AudioKind } from '../export/audio-mix';

export function loudnessInputs(project: Project, kind: AudioKind): string {
  const { highpassHz, compressor, gate } = project.audio[kind];
  const sources = Object.values(project.recordings).map((r) => [r.id, r.sources[kind]?.file, r.sources[kind]?.startOffset, r.syncOffsets[kind]]);
  return JSON.stringify([highpassHz, compressor, gate, project.sequence.segments, sources]);
}

export async function measureChannelLoudness(project: Project, kind: AudioKind, mediaBase: string, signal?: AbortSignal): Promise<number | null> {
  const decoded = await decodeTimelineAudio(project, mediaBase, [kind], signal);
  if (!decoded || signal?.aborted) return null;
  const lufs = trackLoudness(processedTrack(project, kind, decoded));
  return lufs === null ? null : Math.round(lufs * 10) / 10;
}
