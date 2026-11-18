import { deepMerge, type DeepPartial } from "./commands";
import { MAGNIFIER_LIMITS, defaultAudio, defaultStyle, defaultVariants } from "./factory";
import type { Project } from "./types";
import { MAX_AUDIO_GAIN, SCHEMA_VERSION } from "./types";
import {
  ProjectFormatError,
  type FormatRule,
  isObj,
  validateAudio,
  validateCameraLayouts,
  validateMagnifiers,
  validatePrivacy,
  validateRecordings,
  validateSequence,
  validateStyle,
  validateTexts,
  validateVariants,
  validateZoomEngine,
  validateZooms,
} from "./validate";

export { ProjectFormatError, type FormatRule };

/**
 * Validates and normalizes a parsed project.json. Missing optional sections are filled
 * with defaults so older files keep opening; anything the evaluator could not draw
 * (wrong types, non-finite or out-of-range numbers, empty ranges) throws ProjectFormatError
 * naming the field.
 */
const intoRange = (v: unknown, r: { min: number; max: number }) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : v;

export function parseProject(json: unknown): Project {
  if (!isObj(json))
    throw new ProjectFormatError("El archivo del proyecto no es un objeto.");
  const schema = json.schema;
  if (schema !== SCHEMA_VERSION)
    throw new ProjectFormatError(
      `Esquema de proyecto no compatible: ${String(schema)}`,
    );
  for (const key of ["id", "name"] as const) {
    if (typeof json[key] !== "string")
      throw new ProjectFormatError(`Falta el campo: ${key}`);
  }
  if (!isObj(json.recordings))
    throw new ProjectFormatError("Falta el campo: recordings");
  validateRecordings(json.recordings);
  validateSequence(json.sequence, json.recordings);

  const variants =
    Array.isArray(json.variants) && json.variants.length > 0
      ? json.variants
      : defaultVariants();
  validateVariants(variants);
  const activeVariantId =
    typeof json.activeVariantId === "string" &&
    variants.some((v) => v.id === json.activeVariantId)
      ? json.activeVariantId
      : variants[0]!.id;
  const style = deepMerge<Project["style"]>(
    defaultStyle(),
    (isObj(json.style) ? json.style : {}) as DeepPartial<Project["style"]>,
  );
  const lens = style.magnifier as unknown as Record<string, unknown>;
  lens.size = intoRange(lens.size, MAGNIFIER_LIMITS.size);
  lens.zoom = intoRange(lens.zoom, MAGNIFIER_LIMITS.zoom);
  if (isObj(lens.border)) lens.border = { ...lens.border, width: intoRange(lens.border.width, MAGNIFIER_LIMITS.border) };
  validateStyle(style);
  const audio = deepMerge<Project["audio"]>(
    defaultAudio(),
    (isObj(json.audio) ? json.audio : {}) as DeepPartial<Project["audio"]>,
  );
  for (const ch of [audio.mic, audio.system])
    if (isObj(ch) && typeof ch.gain === "number") ch.gain = Math.min(ch.gain, MAX_AUDIO_GAIN);
  validateAudio(audio);
  const zoomEngine = isObj(json.zoomEngine)
    ? json.zoomEngine
    : { sensitivity: "medium" };
  validateZoomEngine(zoomEngine);

  return {
    schema: SCHEMA_VERSION,
    id: json.id as string,
    name: json.name as string,
    createdAt:
      typeof json.createdAt === "string"
        ? json.createdAt
        : new Date(0).toISOString(),
    updatedAt:
      typeof json.updatedAt === "string"
        ? json.updatedAt
        : new Date(0).toISOString(),
    recordings: json.recordings,
    sequence: json.sequence,
    zooms: validateZooms(json.zooms),
    cameraLayouts: validateCameraLayouts(json.cameraLayouts),
    privacy: validatePrivacy(json.privacy),
    magnifiers: validateMagnifiers(
      Array.isArray(json.magnifiers)
        ? json.magnifiers.map((m) =>
            isObj(m) ? { ...m, size: intoRange(m.size, MAGNIFIER_LIMITS.size), zoom: intoRange(m.zoom, MAGNIFIER_LIMITS.zoom) } : m,
          )
        : json.magnifiers,
    ),
    texts: validateTexts(json.texts),
    style,
    variants,
    activeVariantId,
    audio,
    zoomEngine,
  };
}

/** Checks a project that is already in memory, exactly as written: no defaults filled, nothing clamped. */
export function validateProject(project: Project): void {
  validateRecordings(project.recordings);
  validateSequence(project.sequence, project.recordings);
  validateVariants(project.variants);
  validateStyle(project.style);
  validateAudio(project.audio);
  validateZoomEngine(project.zoomEngine);
  validateZooms(project.zooms);
  validateCameraLayouts(project.cameraLayouts);
  validatePrivacy(project.privacy);
  validateMagnifiers(project.magnifiers);
  validateTexts(project.texts);
}

export function serializeProject(project: Project, now = new Date()): string {
  return JSON.stringify({ ...project, updatedAt: now.toISOString() }, null, 2);
}
