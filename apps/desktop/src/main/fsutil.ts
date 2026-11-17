import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const pendingWrites = new Map<string, Promise<void>>();

/**
 * Writes a file atomically: temp file → fsync → rename. A crash leaves the old file intact.
 * Writes to one path land in call order, so the last call's data is what stays on disk.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const key = resolve(path);
  const prev = pendingWrites.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => writeNow(path, data));
  pendingWrites.set(key, next);
  const cleanup = () => { if (pendingWrites.get(key) === next) pendingWrites.delete(key); };
  next.then(cleanup, cleanup);
  return next;
}

async function writeNow(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Resolves `rel` inside `root`, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, rel);
  const r = relative(base, full);
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return null;
  return full;
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  const sizes = await Promise.all(entries.map(async (e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return dirSize(p);
    if (!e.isFile()) return 0;
    try { return (await stat(p)).size; } catch { return 0; }
  }));
  for (const n of sizes) total += n;
  return total;
}

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function removeQuiet(path: string): Promise<void> {
  try { await rm(path, { force: true, recursive: true }); } catch { /* ignore */ }
}
