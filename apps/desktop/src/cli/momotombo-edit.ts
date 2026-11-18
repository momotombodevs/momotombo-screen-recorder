import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import { safeJoin } from "../main/fsutil";
import {
  WriteConflictError,
  readProjectText,
  validatedProjectText,
  writeProjectTextIfUnchanged,
} from "../main/project-file";
import { ToolsMissingError, analyzeProject, toolRunner } from "./analyze";
import { OpError, applyOps, describeProject, parseOps, type Op } from "./ops";

const USAGE = `momotombo-edit: edit Momotombo projects from the command line.

  list                              every project, most recently changed first
  describe <project>                timeline, items, style, variants and media files (times in seconds)
  apply <project> <ops.json | ->    apply a JSON array of ops; all or nothing
  open <project>                    open the project in the Momotombo editor
  analyze <project>                 quality report (needs ffmpeg and ffprobe on PATH): findings, verdict, suggested ops

<project> is "latest", a project id, or an exact project name.
Options: --root <projects folder>   --dry-run (apply: validate and report, write nothing)
Exit codes: 0 done, 1 usage or other error, 3 invalid ops or project, 4 the project changed while applying (nothing written),
            5 analyze needs ffmpeg and ffprobe on PATH`;

export const EXIT = { ok: 0, usage: 1, invalid: 3, conflict: 4, toolsMissing: 5 } as const;

class UsageError extends Error {}

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

async function openInApp(projectId: string, env: NodeJS.ProcessEnv): Promise<string> {
  const flag = `${OPEN_PROJECT_FLAG}${projectId}`;
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
    await launch("open", ["-n", installed, "--args", flag], true);
    return installed;
  }
  if (existsSync(development)) {
    await launch("open", ["-n", development, "--args", appDir, flag], true);
    return development;
  }
  throw new Error(
    "Momotombo is not installed and has no development app yet. Run `pnpm start` once, or set MOMOTOMBO_APP.",
  );
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
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ref, opsFile] = positionals;
  if (values.help || !command) return USAGE;
  if (!["list", "describe", "apply", "open", "analyze"].includes(command))
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
      const app = await openInApp(project.id, io.env);
      return { id: project.id, opened: true, app };
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

function exitCode(e: unknown): number {
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
