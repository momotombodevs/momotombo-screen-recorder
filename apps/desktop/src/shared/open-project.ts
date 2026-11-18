export const OPEN_PROJECT_FLAG = "--open-project=";

export function projectIdFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(OPEN_PROJECT_FLAG));
  return arg ? arg.slice(OPEN_PROJECT_FLAG.length) || null : null;
}
