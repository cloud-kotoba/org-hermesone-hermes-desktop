import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  liveMultiplexer,
  multiplexerServes,
  multiplexerServesHome,
  multiplexedSecondaries,
} from "./gateway-multiplex";

let home: string;

/**
 * A pid that is provably NOT alive, so "dead process" cases test what they
 * claim. Searching upward from an out-of-range value and asserting we found
 * one keeps the test from silently degrading into "alive" on a platform with
 * a larger pid space.
 */
function deadPid(): number {
  for (const candidate of [999_999, 4_194_303, 4_194_302]) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no provably-dead pid available on this platform");
}

function writeState(state: Record<string, unknown>): void {
  writeFileSync(join(home, "gateway_state.json"), JSON.stringify(state));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kotoba-multiplex-"));
  mkdirSync(join(home, "profiles", "akc-blog-i18n"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("gateway multiplex status", () => {
  // @lat: [[gateway-multiplex#Tests#Reads the live gateway's served list]]
  it("reports a served profile as served when the recording process is alive", () => {
    writeState({
      pid: process.pid,
      gateway_state: "running",
      served_profiles: ["default", "akc-blog-i18n"],
    });
    expect(multiplexerServes("akc-blog-i18n", home)).toBe(true);
    expect(liveMultiplexer(home)?.served).toEqual(["default", "akc-blog-i18n"]);
    expect(multiplexedSecondaries(home)).toEqual(["akc-blog-i18n"]);
  });

  // @lat: [[gateway-multiplex#Tests#A profile outside the list is not served]]
  it("answers false for a profile the live gateway does not list", () => {
    writeState({
      pid: process.pid,
      gateway_state: "running",
      served_profiles: ["default"],
    });
    expect(multiplexerServes("akc-blog-i18n", home)).toBe(false);
    // …and the record is still readable: "serves nobody else" is an answer.
    expect(liveMultiplexer(home)?.served).toEqual(["default"]);
    expect(multiplexedSecondaries(home)).toEqual([]);
  });

  // @lat: [[gateway-multiplex#Tests#A dead recorder is unknown, not empty]]
  it("returns null when the recorded pid is not a live process", () => {
    writeState({
      pid: deadPid(),
      gateway_state: "running",
      served_profiles: ["default", "akc-blog-i18n"],
    });
    expect(liveMultiplexer(home)).toBeNull();
    expect(multiplexerServes("akc-blog-i18n", home)).toBe(false);
  });

  // @lat: [[gateway-multiplex#Tests#A record without served_profiles is unknown]]
  it("returns null for a record that carries no served_profiles key", () => {
    writeState({ pid: process.pid, gateway_state: "running" });
    // An older gateway records no list. That is "unknown" — it must not read
    // as an authoritative empty list, which would claim nothing is served.
    expect(liveMultiplexer(home)).toBeNull();
    expect(multiplexerServes("akc-blog-i18n", home)).toBe(false);
  });

  // @lat: [[gateway-multiplex#Tests#A stopped gateway serves nothing]]
  it("returns null when the gateway is recorded as not running", () => {
    writeState({
      pid: process.pid,
      gateway_state: "stopped",
      served_profiles: ["default", "akc-blog-i18n"],
    });
    expect(liveMultiplexer(home)).toBeNull();
  });

  // @lat: [[gateway-multiplex#Tests#A pid file that disagrees wins nothing]]
  it("returns null when gateway.pid names a different process than the record", () => {
    writeState({
      pid: process.pid,
      gateway_state: "running",
      served_profiles: ["default", "akc-blog-i18n"],
    });
    writeFileSync(
      join(home, "gateway.pid"),
      JSON.stringify({ pid: deadPid(), kind: "hermes-gateway" }),
    );
    expect(liveMultiplexer(home)).toBeNull();
  });

  // @lat: [[gateway-multiplex#Tests#A missing record is unknown]]
  it("returns null with no record at all", () => {
    expect(liveMultiplexer(home)).toBeNull();
    expect(multiplexerServes("akc-blog-i18n", home)).toBe(false);
    expect(multiplexedSecondaries(home)).toEqual([]);
  });

  // @lat: [[gateway-multiplex#Tests#Unparseable JSON is unknown]]
  it("returns null when the record is not JSON", () => {
    writeFileSync(join(home, "gateway_state.json"), "{not json");
    expect(liveMultiplexer(home)).toBeNull();
  });

  // @lat: [[gateway-multiplex#Tests#The default profile is served by its own gateway]]
  it("treats the default profile as served whenever a multiplexer is live", () => {
    writeState({
      pid: process.pid,
      gateway_state: "running",
      served_profiles: ["default", "akc-blog-i18n"],
    });
    expect(multiplexerServes(undefined, home)).toBe(true);
    expect(multiplexerServes("default", home)).toBe(true);
    expect(multiplexerServesHome(home, home)).toBe(true);
  });

  // @lat: [[gateway-multiplex#Tests#Profile paths resolve to profile names]]
  it("resolves a profile home path to the name the record uses", () => {
    writeState({
      pid: process.pid,
      gateway_state: "running",
      served_profiles: ["default", "akc-blog-i18n"],
    });
    expect(
      multiplexerServesHome(join(home, "profiles", "akc-blog-i18n"), home),
    ).toBe(true);
    expect(
      multiplexerServesHome(join(home, "profiles", "not-served"), home),
    ).toBe(false);
  });

  // @lat: [[gateway-multiplex#Tests#A malformed profile name is not served]]
  it("answers false rather than throwing for an unnameable profile", () => {
    writeState({
      pid: process.pid,
      gateway_state: "running",
      served_profiles: ["default"],
    });
    expect(multiplexerServes("../escape", home)).toBe(false);
  });
});
