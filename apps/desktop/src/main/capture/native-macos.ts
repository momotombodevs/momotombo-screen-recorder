import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import type { BackendInfo } from "@momotombo/protocol";
import { msg } from "../../shared/i18n";
import { tm } from "../settings";
import {
  HelperClient,
  HelperError,
  prepareCommand,
  probeFiles,
  recordingResult,
  type HelperMessage,
  type ProbedFile,
} from "./helper-client";
import {
  RecorderCrash,
  type BackendResult,
  type BackendStartArgs,
  type CaptureBackend,
} from "./types";

export function helperPath(): string {
  if (app.isPackaged)
    return join(process.resourcesPath, "bin", "momotombo-recorder");
  return resolve(
    app.getAppPath(),
    "..",
    "..",
    "native",
    "recorder-macos",
    "bin",
    "momotombo-recorder",
  );
}

/** The helper's error codes in the user's language; unknown codes keep the helper's text. */
function describe(e: unknown): Error {
  if (!(e instanceof HelperError)) return e as Error;
  switch (e.code) {
    case "screen-permission":
      return new Error(
        tm(
          "Se necesita permiso de grabación de pantalla. Activa Momotombo en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y audio del sistema y luego reinicia Momotombo.",
        ),
      );
    case "camera-permission":
      return new Error(
        tm(
          "Sin permiso de cámara. Permite Momotombo en Ajustes del Sistema › Privacidad y seguridad › Cámara.",
        ),
      );
    case "mic-permission":
      return new Error(
        tm(
          "Sin permiso de micrófono. Permite Momotombo en Ajustes del Sistema › Privacidad y seguridad › Micrófono.",
        ),
      );
    case "display-not-found":
    case "window-not-found":
      return new Error(tm("La fuente seleccionada ya no está disponible."));
    case "camera-not-found":
      return new Error(tm("No se encontró la cámara seleccionada."));
    case "mic-not-found":
      return new Error(tm("No se encontró el micrófono seleccionado."));
    case "camera-busy":
    case "mic-busy":
      return new Error(
        tm("Otra app está usando la cámara o el micrófono."),
      );
    case "screen-start-timeout":
      return new Error(
        tm(
          "macOS no inició la captura de pantalla. Puede que la pantalla esté en reposo o que un aviso del sistema espere respuesta; revísalo e inténtalo de nuevo.",
        ),
      );
    case "screen-start":
      return new Error(
        tm("No se pudo iniciar la grabación de pantalla. {detail}", { detail: e.message }),
      );
    case "timeout":
      return new Error(
        tm("El asistente de grabación no respondió ({type}).", { type: e.message }),
      );
    case "exited":
      return new Error(
        tm("El asistente de grabación se cerró de forma inesperada ({detail}).", {
          detail: e.message,
        }),
      );
    default:
      return new Error(e.message);
  }
}

/**
 * Drives the Swift helper (ScreenCaptureKit + AVFoundation). The helper writes the screen
 * without the pointer, the camera, microphone and system audio into separate files, and a
 * pointer/click log, all on one clock. Sources open during the countdown ("prepare") and
 * recording begins on "go". Events: 'level', 'status', 'error', 'interrupted', 'crashed'
 * (the helper died while recording; its files can be recovered).
 */
export class NativeMacBackend extends EventEmitter implements CaptureBackend {
  private readonly available: boolean;
  private client: HelperClient | null = null;
  private args: BackendStartArgs | null = null;
  private prepared = false;
  private recording = false;

  constructor() {
    super();
    this.available = process.platform === "darwin" && existsSync(helperPath());
  }

  get info(): BackendInfo {
    const available = this.available;
    return {
      id: "native-macos",
      available,
      reason: available
        ? undefined
        : process.platform !== "darwin"
          ? msg("Solo macOS")
          : msg("El componente de grabación nativo de macOS no viene en esta versión."),
      capabilities: {
        separateCursor: true,
        clicks: true,
        systemAudio: true,
        pause: true,
      },
    };
  }

  private onMessage(m: HelperMessage): void {
    if (m.type === "status") {
      this.emit("level", m.micLevel, m.micPeak ?? m.micLevel);
      this.emit("status", { droppedFrames: m.dropped });
    } else if (m.type === "interrupted") {
      // macOS ended the screen stream (permission withdrawn, display gone, …): keep what was recorded.
      this.emit(
        "interrupted",
        new Error(
          tm(
            "macOS detuvo la grabación de pantalla; se conserva todo lo grabado hasta ese momento.",
          ),
        ),
      );
    } else if (m.type === "error") {
      // Non-fatal ones (busy, unknown-command) answer a command the helper ignored; the recording goes on.
      if (m.fatal)
        this.emit(
          "error",
          describe(new HelperError(m.code ?? "internal", m.message)),
        );
      else
        process.stderr.write(
          `momotombo-recorder: ${m.code ?? "internal"}: ${m.message}\n`,
        );
    }
  }

  /** Opens the screen, camera and microphone without recording (runs during the countdown). */
  async prepare(args: BackendStartArgs): Promise<void> {
    this.args = args;
    this.prepared = false;
    this.recording = false;
    const client = new HelperClient(helperPath());
    this.client = client;
    client.on("message", (m: HelperMessage) => this.onMessage(m));
    client.on("exit", (code: number | null, tail: string) => {
      if (this.client !== client) return;
      this.client = null;
      if (this.recording) {
        this.recording = false;
        this.emit(
          "crashed",
          new RecorderCrash(
            describe(
              new HelperError("exited", `${code}${tail ? `; ${tail}` : ""}`),
            ).message,
          ),
        );
      }
    });
    try {
      await client.open();
      const ready = client.waitFor("ready", 120_000); // macOS may be showing a permission dialog
      client.send(prepareCommand(args, process.pid));
      await ready;
      this.prepared = true;
    } catch (e) {
      client.close(500);
      if (this.client === client) this.client = null;
      throw describe(e);
    }
  }

  async start(args: BackendStartArgs): Promise<void> {
    if (!this.prepared || !this.client || this.args !== args)
      await this.prepare(args);
    const client = this.client;
    if (!client) throw describe(new HelperError("exited", "prepare"));
    try {
      const started = client.waitFor("started", 10_000);
      client.send({ cmd: "go" });
      await started;
      this.recording = true;
    } catch (e) {
      throw describe(e);
    }
  }

  async pause(): Promise<void> {
    this.client?.send({ cmd: "pause" });
  }
  async resume(): Promise<void> {
    this.client?.send({ cmd: "resume" });
  }
  mark(): void {
    this.client?.send({ cmd: "mark" });
  }

  async stop(): Promise<BackendResult> {
    const args = this.args;
    const client = this.client;
    if (!args || !client) throw describe(new HelperError("exited", "stop"));
    this.recording = false;
    try {
      const done = client.waitFor("stopped", 60_000);
      client.send({ cmd: "stop" });
      const m = (await done) as Extract<HelperMessage, { type: "stopped" }>;
      return recordingResult(m, args, "native-macos");
    } catch (e) {
      // Died while closing the files: what reached the disk can still be recovered.
      if (e instanceof HelperError && e.code === "exited")
        throw new RecorderCrash(describe(e).message);
      throw describe(e);
    } finally {
      client.close();
      this.client = null;
      this.prepared = false;
    }
  }

  probe(dir: string): Promise<ProbedFile[]> {
    return probeFiles(helperPath(), dir);
  }

  async cancel(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.prepared = false;
    this.recording = false;
    if (!client) return;
    client.send({ cmd: "cancel" });
    client.close(1500);
  }
}
