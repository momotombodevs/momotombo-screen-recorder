import type { Transition } from "./easing";
import { sortedByStart, sortedByTime } from "./sorting";
import type {
  Background,
  CameraLayout,
  CameraLayoutItem,
  CursorStyle,
  FrameStyle,
  MagnifierItem,
  MagnifierStyle,
  PrivacyItem,
  Project,
  Recording,
  Sequence,
  Style,
  Variant,
  ZoomItem,
} from "./types";
import { MAX_AUDIO_GAIN } from "./types";

export class ProjectFormatError extends Error {}

type Obj = Record<string, unknown>;
type Check = (v: unknown, path: string) => void;

function fail(path: string, why = ""): never {
  throw new ProjectFormatError(
    `Campo no válido: ${path}${why ? ` (${why})` : ""}`,
  );
}

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) fail(path, "no es un objeto");
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "no es una lista");
  return v;
}

interface NumRange {
  min?: number;
  max?: number;
  above?: number;
  int?: boolean;
}

function num(v: unknown, path: string, r: NumRange = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    fail(path, "no es un número finito");
  if (r.int && !Number.isInteger(v)) fail(path, "no es un número entero");
  if (r.min !== undefined && v < r.min) fail(path, `menor que ${r.min}`);
  if (r.max !== undefined && v > r.max) fail(path, `mayor que ${r.max}`);
  if (r.above !== undefined && v <= r.above)
    fail(path, `debe ser mayor que ${r.above}`);
  return v;
}

const tick = (v: unknown, path: string, min = -Number.MAX_SAFE_INTEGER) =>
  num(v, path, { min, max: Number.MAX_SAFE_INTEGER });

function str(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, "no es texto");
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "no es verdadero/falso");
  return v;
}

function oneOf<T extends string>(
  v: unknown,
  path: string,
  values: readonly T[],
): T {
  if (!values.includes(v as T)) fail(path, `debe ser ${values.join(" | ")}`);
  return v as T;
}

function optional(o: Obj, key: string, path: string, check: Check): void {
  if (o[key] !== undefined) check(o[key], `${path}.${key}`);
}

function vec(v: unknown, path: string): void {
  const o = obj(v, path);
  num(o.x, `${path}.x`);
  num(o.y, `${path}.y`);
}

function rect(v: unknown, path: string, positive = false): void {
  const o = obj(v, path);
  num(o.x, `${path}.x`);
  num(o.y, `${path}.y`);
  num(o.w, `${path}.w`, positive ? { above: 0 } : {});
  num(o.h, `${path}.h`, positive ? { above: 0 } : {});
}

function fields(
  spec: Record<string, Check>,
  v: unknown,
  path: string,
  partial = false,
): void {
  const o = obj(v, path);
  for (const [key, check] of Object.entries(spec)) {
    if (partial && o[key] === undefined) continue;
    check(o[key], `${path}.${key}`);
  }
}

const border: Check = (v, p) =>
  fields({ width: (x, q) => num(x, q, { min: 0 }), color: str }, v, p);

const unit: NumRange = { min: 0, max: 1 };

function easing(v: unknown, path: string): void {
  const e = obj(v, path);
  switch (
    oneOf(e.kind, `${path}.kind`, [
      "preset",
      "bezier",
      "spring",
      "linear",
      "instant",
    ] as const)
  ) {
    case "preset":
      oneOf(e.name, `${path}.name`, ["smooth", "fast"] as const);
      break;
    case "bezier":
      num(e.x1, `${path}.x1`, unit);
      num(e.y1, `${path}.y1`);
      num(e.x2, `${path}.x2`, unit);
      num(e.y2, `${path}.y2`);
      break;
    case "spring":
      num(e.zeta, `${path}.zeta`, { above: 0 });
      num(e.omega, `${path}.omega`, { above: 0 });
      break;
    default:
      break;
  }
}

function transition(v: unknown, path: string): asserts v is Transition {
  const o = obj(v, path);
  tick(o.duration, `${path}.duration`, 0);
  easing(o.easing, `${path}.easing`);
}

const FRAME_FIELDS: Record<keyof FrameStyle, Check> = {
  padding: (v, p) => num(v, p, { min: 0, max: 0.5 }),
  radius: (v, p) => num(v, p, { min: 0 }),
  shadow: (v, p) =>
    fields(
      { opacity: num, blur: (x, q) => num(x, q, { min: 0 }), offsetY: num },
      v,
      p,
    ),
  border,
  aspectMode: (v, p) => oneOf(v, p, ["source", "fill"] as const),
  area: (v, p) => rect(v, p, true),
};

const CAMERA_FIELDS: Record<keyof CameraLayout, Check> = {
  visible: bool,
  position: vec,
  size: (v, p) => num(v, p, { above: 0 }),
  shape: (v, p) =>
    oneOf(v, p, [
      "circle",
      "square",
      "rounded",
      "rect",
      "free",
      "squircle",
    ] as const),
  aspect: (v, p) => num(v, p, { above: 0 }),
  cornerRadius: num,
  border,
  shadow: (v, p) =>
    fields({ opacity: num, blur: (x, q) => num(x, q, { min: 0 }) }, v, p),
  mirror: bool,
  zoom: (v, p) => num(v, p, { above: 0 }),
};

const CURSOR_FIELDS: Record<keyof CursorStyle, Check> = {
  visible: bool,
  scale: (v, p) => num(v, p, { above: 0 }),
  smoothing: num,
  clickEffect: (v, p) => oneOf(v, p, ["none", "ring", "pulse"] as const),
  hideWhenIdle: bool,
};

const MAGNIFIER_FIELDS: Record<keyof MagnifierStyle, Check> = {
  size: num,
  zoom: num,
  shape: (v, p) => oneOf(v, p, ["circle", "rounded"] as const),
  border,
  hideWhenIdle: bool,
};

function background(v: unknown, path: string): asserts v is Background {
  const b = obj(v, path);
  switch (
    oneOf(b.kind, `${path}.kind`, [
      "solid",
      "gradient",
      "aurora",
      "image",
    ] as const)
  ) {
    case "solid":
      str(b.color, `${path}.color`);
      break;
    case "gradient":
      str(b.from, `${path}.from`);
      str(b.to, `${path}.to`);
      num(b.angle, `${path}.angle`);
      break;
    case "aurora": {
      const colors = arr(b.colors, `${path}.colors`);
      if (colors.length !== 4) fail(`${path}.colors`, "debe tener 4 colores");
      colors.forEach((c, i) => str(c, `${path}.colors[${i}]`));
      num(b.seed, `${path}.seed`);
      num(b.grain, `${path}.grain`);
      break;
    }
    case "image":
      str(b.file, `${path}.file`);
      num(b.blur, `${path}.blur`, { min: 0 });
      break;
  }
}

export function validateStyle(v: unknown, path = "style"): asserts v is Style {
  const s = obj(v, path);
  background(s.background, `${path}.background`);
  fields(FRAME_FIELDS, s.frame, `${path}.frame`);
  fields(CAMERA_FIELDS, s.camera, `${path}.camera`);
  fields(CURSOR_FIELDS, s.cursor, `${path}.cursor`);
  fields(MAGNIFIER_FIELDS, s.magnifier, `${path}.magnifier`);
  fields(
    {
      scale: (x, q) => num(x, q, { above: 0 }),
      enter: transition,
      exit: transition,
    },
    s.zoomDefaults,
    `${path}.zoomDefaults`,
  );
}

const SOURCE_FIELDS: Record<string, Check> = {
  kind: str,
  file: str,
  mime: str,
  startOffset: tick,
  duration: (v, p) => tick(v, p, 0),
};
const OPTIONAL_SOURCE_FIELDS = [
  "width",
  "height",
  "displayAspect",
  "fps",
  "sampleRate",
  "channels",
] as const;

function validateRecording(v: unknown, path: string): asserts v is Recording {
  const r = obj(v, path);
  str(r.id, `${path}.id`);
  str(r.createdAt, `${path}.createdAt`);
  tick(r.duration, `${path}.duration`, 0);
  const sources = obj(r.sources, `${path}.sources`);
  for (const [kind, src] of Object.entries(sources)) {
    const sp = `${path}.sources.${kind}`;
    fields(SOURCE_FIELDS, src, sp);
    for (const key of OPTIONAL_SOURCE_FIELDS)
      optional(src as Obj, key, sp, (x, q) => num(x, q, { min: 0 }));
  }
  optional(r, "cursorFile", path, str);
  const capture = obj(r.capture, `${path}.capture`);
  str(capture.backend, `${path}.capture.backend`);
  str(capture.platform, `${path}.capture.platform`);
  fields(
    {
      kind: str,
      label: str,
      bounds: (x, q) => rect(x, q),
      scaleFactor: (x, q) => num(x, q, { above: 0 }),
    },
    capture.target,
    `${path}.capture.target`,
  );
  bool(capture.cursorInFrames, `${path}.capture.cursorInFrames`);
  bool(capture.hasClicks, `${path}.capture.hasClicks`);
  optional(capture, "crop", `${path}.capture`, (x, q) => rect(x, q, true));
  for (const [kind, offset] of Object.entries(
    obj(r.syncOffsets, `${path}.syncOffsets`),
  ))
    tick(offset, `${path}.syncOffsets.${kind}`);
  arr(r.markers, `${path}.markers`).forEach((m, i) =>
    tick(m, `${path}.markers[${i}]`),
  );
}

export function validateRecordings(
  v: unknown,
): asserts v is Project["recordings"] {
  for (const [id, r] of Object.entries(obj(v, "recordings")))
    validateRecording(r, `recordings.${id}`);
}

const FPS_RANGE = { min: 1, max: 1000 };

export function validateSequence(
  v: unknown,
  recordings: Project["recordings"],
): asserts v is Sequence {
  const seq = obj(v, "sequence");
  const fps = obj(seq.fps, "sequence.fps");
  const n = num(fps.num, "sequence.fps.num", { int: true, min: 1 });
  const d = num(fps.den, "sequence.fps.den", { int: true, min: 1 });
  if (n / d < FPS_RANGE.min || n / d > FPS_RANGE.max)
    fail(
      "sequence.fps",
      `debe estar entre ${FPS_RANGE.min} y ${FPS_RANGE.max} cuadros por segundo`,
    );
  arr(seq.segments, "sequence.segments").forEach((s, i) => {
    const path = `sequence.segments[${i}]`;
    const o = obj(s, path);
    str(o.id, `${path}.id`);
    if (!Object.hasOwn(recordings, str(o.recordingId, `${path}.recordingId`)))
      fail(`${path}.recordingId`, "la grabación no existe");
    const start = tick(o.sourceStart, `${path}.sourceStart`, 0);
    const end = tick(o.sourceEnd, `${path}.sourceEnd`, 0);
    if (end <= start) fail(path, "sourceEnd debe ser posterior a sourceStart");
  });
}

function itemBase(v: unknown, path: string, type: string): Obj {
  const o = obj(v, path);
  if (o.type !== type) fail(`${path}.type`, `debe ser ${type}`);
  str(o.id, `${path}.id`);
  str(o.recordingId, `${path}.recordingId`);
  const start = tick(o.start, `${path}.start`);
  const end = tick(o.end, `${path}.end`);
  if (end <= start) fail(path, "end debe ser posterior a start");
  oneOf(o.origin, `${path}.origin`, ["auto", "manual"] as const);
  return o;
}

function zoomItem(v: unknown, path: string): ZoomItem {
  const o = itemBase(v, path, "zoom");
  oneOf(o.mode, `${path}.mode`, ["region", "follow"] as const);
  vec(o.center, `${path}.center`);
  num(o.scale, `${path}.scale`, { above: 0 });
  transition(o.enter, `${path}.enter`);
  transition(o.exit, `${path}.exit`);
  optional(o, "confidence", path, num);
  return o as unknown as ZoomItem;
}

function cameraItem(v: unknown, path: string): CameraLayoutItem {
  const o = itemBase(v, path, "camera");
  fields(CAMERA_FIELDS, o.layout, `${path}.layout`);
  transition(o.enter, `${path}.enter`);
  optional(o, "second", path, (x, q) =>
    fields({ position: vec, size: (y, r) => num(y, r, { above: 0 }) }, x, q),
  );
  optional(o, "split", path, num);
  return o as unknown as CameraLayoutItem;
}

function privacyEffect(v: unknown, path: string): void {
  const e = obj(v, path);
  switch (
    oneOf(e.kind, `${path}.kind`, [
      "solid",
      "frosted",
      "blur",
      "pixelate",
    ] as const)
  ) {
    case "solid":
      str(e.color, `${path}.color`);
      break;
    case "blur":
      num(e.strength, `${path}.strength`, { min: 0 });
      break;
    case "pixelate":
      num(e.block, `${path}.block`, { above: 0 });
      break;
    default:
      break;
  }
}

function privacyItem(v: unknown, path: string): PrivacyItem {
  const o = itemBase(v, path, "privacy");
  rect(o.region, `${path}.region`);
  const keyframes =
    o.keyframes === undefined ? [] : arr(o.keyframes, `${path}.keyframes`);
  keyframes.forEach((k, i) => {
    const kp = `${path}.keyframes[${i}]`;
    const ko = obj(k, kp);
    tick(ko.t, `${kp}.t`);
    rect(ko.region, `${kp}.region`);
  });
  privacyEffect(o.effect, `${path}.effect`);
  num(o.cornerRadius, `${path}.cornerRadius`);
  num(o.padFrames, `${path}.padFrames`, { min: 0, max: 1000 });
  const item = o as unknown as PrivacyItem;
  const sorted = sortedByTime(keyframes as PrivacyItem["keyframes"]);
  return sorted === o.keyframes ? item : { ...item, keyframes: sorted };
}

function magnifierItem(v: unknown, path: string): MagnifierItem {
  const o = itemBase(v, path, "magnifier");
  num(o.size, `${path}.size`);
  num(o.zoom, `${path}.zoom`);
  return o as unknown as MagnifierItem;
}

function items<T extends { start: number }>(
  v: unknown,
  key: string,
  item: (v: unknown, path: string) => T,
): T[] {
  if (v === undefined) return [];
  const list = arr(v, key);
  const checked = list.map((it, i) => item(it, `${key}[${i}]`));
  return sortedByStart(
    checked.every((it, i) => it === list[i]) ? (list as T[]) : checked,
  );
}

export const validateZooms = (v: unknown) => items(v, "zooms", zoomItem);
export const validateCameraLayouts = (v: unknown) =>
  items(v, "cameraLayouts", cameraItem);
export const validatePrivacy = (v: unknown) => items(v, "privacy", privacyItem);
export const validateMagnifiers = (v: unknown) =>
  items(v, "magnifiers", magnifierItem);

const MAX_OUTPUT_SIDE = 16384;

export function validateVariants(v: unknown): asserts v is Variant[] {
  arr(v, "variants").forEach((x, i) => {
    const path = `variants[${i}]`;
    const o = obj(x, path);
    str(o.id, `${path}.id`);
    str(o.name, `${path}.name`);
    num(o.width, `${path}.width`, { min: 1, max: MAX_OUTPUT_SIDE });
    num(o.height, `${path}.height`, { min: 1, max: MAX_OUTPUT_SIDE });
    optional(o, "frameOverride", path, (y, q) =>
      fields(FRAME_FIELDS, y, q, true),
    );
    optional(o, "cameraOverride", path, (y, q) =>
      fields(CAMERA_FIELDS, y, q, true),
    );
    optional(o, "zoomStrength", path, (y, q) => num(y, q, { min: 0 }));
  });
}

const range = (min: number, max: number): Check => (x, q) => num(x, q, { min, max });

const channel: Check = (v, p) =>
  fields(
    {
      gain: (x, q) => num(x, q, { min: 0, max: MAX_AUDIO_GAIN }),
      muted: bool,
      highpassHz: (x, q) => num(x, q, { min: 0, max: 1000 }),
      compressor: (x, q) =>
        fields({ enabled: bool, thresholdDb: range(-60, 0), ratio: range(1, 20) }, x, q),
      gate: (x, q) => fields({ enabled: bool, thresholdDb: range(-100, 0) }, x, q),
      normalize: (x, q) =>
        fields(
          {
            enabled: bool,
            targetLufs: range(-40, -5),
            measuredLufs: (y, r) => {
              if (y !== null) num(y, r, { min: -120, max: 20 });
            },
          },
          x,
          q,
        ),
    },
    v,
    p,
  );

export function validateAudio(v: unknown): asserts v is Project["audio"] {
  fields({ mic: channel, system: channel }, v, "audio");
}

export function validateZoomEngine(
  v: unknown,
): asserts v is Project["zoomEngine"] {
  const o = obj(v, "zoomEngine");
  oneOf(o.sensitivity, "zoomEngine.sensitivity", [
    "low",
    "medium",
    "high",
  ] as const);
  optional(o, "engineVersion", "zoomEngine", str);
}
