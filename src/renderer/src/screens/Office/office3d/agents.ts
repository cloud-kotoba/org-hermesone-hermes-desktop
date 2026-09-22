import { createAgentAvatarProfileFromSeed } from "./avatars/profile";
import type { OfficeAgent, OfficeAgentCron } from "./core/types";

/**
 * A profile as surfaced by the desktop's `listProfiles` IPC. Only the fields
 * the office needs to render an agent are required here.
 */
export interface OfficeProfileInput {
  id?: string;
  name: string;
  /**
   * Unique, stable identifier for the profile (the on-disk profile path from
   * `listProfiles`). Used as the agent's React key / lookup id so two profiles
   * sharing a display name don't collapse into one agent. Falls back to the
   * name when absent.
   */
  path?: string;
  model?: string;
  provider?: string;
  gatewayRunning?: boolean;
  cron?: OfficeAgentCron | null;
}

/** Minimal Kanban task shape needed to derive live Office activity. */
export interface OfficeTaskInput {
  assignee?: string | null;
  status?: string | null;
}

// Stable, pleasant accent colors keyed off the profile name so each agent keeps
// the same color between renders.
const AGENT_COLORS = [
  "#7090ff",
  "#34d399",
  "#f59e0b",
  "#f43f5e",
  "#8b5cf6",
  "#0891b2",
  "#db2777",
  "#22c55e",
];

function hashName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * What a profile's cron scheduler says its status is, when it says anything:
 * an attempt in flight is "working", a last run that failed is "error", a
 * scheduler with jobs that ran fine is "idle" (between runs). A profile with
 * no cron directory, or with cron but no enabled jobs, says nothing (null)
 * and the upstream rule below decides. This fork's fleet is cron-driven
 * (see main/profile-cron.ts): without this every bot was amber all day, the
 * 57 that had failed indistinguishable from the ones that had succeeded.
 */
export function cronStatus(
  cron: OfficeAgentCron | null | undefined,
): OfficeAgent["status"] | null {
  if (!cron || cron.jobs === 0) return null;
  if (cron.running > 0) return "working";
  if (cron.lastStatus === "error") return "error";
  return "idle";
}

/**
 * Map a desktop profile to an office agent. When Kanban activity is available,
 * a running assignment reads as "working" (green), otherwise "idle" (amber).
 * Gateway liveness is retained as separate metadata and as a compatibility
 * fallback for connection modes that cannot query Kanban. A running Kanban
 * card or a live gateway still wins over cron; cron speaks only when neither
 * says "working" (this fork).
 */
export function profileToOfficeAgent(
  profile: OfficeProfileInput,
  activeTaskCount?: number,
): OfficeAgent {
  const id = profile.id || profile.name;
  const seed = id || "agent";
  const agentName = profile.name;
  const color = AGENT_COLORS[hashName(seed) % AGENT_COLORS.length];
  const upstreamStatus: OfficeAgent["status"] =
    activeTaskCount === undefined
      ? profile.gatewayRunning
        ? "working"
        : "idle"
      : activeTaskCount > 0
        ? "working"
        : "idle";
  const fromCron = cronStatus(profile.cron);
  // Use the profile id as the stable identifier for routing/gateway calls.
  return {
    id,
    name: agentName,
    subtitle: profile.model || profile.provider || null,
    status:
      upstreamStatus === "working" || fromCron === null
        ? upstreamStatus
        : fromCron,
    color,
    item: "desk",
    avatarProfile: createAgentAvatarProfileFromSeed(seed),
    model: profile.model,
    provider: profile.provider,
    gatewayRunning: profile.gatewayRunning,
    activeTaskCount,
    cron: profile.cron ?? null,
    position: "employee",
  };
}

function normalizeProfileId(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export function countRunningTasksByAssignee(
  tasks: OfficeTaskInput[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.status !== "running" || !task.assignee?.trim()) continue;
    const assignee = normalizeProfileId(task.assignee);
    counts.set(assignee, (counts.get(assignee) ?? 0) + 1);
  }
  return counts;
}

export function profilesToOfficeAgents(
  profiles: OfficeProfileInput[],
  tasks?: OfficeTaskInput[] | null,
): OfficeAgent[] {
  if (tasks == null) {
    return profiles.map((profile) => profileToOfficeAgent(profile));
  }

  const activeTasks = countRunningTasksByAssignee(tasks);
  return profiles.map((profile) => {
    const id = normalizeProfileId(profile.id || profile.name);
    return profileToOfficeAgent(profile, activeTasks.get(id) ?? 0);
  });
}

export function officeAgentsChanged(
  previous: OfficeAgent[],
  next: OfficeAgent[],
): boolean {
  if (next.length !== previous.length) return true;
  const previousById = new Map(previous.map((agent) => [agent.id, agent]));
  return next.some((agent) => {
    const before = previousById.get(agent.id);
    return (
      !before ||
      before.name !== agent.name ||
      before.subtitle !== agent.subtitle ||
      before.status !== agent.status ||
      before.model !== agent.model ||
      before.provider !== agent.provider ||
      before.gatewayRunning !== agent.gatewayRunning ||
      before.activeTaskCount !== agent.activeTaskCount ||
      before.cron?.running !== agent.cron?.running ||
      before.cron?.lastRunAt !== agent.cron?.lastRunAt ||
      before.cron?.lastStatus !== agent.cron?.lastStatus
    );
  });
}
