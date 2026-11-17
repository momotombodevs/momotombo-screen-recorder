import { deepMerge, type DeepPartial } from "./commands";
import { defaultStyle, defaultVariants } from "./factory";
import type { Project } from "./types";
import { SCHEMA_VERSION } from "./types";
import {
  ProjectFormatError,
  isObj,
  validateAudio,
  validateCameraLayouts,
  validateMagnifiers,
  validatePrivacy,
  validateRecordings,
  validateSequence,
  validateStyle,
  validateVariants,
  validateZoomEngine,
  validateZooms,
} from "./validate";

export { ProjectFormatError };

/**
 * Validates and normalizes a parsed project.json. Missing optional sections are filled
 * with defaults so older files keep opening; anything the evaluator could not draw
 * (wrong types, non-finite or out-of-range numbers, empty ranges) throws ProjectFormatError
 * naming the field.
 */
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
  validateStyle(style);
  const audio = deepMerge<Project["audio"]>(
    { mic: { gain: 1, muted: false }, system: { gain: 0.8, muted: false } },
    (isObj(json.audio) ? json.audio : {}) as DeepPartial<Project["audio"]>,
  );
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
    magnifiers: validateMagnifiers(json.magnifiers),
    style,
    variants,
    activeVariantId,
    audio,
    zoomEngine,
  };
}

export function serializeProject(project: Project, now = new Date()): string {
  return JSON.stringify({ ...project, updatedAt: now.toISOString() }, null, 2);
}
