// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  countRunningTasksByAssignee,
  officeAgentsChanged,
  profilesToOfficeAgents,
  type OfficeProfileInput,
  type OfficeTaskInput,
} from "./agents";

const profiles: OfficeProfileInput[] = [
  { id: "default", name: "Primary Agent", gatewayRunning: true },
  {
    id: "build-agent",
    name: "Build Agent",
    gatewayRunning: false,
  },
  { id: "research-agent", name: "Research Agent", gatewayRunning: true },
];

describe("Office Kanban activity", () => {
  it("matches running-card assignees to stable profile IDs", () => {
    const tasks: OfficeTaskInput[] = [
      { assignee: "build-agent", status: "running" },
      { assignee: " @BUILD-AGENT ", status: "running" },
      { assignee: "research-agent", status: "done" },
      { assignee: null, status: "running" },
    ];

    const agents = profilesToOfficeAgents(profiles, tasks);

    expect(
      agents.map(({ id, status, activeTaskCount }) => ({
        id,
        status,
        activeTaskCount,
      })),
    ).toEqual([
      { id: "default", status: "idle", activeTaskCount: 0 },
      {
        id: "build-agent",
        status: "working",
        activeTaskCount: 2,
      },
      { id: "research-agent", status: "idle", activeTaskCount: 0 },
    ]);
  });

  it("falls back to gateway liveness when Kanban is unavailable", () => {
    const agents = profilesToOfficeAgents(profiles, null);

    expect(
      agents.map(({ id, status, activeTaskCount }) => ({
        id,
        status,
        activeTaskCount,
      })),
    ).toEqual([
      { id: "default", status: "working", activeTaskCount: undefined },
      {
        id: "build-agent",
        status: "idle",
        activeTaskCount: undefined,
      },
      {
        id: "research-agent",
        status: "working",
        activeTaskCount: undefined,
      },
    ]);
  });

  it("counts only running cards with non-empty assignees", () => {
    const counts = countRunningTasksByAssignee([
      { assignee: "default", status: "running" },
      { assignee: "DEFAULT", status: "running" },
      { assignee: "default", status: "blocked" },
      { assignee: " ", status: "running" },
    ]);

    expect(Object.fromEntries(counts)).toEqual({ default: 2 });
  });

  it("detects activity-count changes even when status stays working", () => {
    const before = profilesToOfficeAgents(profiles, [
      { assignee: "default", status: "running" },
    ]);
    const after = profilesToOfficeAgents(profiles, [
      { assignee: "default", status: "running" },
      { assignee: "default", status: "running" },
    ]);

    expect(officeAgentsChanged(before, after)).toBe(true);
    expect(officeAgentsChanged(after, after)).toBe(false);
  });
});

// @lat: [[office-cron-presence#Cron presence#Tests]]
describe("Office cron presence (this fork)", () => {
  const cron = (over: Partial<NonNullable<OfficeProfileInput["cron"]>>) => ({
    jobs: 1,
    running: 0,
    lastRunAt: "2026-09-22T04:35:29+09:00",
    lastStatus: "ok" as const,
    lastError: null,
    nextRunAt: "2026-09-23T04:34:00+09:00",
    failedJobs: [],
    ...over,
  });

  it("a cron-driven bot between runs is idle, one with an attempt in flight is working", () => {
    const [between, inFlight] = profilesToOfficeAgents(
      [
        { id: "a", name: "A", gatewayRunning: false, cron: cron({}) },
        {
          id: "b",
          name: "B",
          gatewayRunning: false,
          cron: cron({ running: 1 }),
        },
      ],
      [],
    );
    expect(between.status).toBe("idle");
    expect(inFlight.status).toBe("working");
    expect(inFlight.cron?.running).toBe(1);
  });

  it("a bot whose last run failed is an error, not the same amber as one that succeeded", () => {
    const [failed, fine] = profilesToOfficeAgents(
      [
        {
          id: "f",
          name: "F",
          gatewayRunning: false,
          cron: cron({
            lastStatus: "error",
            lastError:
              "RuntimeError: content screening could not run (screen-route-refused)",
            failedJobs: ["daily"],
          }),
        },
        { id: "g", name: "G", gatewayRunning: false, cron: cron({}) },
      ],
      [],
    );
    expect(failed.status).toBe("error");
    expect(failed.cron?.lastError).toMatch(/screen-route-refused/);
    expect(fine.status).toBe("idle");
  });

  it("a running Kanban card still wins over cron; a live gateway only when Kanban is unavailable", () => {
    const [byCard, gatewayWithKanban] = profilesToOfficeAgents(
      [
        {
          id: "c",
          name: "C",
          gatewayRunning: false,
          cron: cron({ lastStatus: "error" }),
        },
        {
          id: "d",
          name: "D",
          gatewayRunning: true,
          cron: cron({ lastStatus: "error" }),
        },
      ],
      [{ assignee: "c", status: "running" }],
    );
    expect(byCard.status).toBe("working");
    // upstream: with Kanban data, gateway liveness is metadata, not status —
    // so the failed run is what shows
    expect(gatewayWithKanban.status).toBe("error");
    const [gatewayNoKanban] = profilesToOfficeAgents(
      [
        {
          id: "d",
          name: "D",
          gatewayRunning: true,
          cron: cron({ lastStatus: "error" }),
        },
      ],
      null,
    );
    expect(gatewayNoKanban.status).toBe("working");
  });

  it("a profile without cron, or with no enabled jobs, keeps the upstream rule", () => {
    const [none, empty] = profilesToOfficeAgents(
      [
        { id: "n", name: "N", gatewayRunning: false, cron: null },
        {
          id: "e",
          name: "E",
          gatewayRunning: false,
          cron: cron({ jobs: 0, lastStatus: "error" }),
        },
      ],
      [],
    );
    expect(none.status).toBe("idle");
    expect(empty.status).toBe("idle");
  });

  it("a change in cron state is a change the scene re-renders for", () => {
    const [before] = profilesToOfficeAgents(
      [{ id: "a", name: "A", cron: cron({}) }],
      [],
    );
    const [after] = profilesToOfficeAgents(
      [{ id: "a", name: "A", cron: cron({ lastStatus: "error" }) }],
      [],
    );
    expect(officeAgentsChanged([before], [after])).toBe(true);
    expect(officeAgentsChanged([after], [after])).toBe(false);
  });
});
