import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProject, serializeProject, type Project } from '@momotombo/project-model';
import { PROJECT_FILE } from '../shared/brand';
import { writeFileAtomic } from './fsutil';

export const BACKUPS_KEPT = 5;
const BACKUP_DIR = join('cache', 'backups');
const BACKUP_NAME = /^project-(\d{9})-.*\.json$/;

export class WriteConflictError extends Error {}

export function readProjectText(dir: string): Promise<string> {
  return readFile(join(dir, PROJECT_FILE), 'utf8');
}

export function validatedProjectText(project: Project): string {
  return serializeProject(parseProject(JSON.parse(serializeProject(project))));
}

export function backupDir(dir: string): string {
  return join(dir, BACKUP_DIR);
}

async function keepBackupHistory(dir: string, previous: string): Promise<void> {
  const history = backupDir(dir);
  const existing = (await readdir(history).catch(() => [])).filter((n) => BACKUP_NAME.test(n)).sort();
  const next = existing.length ? Number(BACKUP_NAME.exec(existing.at(-1)!)![1]) + 1 : 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFileAtomic(join(history, `project-${String(next).padStart(9, '0')}-${stamp}.json`), previous);
  const old = [...existing, 'new'].slice(0, -BACKUPS_KEPT);
  await Promise.all(old.map((n) => rm(join(history, n), { force: true })));
}

export async function writeProjectTextKeepingBackup(dir: string, text: string): Promise<void> {
  const file = join(dir, PROJECT_FILE);
  const previous = await readFile(file).catch(() => null);
  if (previous) await writeFileAtomic(`${file}.bak`, previous);
  await writeFileAtomic(file, text);
}

async function writeSynced(path: string, text: string): Promise<void> {
  const fh = await open(path, 'w');
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** The editor takes no lock: the new text is synced before the last check so that only the rename is left in the race window. */
export async function writeProjectTextIfUnchanged(dir: string, expected: string, text: string): Promise<void> {
  const file = join(dir, PROJECT_FILE);
  const conflict = () => new WriteConflictError('The project changed while the ops were applied (probably saved by the editor). Nothing was written; run apply again.');
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeSynced(tmp, text);
    if ((await readProjectText(dir)) !== expected) throw conflict();
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
  await writeFileAtomic(`${file}.bak`, expected);
  await keepBackupHistory(dir, expected);
}
