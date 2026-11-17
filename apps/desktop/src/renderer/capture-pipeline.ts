export type Invoke = (channel: string, payload?: unknown) => Promise<unknown>;

export interface ChunkMeta {
  firstFrameMs?: number | null;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
}

/**
 * Streams one recorder's chunks to its file in main, in order. After the first failure no more
 * chunks are written (the file already has a hole) and main is told once on `cw:failed`; the
 * file is still closed, which main waits for before it finishes the recording.
 */
export class ChunkQueue {
  private chain = Promise.resolve();
  private sentFirst = false;
  private failed = false;

  constructor(
    private readonly invoke: Invoke,
    private readonly handle: string,
    private readonly meta: () => ChunkMeta,
    private readonly failMessage: (e: Error) => string,
  ) {}

  push(read: () => Promise<Uint8Array>): void {
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      try {
        const data = await read();
        const first = this.sentFirst ? undefined : this.meta();
        await this.invoke('cw:chunk', { handle: this.handle, data, ...(first ? { first } : {}) });
        this.sentFirst = true;
      } catch (e) {
        await this.fail(e);
      }
    });
  }

  close(): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await this.invoke('cw:close', { handle: this.handle, ...this.meta() });
      } catch (e) {
        await this.fail(e);
      }
    });
    return this.chain;
  }

  private async fail(e: unknown): Promise<void> {
    if (this.failed) return;
    this.failed = true;
    const err = e instanceof Error ? e : new Error(String(e));
    await this.invoke('cw:failed', { message: this.failMessage(err) }).catch(() => undefined);
  }
}

interface Stoppable { getTracks(): { stop(): void }[] }
interface Closable { close(): unknown }

export class Acquired {
  private releases: (() => unknown)[] = [];
  private timers: number[] = [];

  track<T extends Stoppable>(stream: T): T {
    this.releases.push(() => { for (const t of stream.getTracks()) t.stop(); });
    return stream;
  }

  closeLater<T extends Closable>(item: T): T {
    this.releases.push(() => item.close());
    return item;
  }

  interval(id: number): number {
    this.timers.push(id);
    return id;
  }

  release(clear: (id: number) => void = clearInterval): void {
    for (const id of this.timers.splice(0)) clear(id);
    for (const release of this.releases.splice(0).reverse()) {
      try {
        const r = release();
        if (r instanceof Promise) r.catch(() => undefined);
      } catch (e) {
        console.warn('[capture] release failed', e);
      }
    }
  }
}
