import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureConfig, CaptureState } from "@momotombo/protocol";
import type { BackendResult, BackendStartArgs } from "./types";

vi.mock("electron", () => {
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    scaleFactor: 1,
  };
  return {
    app: {
      getPath: () => tmpdir(),
      getPreferredSystemLanguages: () => ["en"],
      getLocale: () => "en",
      isPackaged: false,
      getAppPath: () => tmpdir(),
    },
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
    desktopCapturer: {
      getSources: async () => [
        { id: "screen:1:0", name: "Screen", display_id: "1" },
      ],
    },
  };
});
const { CaptureManager } = await import("./manager");
const { WebCaptureBackend } = await import("./web-backend");
const { RecorderCrash } = await import("./types");
type Manager = InstanceType<typeof CaptureManager>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const result: BackendResult = {
  sources: {
    screen: {
      kind: "screen",
      file: "media/r/screen.webm",
      mime: "video/webm",
      startOffset: 0,
      duration: 1,
    },
  },
  durationTicks: 1,
  capture: {
    backend: "web",
    target: {
      kind: "display",
      label: "Screen",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      scaleFactor: 1,
    },
    cursorInFrames: true,
    hasClicks: false,
  },
  markers: [],
};

const managers: Manager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.cancel();
});

function setup(deps: { beforeRecording?: () => Promise<void>; diskFree?: (dir: string) => Promise<number> } = {}) {
  const store = {
    create: vi.fn(async () => ({ id: "p" })),
    mediaDir: vi.fn(async () => "/nonexistent-momotombo-dir"),
    appendRecording: vi.fn(async () => ({})),
    read: vi.fn(async () => ({ name: "P", recordings: {} })),
  };
  const m = new CaptureManager({
    store: store as never,
    createCaptureWindow: () => ({}) as never,
    showHud() {},
    hideHud() {},
    ...deps,
  });
  managers.push(m);
  const b = m.web;
  const backend = {
    prepare: vi.spyOn(b, "prepare").mockResolvedValue(undefined),
    start: vi.spyOn(b, "start").mockResolvedValue(undefined),
    pause: vi.spyOn(b, "pause").mockResolvedValue(undefined),
    resume: vi.spyOn(b, "resume").mockResolvedValue(undefined),
    stop: vi.spyOn(b, "stop").mockResolvedValue(result),
    cancel: vi.spyOn(b, "cancel").mockResolvedValue(undefined),
  };
  const internals = m as unknown as {
    active: unknown;
    session: unknown;
    elapsedBase: number;
  };
  const leaks: CaptureState["phase"][] = [];
  m.on("state", (s: CaptureState) => {
    if (
      internals.active !== null &&
      (s.phase === "idle" || s.phase === "error")
    )
      leaks.push(s.phase);
  });
  return { m, b, backend, store, internals, leaks };
}

function config(extra: Partial<CaptureConfig> = {}): CaptureConfig {
  return {
    target: {
      kind: "display",
      sourceId: "screen:1:0",
      displayId: "1",
      label: "Screen",
    },
    systemAudio: false,
    fps: 30,
    quality: "high",
    countdown: 0,
    backend: "web",
    projectId: "p",
    ...extra,
  } as CaptureConfig;
}

describe("CaptureManager: cancel while start() is awaiting", () => {
  it("during beforeRecording: never starts the backend", async () => {
    const gate = deferred();
    const { m, backend, internals, leaks } = setup({
      beforeRecording: () => gate.promise,
    });
    const p = m.start(config());
    await sleep(20);
    await m.cancel();
    gate.resolve();
    await p;
    expect(backend.start).not.toHaveBeenCalled();
    expect(m.state.phase).toBe("idle");
    expect(internals.session).toBeNull();
    expect(internals.active).toBeNull();
    expect(leaks).toEqual([]);
  });

  it("during prepare: never starts the backend and devices are not reported ready", async () => {
    const { m, backend, internals } = setup();
    const prep = deferred();
    backend.prepare.mockReturnValueOnce(prep.promise);
    const p = m.start(config());
    await sleep(20);
    await m.cancel();
    prep.resolve();
    await p;
    await sleep(0);
    expect(backend.start).not.toHaveBeenCalled();
    expect(m.state).toMatchObject({ phase: "idle", devicesReady: false });
    expect(internals.active).toBeNull();
  });

  it("during the store calls: never prepares or starts", async () => {
    const { m, backend, store } = setup();
    const created = deferred<{ id: string }>();
    store.create.mockReturnValueOnce(created.promise);
    const p = m.start(config({ projectId: undefined }));
    await sleep(10);
    await m.cancel();
    created.resolve({ id: "p" });
    await p;
    expect(backend.prepare).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    expect(m.state.phase).toBe("idle");
  });

  it("cancel and a new start inside one countdown tick: only the new attempt records", async () => {
    const { m, backend } = setup();
    const first = m.start(config({ countdown: 1 }));
    await sleep(100);
    await m.cancel();
    const second = m.start(config({ countdown: 1 }));
    await Promise.all([first, second]);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.prepare).toHaveBeenCalledTimes(2);
    expect(backend.start.mock.calls[0]![0]).toBe(
      backend.prepare.mock.calls[1]![0],
    );
    expect(m.state.phase).toBe("recording");
  });

  it("during backend.start: ends idle, not in error, and the backend is cancelled", async () => {
    const { m, backend, internals, leaks } = setup();
    const started = deferred();
    backend.start.mockReturnValueOnce(started.promise);
    const p = m.start(config());
    await sleep(20);
    await m.cancel();
    started.reject(new Error("cancelled by user"));
    await expect(p).resolves.toBeUndefined();
    expect(m.state.phase).toBe("idle");
    expect(backend.cancel).toHaveBeenCalled();
    expect(internals.active).toBeNull();
    expect(leaks).toEqual([]);
  });

  it("backend.start resolving after a cancel does not leave a recording behind", async () => {
    const { m, backend, internals } = setup();
    const started = deferred();
    backend.start.mockReturnValueOnce(started.promise);
    const p = m.start(config());
    await sleep(20);
    await m.cancel();
    const cancelsBefore = backend.cancel.mock.calls.length;
    started.resolve();
    await p;
    expect(m.state.phase).toBe("idle");
    expect(backend.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    expect(internals.active).toBeNull();
  });
});

describe("CaptureManager: disk space", () => {
  const GB = 1024 ** 3;

  it("refuses to start without room for even a short take, before any countdown", async () => {
    const { m, backend, store } = setup({ diskFree: async () => 0.3 * GB });
    await expect(m.start(config({ countdown: 3, projectId: undefined }))).rejects.toThrow(/espacio/);
    expect(store.create).not.toHaveBeenCalled();
    expect(backend.prepare).not.toHaveBeenCalled();
    expect(m.state.phase).toBe("error");
  });

  it("starts when there is room", async () => {
    const { m, backend } = setup({ diskFree: async () => 100 * GB });
    await m.start(config());
    expect(backend.start).toHaveBeenCalled();
    expect(m.state.phase).toBe("recording");
  });

  it("estimates the minutes left for the configured quality", async () => {
    const { m } = setup({ diskFree: async () => 100 * GB });
    const high = await m.diskEstimate(config({ quality: "high", fps: 60 }));
    const standard = await m.diskEstimate(config({ quality: "standard", fps: 30 }));
    expect(high).toMatchObject({ level: "ok", freeBytes: 100 * GB });
    expect(standard.minutesLeft!).toBeGreaterThan(high.minutesLeft!);
  });

  it("reports an unknown estimate when free space cannot be read, and still starts", async () => {
    const { m, backend } = setup({ diskFree: async () => { throw new Error("no statfs"); } });
    expect(await m.diskEstimate(config())).toEqual({ level: "unknown", freeBytes: null, minutesLeft: null });
    await m.start(config());
    expect(backend.start).toHaveBeenCalled();
  });

  it("stops by itself when the disk gets close to full while recording, and reports minutes left", async () => {
    let free = 100 * GB;
    const { m, backend } = setup({ diskFree: async () => free });
    await m.start(config());
    await sleep(300);
    expect(m.state.diskMinutesLeft).toBeGreaterThan(30);
    free = 0.55 * GB;
    await sleep(300);
    expect(backend.stop).toHaveBeenCalled();
  });

  it("stops a light take by 1.5 GB free at the latest", async () => {
    let free = 100 * GB;
    const { m, backend } = setup({ diskFree: async () => free });
    await m.start(config({ quality: "standard", fps: 30 }));
    free = 1.45 * GB;
    await sleep(300);
    expect(backend.stop).toHaveBeenCalled();
  });
});

describe("CaptureManager: microphone peak", () => {
  const GB = 1024 ** 3;

  it("does not carry a countdown peak into the recording", async () => {
    const { m, b, backend } = setup({ diskFree: async () => 100 * GB });
    const prep = deferred();
    backend.prepare.mockReturnValueOnce(prep.promise);
    const p = m.start(config({ countdown: 1 }));
    await sleep(20);
    b.emit("level", 0.5, 1);
    prep.resolve();
    await p;
    await sleep(300);
    expect(m.state.phase).toBe("recording");
    expect(m.state.micPeak).toBe(0);
  });

  it("reports the loudest sample between two updates while recording", async () => {
    const { m, b } = setup({ diskFree: async () => 100 * GB });
    await m.start(config());
    b.emit("level", 0.1, 0.9);
    b.emit("level", 0.1, 0.3);
    await sleep(300);
    expect(m.state.micPeak).toBe(0.9);
  });
});

describe("CaptureManager: backend errors", () => {
  it("a fatal error while recording ends the session and keeps what was recorded", async () => {
    const { m, b, backend, store, internals, leaks } = setup();
    await m.start(config());
    b.emit("error", new Error("boom"));
    await vi.waitFor(() => expect(m.state.phase).toBe("idle"));
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(store.appendRecording).toHaveBeenCalledTimes(1);
    expect(m.state.message).toBe("boom");
    expect(internals.active).toBeNull();
    expect(internals.session).toBeNull();
    expect(leaks).toEqual([]);
  });

  it("a fatal error while paused ends the session too", async () => {
    const { m, b, backend, internals } = setup();
    await m.start(config());
    await m.pause();
    b.emit("error", new Error("boom"));
    await vi.waitFor(() => expect(m.state.phase).toBe("idle"));
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(internals.active).toBeNull();
  });

  it("when nothing can be saved after a fatal error, it shows the error with no backend left", async () => {
    const { m, b, backend, internals, leaks } = setup();
    backend.stop.mockRejectedValueOnce(new Error("files lost"));
    await m.start(config());
    b.emit("error", new Error("boom"));
    await vi.waitFor(() => expect(m.state.phase).toBe("error"));
    expect(internals.active).toBeNull();
    expect(internals.session).toBeNull();
    expect(leaks).toEqual([]);
    m.resetError();
    expect(m.state.phase).toBe("idle");
  });

  it("a stop timeout reported after a successful save leaves the UI idle, not in error", async () => {
    const { m, b, backend, store } = setup();
    backend.stop.mockImplementationOnce(async () => {
      b.emit("error", new Error("files could not be closed"));
      return result;
    });
    await m.start(config());
    const r = await m.stop();
    expect(r).toEqual({ projectId: "p", recordingId: expect.any(String) });
    expect(store.appendRecording).toHaveBeenCalledTimes(1);
    expect(m.state.phase).toBe("idle");
  });

  it("a fatal error during the countdown aborts the start and cancels the backend", async () => {
    const { m, b, backend, internals, leaks } = setup();
    const p = m.start(config({ countdown: 1 }));
    await sleep(50);
    b.emit("error", new Error("boom"));
    await p.catch(() => undefined);
    await vi.waitFor(() => expect(m.state.phase).toBe("error"));
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.cancel).toHaveBeenCalled();
    expect(internals.active).toBeNull();
    expect(leaks).toEqual([]);
  });

  it("a stop that fails clears the backend before showing the error", async () => {
    const { m, backend, internals, leaks } = setup();
    backend.stop.mockRejectedValueOnce(new Error("disk gone"));
    await m.start(config());
    await m.stop();
    expect(m.state.phase).toBe("error");
    expect(internals.active).toBeNull();
    expect(leaks).toEqual([]);
  });
});

describe("CaptureManager: pause and resume", () => {
  it("two overlapping pause() calls count the elapsed time once", async () => {
    const { m, backend, internals } = setup();
    backend.pause.mockImplementation(async () => {
      await sleep(30);
    });
    await m.start(config());
    await sleep(200);
    await Promise.all([m.pause(), m.pause()]);
    expect(backend.pause).toHaveBeenCalledTimes(1);
    expect(internals.elapsedBase).toBeGreaterThanOrEqual(190);
    expect(internals.elapsedBase).toBeLessThan(300);
    expect(m.state.phase).toBe("paused");
  });

  it("a stop landing while pause() awaits the backend keeps its finishing phase", async () => {
    const { m, backend } = setup();
    const paused = deferred();
    const stopped = deferred<BackendResult>();
    backend.pause.mockReturnValueOnce(paused.promise);
    backend.stop.mockReturnValueOnce(stopped.promise);
    await m.start(config());
    const p = m.pause();
    const s = m.stop();
    expect(m.state.phase).toBe("finishing");
    paused.resolve();
    await p;
    expect(m.state.phase).toBe("finishing");
    stopped.resolve(result);
    await s;
    expect(m.state.phase).toBe("idle");
  });

  it("two overlapping resume() calls resume once", async () => {
    const { m, backend } = setup();
    backend.resume.mockImplementation(async () => {
      await sleep(30);
    });
    await m.start(config());
    await m.pause();
    await Promise.all([m.resume(), m.resume()]);
    expect(backend.resume).toHaveBeenCalledTimes(1);
    expect(m.state.phase).toBe("recording");
  });
});

type FakeWindow = {
  webContents: EventEmitter & {
    send: (channel: string) => void;
    session: { setDisplayMediaRequestHandler: () => void };
  };
  destroyed: boolean;
  isDestroyed: () => boolean;
  destroy: () => void;
};

function fakeWindow(onSend: (channel: string) => void): FakeWindow {
  const webContents = Object.assign(new EventEmitter(), {
    send: (channel: string) => onSend(channel),
    session: { setDisplayMediaRequestHandler: () => undefined },
  });
  const w: FakeWindow = {
    webContents,
    destroyed: false,
    isDestroyed: () => w.destroyed,
    destroy: () => {
      w.destroyed = true;
    },
  };
  return w;
}

describe("WebCaptureBackend (the manager's browser recorder)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function recorder(opts: { load?: "finish" | "fail" | "never" } = {}) {
    const outDir = mkdtempSync(join(tmpdir(), "momotombo-web-"));
    dirs.push(outDir);
    const handlers: Record<string, () => void> = {};
    let win!: FakeWindow;
    const b = new WebCaptureBackend(() => {
      win = fakeWindow((ch) => handlers[ch]?.());
      const load = opts.load ?? "finish";
      setImmediate(() => {
        if (load === "finish") win.webContents.emit("did-finish-load");
        if (load === "fail")
          win.webContents.emit(
            "did-fail-load",
            {},
            -6,
            "ERR_FILE_NOT_FOUND",
            "file:///capture.html",
            true,
          );
      });
      return win as never;
    });
    handlers["cw:prepare"] = () => setImmediate(() => b.onReady());
    handlers["cw:go"] = () => setImmediate(() => b.onStarted(Date.now()));
    const args: BackendStartArgs = {
      config: config(),
      outDir,
      recordingId: "rec_test0001",
      targetBounds: { x: 0, y: 0, w: 100, h: 100 },
      displayBounds: { x: 0, y: 0, w: 100, h: 100 },
      scaleFactor: 1,
    };
    const files = (
      b as unknown as {
        files: Map<
          string,
          { fh: { write: unknown; close: () => Promise<void> } }
        >;
      }
    ).files;
    return { b, args, outDir, handlers, files, window: () => win };
  }

  const meta = { firstFrameMs: null, width: 100, height: 100 };

  it("a failed chunk write still lets the file close, and stop() does not wait for its timeout", async () => {
    const { b, args, handlers, files } = recorder();
    await b.start(args);
    const handle = await b.onOpen("screen", "video/webm");
    await b.onChunk(handle, new Uint8Array([1, 2, 3]), meta);
    const f = files.get(handle)!;
    const close = vi.spyOn(f.fh, "close");
    f.fh.write = vi.fn(async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    });
    const errors: Error[] = [];
    b.on("error", (e: Error) => errors.push(e));
    await expect(b.onChunk(handle, new Uint8Array([4]))).rejects.toThrow(
      "ENOSPC",
    );
    await expect(b.onChunk(handle, new Uint8Array([5]))).rejects.toThrow();
    handlers["cw:stop"] = () => undefined;
    const t0 = Date.now();
    const r = await b.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(close).toHaveBeenCalled();
    expect(errors.map((e) => e.message)).toContain(
      "ENOSPC: no space left on device",
    );
    expect(r.sources.screen?.file).toBe("media/rec_test0001/screen.webm");
  });

  it("closes the files whose close message never arrives", async () => {
    const { b, args, handlers, files } = recorder();
    await b.start(args);
    const handle = await b.onOpen("screen", "video/webm");
    await b.onChunk(handle, new Uint8Array([1, 2, 3]), meta);
    const close = vi.spyOn(files.get(handle)!.fh, "close");
    const errors: Error[] = [];
    b.on("error", (e: Error) => errors.push(e));
    handlers["cw:stop"] = () => undefined;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const stopping = b.stop();
    await vi.advanceTimersByTimeAsync(20_001);
    await stopping;
    expect(close).toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it("a capture window that fails to load rejects prepare()", async () => {
    const { b, args } = recorder({ load: "fail" });
    await expect(b.prepare(args)).rejects.toThrow();
  });

  it("a capture window that never loads rejects prepare() after a timeout", async () => {
    const { b, args } = recorder({ load: "never" });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const prep = b.prepare(args);
    const settled = prep.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await settled).toBe("rejected");
  });

  it("a capture window that dies before it is ready rejects prepare()", async () => {
    const { b, args, handlers, window } = recorder();
    handlers["cw:prepare"] = () =>
      setImmediate(() =>
        window().webContents.emit(
          "render-process-gone",
          {},
          { reason: "crashed", exitCode: 1 },
        ),
      );
    await expect(b.prepare(args)).rejects.toThrow();
  });

  it("a capture window that dies while recording reports a crash and keeps the files for recovery", async () => {
    const { b, args, outDir, window } = recorder();
    await b.start(args);
    const handle = await b.onOpen("screen", "video/webm");
    await b.onChunk(handle, new Uint8Array([1, 2, 3]), meta);
    const crashed = new Promise<Error>((res) => b.once("crashed", res));
    window().webContents.emit(
      "render-process-gone",
      {},
      { reason: "crashed", exitCode: 1 },
    );
    const e = await crashed;
    expect(e).toBeInstanceOf(RecorderCrash);
    expect(window().destroyed).toBe(true);
    expect(existsSync(join(outDir, "screen.webm"))).toBe(true);
    expect(readFileSync(join(outDir, "session.jsonl"), "utf8")).not.toContain(
      '"cancelled"',
    );
    expect(typeof b.probe).toBe("function");
  });
});
