import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_RECORDER_PREFS, type BackendInfo, type CaptureConfig, type PermissionInfo, type PermissionStatus, type RecorderPrefs, type SourceInfo } from '@momotombo/protocol';
import type { DiskEstimate } from '../../shared/recording-budget';
import { api } from '../api';
import { inputProblem, micConstraints, resolveDeviceId, type InputProblem } from '../recorder-inputs';
import { streamReadings, useMicMeter } from '../use-mic-meter';
import { Badge, Button, IconButton, Segmented, Select, Toggle } from '../ui/controls';
import { Icon } from '../ui/icons';
import { keyLabel, RECORDING_KEYS } from '../ui/keys';
import { t } from '../i18n';

type Kind = 'display' | 'window' | 'region';
interface Region { x: number; y: number; w: number; h: number }
type OpenState = 'opening' | 'open' | 'failed';

function openFailure(e: unknown): { permission?: PermissionStatus } {
  const name = (e as DOMException).name;
  return name === 'NotAllowedError' || name === 'SecurityError' ? { permission: 'denied' } : {};
}

function useDevices(kind: 'videoinput' | 'audioinput', enabled: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(all.filter((d) => d.kind === kind && d.deviceId));
  }, [kind]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [enabled, refresh]);
  return { devices, refresh };
}

export function NewRecording(props: { initialKind?: Kind; onBack: () => void; onStarted: () => void }) {
  const [kind, setKind] = useState<Kind>(props.initialKind ?? 'display');
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [perms, setPerms] = useState<PermissionInfo | null>(null);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [backend, setBackend] = useState<'auto' | 'native' | 'web'>('auto');
  const [prefs, setPrefs] = useState<RecorderPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [camState, setCamState] = useState<OpenState>('opening');
  const [micState, setMicState] = useState<OpenState>('opening');
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [disk, setDisk] = useState<DiskEstimate | null>(null);
  const camVideo = useRef<HTMLVideoElement>(null);
  const streams = useRef<MediaStream[]>([]);
  const p = prefs ?? DEFAULT_RECORDER_PREFS;
  const { cameraOn, micOn, systemAudio, fps, quality, countdown } = p;
  const cams = useDevices('videoinput', !!prefs && cameraOn);
  const mics = useDevices('audioinput', !!prefs && micOn);
  const cameraId = resolveDeviceId(cams.devices, p.cameraDeviceId);
  const micId = resolveDeviceId(mics.devices, p.micDeviceId);

  useEffect(() => { void api.recorderPrefs().then(setPrefs, () => setPrefs(DEFAULT_RECORDER_PREFS)); }, []);
  const remember = useCallback((patch: Partial<RecorderPrefs>) => {
    setPrefs((cur) => ({ ...(cur ?? DEFAULT_RECORDER_PREFS), ...patch }));
    void api.setRecorderPrefs(patch).catch(() => undefined);
  }, []);

  const loadSources = useCallback(async () => {
    setSources(null);
    try {
      const list = await api.sources();
      setSources(list);
      setPerms(await api.permissions());
    } catch (e) {
      // Without screen recording permission the system refuses the list. Show the permission note
      // instead of loading forever; any other failure is reported as it is.
      setSources([]);
      const p = await api.permissions().catch(() => null);
      setPerms(p);
      if (p?.screen === 'granted') setError(t("No se pudieron cargar las fuentes: {msg}", { msg: (e as Error).message }));
    }
  }, []);

  useEffect(() => {
    void loadSources();
    void api.backends().then(setBackends);
  }, [loadSources]);

  const visible = (sources ?? []).filter((s) => (kind === 'window' ? s.kind === 'window' : s.kind === 'display'));
  useEffect(() => {
    if (!visible.some((s) => s.id === selected)) setSelected(visible[0]?.id ?? null);
  }, [kind, sources]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopPreviews = () => {
    for (const s of streams.current) for (const t of s.getTracks()) t.stop();
    streams.current = [];
  };

  // The preview keeps the camera on until the recorder has opened and warmed it up, so the
  // device never switches off between preview and recording. If the recorder cannot open a
  // device the preview holds (exclusive cameras on Windows), it asks us to let go.
  useEffect(() => {
    const offState = api.onCaptureState((s) => {
      if (s.devicesReady || s.phase === 'recording') stopPreviews();
      if (s.phase === 'error' || s.phase === 'idle') setStarting(false);
    });
    const offRelease = api.onReleaseDevices(stopPreviews);
    return () => { offState(); offRelease(); };
  }, []);

  // Camera preview (released before recording so the capture backend can open the device).
  useEffect(() => {
    if (!prefs || !cameraOn) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setCamState('opening');
    void navigator.mediaDevices.getUserMedia({ video: cameraId ? { deviceId: { exact: cameraId }, width: { ideal: 640 } } : { width: { ideal: 640 } } })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        streams.current.push(s);
        if (camVideo.current) camVideo.current.srcObject = s;
        void cams.refresh();
        setCamState('open');
        // The preview runs, so access was granted (perhaps just now, in the system's own dialog).
        setPerms((p) => (p ? { ...p, camera: 'granted' } : p));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        void cams.refresh();
        setCamState('failed');
        const f = openFailure(e);
        if (f.permission) setPerms((p) => (p ? { ...p, camera: 'denied' } : p));
      });
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [!!prefs, cameraOn, cameraId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened exactly as the recording opens it, so the meter shows the level that gets recorded.
  useEffect(() => {
    if (!prefs || !micOn) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setMicState('opening');
    void navigator.mediaDevices.getUserMedia(micConstraints(micId)).then((s) => {
      if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      streams.current.push(s);
      setMicStream(s);
      setMicState('open');
      void mics.refresh();
      setPerms((p) => (p ? { ...p, microphone: 'granted' } : p));
    }).catch((e: unknown) => {
      if (cancelled) return;
      void mics.refresh();
      setMicState('failed');
      if (openFailure(e).permission) setPerms((p) => (p ? { ...p, microphone: 'denied' } : p));
    });
    return () => { cancelled = true; setMicStream(null); stream?.getTracks().forEach((t) => t.stop()); };
  }, [!!prefs, micOn, micId]); // eslint-disable-line react-hooks/exhaustive-deps

  const native = backends.find((b) => b.id === 'native-macos' || b.id === 'native-windows');
  const effective = backend === 'web' || (backend === 'auto' && !native?.available) ? backends.find((b) => b.id === 'web') : native;
  const systemAudioSupported = !!effective?.capabilities.systemAudio;
  const source = visible.find((s) => s.id === selected);
  const camProblem = camState === 'opening' ? null : inputProblem({ on: cameraOn, permission: perms?.camera ?? 'unknown', deviceId: cameraId, openFailed: camState === 'failed' });
  const micProblem = micState === 'opening' ? null : inputProblem({ on: micOn, permission: perms?.microphone ?? 'unknown', deviceId: micId, openFailed: micState === 'failed' });
  const devicesPending = (cameraOn && camState === 'opening') || (micOn && micState === 'opening');

  const config = useMemo((): CaptureConfig | null => {
    if (!source) return null;
    const cam = cams.devices.find((d) => d.deviceId === cameraId);
    const mic = mics.devices.find((d) => d.deviceId === micId);
    const r = kind === 'region' && region && source.bounds
      ? { x: Math.round(region.x * source.bounds.w), y: Math.round(region.y * source.bounds.h), w: Math.round(region.w * source.bounds.w), h: Math.round(region.h * source.bounds.h) }
      : undefined;
    return {
      target: { kind, sourceId: source.id, displayId: source.displayId, label: source.name, ...(r ? { region: r } : {}) },
      cameraDeviceId: cameraOn && cam ? cam.deviceId : null,
      cameraLabel: cameraOn && cam ? cam.label : null,
      micDeviceId: micOn && mic ? mic.deviceId : null,
      micLabel: micOn && mic ? mic.label : null,
      systemAudio: systemAudio && systemAudioSupported,
      fps, quality, countdown, backend,
    };
  }, [source, cams.devices, mics.devices, cameraId, micId, kind, region, cameraOn, micOn, systemAudio, systemAudioSupported, fps, quality, countdown, backend]);

  const estimateKey = config && JSON.stringify({ ...config, cameraLabel: null, micLabel: null, countdown: 0 });
  useEffect(() => {
    if (!config) return;
    let live = true;
    const run = () => void api.diskEstimate(config).then((d) => { if (live) setDisk(d); }, () => undefined);
    run();
    const timer = window.setInterval(run, 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [estimateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!config) return;
    setError(null);
    setStarting(true);
    try {
      props.onStarted();
      await api.startCapture(config);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  const inputNote = (device: 'camera' | 'microphone', problem: InputProblem, turnOff: () => void) => {
    const text = {
      camera: {
        permission: t("Momotombo no tiene permiso para usar la cámara. Permítelo en Ajustes del Sistema o graba sin cámara."),
        'no-device': t("No se encontró ninguna cámara. Conecta una o graba sin cámara."),
        unavailable: t("No se pudo abrir la cámara. Puede que otra app la esté usando: ciérrala, elige otra o graba sin cámara."),
      },
      microphone: {
        permission: t("Momotombo no tiene permiso para usar el micrófono. Permítelo en Ajustes del Sistema o graba sin micrófono."),
        'no-device': t("No se encontró ningún micrófono. Conecta uno o graba sin micrófono."),
        unavailable: t("No se pudo abrir el micrófono. Puede que otra app lo esté usando: ciérrala, elige otro o graba sin micrófono."),
      },
    }[device][problem];
    return (
      <div className="note is-error" role="alert"><Icon name="warning" size={14} />
        <div className="note-body">
          <span>{text}</span>
          <div className="note-actions">
            {problem === 'permission' && <button type="button" className="link" onClick={() => api.openPermissionSettings(device)}>{t("Abrir ajustes")}</button>}
            <button type="button" className="link" onClick={turnOff}>{device === 'camera' ? t("Grabar sin cámara") : t("Grabar sin micrófono")}</button>
          </div>
        </div>
      </div>
    );
  };

  const permRow = (label: string, key: keyof PermissionInfo, pane: 'screen' | 'camera' | 'microphone' | 'input') => {
    const st = perms?.[key] ?? 'unknown';
    const ok = st === 'granted';
    return (
      <div className="perm-row">
        <span className={`perm-dot is-${ok ? 'ok' : st === 'denied' ? 'bad' : 'unknown'}`} />
        <span>{label}</span>
        <small className="muted">{ok ? t("Permitido") : st === 'denied' ? t("Denegado") : st === 'not-determined' ? t("Sin preguntar") : t("Desconocido")}</small>
        {!ok && <button type="button" className="link" onClick={() => api.openPermissionSettings(pane)}>{t("Abrir ajustes")}</button>}
      </div>
    );
  };

  return (
    <div className="new-recording">
      <header className="page-head">
        <IconButton icon="back" label={t("Atrás")} onClick={() => { stopPreviews(); props.onBack(); }} />
        <h1>{t("Nueva grabación")}</h1>
      </header>
      <div className="nr-grid">
        <section className="nr-sources">
          <div className="nr-toolbar">
            <Segmented<Kind> value={kind} onChange={setKind} label={t("Tipo de grabación")}
              options={[{ value: 'display', label: t("Pantalla"), icon: 'screen' }, { value: 'window', label: t("Ventana"), icon: 'window' }, { value: 'region', label: t("Región"), icon: 'region' }]} />
            <IconButton icon="refresh" label={t("Actualizar fuentes")} onClick={() => void loadSources()} />
          </div>
          {sources === null && <div className="loading-line" />}
          {sources && visible.length === 0 && (
            <div className="note is-warning"><Icon name="warning" size={14} />
              {perms?.screen === 'denied'
                ? t("No hay permiso de grabación de pantalla. Activa Momotombo en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y audio del sistema y luego reinicia Momotombo. Si Momotombo ya aparece activado ahí (por ejemplo, después de una actualización), quítalo de la lista con \"–\" y vuelve a darle permiso.")
                : t("No se encontraron fuentes. En macOS quizá debas dar acceso en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y audio del sistema.")}
              <button type="button" className="link" onClick={() => api.openPermissionSettings('screen')}>{t("Abrir ajustes")}</button>
              {perms?.screen === 'denied' && <button type="button" className="link" onClick={() => void api.relaunch()}>{t("Reiniciar")}</button>}
            </div>
          )}
          {kind === 'region' && source ? (
            <RegionPicker source={source} region={region} onChange={setRegion} others={visible} onSelect={setSelected} />
          ) : (
            <div className="source-grid">
              {visible.map((s) => (
                <button key={s.id} type="button" className={`source-card${s.id === selected ? ' is-on' : ''}`} onClick={() => setSelected(s.id)}>
                  <span className="source-thumb">{s.thumbnail ? <img src={s.thumbnail} alt="" /> : <Icon name={s.kind === 'window' ? 'window' : 'screen'} size={28} />}</span>
                  <span className="source-name">{s.appIcon && <img src={s.appIcon} alt="" className="app-icon" />}{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="nr-side">
          <div className="nr-card">
            <header><Icon name="camera" size={16} /><strong>{t("Cámara")}</strong><Toggle label={t("Grabar la cámara")} hideLabel checked={cameraOn} onChange={(v) => remember({ cameraOn: v })} /></header>
            {cameraOn && (
              <>
                <div className="cam-preview"><video ref={camVideo} autoPlay muted playsInline /></div>
                {camProblem && inputNote('camera', camProblem, () => remember({ cameraOn: false }))}
                {cams.devices.length > 0 && <Select label={t("Dispositivo")} value={cameraId ?? ''} onChange={(id) => remember({ cameraDeviceId: id })} options={cams.devices.map((d) => ({ value: d.deviceId, label: d.label || t("Cámara") }))} />}
                <p className="muted small">{t("La cámara se graba aparte de la pantalla; su posición y forma se pueden cambiar después.")}</p>
              </>
            )}
          </div>
          <div className="nr-card">
            <header><Icon name="mic" size={16} /><strong>{t("Micrófono")}</strong><Toggle label={t("Grabar el micrófono")} hideLabel checked={micOn} onChange={(v) => remember({ micOn: v })} /></header>
            {micOn && (
              <>
                {micProblem && inputNote('microphone', micProblem, () => remember({ micOn: false }))}
                {mics.devices.length > 0 && <Select label={t("Dispositivo")} value={micId ?? ''} onChange={(id) => remember({ micDeviceId: id })} options={mics.devices.map((d) => ({ value: d.deviceId, label: d.label || t("Micrófono") }))} />}
                {micStream && <MicLevel stream={micStream} />}
              </>
            )}
          </div>
          <div className="nr-card">
            <header><Icon name="speaker" size={16} /><strong>{t("Audio del sistema")}</strong><Toggle label={t("Grabar el audio del sistema")} hideLabel checked={systemAudio && systemAudioSupported} disabled={!systemAudioSupported} onChange={(v) => remember({ systemAudio: v })} /></header>
            {!systemAudioSupported && (
              <p className="muted small">
                {window.momotombo.platform === 'darwin'
                  ? t("En macOS, esta versión no puede grabar el audio de la computadora. El micrófono, la cámara y la grabación de pantalla funcionan con normalidad.")
                  : t("Con este método de grabación no se puede capturar el audio de la computadora.")}
              </p>
            )}
          </div>
          <div className="nr-card">
            <header><Icon name="sliders" size={16} /><strong>{t("Calidad")}</strong></header>
            <Segmented<'30' | '60'> size="sm" label={t("Fotogramas por segundo")} value={String(fps) as '30' | '60'} onChange={(v) => remember({ fps: Number(v) as 30 | 60 })} options={[{ value: '30', label: t("30 fps") }, { value: '60', label: t("60 fps") }]} />
            <Segmented<'standard' | 'high' | 'max'> size="sm" label={t("Calidad")} value={quality} onChange={(v) => remember({ quality: v })} options={[{ value: 'standard', label: t("Estándar") }, { value: 'high', label: t("Alta") }, { value: 'max', label: t("Máxima") }]} />
            <Segmented<'0' | '3' | '5'> size="sm" label={t("Cuenta regresiva")} value={String(countdown) as '0' | '3' | '5'} onChange={(v) => remember({ countdown: Number(v) as 0 | 3 | 5 })} options={[{ value: '0', label: t("Ninguna") }, { value: '3', label: t("3 s") }, { value: '5', label: t("5 s") }]} />
            <DiskLine disk={disk} />
          </div>
          <div className="nr-card">
            <header><Icon name="info" size={16} /><strong>{t("Método de grabación")}</strong></header>
            <Segmented<'auto' | 'native' | 'web'> size="sm" label={t("Método")} value={backend} onChange={setBackend}
              options={[{ value: 'auto', label: t("Automático") }, { value: 'native', label: t("Nativo") }, { value: 'web', label: t("Alternativo") }]} />
            <div className="backend-info">
              {effective && (
                <>
                  <Badge tone={effective.id === 'web' ? 'warning' : 'success'}>{effective.id === 'web' ? t("Grabación alternativa del navegador") : t("Grabación nativa")}</Badge>
                  <ul className="caps">
                    <li className={effective.capabilities.separateCursor ? 'ok' : ''}>{t("Cursor grabado aparte")}</li>
                    <li className={effective.capabilities.clicks ? 'ok' : ''}>{t("Datos de clics (zoom automático)")}</li>
                    <li className={effective.capabilities.systemAudio ? 'ok' : ''}>{t("Audio del sistema")}</li>
                  </ul>
                </>
              )}
              {native && !native.available && <p className="muted small">{native.reason && t(native.reason)}</p>}
            </div>
          </div>
          {window.momotombo.platform === 'darwin' && (
            <div className="nr-card perms">
              <header><Icon name="shield" size={16} /><strong>{t("Permisos")}</strong></header>
              {permRow(t("Grabación de pantalla"), 'screen', 'screen')}
              {permRow(t("Cámara"), 'camera', 'camera')}
              {permRow(t("Micrófono"), 'microphone', 'microphone')}
            </div>
          )}
          {error && <p className="note is-error"><Icon name="warning" size={14} />{error}</p>}
          <Button variant="record" size="lg" icon="record" wide onClick={start} disabled={!config || starting || (kind === 'region' && !region) || !!camProblem || !!micProblem || devicesPending || disk?.level === 'insufficient'}>
            {starting ? t("Preparando la cámara y la grabación…") : t("Iniciar grabación")}
          </Button>
          <p className="muted small center">{t("Durante la grabación:")} <kbd className="kbd">{keyLabel(RECORDING_KEYS.stop)}</kbd> {t("finalizar ·")} <kbd className="kbd">{keyLabel(RECORDING_KEYS.pause)}</kbd> {t("pausar ·")} <kbd className="kbd">{keyLabel(RECORDING_KEYS.mark)}</kbd> {t("marca")}</p>
        </aside>
      </div>
    </div>
  );
}

function MicLevel(props: { stream: MediaStream }) {
  const source = useMemo(() => streamReadings(props.stream), [props.stream]);
  const m = useMicMeter(source);
  return (
    <>
      <div className="meter-row">
        <div className="meter" role="img" aria-label={t("Nivel del micrófono")}>
          <span className="meter-fill" ref={m.fill} />
          <span className="meter-hold" ref={m.hold} />
        </div>
        <span className={`meter-clip${m.clipping ? ' is-on' : ''}`} title={t("Saturación: el sonido llega al máximo y se distorsiona. Aleja el micrófono o baja su volumen.")}>{t("SAT")}</span>
      </div>
      <div className="meter-scale mono" aria-hidden="true"><span>-60</span><span>-40</span><span>-20</span><span>0 dB</span></div>
      {m.silent && <p className="note is-warning" role="status"><Icon name="warning" size={14} />{t("El micrófono no capta sonido. Revisa que no esté silenciado o elige otro dispositivo.")}</p>}
    </>
  );
}

function recordingTime(minutes: number): string {
  return minutes >= 120 ? t("unas {n} h", { n: Math.floor(minutes / 60) }) : t("unos {n} min", { n: minutes });
}

function DiskLine(props: { disk: DiskEstimate | null }) {
  const d = props.disk;
  if (!d || d.level === 'unknown' || d.minutesLeft === null) return null;
  if (d.level === 'insufficient') return <p className="note is-error" role="alert"><Icon name="warning" size={14} />{t("No hay espacio suficiente en disco para grabar con esta calidad. Libera espacio o baja la calidad.")}</p>;
  if (d.level === 'low') return <p className="note is-warning"><Icon name="warning" size={14} />{t("Queda poco espacio en disco: {time} de grabación con esta calidad.", { time: recordingTime(d.minutesLeft) })}</p>;
  return <p className="muted small">{t("Espacio en disco para {time} de grabación con esta calidad.", { time: recordingTime(d.minutesLeft) })}</p>;
}

function RegionPicker(props: { source: SourceInfo; region: Region | null; onChange: (r: Region | null) => void; others: SourceInfo[]; onSelect: (id: string) => void }) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [lock, setLock] = useState<'free' | '16:9' | '9:16' | '1:1'>('16:9');
  const ref = useRef<HTMLDivElement>(null);
  const b = props.source.bounds;
  const displayAspect = b ? b.w / b.h : 16 / 9;
  const ratio = lock === 'free' ? null : lock === '16:9' ? 16 / 9 : lock === '9:16' ? 9 / 16 : 1;
  const pt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const update = (a: { x: number; y: number }, c: { x: number; y: number }) => {
    let w = Math.abs(c.x - a.x);
    let h = Math.abs(c.y - a.y);
    if (ratio) {
      // Normalized units: width fraction × display aspect = pixel aspect.
      const want = ratio / displayAspect;
      if (w / Math.max(h, 1e-6) > want) w = h * want; else h = w / want;
    }
    const x = c.x >= a.x ? a.x : a.x - w;
    const y = c.y >= a.y ? a.y : a.y - h;
    props.onChange({ x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) });
  };
  return (
    <div className="region-picker">
      <div className="nr-toolbar">
        <Select label={t("Pantalla")} value={props.source.id} onChange={props.onSelect} options={props.others.map((s) => ({ value: s.id, label: s.name }))} />
        <Segmented<'free' | '16:9' | '9:16' | '1:1'> size="sm" label={t("Proporción")} value={lock} onChange={setLock}
          options={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }, { value: 'free', label: t("Libre") }]} />
      </div>
      <div
        ref={ref}
        className="region-canvas"
        style={{ aspectRatio: String(displayAspect) }}
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); const p = pt(e); setDrag(p); props.onChange({ x: p.x, y: p.y, w: 0, h: 0 }); }}
        onPointerMove={(e) => { if (drag) update(drag, pt(e)); }}
        onPointerUp={() => { setDrag(null); if (props.region && (props.region.w < 0.02 || props.region.h < 0.02)) props.onChange(null); }}
      >
        {props.source.thumbnail && <img src={props.source.thumbnail} alt="" draggable={false} />}
        {props.region && (
          <span className="region-rect" style={{ left: `${props.region.x * 100}%`, top: `${props.region.y * 100}%`, width: `${props.region.w * 100}%`, height: `${props.region.h * 100}%` }}>
            {b && <small className="mono">{Math.round(props.region.w * b.w)}×{Math.round(props.region.h * b.h)}</small>}
          </span>
        )}
        {!props.region && <span className="region-hint">{t("Arrastra para elegir el área que quieres grabar")}</span>}
      </div>
    </div>
  );
}
