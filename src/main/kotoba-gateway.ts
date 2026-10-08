import { existsSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { profileHome } from "./utils";

// @lat: [[gateway-hy#Desktop integration]]

/**
 * Which process serves the local Hermes API for a profile.
 *
 * - `hy` (default): Kotoba's own gateway in `gateway-hy/`, written in Hy. It
 *   speaks the Hermes API (`/health`, `/v1/capabilities`, `/v1/models`,
 *   `/v1/chat/completions`, `/v1/runs` + SSE events) and runs Hermes Agent's
 *   `AIAgent` in-process, inside the Hermes venv.
 * - `hermes`: upstream `hermes gateway` (the pre-Hy behaviour), for
 *   messaging platforms and anything the Hy gateway does not serve yet.
 */
export type GatewayRuntime = "hy" | "hermes";

export function gatewayRuntime(
  env: NodeJS.ProcessEnv = process.env,
): GatewayRuntime {
  return env.KOTOBA_GATEWAY_RUNTIME?.trim().toLowerCase() === "hermes"
    ? "hermes"
    : "hy";
}

export function isHyGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  return gatewayRuntime(env) === "hy";
}

/** `gateway-hy/` next to the app: unpacked resources when packaged, repo root in dev. */
export function kotobaGatewayDir(): string {
  if (process.env.KOTOBA_GATEWAY_DIR) return process.env.KOTOBA_GATEWAY_DIR;
  return app.isPackaged
    ? join(process.resourcesPath, "gateway-hy")
    : join(app.getAppPath(), "gateway-hy");
}

export function kotobaGatewayLauncher(): string {
  return join(kotobaGatewayDir(), "kotoba_gateway_main.py");
}

/** Missing-install message, or null when the Hy gateway can be spawned. */
export function kotobaGatewaySpawnError(): string | null {
  const dir = kotobaGatewayDir();
  if (!existsSync(kotobaGatewayLauncher())) {
    return `Kotoba Hy gateway not found at ${dir}.`;
  }
  if (!existsSync(join(dir, ".deps", "hy"))) {
    return `Hy is not vendored in ${join(dir, ".deps")}. Run \`npm run gateway:deps\`.`;
  }
  return null;
}

/** Own pid file, so a running upstream `hermes gateway` is never mistaken for it. */
export function kotobaGatewayPidPath(profile?: string): string {
  return join(profileHome(profile), "kotoba-gateway.pid");
}

export function kotobaGatewayArgs(
  profile: string | undefined,
  port: number,
): string[] {
  return [
    kotobaGatewayLauncher(),
    "--port",
    String(port),
    "--pid-file",
    kotobaGatewayPidPath(profile),
  ];
}

/** Env overlay: the Hy gateway reads HERMES_HOME directly (no `--profile` flag). */
export function kotobaGatewayEnv(
  profile: string | undefined,
  hermesRepo: string,
): Record<string, string> {
  return {
    HERMES_HOME: profileHome(profile),
    HERMES_REPO: hermesRepo,
    KOTOBA_GATEWAY_PID_FILE: kotobaGatewayPidPath(profile),
  };
}
