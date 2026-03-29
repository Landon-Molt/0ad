# SC2-Style Responsive Group Movement

## Overview

Optional "Responsive" group movement mode for 0 A.D., selectable in the Game
Type tab. Implements techniques from the GDC 2014 talk "Group Pathfinding &
Movement in RTS Style Games" plus flow field tile-based pathfinding.

## Game Setting

**Group Movement** dropdown in Game Type tab:
- **Classic**: Standard formation movement (completely unchanged)
- **Responsive (SC2-style)**: Optimized for large armies

## Features

### SmartCenter Clustering
Sqrt-optimized outlier detection using squared distances:
- **Tight** (sigma² < 400): Normal formation offsets
- **Scattered** (sigma² > 6400): DistributeAround spiral spread
- **Outlier collapse**: normalize(offset) * sigma (article formula)

### Path Sharing + Flow Fields
One strategic path per group. In responsive mode, uses flow field
tile-based routing (portal A* over 16x16 sectors) instead of JPS.
Formation members skip JPS entirely — short-range pathfinding only.
~93-99% reduction in JPS queries for 300-unit groups.

### Flow Field Infrastructure
- 16x16 navcell sectors with cost fields from passability grid
- Portal detection at sector boundaries
- Portal A* for hierarchical routing
- Dijkstra integration + gradient flow field generation
- Cached by (portal, sector, passClass)
- Incremental dirty sector updates on terrain change

### Transitive Bumping
Arrival propagates through 4m contact chains. Group stops naturally.

### Enhanced Pushing
- 5x perpendicular nudge (vs 3x) when paths cross
- Formation members push freely when moving, restricted when stationary
- Stationary non-formation units resist displacement

### Tactical Building Surround
Pincer maneuver with role-based ring assignment:
- **Melee + cavalry**: inner ring (1.92m spacing), pincer split
- **Ranged**: second ring just behind melee (+2m)
- **Overflow cavalry**: 6-waypoint patrol circuit
- **Overflow infantry**: concentric standground guard rings
- Batched position queries via GetEntityPositionsBatch

### Other
- Forward-biased controller (30% toward target)
- Lower stuck threshold (15 turns vs 35)
- Straggler re-joining (idle units >60m auto-rejoin)
- Responsive WALKING, WALKINGANDFIGHTING, PATROL states
- Path obstacle offset at corners (GetPathSideWidths)

## Performance

| Metric | Classic | Responsive |
|--------|---------|------------|
| JPS queries (300 units) | ~300 | ~20-30 (~93% reduction) |
| Surround JS→C++ crossings | 3N | ~1 (batched) |
| Strategic routing | JPS per unit | Flow field portal A* (shared) |

Benchmark: `Engine.GuiInterfaceCall("GetPathStats")`

## Architecture

```
Classic:  HierarchicalPathfinder → JPS (per unit) → VertexPathfinder (per unit)
Responsive: FlowFieldManager (portal A*) → Flow field waypoints (shared)
            Formation members: short-range only (JPS skipped)
            Per-tick movement: existing collision-checked pipeline
```

Note: Direct per-tick flow field steering was prototyped but needs ORCA/RVO
collision avoidance to replace the pushing system (Phase 3).

## Files

**New (6):**
- GroupMovement.js (game setting + dropdown)
- GroupMovementManager.js (SmartCenter, path sharing, surround, transitive bumping)
- GroupMovementManager interface registration
- FlowFieldManager.h/.cpp (sectors, portals, A*, Dijkstra, flow fields)

**Modified JS (6):**
- GameSettingsLayout.js, InitGame.js, Formation.js, UnitAI.js, Commands.js, GuiInterface.js

**Modified C++ (8):**
- CCmpPathfinder.cpp, CCmpPathfinder_Common.h (flow field integration)
- CCmpUnitMotion.h (JPS skip, stuck threshold, flow field include)
- CCmpUnitMotionManager.h, CCmpUnitMotion_System.cpp (enhanced pushing)
- ICmpPathfinder.h/.cpp (ComputeFlowFieldPath, GetFlowDirection, batch APIs)
- ICmpUnitMotionManager.h/.cpp (responsive mode interface)

## Based On

- "Group Pathfinding & Movement in RTS Style Games" (GDC 2014, Dru Erridge)
- GameAIPro Ch.23: "Crowd Pathfinding Using Flow Field Tiles" (Emerson)
- openage v0.6.0 flow field implementation (SFTtech)

## Next: Phase 3 — ORCA/RVO

Replace the O(N²) pushing system with ORCA (Optimal Reciprocal Collision
Avoidance). This will enable direct flow field steering where units read
direction from the flow field grid O(1) per tick with proper collision-free
velocity computation. Currently blocked because direct steering bypasses
collision checking.
