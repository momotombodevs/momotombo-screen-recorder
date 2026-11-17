import { applyZoomSuggestions, clearAutoZooms, parseCursorLog, type Project } from '@momotombo/project-model';
import { ENGINE_VERSION, combineNoSuggestionReasons, suggestZooms, whyNoSuggestions, type NoSuggestionReason } from '@momotombo/zoom-engine';
import type { EditorStore } from '../../state/editor-store';
import { t } from '../../i18n';

export interface ZoomRun {
  /** Suggestions made. */
  count: number;
  /** Why there are none, when there are none. */
  reason: NoSuggestionReason | null;
}

/** Runs the zoom engine for every recording that has a cursor log. Returns the number of suggestions. */
export async function regenerateZoomSuggestions(store: EditorStore): Promise<number> {
  return (await runZoomSuggestions(store)).count;
}

/** Runs the zoom engine for every recording that has a cursor log, and says why if nothing came out. */
export async function runZoomSuggestions(store: EditorStore): Promise<ZoomRun> {
  const project = store.project;
  const results: { recordingId: string; items: ReturnType<typeof suggestZooms> }[] = [];
  const reasons: NoSuggestionReason[] = [];
  for (const rec of Object.values(project.recordings)) {
    const text = await store.rawCursorText(rec.id);
    if (!text) { reasons.push('no-cursor'); continue; }
    const track = parseCursorLog(text);
    const items = suggestZooms({
      recordingId: rec.id,
      duration: rec.duration,
      track,
      hasClicks: rec.capture.hasClicks,
      markers: rec.markers,
      sensitivity: project.zoomEngine.sensitivity,
      defaults: project.style.zoomDefaults,
    });
    results.push({ recordingId: rec.id, items });
    if (items.length === 0) reasons.push(whyNoSuggestions(track, rec.capture.hasClicks));
  }
  let count = 0;
  store.apply((p: Project) => {
    let next = p;
    for (const r of results) {
      next = applyZoomSuggestions(next, r.recordingId, r.items);
      count += r.items.length;
    }
    return { ...next, zoomEngine: { ...next.zoomEngine, engineVersion: ENGINE_VERSION } };
  });
  return { count, reason: count > 0 ? null : combineNoSuggestionReasons(reasons) };
}

/** What to tell the user when a run made no suggestions. */
export function noSuggestionMessage(reason: NoSuggestionReason): string {
  switch (reason) {
    case 'outside': return t("Sin sugerencias: el cursor estuvo fuera de la pantalla grabada casi toda la grabación. Lo más probable es que se grabara una pantalla distinta de la que usabas. Puedes añadir zooms a mano.");
    case 'no-cursor': return t("Sin sugerencias: esta grabación no tiene datos del cursor.");
    case 'no-clicks': return t("Sin sugerencias: la grabación no tiene datos de clics y el cursor nunca se detuvo lo suficiente en ningún punto.");
    case 'quiet': return t("Sin sugerencias: no hay ningún momento en los movimientos del cursor que sirva para un zoom. Pon la sensibilidad en \"Alta\" e inténtalo de nuevo.");
  }
}

export function clearZoomSuggestions(store: EditorStore): void {
  store.apply((p) => {
    let next = p;
    for (const id of Object.keys(p.recordings)) next = clearAutoZooms(next, id);
    return next;
  });
}
