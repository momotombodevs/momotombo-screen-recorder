import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const appPath = mkdtempSync(join(tmpdir(), "momotombo-native-"));
vi.mock("electron", () => ({
  app: {
    getPath: () => appPath,
    getPreferredSystemLanguages: () => ["en-US"],
    getLocale: () => "en",
    isPackaged: false,
    getAppPath: () => appPath,
  },
}));
const { loadSettings } = await import("../settings");
const { NativeMacBackend } = await import("./native-macos");
const { EN } = await import("../../shared/i18n-en");

describe("native macOS backend info", () => {
  it("reports why it is unavailable as a source string, so the screen translates it when shown", async () => {
    await loadSettings({ ephemeral: true, language: "en" });
    const info = new NativeMacBackend().info;
    expect(info.available).toBe(false);
    expect(Object.keys(EN)).toContain(info.reason);
  });
});
