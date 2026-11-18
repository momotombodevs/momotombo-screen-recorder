import {
  DEFAULT_MAGNIFIER_DURATION, DEFAULT_TEXT_DURATION, TEXT_PRESETS, defaultPrivacyLook, laneRange, layoutSegments, newCameraMoveLayout, placeItem,
  presetTransition, timelineToSource, type ID, type NewByKey, type TextPresetId, type TrackKey, type Vec2,
} from '@momotombo/project-model';
import type { Ticks } from '@momotombo/timing';
import type { EditorStore, SelectionKind } from '../../state/editor-store';
import { t } from '../../i18n';

const KIND: Record<TrackKey, SelectionKind> = { zooms: 'zoom', privacy: 'privacy', cameraLayouts: 'camera', magnifiers: 'magnifier', texts: 'text' };

/** Adds an item through the placement rules and tells the user when it is refused. */
export function place<K extends TrackKey>(store: EditorStore, key: K, item: NewByKey[K]): boolean {
  const r = placeItem(store.project, key, item);
  if (!r.ok) {
    store.select({ kind: KIND[key], id: r.conflict.id });
    store.notify(key === 'privacy'
      ? t("Esta área ya se oculta en este momento. Seleccioné el área existente; puedes editarla o dibujar en otro lugar.")
      : key === 'zooms'
        ? t("Ya hay un zoom aquí. Los elementos no se pueden superponer; seleccioné el existente.")
        : key === 'magnifiers'
          ? t("Ya hay un intervalo de lupa aquí. Los elementos no se pueden superponer; se seleccionó el existente.")
          : t("Ya hay un movimiento de cámara aquí. Los elementos no se pueden superponer; seleccioné el existente."));
    return false;
  }
  store.apply(() => r.project);
  store.select({ kind: KIND[key], id: r.id });
  if (r.replacedSuggestions > 0) store.notify(t("Tu zoom reemplazó la sugerencia de zoom automático en este intervalo."));
  else if (r.trimmed) {
    store.notify(key === 'zooms' ? t("El nuevo zoom se acortó para que no choque con el siguiente elemento.") : key === 'privacy' ? t("La nueva área de privacidad se acortó para que no choque con el siguiente elemento.")
      : key === 'magnifiers' ? t("El nuevo intervalo de lupa se acortó para que no choque con el siguiente elemento.") : t("El nuevo movimiento de cámara se acortó para que no choque con el siguiente elemento."));
  }
  return true;
}

/** Where a privacy area added from the timeline starts; the user then moves it on the preview. */
export const DEFAULT_PRIVACY_REGION = { x: 0.4, y: 0.42, w: 0.2, h: 0.08 };

/** Adds a zoom, camera move, privacy area or magnifier range over a source range picked on the timeline (or at the playhead). */
export function placeRange(store: EditorStore, key: TrackKey, r: { recordingId: ID; start: Ticks; end: Ticks }): boolean {
  const p = store.project;
  if (key === 'privacy') {
    return place(store, 'privacy', {
      ...r, origin: 'manual', region: DEFAULT_PRIVACY_REGION, ...defaultPrivacyLook(),
    });
  }
  if (key === 'cameraLayouts') {
    const ok = place(store, 'cameraLayouts', { ...r, origin: 'manual', layout: newCameraMoveLayout(p), enter: presetTransition('smooth') });
    if (ok) store.notify(t("Movimiento de cámara añadido. Ahora elige la posición 2 en la vista previa."));
    return ok;
  }
  if (key === 'magnifiers') {
    const m = p.style.magnifier;
    return place(store, 'magnifiers', { ...r, origin: 'manual', size: m.size, zoom: m.zoom });
  }
  if (key === 'texts') return place(store, 'texts', newText(r));
  const d = p.style.zoomDefaults;
  return place(store, 'zooms', { ...r, origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.5 }, scale: d.scale, enter: d.enter, exit: d.exit });
}

/**
 * Adds a magnifier range at timeline time `at` (3 s, shortened to fit before the next one), or
 * selects the range already there.
 */
export function addMagnifierAt(store: EditorStore, at: Ticks): boolean {
  const p = store.project;
  const pos = timelineToSource(p, at, layoutSegments(p));
  if (!pos) return false;
  const here = p.magnifiers.find((m) => m.recordingId === pos.recordingId && m.start <= pos.sourceTime && pos.sourceTime < m.end);
  if (here) { store.select({ kind: 'magnifier', id: here.id }); return false; }
  const r = laneRange(p, 'magnifiers', at, at + DEFAULT_MAGNIFIER_DURATION);
  if (!r) { store.notify(t("Aquí no hay espacio para un nuevo intervalo de lupa.")); return false; }
  return placeRange(store, 'magnifiers', r);
}

export function newText(r: { recordingId: ID; start: Ticks; end: Ticks }, preset: TextPresetId = 'title', position?: Vec2): NewByKey['texts'] {
  const look = TEXT_PRESETS[preset];
  return { ...r, origin: 'manual', text: t("Escribe tu texto"), ...look, position: position ?? look.position };
}

export function addTextAt(store: EditorStore, at: Ticks, position?: Vec2): boolean {
  const r = laneRange(store.project, 'texts', at, at + DEFAULT_TEXT_DURATION);
  if (!r) { store.notify(t("Aquí no hay espacio para un nuevo texto.")); return false; }
  return place(store, 'texts', newText(r, 'title', position));
}
