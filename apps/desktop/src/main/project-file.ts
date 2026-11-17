import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProject, serializeProject, type Project } from '@momotombo/project-model';
import { PROJECT_FILE } from '../shared/brand';
import { writeFileAtomic } from './fsutil';

export function readProjectText(dir: string): Promise<string> {
  return readFile(join(dir, PROJECT_FILE), 'utf8');
}

export function validatedProjectText(project: Project): string {
  return serializeProject(parseProject(JSON.parse(serializeProject(project))));
}

export async function writeProjectTextKeepingBackup(dir: string, text: string): Promise<void> {
  const file = join(dir, PROJECT_FILE);
  const previous = await readFile(file).catch(() => null);
  if (previous) await writeFileAtomic(`${file}.bak`, previous);
  await writeFileAtomic(file, text);
}
