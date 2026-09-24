#!/usr/bin/env node
// launchd KeepAlive agent → ~/.hermes/desktop-services.json entry (service-supervisor.ts).
//
//   node scripts/launchd-to-desktop-services.mjs <plist>...           # print entries (dry-run)
//   node scripts/launchd-to-desktop-services.mjs --write <plist>...   # merge into desktop-services.json
//
// Only KeepAlive agents convert: a schedule (StartInterval / StartCalendarInterval without
// KeepAlive) belongs in Hermes cron, not here. The supervisor refuses to start a label that
// launchd still has loaded, so write first, then `launchctl bootout` the agent — the next
// supervisor tick starts it. Merge is by label: an existing entry is replaced, others kept.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function restartPolicy(keepAlive) {
  if (keepAlive === true) return "always";
  if (keepAlive && typeof keepAlive === "object") {
    // {SuccessfulExit:false} restarts on a non-zero exit; {Crashed:true} on a crash. Both map to
    // on-failure. Any other condition (NetworkState, PathState, ...) was a "keep it up" intent.
    if (keepAlive.SuccessfulExit === false || keepAlive.Crashed === true) return "on-failure";
    return "always";
  }
  return null;
}

export function specFromPlist(p) {
  const restart = restartPolicy(p.KeepAlive);
  if (!restart) return { error: `${p.Label}: not a KeepAlive agent (a schedule goes to Hermes cron)` };
  const argv = p.ProgramArguments ?? (p.Program ? [p.Program] : []);
  if (argv.length === 0) return { error: `${p.Label}: no Program / ProgramArguments` };
  const spec = {
    label: p.Label,
    program: p.Program ?? argv[0],
    args: p.Program ? argv.slice(1) : argv.slice(1),
    restart,
    throttleSec: p.ThrottleInterval ?? 10,
    enabled: p.Disabled !== true,
  };
  if (p.EnvironmentVariables) spec.env = p.EnvironmentVariables;
  if (p.WorkingDirectory) spec.cwd = p.WorkingDirectory;
  if (p.StandardOutPath) spec.stdout = p.StandardOutPath;
  if (p.StandardErrorPath) spec.stderr = p.StandardErrorPath;
  return { spec };
}

function readPlist(path) {
  // plutil accepts plists expat-strict parsers reject (e.g. `--` inside an XML comment).
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
}

function main(argv) {
  const write = argv.includes("--write");
  const plists = argv.filter((a) => a !== "--write");
  if (plists.length === 0) {
    console.error("usage: launchd-to-desktop-services.mjs [--write] <plist>...");
    process.exit(2);
  }
  const specs = [];
  let failed = 0;
  for (const path of plists) {
    const { spec, error } = specFromPlist(readPlist(path));
    if (error) {
      console.error(`SKIP ${error}`);
      failed++;
    } else specs.push(spec);
  }
  if (!write) {
    console.log(JSON.stringify({ services: specs }, null, 2));
  } else {
    const cfg = join(homedir(), ".hermes", "desktop-services.json");
    const current = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : { services: [] };
    const byLabel = new Map((current.services ?? []).map((s) => [s.label, s]));
    for (const s of specs) byLabel.set(s.label, s);
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ services: [...byLabel.values()] }, null, 2) + "\n");
    console.log(`wrote ${specs.length} service(s) → ${cfg} (${byLabel.size} total)`);
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
