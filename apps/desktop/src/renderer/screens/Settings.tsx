import { useEffect, useState } from 'react';
import type { AppInfo, BackendInfo, PermissionInfo } from '@momotombo/protocol';
import { APP_NAME, COPYRIGHT, DEVELOPER, LICENSE_NAME, WEBSITE_URL } from '../../shared/brand';
import type { LangSetting, SettingsInfo } from '../../shared/i18n';
import { api } from '../api';
import { Badge, Button, Kbd, Segmented } from '../ui/controls';
import { Icon } from '../ui/icons';
import { keyLabel, RECORDING_KEYS } from '../ui/keys';
import { LicensesSection } from './Licenses';
import { t } from '../i18n';

/** Display name of a BCP 47 tag in its own language, e.g. "es-NI" → "español (Nicaragua)". */
function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return name ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : tag;
  } catch {
    return tag;
  }
}

function LanguageSection() {
  const [s, setS] = useState<SettingsInfo | null>(null);
  useEffect(() => {
    void api.getSettings().then(setS);
    return api.onSettingsChanged(setS);
  }, []);
  if (!s) return null;
  const system = s.system[0];
  return (
    <section>
      <h2>{t("Idioma")}</h2>
      <p className="muted">{t("Al abrirse por primera vez, la app usa el idioma de tu computadora. Puedes cambiarlo cuando quieras.")}</p>
      <div className="lang-card">
        <Segmented<LangSetting> value={s.language} label={t("Idioma")}
          onChange={(language) => void api.setLanguage(language).then(setS)}
          options={[
            { value: 'auto', label: t("Automático") },
            { value: 'es', label: 'Español' },
            { value: 'en', label: 'English' },
          ]} />
        <p className="muted small">
          {system ? t("Idioma de la computadora: {name}", { name: languageName(system) }) : t("No se pudo detectar el idioma de la computadora.")}
          {s.language === 'auto' && <> · {t("Elección automática: {lang}", { lang: s.resolved === 'es' ? 'Español' : 'English' })}</>}
        </p>
      </div>
    </section>
  );
}

export function Settings({ embedded = false }: { embedded?: boolean }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [perms, setPerms] = useState<PermissionInfo | null>(null);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const refresh = () => {
    void api.appInfo().then(setInfo);
    void api.permissions().then(setPerms);
    void api.backends().then(setBackends);
  };
  useEffect(refresh, []);
  const label = (s?: string) => (s === 'granted' ? t("Permitido") : s === 'denied' ? t("Denegado") : s === 'not-determined' ? t("Aún sin preguntar") : s === 'restricted' ? t("Restringido") : t("Desconocido"));
  const tone = (s?: string) => (s === 'granted' ? 'success' : s === 'denied' ? 'record' : 'neutral') as 'success' | 'record' | 'neutral';
  const permCards: { key: keyof PermissionInfo; title: string; text: string; pane: 'screen' | 'camera' | 'microphone' | 'input'; request?: 'camera' | 'microphone' }[] = [
    { key: 'screen', title: t("Grabación de pantalla"), text: t("Necesario para grabar tu pantalla o una ventana."), pane: 'screen' },
    { key: 'camera', title: t("Cámara"), text: t("Para grabarte aparte de la pantalla."), pane: 'camera', request: 'camera' },
    { key: 'microphone', title: t("Micrófono"), text: t("Para grabar tu voz."), pane: 'microphone', request: 'microphone' },
    { key: 'input', title: t("Eventos del mouse"), text: t("Los clics se guardan solo en tu computadora, para sugerir zooms automáticos. Las teclas que pulsas nunca se graban."), pane: 'input' },
  ];
  return (
    <div className={`settings${embedded ? ' is-embedded' : ''}`}>
      <LanguageSection />
      <section>
        <h2>{t("Permisos")}</h2>
        <p className="muted">{t("El sistema operativo administra los permisos. Abre la página de ajustes correspondiente para cambiarlos.")}</p>
        <div className="perm-grid">
          {permCards.map((c) => (
            <div key={c.key} className="perm-card">
              <header><strong>{c.title}</strong><Badge tone={tone(perms?.[c.key])}>{label(perms?.[c.key])}</Badge></header>
              <p className="muted small">{c.text}</p>
              <div className="row-actions">
                {c.request && perms?.[c.key] === 'not-determined' && <Button size="sm" onClick={async () => { await api.requestPermission(c.request!); refresh(); }}>{t("Pedir acceso")}</Button>}
                <Button size="sm" variant="ghost" icon="sliders" onClick={() => api.openPermissionSettings(c.pane)}>{t("Abrir ajustes del sistema")}</Button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>{t("Métodos de grabación")}</h2>
        <div className="perm-grid">
          {backends.map((b) => (
            <div key={b.id} className="perm-card">
              <header><strong>{b.id === 'web' ? t("Grabación alternativa del navegador") : b.id === 'native-macos' ? t("Grabación nativa (macOS)") : t("Grabación nativa (Windows)")}</strong><Badge tone={b.available ? 'success' : 'neutral'}>{b.available ? t("Disponible") : t("No disponible")}</Badge></header>
              {b.reason && <p className="muted small">{t(b.reason)}</p>}
              <ul className="caps">
                <li className={b.capabilities.separateCursor ? 'ok' : ''}>{t("Cursor grabado aparte")}</li>
                <li className={b.capabilities.clicks ? 'ok' : ''}>{t("Datos de clics")}</li>
                <li className={b.capabilities.systemAudio ? 'ok' : ''}>{t("Audio del sistema")}</li>
              </ul>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>{t("Atajos")}</h2>
        <dl className="shortcut-list">
          <div><dt><Kbd>{keyLabel(RECORDING_KEYS.stop)}</Kbd></dt><dd>{t("Finalizar grabación")}</dd></div>
          <div><dt><Kbd>{keyLabel(RECORDING_KEYS.pause)}</Kbd></dt><dd>{t("Pausar / reanudar la grabación")}</dd></div>
          <div><dt><Kbd>{keyLabel(RECORDING_KEYS.mark)}</Kbd></dt><dd>{t("Añadir una marca durante la grabación (sirve de pista para el zoom)")}</dd></div>
          <div><dt><Kbd>?</Kbd></dt><dd>{t("Todos los atajos en el editor")}</dd></div>
        </dl>
      </section>
      <section>
        <h2>{t("Almacenamiento y privacidad")}</h2>
        <p className="muted small"><Icon name="folder" size={14} /> {t("Proyectos:")} <code>{info?.projectsRoot}</code></p>
        <p className="muted small"><Icon name="shield" size={14} /> {t("Las grabaciones y los datos del cursor y de clics se guardan solo en esta computadora. La app no hace solicitudes de red ni envía telemetría.")}</p>
      </section>
      <LicensesSection />
      <section>
        <h2>{t("Acerca de")}</h2>
        <p className="about-name"><strong>{APP_NAME}</strong> <span className="mono muted small">{info?.version}</span></p>
        <p className="muted small">{t("Desarrollador:")} {DEVELOPER}</p>
        <p className="muted small">{COPYRIGHT} · {LICENSE_NAME} · <span className="mono">{WEBSITE_URL}</span></p>
        <p className="muted small mono">Electron {info?.electron} · Chromium {info?.chrome} · {info?.platform} {info?.arch} · {info?.osVersion}</p>
        <p className="muted small">{t("Los componentes de terceros se distribuyen con sus propias licencias, que aparecen arriba en la sección “Licencias y software de terceros”.")}</p>
      </section>
    </div>
  );
}
