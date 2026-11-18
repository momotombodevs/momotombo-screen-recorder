import { EventEmitter } from "node:events";
import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { desktopCapturer, screen, type BrowserWindow } from "electron";
import { newId, type Rect, type Recording } from "@momotombo/project-model";
import type {
  BackendInfo,
  CaptureConfig,
  CaptureResult,
  CaptureState,
  RecoveryNotice,
  SourceInfo,
} from "@momotombo/protocol";
import { localeOf, msg } from "../../shared/i18n";
import {
  diskBudget,
  minutesLeft,
  recordingBytesPerSecond,
  stopBelowBytes,
  type DiskEstimate,
} from "../../shared/recording-budget";
import type { ProjectStore } from "../projects";
import { currentLang, tm } from "../settings";
import type { ProbedFile } from "./helper-client";
import { NativeMacBackend } from "./native-macos";
import {
  parseSessionLog,
  recoverAbandoned,
  recoverFolder,
  SESSION_FILE,
  type FolderResult,
  type ProjectEntry,
  type RecoveryDeps,
} from "./recovery";
import { RecorderCrash, type CaptureBackend } from "./types";
import { WebCaptureBackend } from "./web-backend";

export interface ManagerDeps {
  store: ProjectStore;
  createCaptureWindow: () => BrowserWindow;
  showHud: (displayBounds: Rect) => void;
  hideHud: (temporarily?: boolean) => void;
  /** A session begins (countdown starts): get our own windows out of the way. */
  onSessionStart?: (targetKind: "display" | "window" | "region") => void;
  /** Resolves once it is safe to record (e.g. minimize animations have finished). */
  beforeRecording?: () => Promise<void>;
  /** Free bytes on the volume holding `dir`. */
  diskFree?: (dir: string) => Promise<number>;
}

type Session = {
  projectId: string;
  recordingId: string;
  outDir: string;
  startedAt: number;
  bytesPerSecond: number;
};
type Recovered = Extract<FolderResult, { status: "recovered" }>;

const IDLE: CaptureState = {
  phase: "idle",
  backend: null,
  elapsedMs: 0,
  countdown: 0,
  hasMic: false,
  micLevel: 0,
  micPeak: 0,
  droppedFrames: 0,
  diskFreeBytes: null,
  diskMinutesLeft: null,
  devicesReady: false,
};

/**
 * Orchestrates one recording session: backend choice, countdown, status, saving into a project.
 * If the recorder dies, the recording is rebuilt from its files (recovery.ts), both right away
 * and, for sessions lost with the app itself, on the next start (recoverAbandoned).
 * Events: 'state', 'finished', 'recoveries' (RecoveryNotice[]), 'releaseDevices', 'recordingStarted'.
 */
export class CaptureManager extends EventEmitter {
  state: CaptureState = { ...IDLE };
  readonly web: WebCaptureBackend;
  readonly native: NativeMacBackend;
  private active: CaptureBackend | null = null;
  private session: Session | null = null;
  /** Recordings rebuilt after a crash that the user has not dismissed yet. */
  private recovered: (Recovered & { projectName: string })[] = [];
  private statusTimer: NodeJS.Timeout | null = null;
  private elapsedBase = 0;
  private runningSince = 0;
  /** Shown after the session ends (for example why it stopped early). */
  private notice: string | undefined;
  /** Bumped by every start and cancel: a start() whose number is no longer current stops at its next await. */
  private attempt = 0;
  private toggling = false;
  private peakSinceTick = 0;

  constructor(private readonly deps: ManagerDeps) {
    super();
    this.web = new WebCaptureBackend(deps.createCaptureWindow);
    this.native = new NativeMacBackend();
    for (const b of [this.web, this.native] as CaptureBackend[]) {
      b.on("level", (rms: number, peak: number) => {
        this.state.micLevel = rms;
        this.peakSinceTick = Math.max(this.peakSinceTick, peak);
      });
      b.on("status", (s: { droppedFrames: number }) => {
        this.state.droppedFrames = s.droppedFrames;
      });
      b.on("error", (e: Error) => this.backendFailed(b, e));
      b.on("crashed", (e: Error) => {
        if (b === this.active) void this.crashed(e);
      });
      b.on("interrupted", (e: Error) => {
        if (b === this.active) this.interrupted(e);
      });
      b.on("releaseDevices", () => this.emit("releaseDevices"));
    }
  }

  backends(): BackendInfo[] {
    return [this.native.info, this.web.info];
  }

  private set(patch: Partial<CaptureState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  async listSources(): Promise<SourceInfo[]> {
    const displays = screen.getAllDisplays();
    const primaryId = String(screen.getPrimaryDisplay().id);
    const isPrimary = (s: SourceInfo) =>
      s.kind === "display" && s.displayId === primaryId;
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: true,
    });
    return (
      sources
        .map((s): SourceInfo => {
          const isScreen = s.id.startsWith("screen:");
          const d = isScreen
            ? (displays.find((x) => String(x.id) === s.display_id) ??
              displays[0])
            : undefined;
          return {
            id: s.id,
            kind: isScreen ? "display" : "window",
            name: s.name,
            displayId: s.display_id || undefined,
            thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
            appIcon:
              s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
            bounds: d
              ? {
                  x: d.bounds.x,
                  y: d.bounds.y,
                  w: d.bounds.width,
                  h: d.bounds.height,
                }
              : undefined,
            scaleFactor: d?.scaleFactor,
          };
        })
        .filter(
          (s) => s.kind === "display" || !/^(Momotombo|Electron)$/.test(s.name),
        )
        // The main display first: the recording screen preselects the first entry, and the
        // pointer is usually on the main display (recording another screen leaves no zooms).
        .sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)))
    );
  }

  private pickBackend(config: CaptureConfig): CaptureBackend {
    if (config.backend === "web") return this.web;
    if (config.backend === "native") {
      if (!this.native.info.available)
        throw new Error(
          tm(this.native.info.reason ?? msg("La grabación nativa no está disponible")),
        );
      return this.native;
    }
    return this.native.info.available ? this.native : this.web;
  }

  private async freeBytes(dir: string): Promise<number | null> {
    try {
      if (this.deps.diskFree) return await this.deps.diskFree(dir);
      const s = await statfs(dir);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  private bytesPerSecond(config: CaptureConfig, backend: CaptureBackend): number {
    const t = config.target;
    const display =
      screen.getAllDisplays().find((d) => String(d.id) === t.displayId) ??
      screen.getPrimaryDisplay();
    const area =
      t.kind === "region" && t.region
        ? t.region.w * t.region.h
        : display.bounds.width * display.bounds.height;
    return recordingBytesPerSecond({
      backend: backend.info.id,
      quality: config.quality,
      fps: config.fps,
      pixels: area * display.scaleFactor ** 2,
      camera: config.cameraDeviceId !== null,
      mic: config.micDeviceId !== null,
      systemAudio: config.systemAudio,
    });
  }

  async diskEstimate(config: CaptureConfig): Promise<DiskEstimate> {
    let backend: CaptureBackend;
    try {
      backend = this.pickBackend(config);
    } catch {
      backend = this.web;
    }
    const free = await this.freeBytes(this.deps.store.root);
    if (free === null) return { level: "unknown", freeBytes: null, minutesLeft: null };
    return { ...diskBudget(free, this.bytesPerSecond(config, backend)), freeBytes: free };
  }

  async start(config: CaptureConfig): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error")
      throw new Error(tm("Ya hay una grabación en curso"));
    const backend = this.pickBackend(config);
    const attempt = ++this.attempt;
    const live = () => this.attempt === attempt;
    this.set({
      ...IDLE,
      phase: "preparing",
      backend: backend.info.id,
      hasMic: config.micDeviceId !== null,
    });
    let backendTouched = false;
    try {
      const disk = await this.diskEstimate(config);
      if (!live()) return;
      if (disk.level === "insufficient")
        throw new Error(
          tm("No hay suficiente espacio en disco para grabar. Libera espacio e inténtalo de nuevo."),
        );
      const store = this.deps.store;
      const projectId =
        config.projectId ??
        (await store.create(config.projectName?.trim() || defaultProjectName()))
          .id;
      if (!live()) return;
      const recordingId = newId("rec");
      const outDir = await store.mediaDir(projectId, recordingId);
      if (!live()) return;
      const displays = screen.getAllDisplays();
      const t = config.target;
      const display =
        displays.find((d) => String(d.id) === t.displayId) ??
        screen.getPrimaryDisplay();
      const displayBounds = {
        x: display.bounds.x,
        y: display.bounds.y,
        w: display.bounds.width,
        h: display.bounds.height,
      };
      const targetBounds =
        t.kind === "region" && t.region
          ? {
              x: displayBounds.x + t.region.x,
              y: displayBounds.y + t.region.y,
              w: t.region.w,
              h: t.region.h,
            }
          : displayBounds;
      this.session = {
        projectId,
        recordingId,
        outDir,
        startedAt: Date.now(),
        bytesPerSecond: this.bytesPerSecond(config, backend),
      };

      const args = {
        config,
        outDir,
        recordingId,
        targetBounds,
        displayBounds,
        scaleFactor: display.scaleFactor,
      };
      this.deps.showHud(displayBounds);
      this.deps.onSessionStart?.(t.kind);
      this.active = backend;
      backendTouched = true;
      // Devices open and warm up while the countdown runs, so recording starts on good frames.
      let prepError: Error | null = null;
      let prepDone = false;
      const prep = (backend.prepare ? backend.prepare(args) : Promise.resolve())
        .then(() => {
          prepDone = true;
          if (live()) this.set({ devicesReady: true });
        })
        .catch((e: Error) => {
          prepError = e;
          prepDone = true;
        });
      for (let n = config.countdown; n > 0; n--) {
        this.set({ phase: "countdown", countdown: n });
        await new Promise((r) => setTimeout(r, 1000));
        if (!live()) return void this.releaseStale(backend, prep);
        if (prepError) throw prepError;
      }
      if (!prepDone)
        this.set({
          phase: "preparing",
          countdown: 0,
          message: tm("Preparando la cámara…"),
        });
      await prep;
      if (!live()) return void this.releaseStale(backend);
      if (prepError) throw prepError;
      await this.deps.beforeRecording?.();
      if (!live()) return void this.releaseStale(backend);
      // Chromium capture on macOS would record our own HUD; hide it and rely on tray + shortcuts.
      if (backend === this.web && process.platform === "darwin")
        this.deps.hideHud(true);
      await backend.start(args);
      if (!live()) return void this.releaseStale(backend);
      this.elapsedBase = 0;
      this.runningSince = Date.now();
      this.set({ phase: "recording", countdown: 0, message: undefined });
      this.emit("recordingStarted", config.target.kind);
      this.statusTimer = setInterval(() => void this.tick(), 250);
    } catch (e) {
      if (!live()) {
        if (backendTouched) void this.releaseStale(backend);
        return;
      }
      this.attempt++;
      await this.active?.cancel().catch(() => undefined);
      this.active = null;
      this.session = null;
      this.deps.hideHud();
      this.fail(e as Error);
      throw e;
    }
  }

  /**
   * A cancelled start() may have opened devices after cancel() closed them (cancel ran while
   * prepare or start was in flight). Closes them again unless a newer session now owns the backend.
   */
  private async releaseStale(
    backend: CaptureBackend,
    pending?: Promise<void>,
  ): Promise<void> {
    await pending;
    if (this.active !== backend) await backend.cancel().catch(() => undefined);
  }

  private async tick(): Promise<void> {
    const running =
      this.state.phase === "recording" ? Date.now() - this.runningSince : 0;
    const session = this.session;
    const diskFreeBytes =
      (session && (await this.freeBytes(session.outDir))) ??
      this.state.diskFreeBytes;
    const micPeak = this.peakSinceTick;
    this.peakSinceTick = 0;
    this.set({
      elapsedMs: this.elapsedBase + running,
      micPeak,
      diskFreeBytes,
      diskMinutesLeft:
        session && diskFreeBytes !== null
          ? minutesLeft(diskFreeBytes, session.bytesPerSecond)
          : null,
    });
    if (
      session &&
      diskFreeBytes !== null &&
      diskFreeBytes < stopBelowBytes(session.bytesPerSecond) &&
      this.state.phase === "recording"
    ) {
      this.set({
        message: tm("Queda poco espacio en disco; deteniendo la grabación de forma segura."),
      });
      void this.stop();
    }
  }

  async pause(): Promise<void> {
    const backend = this.active;
    if (!backend || this.state.phase !== "recording" || this.toggling) return;
    this.toggling = true;
    const at = Date.now();
    try {
      await backend.pause();
    } finally {
      this.toggling = false;
    }
    if (this.active !== backend || this.state.phase !== "recording") return;
    this.elapsedBase += at - this.runningSince;
    this.set({ phase: "paused" });
  }

  async resume(): Promise<void> {
    const backend = this.active;
    if (!backend || this.state.phase !== "paused" || this.toggling) return;
    this.toggling = true;
    try {
      await backend.resume();
    } finally {
      this.toggling = false;
    }
    if (this.active !== backend || this.state.phase !== "paused") return;
    this.runningSince = Date.now();
    this.set({ phase: "recording" });
  }

  mark(): void {
    if (this.state.phase === "recording") this.active?.mark();
  }

  async stop(): Promise<CaptureResult | null> {
    const backend = this.active;
    const session = this.session;
    if (!session || this.state.phase === "finishing") return null;
    if (
      !backend ||
      this.state.phase === "countdown" ||
      this.state.phase === "preparing"
    ) {
      // Stopped before recording began: nothing to keep.
      if (backend) {
        await this.cancel();
        return null;
      }
      this.attempt++;
      this.session = null;
      this.deps.hideHud();
      this.set({ ...IDLE });
      return null;
    }
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.set({ phase: "finishing" });
    let failure: Error | null = null;
    try {
      const r = await backend.stop();
      const recording: Recording = {
        id: session.recordingId,
        createdAt: new Date(session.startedAt).toISOString(),
        duration: r.durationTicks,
        sources: r.sources,
        cursorFile: r.cursorFile,
        capture: {
          ...r.capture,
          platform: `${process.platform}-${process.arch}`,
        },
        syncOffsets: {},
        markers: r.markers,
      };
      if (!recording.sources.screen)
        throw new Error(tm("No se generó ninguna grabación de pantalla."));
      await this.deps.store.appendRecording(session.projectId, recording);
      const result = {
        projectId: session.projectId,
        recordingId: session.recordingId,
      };
      this.emit("finished", result);
      return result;
    } catch (e) {
      if (e instanceof RecorderCrash) {
        try {
          return await this.recoverSession(session, backend, e);
        } catch (err) {
          failure = err as Error;
          return null;
        }
      }
      failure = e as Error;
      return null;
    } finally {
      this.active = null;
      this.session = null;
      this.deps.hideHud();
      if (failure) this.fail(failure);
      else this.set({ ...IDLE, message: this.notice });
      this.notice = undefined;
    }
  }

  async cancel(): Promise<void> {
    this.attempt++;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    await this.active?.cancel().catch(() => undefined);
    this.active = null;
    this.session = null;
    this.deps.hideHud();
    this.set({ ...IDLE });
  }

  /** The recorder died while recording: rebuild the recording from what reached the disk. */
  private async crashed(e: Error): Promise<void> {
    const session = this.session;
    const backend = this.active;
    const phase = this.state.phase;
    if (!session || !backend || (phase !== "recording" && phase !== "paused"))
      return;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.set({
      phase: "finishing",
      message: tm("El asistente de grabación se cerró; recuperando la grabación…"),
    });
    let failure: Error | null = null;
    try {
      await this.recoverSession(session, backend, e);
    } catch (err) {
      failure = err as Error;
    } finally {
      this.active = null;
      this.session = null;
      this.deps.hideHud();
      if (failure) this.fail(failure);
      else this.set({ ...IDLE });
    }
  }

  private async recoverSession(
    session: Session,
    backend: CaptureBackend,
    cause: Error,
  ): Promise<CaptureResult> {
    if (!backend.probe) throw cause;
    const r = await recoverFolder(
      session.projectId,
      session.outDir,
      session.recordingId,
      this.recoveryDeps(backend.probe.bind(backend), true),
    );
    if (r.status !== "recovered")
      throw new Error(
        tm(
          "El asistente de grabación se cerró de forma inesperada; no quedó video para recuperar.",
        ),
      );
    await this.noteRecovered(r);
    const result = {
      projectId: session.projectId,
      recordingId: session.recordingId,
    };
    this.emit("finished", result);
    return result;
  }

  /** `ownSession`: the folder of the session that just ended, whose helper is known to be gone. */
  private recoveryDeps(
    probe: (dir: string) => Promise<ProbedFile[]>,
    ownSession = false,
  ): RecoveryDeps {
    const store = this.deps.store;
    return {
      probe,
      hasRecording: async (projectId, recordingId) =>
        recordingId in (await store.read(projectId)).recordings,
      appendRecording: (projectId, recording) =>
        store.appendRecording(projectId, recording),
      platform: `${process.platform}-${process.arch}`,
      fallbackLabel: tm("Grabación recuperada"),
      ...(ownSession
        ? { isAlive: () => false }
        : { isBusy: (dir: string) => this.session?.outDir === dir }),
    };
  }

  /**
   * Finds recordings left on disk by a recorder (or app) that stopped unexpectedly and adds
   * them to their projects. Runs once at start. Files of the browser recording path are
   * measured here (webm-probe.ts); native ones by the native helper, when it is present.
   */
  async recoverAbandoned(): Promise<void> {
    const store = this.deps.store;
    const projects: ProjectEntry[] = [];
    for (const { id, dir } of await store.entries()) {
      try {
        projects.push({
          id,
          dir,
          recordingIds: new Set(Object.keys((await store.read(id)).recordings)),
        });
      } catch {
        /* unreadable project */
      }
    }
    const probe = async (dir: string): Promise<ProbedFile[]> => {
      const log = parseSessionLog(
        await readFile(join(dir, SESSION_FILE), "utf8"),
      );
      if (log?.meta?.backend === "web") return this.web.probe(dir);
      // Thrown before anything is written: the folder is tried again when the helper is there.
      if (!this.native.info.available)
        throw new Error("native helper not available");
      return this.native.probe(dir);
    };
    const results = await recoverAbandoned(
      projects,
      this.recoveryDeps(probe),
      (dir, e) => {
        process.stderr.write(`Recovery failed (${dir}): ${String(e)}\n`);
      },
    );
    for (const r of results)
      if (r.status === "recovered") await this.noteRecovered(r);
  }

  private async noteRecovered(r: Recovered): Promise<void> {
    let projectName = "";
    try {
      projectName = (await this.deps.store.read(r.projectId)).name;
    } catch {
      /* shown without a name */
    }
    this.recovered = [
      ...this.recovered.filter((x) => x.recordingId !== r.recordingId),
      { ...r, projectName },
    ];
    this.emit("recoveries", this.recoveryNotices());
  }

  /** Built on every read so the text follows the current language. */
  recoveryNotices(): RecoveryNotice[] {
    const seconds = new Intl.NumberFormat(localeOf(currentLang()), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return this.recovered.map((r) => ({
      projectId: r.projectId,
      recordingId: r.recordingId,
      recoveredMs: r.recoveredMs,
      message: tm(
        "La grabación se interrumpió; se recuperaron {seconds} s y se añadieron a “{project}”.",
        {
          seconds: seconds.format(r.recoveredMs / 1000),
          project: r.projectName,
        },
      ),
    }));
  }

  dismissRecovery(recordingId: string): void {
    this.recovered = this.recovered.filter(
      (r) => r.recordingId !== recordingId,
    );
    this.emit("recoveries", this.recoveryNotices());
  }

  /** The system ended the capture: save what was recorded and say why it stopped. */
  private interrupted(e: Error): void {
    if (this.state.phase !== "recording" && this.state.phase !== "paused")
      return;
    this.notice = e.message;
    void this.stop();
  }

  /**
   * Backends report only errors the recording cannot survive. While recording, what reached the
   * disk is kept, as for an interruption; during the countdown the start is abandoned; while the
   * files are being saved the message is shown once the session has ended.
   */
  private backendFailed(backend: CaptureBackend, e: Error): void {
    if (backend !== this.active) return;
    const phase = this.state.phase;
    if (phase === "recording" || phase === "paused") {
      this.notice = e.message;
      void this.stop();
    } else if (phase === "finishing") {
      this.notice ??= e.message;
    } else if (phase === "preparing" || phase === "countdown") {
      this.attempt++;
      this.active = null;
      this.session = null;
      void backend.cancel().catch(() => undefined);
      this.deps.hideHud();
      this.fail(e);
    }
  }

  private fail(e: Error): void {
    this.set({ phase: "error", message: e.message });
  }

  resetError(): void {
    if (this.state.phase === "error") this.set({ ...IDLE });
  }
}

function defaultProjectName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return tm("Grabación {date}", {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`,
  });
}
