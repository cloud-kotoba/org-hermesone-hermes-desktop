import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Office2D from "./Office2D";
import {
  completeMission,
  dispatchMission,
  onMissionEvent,
  type MissionEvent,
} from "./office3d/interactions/missionBus";
import type { OfficeAgent } from "./office3d/core/types";

const AGENTS: OfficeAgent[] = [
  { id: "a", name: "Alpha", status: "working", color: "#123456", item: "" },
  { id: "b", name: "Beta", status: "idle", color: "#654321", item: "" },
];

describe("Office2D", () => {
  let events: MissionEvent[];
  let off: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    off = onMissionEvent((e) => events.push(e));
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it("enters a building from the city map", () => {
    const onEnter = vi.fn();
    render(
      <Office2D
        agents={AGENTS}
        selectedId={null}
        onSelectAgent={() => {}}
        onEnterBuilding={onEnter}
      />,
    );
    fireEvent.click(screen.getByText("Bank"));
    expect(onEnter).toHaveBeenCalledWith("bank");
  });

  it("selects an agent from its desk card", () => {
    const onSelect = vi.fn();
    render(
      <Office2D
        agents={AGENTS}
        selectedId={null}
        onSelectAgent={onSelect}
        location="office"
      />,
    );
    fireEvent.click(screen.getByText("Beta"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  // @lat: [[office-2d#Tests#Mission stand-in]]
  it("stands in for the walking sim on the mission bus", () => {
    render(
      <Office2D agents={AGENTS} selectedId={null} onSelectAgent={() => {}} />,
    );
    const mission = {
      id: "m1",
      agentId: "a",
      dest: "bank" as const,
      interaction: { repId: "bank-teller", actionId: "status" as never },
    };
    act(() => dispatchMission(mission));
    expect(events).toEqual([]);
    act(() => vi.advanceTimersByTime(1000));
    expect(events.map((e) => e.type)).toEqual(["arrived"]);
    act(() => completeMission("m1"));
    expect(events.map((e) => e.type)).toEqual(["arrived", "ended"]);

    const ghost = { ...mission, id: "m2", agentId: "nobody" };
    act(() => dispatchMission(ghost));
    expect(events.at(-1)).toEqual({ type: "ended", mission: ghost });
  });
});
