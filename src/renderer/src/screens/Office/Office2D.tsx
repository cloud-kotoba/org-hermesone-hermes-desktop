import { useEffect, useMemo } from "react";
import { Building2, Car, Crown, Landmark, Wallet } from "lucide-react";
import {
  emitMissionEvent,
  onMission,
  onMissionComplete,
  type Mission,
} from "./office3d/interactions/missionBus";
import type { ShowroomCar } from "./office3d/objects/CarShowroom";
import type { BuildingId, OfficeLocation } from "./office3d/core/locations";
import type { OfficeAgent } from "./office3d/core/types";

// @lat: [[office-2d]]

// The showroom's display cars, by name and paint only. Mirrors DISPLAY_CARS +
// HERO_CAR in office3d/objects/CarShowroom.tsx, copied rather than imported
// because that module pulls in three.js — the very bundle this view avoids.
const SHOWROOM_CARS: ShowroomCar[] = [
  { name: "Hermes S1 Aurum", tint: "#d4ac0d" },
  { name: "Hermes S1 Crimson", tint: "#b03a2e" },
  { name: "Hermes GT Azure", tint: "#1f618d" },
  { name: "Hermes S1 Pearl", tint: "#e8e8e8" },
  { name: "Hermes GT Gunmetal", tint: "#39414f" },
  { name: "Hermes GT Sunset", tint: "#ca6f1e" },
  { name: "Hermes S1 Emerald", tint: "#239b56" },
];

// Mission timings match the 3D sim (AgentsLayer): an interaction holds for up
// to two minutes while its modal is open, a plain visit lingers briefly.
const MISSION_ARRIVE_MS = 600;
const MISSION_HOLD_MS = 120_000;
const MISSION_LINGER_MS = 15_000;

const STATUS_COLOR: Record<OfficeAgent["status"], string> = {
  working: "#22c55e",
  idle: "#f59e0b",
  error: "#ef4444",
};

const panel: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid var(--border, rgba(0,0,0,0.12))",
  background: "var(--bg-secondary, rgba(127,127,127,0.06))",
};

function tileButton(active: boolean): React.CSSProperties {
  return {
    ...panel,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 8,
    padding: 14,
    textAlign: "left",
    cursor: "pointer",
    color: "var(--text-primary, inherit)",
    font: "inherit",
    border: active
      ? "1px solid rgba(125,211,252,0.9)"
      : "1px solid var(--border, rgba(0,0,0,0.12))",
    boxShadow: active ? "0 0 0 3px rgba(125,211,252,0.25)" : "none",
  };
}

/**
 * The 2D mission stand-in: the 3D sim walks the agent to the destination and
 * reports arrival; here the agent "arrives" after a beat and holds exactly as
 * long as the sim would, so Office.tsx's mission flow is unchanged.
 */
function useInstantMissions(agents: OfficeAgent[]): void {
  const agentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  useEffect(() => {
    let active: { mission: Mission; timers: number[] } | null = null;
    const end = (): void => {
      if (!active) return;
      for (const t of active.timers) window.clearTimeout(t);
      const { mission } = active;
      active = null;
      emitMissionEvent({ type: "ended", mission });
    };
    const offMission = onMission((mission) => {
      end();
      if (!agentIds.has(mission.agentId)) {
        emitMissionEvent({ type: "ended", mission });
        return;
      }
      const hold = mission.interaction ? MISSION_HOLD_MS : MISSION_LINGER_MS;
      const current = { mission, timers: [] as number[] };
      active = current;
      current.timers.push(
        window.setTimeout(() => {
          if (active !== current) return;
          emitMissionEvent({ type: "arrived", mission });
          current.timers.push(window.setTimeout(end, hold));
        }, MISSION_ARRIVE_MS),
      );
    });
    const offComplete = onMissionComplete((missionId) => {
      if (active?.mission.id === missionId) end();
    });
    return () => {
      offMission();
      offComplete();
      if (active) for (const t of active.timers) window.clearTimeout(t);
      active = null;
    };
  }, [agentIds]);
}

function AgentCard({
  agent,
  selected,
  onClick,
}: {
  agent: OfficeAgent;
  selected: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const ceo = agent.position === "ceo";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-agent-id={agent.id}
      style={{ ...tileButton(selected), minHeight: 96 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
        }}
      >
        <span
          aria-hidden
          style={{
            position: "relative",
            flex: "none",
            width: 34,
            height: 34,
            borderRadius: "50%",
            background: agent.color,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          {agent.name.slice(0, 1).toUpperCase()}
          <span
            style={{
              position: "absolute",
              right: -1,
              bottom: -1,
              width: 11,
              height: 11,
              borderRadius: "50%",
              background: STATUS_COLOR[agent.status],
              border: "2px solid var(--bg-primary, #111)",
            }}
          />
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontWeight: 600,
              fontSize: 14,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ceo && <Crown size={14} color="#f4b41f" />}
            {agent.name}
          </span>
          {agent.subtitle && (
            <span
              style={{
                display: "block",
                fontSize: 12,
                opacity: 0.6,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {agent.subtitle}
            </span>
          )}
        </span>
      </div>
      <span style={{ fontSize: 12, opacity: 0.7 }}>
        {agent.status}
        {agent.activeTaskCount ? ` · ${agent.activeTaskCount} task` : ""}
        {agent.cron?.jobs ? ` · cron ${agent.cron.jobs}` : ""}
      </span>
    </button>
  );
}

const CITY_BUILDINGS: {
  id: BuildingId;
  label: string;
  Icon: typeof Building2;
}[] = [
  { id: "showroom", label: "Showroom", Icon: Car },
  { id: "office", label: "Office", Icon: Building2 },
  { id: "bank", label: "Bank", Icon: Landmark },
];

/**
 * The Office tab's default view: a flat, DOM-only map of the same world the 3D
 * scene draws (city → office / bank / showroom). No WebGL, no GLB assets, no
 * per-frame loop — it re-renders only when agents or selection change.
 * Props are the subset of Office3D's that do not depend on walking a 3D world.
 */
export default function Office2D({
  agents,
  selectedId,
  onSelectAgent,
  location = "city",
  onEnterBuilding,
  onAtmActivate,
  tellerLabel = "Bank teller",
  onTellerActivate,
  onCarActivate,
}: {
  agents: OfficeAgent[];
  selectedId: string | null;
  onSelectAgent: (id: string | null) => void;
  location?: OfficeLocation;
  /** City view: a building was clicked — the flat map enters it directly. */
  onEnterBuilding?: (building: BuildingId) => void;
  onAtmActivate?: () => void;
  tellerLabel?: string;
  onTellerActivate?: () => void;
  onCarActivate?: (car: ShowroomCar) => void;
}): React.JSX.Element {
  useInstantMissions(agents);

  const ceo = agents.find((a) => a.position === "ceo") ?? null;
  const staff = agents.filter((a) => a !== ceo);
  const working = agents.filter((a) => a.status === "working").length;

  const pickAgent = (id: string): void =>
    onSelectAgent(id === selectedId ? null : id);

  let body: React.JSX.Element;
  if (location === "city") {
    body = (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        {CITY_BUILDINGS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            data-building={id}
            onClick={() => onEnterBuilding?.(id)}
            style={{ ...tileButton(false), minHeight: 150 }}
          >
            <Icon size={28} />
            <span style={{ fontWeight: 600, fontSize: 16 }}>{label}</span>
            {id === "office" && (
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {agents.length} agents · {working} working
              </span>
            )}
          </button>
        ))}
      </div>
    );
  } else if (location === "office") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {ceo && (
          <div style={{ maxWidth: 320 }}>
            <AgentCard
              agent={ceo}
              selected={ceo.id === selectedId}
              onClick={() => pickAgent(ceo.id)}
            />
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 12,
          }}
        >
          {staff.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              selected={a.id === selectedId}
              onClick={() => pickAgent(a.id)}
            />
          ))}
        </div>
      </div>
    );
  } else if (location === "bank") {
    body = (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 16,
        }}
      >
        <button
          type="button"
          onClick={onTellerActivate}
          style={{ ...tileButton(false), minHeight: 130 }}
        >
          <Landmark size={26} />
          <span style={{ fontWeight: 600 }}>{tellerLabel}</span>
        </button>
        <button
          type="button"
          onClick={onAtmActivate}
          style={{ ...tileButton(false), minHeight: 130 }}
        >
          <Wallet size={26} />
          <span style={{ fontWeight: 600 }}>ATM</span>
        </button>
      </div>
    );
  } else {
    body = (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
          gap: 12,
        }}
      >
        {SHOWROOM_CARS.map((car) => (
          <button
            key={car.name}
            type="button"
            onClick={() => onCarActivate?.(car)}
            style={{ ...tileButton(false), minHeight: 110 }}
          >
            <span
              aria-hidden
              style={{
                width: "100%",
                height: 36,
                borderRadius: 8,
                background: car.tint,
                border: "1px solid rgba(0,0,0,0.15)",
              }}
            />
            <span style={{ fontWeight: 600, fontSize: 13 }}>{car.name}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      data-office-view="2d"
      onClick={(e) => {
        // Clicking empty floor clears the selection, like the 3D scene's
        // pointer-missed handler.
        if (e.target === e.currentTarget) onSelectAgent(null);
      }}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "auto",
        padding: location === "city" ? "24px 20px 96px" : "64px 20px 96px",
      }}
    >
      {body}
    </div>
  );
}
