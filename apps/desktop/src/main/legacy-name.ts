// The app was called "Sahne" while it was developed and "Zeyvola" upstream. The first start under
// the new name moves the most recent old projects folder to the new one and copies the most recent
// old settings file, so nothing the user made disappears. Projects store paths relative to their
// folder, so a move keeps them intact. Nothing is deleted, and nothing happens when the new folder
// already exists.
import { access, copyFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Earlier names, most recent first: userData folder name and projects folder name. */
export const LEGACY_NAMES = [
  { name: 'Zeyvola', projectsFolder: 'Zeyvola Projeleri' },
  { name: 'Sahne', projectsFolder: 'Sahne Projeleri' },
] as const;

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const p of paths) if (await exists(p)) return p;
  return undefined;
}

export interface LegacyPaths {
  /** Parent of the projects folder (Electron: app.getPath('videos')). */
  videos: string;
  /** This app's userData folder; the old ones are its siblings named after LEGACY_NAMES. */
  userData: string;
  projectsFolder: string;
}

/** Returns what was moved or copied, for the log. */
export async function migrateLegacyData(p: LegacyPaths): Promise<string[]> {
  const done: string[] = [];
  const newProjects = join(p.videos, p.projectsFolder);
  if (!(await exists(newProjects))) {
    const oldProjects = await firstExisting(LEGACY_NAMES.map((l) => join(p.videos, l.projectsFolder)).filter((o) => o !== newProjects));
    if (oldProjects) {
      await rename(oldProjects, newProjects);
      done.push(`${oldProjects} → ${newProjects}`);
    }
  }
  const newSettings = join(p.userData, 'settings.json');
  if (!(await exists(newSettings))) {
    const oldSettings = await firstExisting(LEGACY_NAMES.map((l) => join(dirname(p.userData), l.name, 'settings.json')).filter((o) => o !== newSettings));
    if (oldSettings) {
      await mkdir(p.userData, { recursive: true });
      await copyFile(oldSettings, newSettings);
      done.push(`${oldSettings} → ${newSettings}`);
    }
  }
  return done;
}
