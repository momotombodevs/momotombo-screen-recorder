// Starts the app for development.
//
// macOS attributes privacy permissions (screen recording, camera, microphone) to the
// "responsible" app. Launched from a terminal, that is the terminal, so the request
// shows up under the wrong name. We therefore build a small development bundle,
// "Momotombo (development)", with its own identifier and usage texts, and start it through
// LaunchServices so it owns its permissions. The bundle is built once; re-signing
// would reset granted permissions, so it is reused until Electron's version changes.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const require = createRequire(import.meta.url);

if (process.platform !== 'darwin') {
  const electron = require('electron');
  spawn(electron, [appDir], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
} else {
  const electronApp = resolve(dirname(require.resolve('electron/package.json')), 'dist', 'Electron.app');
  const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
  const bundle = join(appDir, '.dev-app', 'Momotombo Development.app');
  const stamp = join(appDir, '.dev-app', 'electron-version.txt');
  const plist = join(bundle, 'Contents', 'Info.plist');

  const current = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
  if (!existsSync(bundle) || current !== electronVersion) {
    console.log('Preparing the development app (once)…');
    rmSync(bundle, { recursive: true, force: true });
    execFileSync('mkdir', ['-p', dirname(bundle)]);
    // APFS clone: no extra disk space until files change.
    execFileSync('cp', ['-cR', electronApp, bundle]);
    const set = (key, type, value) => {
      try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist], { stdio: 'ignore' }); } catch { /* absent */ }
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]);
    };
    set('CFBundleName', 'string', 'Momotombo (development)');
    set('CFBundleDisplayName', 'string', 'Momotombo (development)');
    set('CFBundleIdentifier', 'string', 'dev.momotombo.recorder.dev');
    set('NSCameraUsageDescription', 'string', 'Momotombo usa la cámara para grabar tu imagen por separado de la pantalla.');
    set('NSMicrophoneUsageDescription', 'string', 'Momotombo usa el micrófono para grabar tu voz.');
    set('NSAudioCaptureUsageDescription', 'string', 'Momotombo usa el audio del sistema para agregar el sonido de la computadora a la grabación de pantalla.');
    set('NSCameraUseContinuityCameraDeviceType', 'bool', 'true');
    // Info.plist changed, so the bundle must be re-signed (ad hoc, local use only).
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
    writeFileSync(stamp, electronVersion);
  }
  // -n: new instance; arguments after --args reach Electron (the app folder to load).
  execFileSync('open', ['-n', bundle, '--args', appDir], { stdio: 'inherit' });
  console.log('Momotombo (development) opened.');
}
