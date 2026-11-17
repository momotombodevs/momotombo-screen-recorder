// Windows only. Electron for Windows brings Microsoft's d3dcompiler_47.dll (the Direct3D HLSL
// compiler that WebGL uses there). It is "Distributable Code" of the Windows SDK, whose terms ask
// the distributor to make end users agree to terms that protect it at least as much as the SDK
// license. Microsoft Learn ("Where is the DirectX SDK?") says the DLL is not a system component and
// is redistributed next to the app.
//
// The package therefore ships it as "d3dcompiler_47.dll.terms-pending" (apps/desktop/scripts/
// package.mjs). Under that name Windows' loader cannot find it next to the app, so no process of
// the app can load the shipped copy before the user has agreed. On first start, before any window,
// the terms are shown:
//   Accept  → acceptance is recorded, the file gets its real name, the app restarts once.
//   Decline → the app quits; the file keeps its pending name.
// After an update (a new zip brings the pending name again) an earlier acceptance is enough: the
// file is renamed at start and the app restarts once. If it cannot be renamed (no write access to
// the app's folder, file in use), the app starts anyway and says which folder needs write access.
//
// Hardware acceleration stays off while the dialog is open (main.ts). That alone does not keep
// Chromium's GPU process from loading a d3dcompiler_47.dll it can find: measured on GitHub's Windows
// runner (2026-11-13), it loaded the copy next to electron.exe. Hence the pending name.
// The development build (node_modules/electron) keeps Electron's own d3dcompiler_47.dll under its
// real name: this protection applies to packages made by package.mjs only.
// Signing: the Windows package is unsigned today. Authenticode signs each file on its own, so a
// rename keeps a file's signature; a catalog-signed package would need a fresh look at this.
// The terms cover only that Microsoft file; Momotombo's own license and the open-source licenses
// (FFmpeg, LGPL-2.1) are not changed by them.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app, dialog, shell } from 'electron';
import { tm } from './settings';

/** Bumped whenever the terms text changes, so it is shown again. */
export const TERMS_VERSION = '2026-10-17';
export const TERMS_ID = 'microsoft-d3dcompiler';
export const TERMS_FILE = 'MICROSOFT-D3DCOMPILER-TERMS.txt';
const STATE_FILE = 'third-party-terms.json';
export const DLL_NAME = 'd3dcompiler_47.dll';
/** The name the package ships the DLL under until the terms are accepted. */
export const DLL_PENDING = `${DLL_NAME}.terms-pending`;

type TermsState = Record<string, { version: string; acceptedAt: string }>;

function readState(userData: string): TermsState {
  try {
    const j = JSON.parse(readFileSync(join(userData, STATE_FILE), 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as TermsState) : {};
  } catch {
    return {};
  }
}

export function termsAccepted(userData: string, version = TERMS_VERSION): boolean {
  return readState(userData)[TERMS_ID]?.version === version;
}

export function recordAcceptance(userData: string, now = new Date(), version = TERMS_VERSION): void {
  const state = readState(userData);
  state[TERMS_ID] = { version, acceptedAt: now.toISOString() };
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** The terms are needed only on Windows and only while the DLL actually ships next to the app. */
export function termsNeeded(platform: string, dllPresent: boolean, accepted: boolean): boolean {
  return platform === 'win32' && dllPresent && !accepted;
}

export interface DllFiles { active: boolean; pending: boolean }

/** Which names of the DLL are next to the app's executable. */
export function dllFiles(dir = dirname(process.execPath)): DllFiles {
  return { active: existsSync(join(dir, DLL_NAME)), pending: existsSync(join(dir, DLL_PENDING)) };
}

/** The DLL ships with the app under either name. */
export function microsoftDllPresent(dir = dirname(process.execPath)): boolean {
  const f = dllFiles(dir);
  return f.active || f.pending;
}

/**
 * What to do at start: ask for the terms; put an accepted DLL in place (after an update) and
 * restart; or nothing.
 */
export function startupAction(platform: string, files: DllFiles, accepted: boolean): 'ask' | 'activate' | 'none' {
  if (platform !== 'win32' || (!files.active && !files.pending)) return 'none';
  if (!accepted) return 'ask';
  return files.pending ? 'activate' : 'none';
}

/**
 * Gives the DLL its real name (after acceptance). A copy already under the real name is replaced
 * by the pending one, which came with this version. Returns the error code when it cannot.
 */
export function activateDll(dir = dirname(process.execPath)): { ok: true } | { ok: false; code: string; dir: string } {
  const pending = join(dir, DLL_PENDING);
  const active = join(dir, DLL_NAME);
  try {
    if (!existsSync(pending)) return { ok: true };
    if (existsSync(active)) rmSync(active);
    renameSync(pending, active);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: (e as NodeJS.ErrnoException).code ?? 'unknown', dir };
  }
}

/** Says the DLL could not be put in place, and which folder needs write access. Native dialog. */
export async function tellActivationFailed(dir: string): Promise<void> {
  await dialog.showMessageBox({
    type: 'warning',
    title: tm("Términos de un componente de Microsoft"),
    message: tm("No se pudo colocar el componente de Microsoft"),
    detail: tm("Aceptaste los términos, pero no se pudo dar su nombre real al archivo d3dcompiler_47.dll. Para eso se necesita permiso de escritura en esta carpeta:\n{dir}", { dir }),
    buttons: [tm("Aceptar")],
    noLink: true,
  });
}

export function termsFile(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'licenses', TERMS_FILE)
    : resolve(app.getAppPath(), '..', '..', 'tools', 'notices-supplement', TERMS_FILE);
}

/** Native dialog (no window, no GPU). Resolves true on "Accept". */
export async function askForTerms(): Promise<boolean> {
  const file = termsFile();
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: tm("Términos de un componente de Microsoft"),
      message: tm("En Windows, Momotombo usa un archivo de Microsoft"),
      detail: tm("La versión de Momotombo para Windows incluye d3dcompiler_47.dll, un archivo de Microsoft que se usa para los gráficos. Microsoft solo permite distribuir este archivo si los usuarios aceptan sus términos. Los términos se aplican solo a este archivo: no distribuirlo por separado, no aplicarle ingeniería inversa (salvo donde la ley lo permita) y límites de garantía y responsabilidad. No cambian la licencia propia de Momotombo ni los derechos que te dan los componentes de código abierto (FFmpeg, LGPL).\n\nPulsa \"Leer los términos\" para leerlos completos. Si no los aceptas, Momotombo se cierra."),
      buttons: [tm("Acepto"), tm("Leer los términos"), tm("No acepto")],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) return true;
    if (response === 2) return false;
    const err = await shell.openPath(file);
    if (err) await dialog.showMessageBox({ type: 'warning', message: tm("No se pudo abrir el archivo de términos"), detail: `${file}\n${err}` });
  }
}
