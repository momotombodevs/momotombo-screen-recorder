import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ProjectFormatError,
  parseCursorLog,
  parseProject,
  sequenceDuration,
  type CursorTrack,
  type Project,
} from "@momotombo/project-model";
import { ticksToSeconds } from "@momotombo/timing";
import { PROJECT_FILE, PROJECTS_FOLDER } from "../shared/brand";
import { OPEN_PROJECT_FLAG } from "../shared/open-project";
import {
  EXPORT_REQUEST_FLAG,
  ExportRequest,
  TERMINAL_STATES,
  outPathProblem,
  projectExportStatusPath,
  projectExportRequestPath,
  statusForRequest,
  type ExportStatus,
} from "../shared/export-request";
import { safeJoin } from "../main/fsutil";
import {
  WriteConflictError,
  readProjectText,
  validatedProjectText,
  writeProjectTextIfUnchanged,
} from "../main/project-file";
import { ToolsMissingError, analyzeProject, toolRunner, type Run } from "./analyze";
import { OpError, applyOps, describeProject, parseOps, type Op } from "./ops";

const DEFAULT_EXPORT_TIMEOUT_SECONDS = 1800;

const USAGE = `momotombo-edit: edit Momotombo projects from the command line.

  list                              every project, most recently changed first
  describe <project>                timeline, items, style, variants and media files (times in seconds)
  apply <project> <ops.json | ->    apply a JSON array of ops; all or nothing
  open <project>                    open the project in the Momotombo editor
  analyze <project>                 quality report (needs ffmpeg and ffprobe on PATH): findings, verdict, suggested ops
  export <project>                  render the project with the Momotombo app and wait for the file

<project> is "latest", a project id, or an exact project name.
Options: --root <projects folder>   --dry-run (apply: validate and report, write nothing)
export:  --variant <id|name>  --format mp4|webm  --resolution 1080|2160  --fps 30|60  --quality standard|high
         --no-audio  --out <new file, absolute or relative to here>  --timeout <seconds, default ${DEFAULT_EXPORT_TIMEOUT_SECONDS}>
Exit codes: 0 done, 1 usage or other error, 3 invalid ops, project or export options, 4 the project changed while applying
            (nothing written), 5 analyze needs ffmpeg and ffprobe on PATH, 6 the app refused the export (busy),
            7 the export failed, 8 no result before --timeout (the export may still be running)`;

export const EXIT = { ok: 0, usage: 1, invalid: 3, conflict: 4, toolsMissing: 5, refused: 6, failed: 7, timeout: 8 } as const;

class UsageError extends Error {}
class ExportRefusedError extends Error {}
class ExportFailedError extends Error {}
class ExportTimeoutError extends Error {}

interface Found {
  dir: string;
  text: string;
  project: Project;
  modifiedMs: number;
}

interface Skipped {
  dir: string;
  error: string;
  modifiedMs: number;
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  stdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  launchApp?: (flag: string, env: NodeJS.ProcessEnv) => Promise<string>;
  pollMs?: number;
  run?: Run;
}

function projectsRoot(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag) return resolve(flag);
  if (env.MOMOTOMBO_TEST_HOME) return join(env.MOMOTOMBO_TEST_HOME, "projects");
  return join(
    homedir(),
    process.platform === "darwin" ? "Movies" : "Videos",
    PROJECTS_FOLDER,
  );
}

async function findProjects(root: string): Promise<{ projects: Found[]; skipped: Skipped[] }> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const projects: Found[] = [];
  const skipped: Skipped[] = [];
  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dir = join(root, e.name);
        const modifiedMs = await stat(join(dir, PROJECT_FILE)).then((s) => s.mtimeMs, () => null);
        if (modifiedMs === null) return;
        try {
          const text = await readProjectText(dir);
          projects.push({ dir, text, project: parseProject(JSON.parse(text)), modifiedMs });
        } catch (error) {
          skipped.push({ dir, error: (error as Error).message, modifiedMs });
        }
      }),
  );
  projects.sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt));
  skipped.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return { projects, skipped };
}

export function pick(
  { projects, skipped }: { projects: Found[]; skipped: Skipped[] },
  ref: string | undefined,
  root: string,
): Found {
  if (!ref) throw new UsageError("Missing <project>.");
  if (ref === "latest") {
    const newest = projects[0];
    const broken = skipped[0];
    if (broken && (!newest || broken.modifiedMs > newest.modifiedMs))
      throw new Error(`The most recently changed project, ${broken.dir}, cannot be read: ${broken.error}. Fix it or name the project you want.`);
    if (!newest) throw new UsageError(`No projects in ${root}`);
    return newest;
  }
  const matches = projects.filter(
    (f) =>
      f.project.id === ref ||
      f.project.name.toLowerCase() === ref.toLowerCase(),
  );
  if (matches.length === 0)
    throw new UsageError(`No project with id or name "${ref}"${skipped.length ? ` (${skipped.length} unreadable project${skipped.length > 1 ? "s" : ""} skipped)` : ""}.`);
  if (matches.length > 1)
    throw new UsageError(
      `${matches.length} projects are named "${ref}"; use the id.`,
    );
  return matches[0]!;
}

const durationSeconds = (p: Project) =>
  Math.round(ticksToSeconds(sequenceDuration(p)) * 1000) / 1000;

function readProcessStdin(): Promise<string> {
  return new Promise((done, fail) => {
    let text = "";
    process.stdin
      .setEncoding("utf8")
      .on("data", (chunk) => {
        text += chunk;
      })
      .on("end", () => done(text))
      .on("error", fail);
  });
}

async function readOps(file: string, io: Io): Promise<Op[]> {
  const source = file === "-" ? "stdin" : file;
  const text = file === "-" ? await io.stdin() : await readFile(file, "utf8").catch((e: Error) => {
    throw new UsageError(`Cannot read ${file}: ${e.message}`);
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new OpError(`The ops in ${source} are not valid JSON: ${(e as Error).message}`);
  }
  return parseOps(raw);
}

async function cursorTracks(dir: string, project: Project): Promise<Record<string, CursorTrack | null>> {
  const tracks: Record<string, CursorTrack | null> = {};
  for (const rec of Object.values(project.recordings)) {
    const file = rec.cursorFile ? safeJoin(dir, rec.cursorFile) : null;
    const text = file ? await readFile(file, "utf8").catch(() => null) : null;
    tracks[rec.id] = text ? parseCursorLog(text) : null;
  }
  return tracks;
}

export function launch(command: string, args: string[], waitForExit: boolean): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", (e) => fail(new Error(`Could not start ${command}: ${e.message}`)));
    if (waitForExit)
      child.once("exit", (code, signal) =>
        code === 0 ? done() : fail(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}).`)),
      );
    else
      child.once("spawn", () => {
        child.unref();
        done();
      });
  });
}

export function openArgs(app: string, flag: string, env: NodeJS.ProcessEnv, background: boolean, appDir?: string): string[] {
  const testHome = env.MOMOTOMBO_TEST_HOME ? ["--env", `MOMOTOMBO_TEST_HOME=${env.MOMOTOMBO_TEST_HOME}`] : [];
  return ["-n", ...(background ? ["-g"] : []), ...testHome, app, "--args", ...(appDir ? [appDir] : []), flag];
}

async function launchApp(flag: string, env: NodeJS.ProcessEnv, background: boolean): Promise<string> {
  const appDir = resolve(__dirname, "..", "..");
  const chosen = env.MOMOTOMBO_APP;
  if (process.platform !== "darwin") {
    const electron = chosen ?? (require("electron") as unknown as string);
    await launch(electron, chosen ? [flag] : [appDir, flag], false);
    return electron;
  }
  const installed = chosen ?? "/Applications/Momotombo.app";
  const development = join(appDir, ".dev-app", "Momotombo Development.app");
  if (existsSync(installed)) {
    await launch("open", openArgs(installed, flag, env, background), true);
    return installed;
  }
  if (existsSync(development)) {
    await launch("open", openArgs(development, flag, env, background, appDir), true);
    return development;
  }
  throw new Error(
    "Momotombo is not installed and has no development app yet. Run `pnpm start` once, or set MOMOTOMBO_APP.",
  );
}

interface ExportFlags {
  variant?: string;
  format?: string;
  resolution?: string;
  fps?: string;
  quality?: string;
  "no-audio"?: boolean;
  out?: string;
}

function oneOf<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new OpError(`--${flag} must be ${allowed.join(" or ")}, got ${value}.`);
  return value as T;
}

export function exportRequest(project: Project, flags: ExportFlags, cwd: string, requestId: string): ExportRequest {
  const out = flags.out === undefined ? undefined : resolve(cwd, flags.out);
  const format = oneOf("format", flags.format, ["mp4", "webm"] as const) ?? (out && extname(out).toLowerCase() === ".webm" ? "webm" : "mp4");
  let variantId: string | undefined;
  if (flags.variant !== undefined) {
    const wanted = flags.variant.toLowerCase();
    const variant = project.variants.find((v) => v.id === flags.variant || v.name.toLowerCase() === wanted);
    if (!variant)
      throw new OpError(`No format "${flags.variant}" in the project; it has ${project.variants.map((v) => `${v.id} (${v.name})`).join(", ")}.`);
    variantId = variant.id;
  }
  const fps = oneOf("fps", flags.fps, ["30", "60"] as const);
  const parsed = ExportRequest.safeParse({
    requestId,
    projectId: project.id,
    format,
    ...(variantId ? { variantId } : {}),
    ...(flags.resolution !== undefined ? { resolution: oneOf("resolution", flags.resolution, ["1080", "2160"] as const) } : {}),
    ...(fps ? { fps: Number(fps) } : {}),
    ...(flags.quality !== undefined ? { quality: oneOf("quality", flags.quality, ["standard", "high"] as const) } : {}),
    ...(flags["no-audio"] ? { includeAudio: false } : {}),
    ...(out ? { out } : {}),
  });
  if (!parsed.success) throw new OpError(`Invalid export options: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

async function checkOut(out: string, format: "mp4" | "webm", root: string): Promise<void> {
  const realParent = await realpath(dirname(out)).then(
    async (p) => ((await stat(p)).isDirectory() ? p : null),
    () => null,
  );
  const taken = await lstat(out).then(() => true, (e: NodeJS.ErrnoException) => e.code !== "ENOENT");
  const projectsRoot = await realpath(root).catch(() => root);
  const problem = outPathProblem(out, format, { realParent, projectsRoot, taken });
  if (problem) throw new OpError(problem);
}

export interface MediaSummary {
  durationSeconds: number | null;
  video: { codec: string; width: number; height: number; fps: number | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
}

export function mediaSummary(ffprobeJson: string): MediaSummary {
  const data = JSON.parse(ffprobeJson) as { streams?: Record<string, unknown>[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const num = (x: unknown) => (x === undefined || x === null || Number.isNaN(Number(x)) ? null : Number(x));
  const rate = (x: unknown) => {
    const [n, d] = String(x ?? "").split("/").map(Number);
    return n && d ? Math.round((n / d) * 1000) / 1000 : null;
  };
  const duration = num(data.format?.duration);
  return {
    durationSeconds: duration === null ? null : Math.round(duration * 1000) / 1000,
    video: v ? { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: rate(v.avg_frame_rate) } : null,
    audio: a ? { codec: String(a.codec_name), sampleRate: num(a.sample_rate), channels: num(a.channels) } : null,
  };
}

async function probeMedia(file: string, run: Run): Promise<MediaSummary | null> {
  try {
    return mediaSummary(await run("ffprobe", ["-v", "error", "-of", "json", "-show_streams", "-show_format", file]));
  } catch (e) {
    if (e instanceof ToolsMissingError) return null;
    throw e;
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exportInApp(chosen: Found, request: ExportRequest, root: string, timeoutSeconds: number, io: Io): Promise<unknown> {
  if (request.out) await checkOut(request.out, request.format, root);
  const requestFile = join(chosen.dir, projectExportRequestPath(request.requestId));
  const statusFile = join(chosen.dir, projectExportStatusPath(request.requestId));
  const started = Date.now();
  await mkdir(dirname(requestFile), { recursive: true });
  await writeFile(requestFile, JSON.stringify(request));
  let status: ExportStatus | null = null;
  try {
    const app = await (io.launchApp ?? ((flag, env) => launchApp(flag, env, true)))(`${EXPORT_REQUEST_FLAG}${requestFile}`, io.env);
    const deadline = started + timeoutSeconds * 1000;
    while (!status || !TERMINAL_STATES.includes(status.state)) {
      if (Date.now() > deadline)
        throw new ExportTimeoutError(
          status
            ? `No result after ${timeoutSeconds} s; the export is ${status.state} at ${Math.round(status.progress * 100)}% (${statusFile}).`
            : `${app} did not take the export request within ${timeoutSeconds} s.`,
        );
      await pause(io.pollMs ?? 500);
      status = statusForRequest(await readFile(statusFile, "utf8").catch(() => null), request.requestId) ?? status;
    }
  } finally {
    await rm(requestFile, { force: true });
  }
  await rm(statusFile, { force: true });
  if (status.state === "refused") throw new ExportRefusedError(`The app refused the export (${status.reason}): ${status.error}`);
  if (status.state === "failed") throw new ExportFailedError(`The export failed: ${status.error}`);
  const outFile = status.outFile!;
  const info = await stat(outFile).catch(() => null);
  if (!info?.isFile() || info.size !== status.bytes)
    throw new ExportFailedError(`The app reported ${outFile} done, but it is missing or incomplete.`);
  return {
    id: chosen.project.id,
    requestId: request.requestId,
    state: status.state,
    outFile,
    bytes: info.size,
    format: request.format,
    timelineSeconds: durationSeconds(chosen.project),
    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
    privacyAreas: chosen.project.privacy.length,
    media: await probeMedia(outFile, io.run ?? toolRunner(io.env)),
  };
}

async function main(argv: string[], io: Io): Promise<unknown> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        variant: { type: "string" },
        format: { type: "string" },
        resolution: { type: "string" },
        fps: { type: "string" },
        quality: { type: "string" },
        "no-audio": { type: "boolean", default: false },
        out: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ref, opsFile] = positionals;
  if (values.help || !command) return USAGE;
  if (!["list", "describe", "apply", "open", "analyze", "export"].includes(command))
    throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  const root = projectsRoot(values.root, io.env);
  const found = await findProjects(root);
  for (const s of found.skipped)
    io.err(`momotombo-edit: warning: skipped ${s.dir}: ${s.error}\n`);

  switch (command) {
    case "list":
      return {
        projects: found.projects.map(({ dir, project }) => ({
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          durationSeconds: durationSeconds(project),
          dir,
        })),
        skipped: found.skipped.map(({ dir, error }) => ({ dir, error })),
      };
    case "describe": {
      const { dir, project } = pick(found, ref, root);
      return { dir, ...describeProject(project) };
    }
    case "apply": {
      const { dir, text: readText, project } = pick(found, ref, root);
      if (!opsFile) throw new UsageError("Missing <ops.json | ->.");
      const ops = await readOps(opsFile, io);
      const needsCursor = ops.some((op) => op.op === "applyZoomSuggestions");
      const { project: edited, results, warnings } = applyOps(project, ops, {
        cursorTracks: needsCursor ? await cursorTracks(dir, project) : {},
      });
      const text = validatedProjectText(edited);
      if (!values["dry-run"]) await writeProjectTextIfUnchanged(dir, readText, text);
      return {
        id: project.id,
        applied: ops.length,
        written: !values["dry-run"],
        durationSeconds: {
          before: durationSeconds(project),
          after: durationSeconds(edited),
        },
        ops: results,
        warnings,
      };
    }
    case "analyze": {
      const { dir, project } = pick(found, ref, root);
      return analyzeProject(dir, project, toolRunner(io.env));
    }
    case "open": {
      if (values.root)
        throw new UsageError(
          "open shows the project in the app, which only reads its own projects folder; drop --root.",
        );
      const { project } = pick(found, ref, root);
      const app = await launchApp(`${OPEN_PROJECT_FLAG}${project.id}`, io.env, false);
      return { id: project.id, opened: true, app };
    }
    case "export": {
      if (values.root)
        throw new UsageError(
          "export runs in the app, which only reads its own projects folder; drop --root.",
        );
      const chosen = pick(found, ref, root);
      const request = exportRequest(chosen.project, values, process.cwd(), `xr_${randomBytes(8).toString("hex")}`);
      const timeout = values.timeout === undefined ? DEFAULT_EXPORT_TIMEOUT_SECONDS : Number(values.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`--timeout must be a number of seconds above 0, got ${values.timeout}.`);
      return exportInApp(chosen, request, root, timeout, io);
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

function exitCode(e: unknown): number {
  if (e instanceof ExportRefusedError) return EXIT.refused;
  if (e instanceof ExportFailedError) return EXIT.failed;
  if (e instanceof ExportTimeoutError) return EXIT.timeout;
  if (e instanceof WriteConflictError) return EXIT.conflict;
  if (e instanceof ToolsMissingError) return EXIT.toolsMissing;
  if (e instanceof OpError || e instanceof ProjectFormatError) return EXIT.invalid;
  return EXIT.usage;
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const out = await main(argv, io);
    io.out(`${typeof out === "string" ? out : JSON.stringify(out, null, 2)}\n`);
    return EXIT.ok;
  } catch (e) {
    const lines = (e as Error).message.split("\n");
    io.err(lines.map((l) => `momotombo-edit: ${l}\n`).join(""));
    return exitCode(e);
  }
}

if (typeof module !== "undefined" && require.main === module) {
  void run(process.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    stdin: readProcessStdin,
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}
