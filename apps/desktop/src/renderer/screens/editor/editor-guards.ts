import { itemTimelineRanges, layoutSegments, type Project } from '@momotombo/project-model';
import type { EditorState } from '../../state/editor-store';

/** Editing shortcuts act on the project behind a modal; they are off while one is open. */
export function shortcutsBlocked(s: Pick<EditorState, 'exportOpen' | 'leaveBlocked'>): boolean {
  return s.exportOpen || s.leaveBlocked;
}

/** What the privacy check confirms: every privacy area and where it lands on the timeline. */
export function privacySignature(project: Project): string {
  const placements = layoutSegments(project);
  return JSON.stringify(project.privacy.map((item) => [item, itemTimelineRanges(project, item, placements)]));
}

export function privacyConfirmed(project: Project, confirmedFor: string | null): boolean {
  return project.privacy.length === 0 || confirmedFor === privacySignature(project);
}
