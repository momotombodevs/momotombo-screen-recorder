import { useEffect, useState } from 'react';
import {
  TEXT_ANCHORS, TEXT_ANIMATION_KINDS, TEXT_LIMITS, TEXT_PRESETS, TEXT_PRESET_IDS, TEXT_WEIGHTS, removeText, updateText,
  type DeepPartial, type TextAlign, type TextAnchor, type TextAnimation, type TextAnimationKind, type TextItem, type TextPresetId,
} from '@momotombo/project-model';
import { TICKS_PER_SECOND, formatTimecode, secondsToTicks } from '@momotombo/timing';
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
        <Slider label={t("Duración")} value={value.duration / TICKS_PER_SECOND} min={0.1} max={2} step={0.05} format={(v) => t("{n} s", { n: v.toFixed(2) })}
          onChange={(v) => onChange({ ...value, duration: secondsToTicks(v) })} />
      )}
    </div>
  );
}

export function TextPanel({ store, item, onClose }: { store: EditorStore; item: TextItem; onClose: () => void }) {
  const L = TEXT_LIMITS;
  const set = (patch: DeepPartial<TextItem>, commit = false) =>
    store.apply((p) => updateText(p, item.id, patch), commit ? {} : { coalesce: `t-${item.id}` });
  const [draft, setDraft] = useState(item.text);
  useEffect(() => setDraft(item.text), [item.text]);
  const writeText = (text: string) => {
    setDraft(text);
    if (text.trim() !== '') set({ text });
  };
  const replace = (fn: (x: TextItem) => TextItem) => store.apply((p) => ({
    ...p, texts: p.texts.map((x) => (x.id === item.id ? { ...fn(x), origin: 'manual' } : x)),
  }));
  const applyPreset = (id: TextPresetId) => replace(({ background: _b, stroke: _s, shadow: _h, ...x }) => ({ ...x, ...TEXT_PRESETS[id] }));
  const toggle = <K extends 'background' | 'stroke' | 'shadow'>(key: K, on: TextItem[K]) => replace((x) => {
    const next: TextItem = { ...x, [key]: on };
    if (!on) delete next[key];
    return next;
  });
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
        onChange={(id) => { if (id) applyPreset(id); }} />
      <Slider label={t("Posición horizontal")} value={item.position.x} min={0} max={1} format={pct} onChange={(x) => set({ position: { x } })} />
      <Slider label={t("Posición vertical")} value={item.position.y} min={0} max={1} format={pct} onChange={(y) => set({ position: { y } })} />
      <Select<TextAnchor> label={t("Punto de anclaje")} value={item.anchor} options={TEXT_ANCHORS.map((a) => ({ value: a, label: anchorName(a) }))} onChange={(anchor) => set({ anchor }, true)} />
      <Segmented<TextAlign> size="sm" label={t("Alineación")} value={item.align}
        options={[{ value: 'left', label: t("Izquierda") }, { value: 'center', label: t("Centro") }, { value: 'right', label: t("Derecha") }]}
        onChange={(align) => set({ align }, true)} />
      <Slider label={t("Tamaño")} value={item.fontSize} min={0.02} max={0.2} step={0.002} format={pct} onChange={(fontSize) => set({ fontSize })} />
      <Select<string> label={t("Grosor")} value={String(item.fontWeight)} options={TEXT_WEIGHTS.map((w) => ({ value: String(w), label: String(w) }))}
        onChange={(w) => set({ fontWeight: Number(w) as TextItem['fontWeight'] }, true)} />
      <Slider label={t("Ancho máximo")} value={item.maxWidth} min={L.maxWidth.min} max={L.maxWidth.max} format={pct} onChange={(maxWidth) => set({ maxWidth })} />
      <ColorInput label={t("Color")} value={item.color} onChange={(color) => set({ color })} />
      <Toggle label={t("Fondo")} checked={!!bg} onChange={(on) => toggle('background', on ? { color: '#111318', opacity: 0.8, padding: 0.45, radius: 0.25 } : undefined)} />
      {bg && (
        <>
          <ColorInput label={t("Color del fondo")} value={bg.color} onChange={(color) => set({ background: { color } })} />
          <Slider label={t("Opacidad del fondo")} value={bg.opacity} min={0} max={1} format={pct} onChange={(opacity) => set({ background: { opacity } })} />
          <Slider label={t("Margen interior")} value={bg.padding} min={L.padding.min} max={1.2} format={em} onChange={(padding) => set({ background: { padding } })} />
          <Slider label={t("Radio de las esquinas")} value={bg.radius} min={L.radius.min} max={1} format={em} onChange={(radius) => set({ background: { radius } })} />
        </>
      )}
      <Toggle label={t("Contorno")} checked={!!stroke} onChange={(on) => toggle('stroke', on ? { color: '#000000', width: 0.06 } : undefined)} />
      {stroke && (
        <>
          <ColorInput label={t("Color del contorno")} value={stroke.color} onChange={(color) => set({ stroke: { color } })} />
          <Slider label={t("Grosor del contorno")} value={stroke.width} min={0.01} max={L.stroke.max} format={em} onChange={(width) => set({ stroke: { width } })} />
        </>
      )}
      <Toggle label={t("Sombra")} checked={!!shadow} onChange={(on) => toggle('shadow', on ? { color: '#000000', opacity: 0.45, blur: 0.25, offsetY: 0.05 } : undefined)} />
      {shadow && <Slider label={t("Opacidad de la sombra")} value={shadow.opacity} min={0} max={1} format={pct} onChange={(opacity) => set({ shadow: { opacity } })} />}
      <AnimationField label={t("Entrada")} value={item.enter} onChange={(enter, c) => set({ enter }, c)} />
      <AnimationField label={t("Salida")} value={item.exit} onChange={(exit, c) => set({ exit }, c)} />
      <Button icon="trash" variant="ghost" size="sm" onClick={() => store.apply((p) => removeText(p, item.id))}>{t("Eliminar texto")}</Button>
    </div>
  );
}
