import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CaptureState } from '@momotombo/protocol';
import { api } from './api';
import { initI18n, t, useLang } from './i18n';
import { Icon } from './ui/icons';
import { keyLabel, RECORDING_KEYS } from './ui/keys';
import { useMicMeter, type ReadingSource } from './use-mic-meter';
import './styles/tokens.css';
import './styles/hud.css';

const LOW_DISK_MINUTES = 10;

function stateReadings(): ReadingSource {
  return (push) => api.onCaptureState((s) => {
    if (s.hasMic && (s.phase === 'recording' || s.phase === 'paused')) push({ rms: s.micLevel, peak: s.micPeak });
  });
}

function HudMeter() {
  const source = useMemo(stateReadings, []);
  const m = useMicMeter(source);
  const label = m.silent ? t("El micrófono no capta sonido") : m.clipping ? t("El micrófono se satura") : t("Nivel del micrófono");
  return (
    <span className={`level-wrap${m.silent ? ' is-silent' : ''}${m.clipping ? ' is-clipping' : ''}`} title={label}>
      <span className="level" ref={m.bar} role="meter" aria-label={t("Nivel del micrófono")} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={-60}>
        <span className="level-fill" ref={m.fill} />
        <span className="level-hold" ref={m.hold} />
      </span>
      <span role="status" className="level-status">
        {m.clipping && <span className="hud-badge is-danger" title={label}>{t("SAT")}</span>}
        {m.silent && <span className="hud-badge is-warning" title={label}>{t("Sin sonido")}</span>}
      </span>
    </span>
  );
}

function Hud() {
  useLang();
  const [s, setS] = useState<CaptureState | null>(null);
  useEffect(() => {
    void api.captureState().then(setS);
    return api.onCaptureState(setS);
  }, []);
  if (!s) return null;
  if (s.phase === 'countdown') {
    return (
      <div className="hud hud-countdown drag">
        <span className="count" key={s.countdown}>{s.countdown}</span>
        <span>{t("La grabación empieza")}</span>
        <button type="button" className="hud-btn no-drag" onClick={() => void api.cancelCapture()} title={t("Cancelar")}><Icon name="close" size={16} /></button>
      </div>
    );
  }
  const sec = Math.floor(s.elapsedMs / 1000);
  const time = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const paused = s.phase === 'paused';
  return (
    <div className={`hud drag${paused ? ' is-paused' : ''}`}>
      <span className="rec-dot" />
      <span className="time mono">{time}</span>
      {s.hasMic && <HudMeter />}
      {s.droppedFrames > 0 && (
        <span className="hud-badge is-warning" title={t("Se perdieron {n} fotogramas: el equipo no da abasto. Cierra otras apps o baja la calidad o los fps.", { n: s.droppedFrames })}>
          <Icon name="warning" size={12} />{s.droppedFrames}
        </span>
      )}
      {s.diskMinutesLeft !== null && s.diskMinutesLeft < LOW_DISK_MINUTES && (
        <span className="hud-badge is-danger" title={t("Queda poco espacio en disco; la grabación se detendrá sola antes de llenarlo.")}>
          {t("Disco: {n} min", { n: s.diskMinutesLeft })}
        </span>
      )}
      <span className="sep" />
      {paused
        ? <button type="button" className="hud-btn no-drag" onClick={() => void api.resumeCapture()} title={t("Reanudar ({key})", { key: keyLabel(RECORDING_KEYS.pause) })}><Icon name="play" size={16} /></button>
        : <button type="button" className="hud-btn no-drag" onClick={() => void api.pauseCapture()} title={t("Pausar ({key})", { key: keyLabel(RECORDING_KEYS.pause) })} disabled={s.phase !== 'recording'}><Icon name="pause" size={16} /></button>}
      <button type="button" className="hud-btn no-drag" onClick={() => void api.markCapture()} title={t("Añadir marca ({key})", { key: keyLabel(RECORDING_KEYS.mark) })} disabled={s.phase !== 'recording'}><Icon name="marker" size={16} /></button>
      <button type="button" className="hud-btn stop no-drag" onClick={() => void api.stopCapture()} title={t("Finalizar ({key})", { key: keyLabel(RECORDING_KEYS.stop) })} disabled={s.phase === 'finishing'}><Icon name="stop" size={16} /><span>{t("Finalizar")}</span></button>
      <button type="button" className="hud-btn no-drag" onClick={() => void api.cancelCapture()} title={t("Cancelar")} disabled={s.phase === 'finishing'}><Icon name="close" size={15} /></button>
    </div>
  );
}

void initI18n().finally(() => createRoot(document.getElementById('root')!).render(<StrictMode><Hud /></StrictMode>));
