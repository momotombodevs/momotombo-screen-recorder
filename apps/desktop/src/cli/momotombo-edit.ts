import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  parseProject,
  sequenceDuration,
  type Project,
} from "@momotombo/project-model";
import { ticksToSeconds } from "@momotombo/timing";
import { PROJECTS_FOLDER } from "../shared/brand";
import { OPEN_PROJECT_FLAG } from "../shared/open-project";
import {
  readProjectText,
  validatedProjectText,
  writeProjectTextKeepingBackup,
} from "../main/project-file";
import { Ops, applyOps, describeProject } from "./ops";

const USAGE = `momotombo-edit: edit Momotombo projects from the command line.

  list                              every project, most recently changed first
  describe <project>                timeline, items, style and media files (times in seconds)
  apply <project> <ops.json | ->    apply a JSON array of ops; all or nothing
  open <project>                    open the project in the Momotombo editor

<project> is "latest", a project id, or an exact project name.
Options: --root <projects folder>   --dry-run (apply: validate and report, write nothing)`;

interface Found {
  dir: string;
  text: string;
  project: Project;
}

function projectsRoot(flag: string | undefined): string {
  if (flag) return resolve(flag);
  if (process.env.MOMOTOMBO_TEST_HOME)
    return join(process.env.MOMOTOMBO_TEST_HOME, "projects");
  return join(
    homedir(),
    process.platform === "darwin" ? "Movies" : "Videos",
    PROJECTS_FOLDER,
  );
}

async function findProjects(root: string): Promise<Found[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e): Promise<Found | null> => {
        const dir = join(root, e.name);
        try {
          const text = await readProjectText(dir);
          return { dir, text, project: parseProject(JSON.parse(text)) };
        } catch {
          return null;
        }
      }),
  );
  return found
    .filter((f) => f !== null)
    .sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt));
}

function pick(projects: Found[], ref: string | undefined, root: string): Found {
  if (!ref) throw new Error("Missing <project>.");
  if (projects.length === 0) throw new Error(`No projects in ${root}`);
  if (ref === "latest") return projects[0]!;
  const matches = projects.filter(
    (f) =>
      f.project.id === ref ||
      f.project.name.toLowerCase() === ref.toLowerCase(),
  );
  if (matches.length === 0)
    throw new Error(`No project with id or name "${ref}".`);
  if (matches.length > 1)
    throw new Error(
      `${matches.length} projects are named "${ref}"; use the id.`,
    );
  return matches[0]!;
}

const durationSeconds = (p: Project) =>
  Math.round(ticksToSeconds(sequenceDuration(p)) * 1000) / 1000;

function readStdin(): Promise<string> {
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

function launch(command: string, args: string[]): void {
  spawn(command, args, { detached: true, stdio: "ignore" })
    .on("error", (e) => {
      process.stderr.write(`momotombo-edit: could not start ${command}: ${e.message}\n`);
      process.exitCode = 1;
    })
    .unref();
}

function openInApp(projectId: string): void {
  const flag = `${OPEN_PROJECT_FLAG}${projectId}`;
  const appDir = resolve(__dirname, "..", "..");
  const chosen = process.env.MOMOTOMBO_APP;
  if (process.platform !== "darwin") {
    if (chosen) launch(chosen, [flag]);
    else launch(require("electron") as unknown as string, [appDir, flag]);
    return;
  }
  const installed = chosen ?? "/Applications/Momotombo.app";
  const development = join(appDir, ".dev-app", "Momotombo Development.app");
  if (existsSync(installed)) launch("open", ["-n", installed, "--args", flag]);
  else if (existsSync(development))
    launch("open", ["-n", development, "--args", appDir, flag]);
  else
    throw new Error(
      "Momotombo is not installed and has no development app yet. Run `pnpm start` once, or set MOMOTOMBO_APP.",
    );
}

async function main(): Promise<unknown> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ref, opsFile] = positionals;
  if (values.help || !command) return USAGE;
  const root = projectsRoot(values.root);
  const projects = await findProjects(root);

  switch (command) {
    case "list":
      return projects.map(({ dir, project }) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        durationSeconds: durationSeconds(project),
        dir,
      }));
    case "describe": {
      const { dir, project } = pick(projects, ref, root);
      return { dir, ...describeProject(project) };
    }
    case "apply": {
      const { dir, text: readText, project } = pick(projects, ref, root);
      if (!opsFile) throw new Error("Missing <ops.json | ->.");
      const ops = Ops.parse(
        JSON.parse(
          opsFile === "-" ? await readStdin() : await readFile(opsFile, "utf8"),
        ),
      );
      const edited = applyOps(project, ops);
      const text = validatedProjectText(edited);
      if (!values["dry-run"]) {
        if ((await readProjectText(dir)) !== readText)
          throw new Error("The project changed while the ops were applied (probably saved by the editor). Nothing was written; run apply again.");
        await writeProjectTextKeepingBackup(dir, text);
      }
      return {
        id: project.id,
        applied: ops.length,
        written: !values["dry-run"],
        durationSeconds: {
          before: durationSeconds(project),
          after: durationSeconds(edited),
        },
      };
    }
    case "open": {
      if (values.root)
        throw new Error(
          "open shows the project in the app, which only reads its own projects folder; drop --root.",
        );
      const { project } = pick(projects, ref, root);
      openInApp(project.id);
      return { id: project.id, opening: true };
    }
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().then(
  (out) => {
    process.stdout.write(
      `${typeof out === "string" ? out : JSON.stringify(out, null, 2)}\n`,
    );
  },
  (e: unknown) => {
    process.stderr.write(`momotombo-edit: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
