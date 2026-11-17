import { describe, expect, it, vi } from 'vitest';
import { Acquired, ChunkQueue } from './capture-pipeline';

function fakeMain(failOn: (channel: string, call: number) => boolean = () => false) {
  const calls: { channel: string; payload: unknown }[] = [];
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    calls.push({ channel, payload });
    if (failOn(channel, calls.filter((c) => c.channel === channel).length)) throw new Error(`${channel} refused`);
    return undefined;
  });
  return { calls, invoke, channels: () => calls.map((c) => c.channel) };
}

const bytes = (n: number) => async () => new Uint8Array([n]);

describe('ChunkQueue', () => {
  it('sends chunks in order, then closes the file', async () => {
    const main = fakeMain();
    const q = new ChunkQueue(main.invoke, 'h1', () => ({ width: 10 }), (e) => e.message);
    q.push(bytes(1));
    q.push(bytes(2));
    await q.close();
    expect(main.channels()).toEqual(['cw:chunk', 'cw:chunk', 'cw:close']);
    expect(main.calls[0]?.payload).toMatchObject({ handle: 'h1', first: { width: 10 } });
    expect(main.calls[1]?.payload).not.toHaveProperty('first');
  });

  it('tells main once when a chunk fails and still closes the file', async () => {
    const main = fakeMain((channel, n) => channel === 'cw:chunk' && n === 2);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const q = new ChunkQueue(main.invoke, 'h1', () => ({}), (e) => `write failed: ${e.message}`);
      q.push(bytes(1));
      q.push(bytes(2));
      q.push(bytes(3));
      q.push(bytes(4));
      await q.close();
      await new Promise((r) => setTimeout(r, 0));
      expect(main.channels()).toEqual(['cw:chunk', 'cw:chunk', 'cw:failed', 'cw:close']);
      expect(main.calls[2]?.payload).toEqual({ message: 'write failed: cw:chunk refused' });
      expect(main.calls[3]?.payload).toMatchObject({ handle: 'h1' });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('tells main when reading a chunk fails', async () => {
    const main = fakeMain();
    const q = new ChunkQueue(main.invoke, 'h1', () => ({}), (e) => e.message);
    q.push(async () => { throw new Error('blob unreadable'); });
    await q.close();
    expect(main.calls.map((c) => [c.channel, c.channel === 'cw:failed' ? c.payload : null])).toEqual([
      ['cw:failed', { message: 'blob unreadable' }],
      ['cw:close', null],
    ]);
  });

  it('settles close even when main cannot close the file', async () => {
    const main = fakeMain((channel) => channel === 'cw:close');
    const q = new ChunkQueue(main.invoke, 'h1', () => ({}), (e) => e.message);
    q.push(bytes(1));
    await expect(q.close()).resolves.toBeUndefined();
    expect(main.channels()).toEqual(['cw:chunk', 'cw:close', 'cw:failed']);
  });
});

function fakeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { tracks, getTracks: () => tracks };
}

describe('Acquired', () => {
  it('releases every stream, context, closable and timer taken so far', () => {
    const held = new Acquired();
    const screen = held.track(fakeStream());
    const camera = held.track(fakeStream());
    const ctx = held.closeLater({ close: vi.fn(async () => undefined) });
    const watch = held.closeLater({ close: vi.fn() });
    const timer = held.interval(42);
    const clear = vi.fn();
    held.release(clear);
    for (const t of [...screen.tracks, ...camera.tracks]) expect(t.stop).toHaveBeenCalledOnce();
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(watch.close).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(timer);
  });

  it('releases the rest when one item fails to release', () => {
    const held = new Acquired();
    held.closeLater({ close: () => { throw new Error('already closed'); } });
    const later = held.track(fakeStream());
    held.release(() => undefined);
    for (const t of later.tracks) expect(t.stop).toHaveBeenCalledOnce();
  });

  it('releases each item only once', () => {
    const held = new Acquired();
    const s = held.track(fakeStream());
    held.release(() => undefined);
    held.release(() => undefined);
    expect(s.tracks[0]?.stop).toHaveBeenCalledOnce();
  });
});
