// @lat: [[gateway-multiplex#Multiplexed gateway status]]
/**
 * Which profiles the LIVE default gateway already serves.
 *
 * With `gateway.multiplex_profiles: true` (the CLI's default since 0.21) ONE
 * process — the default profile's gateway — is the single inbound process for
 * every profile on the host. No named profile gets its own `gateway.pid`, so a
 * status derived from that file alone reports every named profile as "Off"
 * while its bots are in fact online, and the row's Start action spawns a
 * gateway the CLI immediately refuses:
 *
 *     ✗ The default gateway is running as a profile multiplexer and already
 *       serves profile 'akc-blog-i18n'.                        (exit 78)
 *
 * Measured 2026-09-22 on this workstation: 93 profiles, one live gateway
 * (pid 37295), `served_profiles` listing all 93, zero per-profile
 * `gateway.pid` files, and `hermes profile list` showing Gateway=running for
 * every one of them. The desktop showed 92 of 93 as "Off" and left the one
 * the operator clicked spinning on "Starting…" until the poll gave up.
 *
 * The truth about the running process is the record the gateway itself writes
 * at startup (`gateway/run_adapters.py::_record_served_profiles` →
 * `served_profiles` in the default home's `gateway_state.json`), not the
 * config: `hermes -p coder …` loads coder's `.env`, so an env-only opt-in is
 * invisible to a config read, and an allowlist edited after start flips the
 * guess before the restart. This module reads that record and proves it
 * against a live process, mirroring the CLI's own
 * `hermes_cli/gateway_multiplex_served.py`.
 *
 * Unknown is a third answer, never "serves nobody": a record we cannot read,
 * or one whose pid is not the live gateway's, returns `null` so callers keep
 * their own evidence (the per-profile pid file) instead of being told a dead
 * multiplexer serves nothing.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { HERMES_HOME } from "./installer";
import { normalizeProfileName, pidIsAliveAs } from "./utils";

/** Image prefixes a hermes gateway runs as (Windows only check; see pidIsAliveAs). */
const GATEWAY_IMAGE_PREFIXES = ["python", "pythonw"];

/** The default profile's own name in `served_profiles`. */
export const DEFAULT_PROFILE_NAME = "default";

export interface MultiplexerRecord {
  /** The live gateway process. */
  pid: number;
  /** Profile names it serves, `default` included, exactly as recorded. */
  served: string[];
}

function parsePid(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = text.startsWith("{")
      ? (JSON.parse(text) as { pid?: unknown }).pid
      : parseInt(text, 10);
    return typeof parsed === "number" && Number.isFinite(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The live default gateway and the profiles it records serving, or `null` when
 * that cannot be established — no record, a record from a process that is gone,
 * a gateway that is not `running`, or a record written by a build old enough not
 * to carry `served_profiles`. `null` means "unknown", not "serves nobody"; an
 * empty `served` array IS an authoritative "serves nobody else".
 *
 * The record's own `pid` must match a live process: `gateway_state.json`
 * survives a crash, and a recycled pid must not make a dead process's list
 * authoritative. The default's `gateway.pid` is preferred when present (it is
 * what `stopGateway` signals) but is not required — a launch-service gateway
 * can be live with no pid file at all, and the record's pid is then the only
 * handle there is.
 */
export function liveMultiplexer(
  hermesHome: string = HERMES_HOME,
): MultiplexerRecord | null {
  const record = readJson(join(hermesHome, "gateway_state.json"));
  if (!record) return null;
  if (
    typeof record.gateway_state === "string" &&
    record.gateway_state !== "running"
  ) {
    return null;
  }
  const recordedPid =
    typeof record.pid === "number" && Number.isFinite(record.pid)
      ? record.pid
      : null;
  if (recordedPid === null) return null;

  // When a pid file exists it must agree: two different live pids means the
  // record is not about the process that owns this home.
  const pidFile = join(hermesHome, "gateway.pid");
  if (existsSync(pidFile)) {
    let filePid: number | null = null;
    try {
      filePid = parsePid(readFileSync(pidFile, "utf-8"));
    } catch {
      filePid = null;
    }
    if (filePid !== null && filePid !== recordedPid) return null;
  }

  if (!pidIsAliveAs(recordedPid, GATEWAY_IMAGE_PREFIXES)) return null;

  const served = record.served_profiles;
  if (!Array.isArray(served)) return null; // older gateway: unknown, not empty
  return {
    pid: recordedPid,
    served: served
      .filter((name): name is string => typeof name === "string" && !!name)
      .map((name) => name.trim())
      .filter(Boolean),
  };
}

/**
 * Does the live default multiplexer already serve this profile? `false` when
 * there is no live multiplexer, when its record does not list the profile, or
 * when the record cannot be read — callers fall back to their own pid-file
 * evidence, which is what they did before multiplexing existed.
 *
 * `undefined` / "default" asks about the default profile itself, which a live
 * multiplexer always serves (it IS the default's gateway).
 */
export function multiplexerServes(
  profile?: string,
  hermesHome: string = HERMES_HOME,
): boolean {
  const record = liveMultiplexer(hermesHome);
  if (!record) return false;
  let name: string;
  try {
    // normalizeProfileName throws on a malformed name; an unnameable profile
    // is not one the multiplexer can be serving, so answer false rather than
    // propagating into a status read.
    name = normalizeProfileName(profile) || DEFAULT_PROFILE_NAME;
  } catch {
    return false;
  }
  if (name === DEFAULT_PROFILE_NAME) return true;
  return record.served.includes(name);
}

/**
 * Same question, asked with a profile HOME PATH — what `listProfiles` has.
 * `HERMES_HOME` itself is the default profile; anything under
 * `<home>/profiles/<name>` is that named profile.
 */
export function multiplexerServesHome(
  profilePath: string,
  hermesHome: string = HERMES_HOME,
): boolean {
  const profilesDir = join(hermesHome, "profiles");
  if (!profilePath.startsWith(profilesDir)) {
    // The default home (or something outside this install): the default
    // profile is served whenever a multiplexer is live.
    return (
      profilePath === hermesHome && multiplexerServes(undefined, hermesHome)
    );
  }
  const name = profilePath.slice(profilesDir.length + 1).split(/[/\\]/)[0];
  return multiplexerServes(name, hermesHome);
}

/**
 * The profile names a live multiplexer serves besides `default`. Empty when
 * there is no live multiplexer or it serves only the default profile — used
 * for reporting, never as evidence that a specific profile is off.
 */
export function multiplexedSecondaries(
  hermesHome: string = HERMES_HOME,
): string[] {
  const record = liveMultiplexer(hermesHome);
  if (!record) return [];
  return record.served.filter((name) => name !== DEFAULT_PROFILE_NAME);
}
