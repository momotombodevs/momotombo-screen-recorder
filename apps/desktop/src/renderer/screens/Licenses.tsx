import { useEffect, useState } from 'react';
import type { ThirdPartyInfo } from '@momotombo/protocol';
import { api } from '../api';
import { t, useLang } from '../i18n';
import { Badge, Button } from '../ui/controls';
import { Icon } from '../ui/icons';

type Codec = ThirdPartyInfo['codecs'][number];

/** Settings → "Licencias y software de terceros". Data comes from dist/licenses (written by the build). */
export function LicensesSection() {
  const lang = useLang();
  const [info, setInfo] = useState<ThirdPartyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.licenses().then(setInfo, (e: Error) => setError(e.message)); }, []);

  const toggle = (key: string) => setOpen(open === key ? null : key);
  const pick = (v: { es: string; en: string }) => (lang === 'es' ? v.es : v.en);
  const status = (c: Codec) => (c.status === 'legal-review'
    ? <Badge tone="warning">{t("Requiere revisión legal")}</Badge>
    : <Badge tone="neutral">{t("Riesgo bajo · sin verificar")}</Badge>);

  return (
    <section className="licenses">
      <h2>{t("Licencias y software de terceros")}</h2>
      <p className="muted">{t("Momotombo se distribuye con los componentes de terceros de abajo. Cada componente está sujeto a su propia licencia.")}</p>
      {error && <p className="note is-error"><Icon name="warning" size={14} />{t("No se pudo leer la información de licencias: {msg}", { msg: error })}</p>}
      {info && (
        <>
          <div className={info.ownLicense ? 'license-own is-set' : 'license-own'}>
            <div><strong>{t("Licencia propia de Momotombo")}</strong><Badge tone={info.ownLicense ? 'success' : 'warning'}>{info.ownLicense ?? t("Aún sin elegir")}</Badge></div>
            {info.ownNotice?.map((l) => <p key={l} className="muted small">{l}</p>)}
            <p className="muted small">{info.ownLicense
              ? t("Gratis para personas y empresas. La licencia no reclama ningún derecho sobre los videos que haces con Momotombo ni limita su uso comercial. El único fin que no permite es ofrecer un producto que compita con Momotombo; un producto ofrecido como sustituto de Momotombo compite aunque sea gratis. Lo que vale es el texto de la licencia.")
              : t("Todavía no se ha decidido la licencia propia de la app. Esta sección solo enumera componentes de terceros.")}</p>
          </div>

          <div className="license-list" role="list">
            {info.packages.map((p) => (
              <div key={p.name} className="license-row" role="listitem">
                <div className="license-head">
                  <strong>{p.name}</strong>
                  <span className="mono muted small">{p.version}</span>
                  <Badge tone="success">{p.license}</Badge>
                  <button type="button" className="link" aria-expanded={open === p.name} onClick={() => toggle(p.name)}>
                    {open === p.name ? t("Ocultar texto") : t("Texto de la licencia")}
                  </button>
                </div>
                <span className="muted small">{p.copyright.join(' · ')}</span>
                {open === p.name && <pre className="license-text">{p.text}</pre>}
              </div>
            ))}
            <div className="license-row" role="listitem">
              <div className="license-head">
                <strong>Electron</strong>
                <span className="mono muted small">{info.electron.version}</span>
                <Badge tone="success">{info.electron.license}</Badge>
                <button type="button" className="link" aria-expanded={open === 'electron'} onClick={() => toggle('electron')}>
                  {open === 'electron' ? t("Ocultar texto") : t("Texto de la licencia")}
                </button>
              </div>
              <span className="muted small">{info.electron.copyright.join(' · ')}</span>
              {open === 'electron' && <pre className="license-text">{info.electron.text}</pre>}
              <p className="muted small">{t("Electron incluye Chromium, Node.js, FFmpeg y otros componentes. Sus avisos de licencia ({n} entradas) vienen con la app.", { n: info.electron.chromiumEntries })}</p>
              <div className="row-actions">
                <Button size="sm" variant="ghost" icon="info" onClick={() => void api.openChromiumLicenses().catch((e: Error) => setError(e.message))}>{t("Abrir los avisos de componentes de Chromium")}</Button>
              </div>
            </div>
            {/* Shipped with Electron but missing from its Chromium notices. */}
            {(info.supplements ?? []).map((r) => (
              <div key={r.id} className="license-row" role="listitem">
                <div className="license-head">
                  <strong>{r.name}</strong>
                  <Badge tone="success">{r.license.split(';')[0]!.split('.')[0]!}</Badge>
                  {r.text && (
                    <button type="button" className="link" aria-expanded={open === r.id} onClick={() => toggle(r.id)}>
                      {open === r.id ? t("Ocultar texto") : t("Texto de la licencia")}
                    </button>
                  )}
                </div>
                <span className="muted small">{r.version}</span>
                {!r.text && <span className="muted small">{r.license}</span>}
                {open === r.id && <pre className="license-text">{r.text}</pre>}
              </div>
            ))}
          </div>

          <h3 className="license-subhead">{t("Códecs: la licencia de código abierto y las patentes son cosas distintas")}</h3>
          <p className="muted small">{t("Una licencia de código abierto no da a sus usuarios una licencia de patentes. Las notas sobre patentes de abajo no están resueltas y no son asesoría legal.")}</p>
          {info.distribution && (
            <p className="note small"><Icon name="info" size={14} />{info.distribution === 'webm'
              ? t("Esta es la distribución centrada en WebM: no usa H.264, AAC ni HEVC; las exportaciones usan VP9 + Opus.")
              : info.distribution === 'webm-vp8'
              ? t("Esta es la distribución experimental con VP8: no usa H.264, AAC ni HEVC; la grabación y la exportación usan VP8 + Opus (WebM).")
              : t("Esta es la distribución con MP4: H.264 y AAC se escriben solo con los codificadores del propio sistema operativo; el paquete instalado no incluye decodificadores de H.264 ni AAC.")}</p>
          )}
          <div className="codec-list" role="list">
            {info.codecs.map((c) => (
              <div key={c.id} className="codec-row" role="listitem">
                <div className="license-head"><strong>{lang === 'es' ? c.name : c.nameEn ?? c.name}</strong>{status(c)}</div>
                <dl>
                  <div><dt>{t("Dónde")}</dt><dd>{pick(c.where)}</dd></div>
                  <div><dt>{t("Licencia de código abierto")}</dt><dd>{pick(c.license)}</dd></div>
                  <div><dt>{t("Estado de las patentes")}</dt><dd>{pick(c.patent)}</dd></div>
                </dl>
              </div>
            ))}
          </div>
          <div className="row-actions">
            <Button size="sm" variant="ghost" icon="folder" onClick={() => void api.openThirdPartyNotices().catch((e: Error) => setError(e.message))}>{t("Abrir todos los avisos")}</Button>
          </div>
        </>
      )}
    </section>
  );
}
