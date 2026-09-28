// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "" },
}));

import { migrateLegacyUserData } from "./legacy-kotoba-migration";

let appData: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), "mithril-appdata-"));
});

afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

describe("migrateLegacyUserData", () => {
  it("moves the Kotoba directory and renames its session partitions", () => {
    const legacy = join(appData, "Kotoba");
    mkdirSync(join(legacy, "Partitions", "kotoba-cloud"), { recursive: true });
    mkdirSync(join(legacy, "Partitions", "kotoba-cloud-gateway"), {
      recursive: true,
    });
    writeFileSync(join(legacy, "gpu-preference.json"), "{}");
    const target = join(appData, "Mithril");

    expect(migrateLegacyUserData(appData, target)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(target, "gpu-preference.json"))).toBe(true);
    expect(existsSync(join(target, "Partitions", "mithril"))).toBe(true);
    expect(existsSync(join(target, "Partitions", "mithril-gateway"))).toBe(
      true,
    );
  });

  it("leaves an existing Mithril directory alone", () => {
    mkdirSync(join(appData, "Kotoba"));
    mkdirSync(join(appData, "Mithril"));
    expect(migrateLegacyUserData(appData, join(appData, "Mithril"))).toBe(
      false,
    );
    expect(existsSync(join(appData, "Kotoba"))).toBe(true);
  });

  it("does nothing on a fresh install", () => {
    expect(migrateLegacyUserData(appData, join(appData, "Mithril"))).toBe(
      false,
    );
    expect(existsSync(join(appData, "Mithril"))).toBe(false);
  });
});
