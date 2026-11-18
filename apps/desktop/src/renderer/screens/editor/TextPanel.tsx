import { useEffect, useState } from 'react';
import {
  TEXT_ANCHORS, TEXT_ANIMATION_KINDS, TEXT_LIMITS, TEXT_PRESET_IDS, TEXT_WEIGHTS, applyTextPreset, removeText, updateTextLook,
  type TextAlign, type TextAnchor, type TextAnimation, type TextAnimationKind, type TextItem, type TextLookPatch, type TextPresetId,
} from '@momotombo/project-model';
import { TICKS_PER_SECOND, formatTimecode, secondsToTicks, ticksToSeconds } from '@momotombo/timing';
import type { EditorStore } from '../../state/editor-store';
import { Button, ColorInput, Segmented, Select, Slider, Toggle } from '../../ui/controls';
import { t } from '../../i18n';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const em = (v: number) => `${v.toFixed(2)} em`;

const presetName = (id: TextPresetId) => ({
  title: t("Título"), 'lower-third': t("Rótulo inferior"), caption: t("Subtítulo"), callout: t("Llamada"), chapter: t("Capítulo"),
})[id];

const animationName = (k: TextAnimationKind) => ({
  none: t("Ninguna"), fade: t("Fundido"), 'slide-up': t("Deslizar hacia arriba"), 'slide-down': t("Deslizar hacia abajo"),
  'slide-left': t("Deslizar a la izquierda"), 'slide-right': t("Deslizar a la derecha"), pop: t("Rebote"), typewriter: t("Máquina de escribir"),
})[k];

const anchorName = (a: TextAnchor) => ({
  'top-left': t("Arriba a la izquierda"), top: t("Arriba"), 'top-right': t("Arriba a la derecha"), left: t("Izquierda"), center: t("Centro"),
  right: t("Derecha"), 'bottom-left': t("Abajo a la izquierda"), bottom: t("Abajo"), 'bottom-right': t("Abajo a la derecha"),
})[a];

function AnimationField({ label, value, onChange }: { label: string; value: TextAnimation; onChange: (a: TextAnimation, commit?: boolean) => void }) {
  return (
    <div className="field-group">
      <Select<TextAnimationKind> label={label} value={value.kind} options={TEXT_ANIMATION_KINDS.map((k) => ({ value: k, label: animationName(k) }))}
        onChange={(kind) => onChange({ kind, duration: value.duration || secondsToTicks(0.4) }, true)} />
      {value.kind !== 'none' && (
        <Slider label={t("Duración")} value={value.duration / TICKS_PER_SECOND} min={0.1} max={ticksToSeconds(TEXT_LIMITS.animation.max)} step={0.05} format={(v) => t("{n} s", { n: v.toFixed(2) })}
          onChange={(v) => onChange({ ...value, duration: secondsToTicks(v) })} />
      )}
    </div>
  );
}

export function TextPanel({ store, item, onClose }: { store: EditorStore; item: TextItem; onClose: () => void }) {
  const L = TEXT_LIMITS;
  const set = (patch: TextLookPatch, commit = false) =>
    store.apply((p) => updateTextLook(p, item.id, patch), commit ? {} : { coalesce: `t-${item.id}` });
  const [draft, setDraft] = useState(item.text);
  useEffect(() => setDraft(item.text), [item.text]);
  const writeText = (text: string) => {
    setDraft(text);
    if (text.trim() !== '') set({ text });
  };
  const bg = item.background;
  const stroke = item.stroke;
  const shadow = item.shadow;
  return (
    <div className="selected-panel">
      <header><span className="dot" style={{ background: 'var(--track-text)' }} /><strong>{t("Texto")}</strong><button className="link" onClick={onClose}>{t("Cerrar")}</button></header>
      <span className="muted mono">{formatTimecode(item.start)} – {formatTimecode(item.end)} · {t("{n} s", { n: ((item.end - item.start) / TICKS_PER_SECOND).toFixed(1) })}</span>
      <label className="field-label" htmlFor={`text-${item.id}`}>{t("Texto")}</label>
      <textarea id={`text-${item.id}`} className="text-area" value={draft} maxLength={L.length} rows={3}
        onChange={(e) => writeText(e.target.value)} onBlur={() => { setDraft(item.text); store.endGesture(); }} />
      <Select<TextPresetId | ''> label={t("Estilo predefinido")} value=""
        options={[{ value: '', label: t("Elegir…") }, ...TEXT_PRESET_IDS.map((id) => ({ value: id, label: presetName(id) }))]}
        onChange={(id) => { if (id) store.apply((p) => applyTextPreset(p, item.id, id)); }} />
      <Slider label={t("Posición horizontal")} value={item.position.x} min={0} max={1} format={pct} onChange={(x) => set({ position: { x } })} />
      <Slider label={t("Posición vertical")} value={item.position.y} min={0} max={1} format={pct} onChange={(y) => set({ position: { y } })} />
      <Select<TextAnchor> label={t("Punto de anclaje")} value={item.anchor} options={TEXT_ANCHORS.map((a) => ({ value: a, label: anchorName(a) }))} onChange={(anchor) => set({ anchor }, true)} />
      <Segmented<TextAlign> size="sm" label={t("Alineación")} value={item.align}
        options={[{ value: 'left', label: t("Izquierda") }, { value: 'center', label: t("Centro") }, { value: 'right', label: t("Derecha") }]}
        onChange={(align) => set({ align }, true)} />
      <Slider label={t("Tamaño")} value={item.fontSize} min={L.fontSize.min} max={L.fontSize.max} step={0.002} format={pct} onChange={(fontSize) => set({ fontSize })} />
      <Select<string> label={t("Grosor")} value={String(item.fontWeight)} options={TEXT_WEIGHTS.map((w) => ({ value: String(w), label: String(w) }))}
        onChange={(w) => set({ fontWeight: Number(w) as TextItem['fontWeight'] }, true)} />
      <Slider label={t("Ancho máximo")} value={item.maxWidth} min={L.maxWidth.min} max={L.maxWidth.max} format={pct} onChange={(maxWidth) => set({ maxWidth })} />
      <ColorInput label={t("Color")} value={item.color} onChange={(color) => set({ color })} />
      <Toggle label={t("Fondo")} checked={!!bg} onChange={(on) => set({ background: on ? { color: '#111318', opacity: 0.8, padding: 0.45, radius: 0.25 } : null }, true)} />
      {bg && (
        <>
          <ColorInput label={t("Color del fondo")} value={bg.color} onChange={(color) => set({ background: { color } })} />
          <Slider label={t("Opacidad del fondo")} value={bg.opacity} min={0} max={1} format={pct} onChange={(opacity) => set({ background: { opacity } })} />
          <Slider label={t("Margen interior")} value={bg.padding} min={L.padding.min} max={L.padding.max} format={em} onChange={(padding) => set({ background: { padding } })} />
          <Slider label={t("Radio de las esquinas")} value={bg.radius} min={L.radius.min} max={L.radius.max} format={em} onChange={(radius) => set({ background: { radius } })} />
        </>
      )}
      <Toggle label={t("Contorno")} checked={!!stroke} onChange={(on) => set({ stroke: on ? { color: '#000000', width: 0.06 } : null }, true)} />
      {stroke && (
        <>
          <ColorInput label={t("Color del contorno")} value={stroke.color} onChange={(color) => set({ stroke: { color } })} />
          <Slider label={t("Grosor del contorno")} value={stroke.width} min={L.stroke.min} max={L.stroke.max} format={em} onChange={(width) => set({ stroke: { width } })} />
        </>
      )}
      <Toggle label={t("Sombra")} checked={!!shadow} onChange={(on) => set({ shadow: on ? { color: '#000000', opacity: 0.45, blur: 0.25, offsetY: 0.05 } : null }, true)} />
      {shadow && <Slider label={t("Opacidad de la sombra")} value={shadow.opacity} min={0} max={1} format={pct} onChange={(opacity) => set({ shadow: { opacity } })} />}
      <AnimationField label={t("Entrada")} value={item.enter} onChange={(enter, c) => set({ enter }, c)} />
      <AnimationField label={t("Salida")} value={item.exit} onChange={(exit, c) => set({ exit }, c)} />
      <Button icon="trash" variant="ghost" size="sm" onClick={() => store.apply((p) => removeText(p, item.id))}>{t("Eliminar texto")}</Button>
    </div>
  );
}
