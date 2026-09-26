# Office 2D View

The Office tab's default view is a flat, DOM-only map of the office world; the three.js scene is opt-in behind a header toggle and loaded lazily, because the 3D office was too heavy to be the default.

## Why 2D is the default

The 3D scene costs a WebGL context and continuous CPU/GPU work even when nothing changes.

It carries three.js, GLB models, traffic, pedestrians and a per-frame simulation. [[src/renderer/src/screens/Office/Office2D.tsx#Office2D]] renders the same locations (city → office / bank / showroom) as plain buttons and cards, re-rendering only when agents or selection change.

[[src/renderer/src/screens/Office/Office.tsx]] imports the 3D scene with `React.lazy`, so its chunk is fetched only after the user switches to 3D. The choice persists in `localStorage` under `hermes:office:view` (`"2d"` unless it reads `"3d"`). Switching back to 2D exits walk mode and the dev building mover, which exist only in the 3D scene; the GPU software-rendering banner is shown only in 3D.

## Interactions in 2D

Every 3D interaction that does not need a walkable world has a 2D equivalent.

A city tile enters its building directly (no focus-then-Enter step), agent cards select the agent (opening the same details sidebar), the bank shows teller and ATM tiles, and the showroom lists the display cars for the spec card.

## Missions without a simulation

Chat-commanded errands ([[office-world-actions]]) still go through the mission bus; Office2D answers it in place of the walking sim.

With no walking sim mounted, `useInstantMissions` in Office2D stands in for AgentsLayer: it reports `arrived` after a short beat, holds for the same durations as the 3D sim (two minutes with an interaction, fifteen seconds without), and reports `ended` on completion, timeout, or a superseding mission — so Office.tsx's mission flow is unchanged in either view.

## Tests

Tests for the 2D view.

### Mission stand-in

A dispatched mission reports `arrived` without a 3D scene, completing it reports `ended`, and a mission for an unknown agent ends immediately.
