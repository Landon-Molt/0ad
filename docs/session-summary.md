# 0 A.D. SC2-Style Pathfinding Session Summary

## Date: March 28-30, 2026
## Branch: `sc2-pathfinding` (based on upstream/main from gitea.wildfiregames.com)
## Repo: https://github.com/Landon-Molt/0ad

---

## What We Built

### 4 commits, 26 files, ~3,200 lines of new code

```
76c0656 — SC2 responsive movement + tactical building surround (19 files, 1667 lines)
6545306 — Flow fields + Eikonal + ORCA (4 files, 1364 lines)
e96f930 — Documentation + future ideas (3 files)
0e67b0a — OOS desync fix: pure fixed-point math (4 files)
```

---

## Feature 1: SC2-Style Responsive Group Movement

**Game Setting:** "Group Movement" dropdown in Game Type tab (Classic / Responsive).
All changes gated behind `IsResponsive()` — Classic mode completely unchanged.

### SmartCenter Clustering (GroupMovementManager.js)
- Computes group center with 1-sigma outlier removal
- Sqrt-optimized: uses squared distances, only computes sqrt when needed
- Three modes: tight (σ² < 400), scattered (σ² > 6400), outlier_collapse
- Outlier formula from article: `normalize(offset) * sigma`

### Path Sharing
- `ComputeGroupPath()` in C++ — one synchronous JPS path per group
- Formation members skip long-range JPS entirely (short-range only)
- ~93% reduction in JPS queries for 300-unit groups
- `ComputeFlowFieldPath()` uses flow field portal A* in responsive mode

### Transitive Bumping (GroupMovementManager.js)
- First unit to arrive marks "arrived"
- Propagates through 4m contact chains
- Formation controller finishes when group has settled

### Enhanced C++ Pushing (CCmpUnitMotion_System.cpp)
- Stronger perpendicular nudge (5x vs 3x) when paths cross
- Formation members push freely when moving, restricted when stationary
- Stationary non-formation units resist displacement
- All gated behind `IsResponsiveMode()`

### Other Movement Improvements
- Forward-biased controller (30% toward target, prevents backward-seeking)
- Lower stuck threshold (15 turns vs 35)
- Straggler re-joining (idle units >60m auto-rejoin during movement)
- Path obstacle offset at corners (GetPathSideWidths)
- Responsive WALKING, WALKINGANDFIGHTING, PATROL states
- Batched entity position queries (GetEntityPositionsBatch)

---

## Feature 2: Tactical Building Surround

### Pincer Maneuver (Commands.js + GroupMovementManager.js)
- When attacking buildings in responsive mode, units execute tactical pincer
- Approach direction computed, units split into left/right halves
- Each half flows around their side of the building

### Role-Based Rings
- **Inner ring:** melee + cavalry (1.92m spacing, pincer split)
- **Second ring:** ranged units just behind melee (+2m)
- **Guard rings:** overflow infantry in concentric standground rings (8m gap, 6m between)
- **Cavalry patrol:** overflow cavalry circle with 6-waypoint patrol circuit
- Cavalry is outermost, guards between attack rings and cavalry

### Building Detection
- Triggers for targets with `IID_Obstruction.GetSize() > 2`
- Applied at command dispatch level (Commands.js), not formation AI
- Uses `IID_Attack.GetBestAttackAgainst()` and `GetRange()` for proper spacing

---

## Feature 3: Flow Field Tiles (FlowFieldManager.h/.cpp)

### 16x16 Navcell Sectors
- Cost fields built from existing `Grid<NavcellData>` passability grid
- `u8 costField[16][16]` — 1=passable, 255=impassable

### Portal System
- Portals detected at sector boundaries (contiguous passable spans)
- Portal graph with A* routing for hierarchical pathfinding
- `std::map` (not `unordered_map`) for deterministic iteration order

### Dijkstra Integration + Flow Field
- `u16 integrationField[16][16]` — cumulative cost via Dijkstra
- `u8 flowField[16][16]` — 8-direction gradient descent
- Cached by `(portalId, sectorX, sectorY, passClass)`

### Eikonal Equation Solver (Fast Marching Method)
- `fixed eikonalField[16][16]` — continuous travel time (ALL fixed-point)
- FMM with upwind scheme: `(T-Tx)² + (T-Tz)² = cost²`
- Uses `fixed::Sqrt()` (isqrt64) — bit-exact across ARM/x86
- Central-difference gradient produces smooth direction vectors
- `CFixedVector2D smoothFlowField[16][16]` — normalized gradient

### Cache Management
- Flow fields cached per (portal, sector, passClass)
- Dirty sector tracking via GridUpdateInformation
- Incremental updates when terrain changes

---

## Feature 4: ORCA Collision Avoidance (OrcaSolver.h/.cpp)

### Algorithm
- Optimal Reciprocal Collision Avoidance (van den Berg et al. 2011)
- Fixed-point 2D linear programming over half-plane constraints
- Each agent computes collision-free velocity independently: O(N*K)
- Uses `fixed::Sqrt()` for discriminant — deterministic cross-platform

### Integration (CCmpUnitMotion_System.cpp)
- ORCA phase runs for units with flow field/formation preferred velocity
- Classic pushing runs for individual combat movement and stationary units
- Both moving pairs: ORCA handles; at least one stationary: pushing handles
- Agent radius = `clearance * PushingRadiusMultiplier` (~2.2m, matches classic)
- `orcaVelocity` and `prefVelocity` reset every tick (no stale state)

### Formation-Aware ORCA (CCmpUnitMotion.h)
- Preferred velocity: 70% flow field direction + 30% offset correction
- Formation shape "rides" the flow field — units maintain rough formation
- Falls back through: Eikonal smooth → discrete flow → waypoint → JPS

### Move() Integration
- When ORCA velocity is available and unit is actively moving: apply directly
- Computes preferred velocity from Eikonal → discrete flow → waypoints
- Falls through to classic `TryGoingStraight + PerformMove` when no ORCA

---

## Feature 5: Performance Profiling

### GetPathStats (GuiInterface.js)
- `Engine.GuiInterfaceCall("GetPathStats")` returns `{longPaths, shortPaths}`
- Resets counters on each call
- Used to benchmark Classic vs Responsive mode

### Path Request Counters (CCmpPathfinder.cpp)
- `m_LongPathCount` and `m_ShortPathCount` incremented per async request
- `GetAndResetPathStats()` exposed to JS

---

## Determinism & Multiplayer

### OOS Testing
- Tested with 2000 units across ARM (macOS M5 Max) and x86 (Windows RTX 3090)
- **Passed** — no desync

### Determinism Guarantees
- ALL simulation math uses `entity_pos_t` / `CFixedVector2D` (fixed-point)
- `fixed::Sqrt()` uses `isqrt64` — bit-exact integer square root
- Zero `float`/`sqrtf` in simulation path
- Flow field cache uses `std::map` (deterministic iteration order)
- ORCA state reset every tick (no stale cross-phase leakage)
- Classic mode completely untouched

### OOS Bugs Found & Fixed
1. **Eikonal used `float`/`sqrtf`** → rewrote to pure fixed-point
2. **ORCA used Newton's method sqrt** → replaced with `fixed::Sqrt()`
3. **`unordered_map` cache** → changed to `std::map` for deterministic order
4. **Stale `prefVelocity`/`orcaVelocity`** → reset every tick

---

## Build & Deployment

### macOS (arm64)
- Built with Clang via Makefile (gcc workspace)
- SpiderMonkey required linker detection patch for Apple Silicon
- Homebrew dependencies for gloox (caused `-DDEBUG` in release builds — stripped from makefiles)
- MoltenVK built with Xcode for Vulkan support

### Windows (x64)
- Built with VS2022 Community (MSBuild)
- Pre-built dependencies from SVN (`get-windows-libs.bat`)
- Required SVN CLI installation
- Mock class (`test_TerritoryManager.h`) needed stubs for new ICmpPathfinder methods

### Portable Package
- `0AD-SC2-Portable.7z` — 4.39 GB
- Contains: pyrogenesis.exe, release DLLs, public.zip, mod.zip, config
- Extract and run — no installation needed

---

## Performance Results

| Metric | Classic | Responsive |
|--------|---------|------------|
| JPS queries (300 units, per move) | ~300 | ~20-30 (~93% reduction) |
| Movement | Waypoint following | ORCA velocity (when flow field available) |
| Collision | O(N²) pushing | ORCA O(N*K) + pushing for stationary |
| Building attack | Clump on one side | Pincer surround with role-based rings |

### Performance Bottleneck Identified
At 750+ units, FPS drops to 16-24 on BOTH M5 Max and RTX 3090. Same FPS = NOT a pathfinding bottleneck. Confirmed as **rendering** (blood decals, corpse decay) — GPU usage is low, CPU rendering overhead dominates. Moving camera away from battle area restores FPS.

---

## Files Changed

### New Files (8)
- `binaries/data/mods/public/gamesettings/attributes/GroupMovement.js`
- `binaries/data/mods/public/gui/.../Dropdowns/GroupMovement.js`
- `binaries/data/mods/public/simulation/components/GroupMovementManager.js`
- `binaries/data/mods/public/simulation/components/interfaces/GroupMovementManager.js`
- `source/simulation2/helpers/FlowFieldManager.h`
- `source/simulation2/helpers/FlowFieldManager.cpp`
- `source/simulation2/helpers/OrcaSolver.h`
- `source/simulation2/helpers/OrcaSolver.cpp`

### Modified JS (6)
- `GameSettingsLayout.js` — added dropdown
- `InitGame.js` — propagates setting to JS and C++
- `Formation.js` — responsive branch, forward-biased controller, outlier formula
- `UnitAI.js` — responsive states, straggler recovery, building surround fallback
- `Commands.js` — pincer building surround at command dispatch
- `GuiInterface.js` — path stats console command

### Modified C++ (9)
- `CCmpPathfinder.cpp` — flow field integration, ComputeFlowFieldPath, batch APIs
- `CCmpPathfinder_Common.h` — FlowFieldManager member, method declarations
- `CCmpUnitMotion.h` — ORCA steering, JPS skip, stuck threshold, preferred velocity
- `CCmpUnitMotionManager.h` — group movement mode, ORCA state in MotionState
- `CCmpUnitMotion_System.cpp` — ORCA phase, enhanced pushing, state reset
- `ICmpPathfinder.h` — ComputeGroupPath, flow field APIs, batch queries
- `ICmpPathfinder.cpp` — JS bindings
- `ICmpUnitMotionManager.h/.cpp` — SetGroupMovementMode binding
- `test_TerritoryManager.h` — mock stubs for new methods

### Documentation (3)
- `docs/sc2-group-movement.md` — comprehensive feature docs
- `docs/future-ideas.md` — formation drag preview, terrain costs
- `docs/session-summary.md` — this file

---

## Based On

- "Group Pathfinding & Movement in RTS Style Games" (GDC 2014, Dru Erridge)
- GameAIPro Ch.23: "Crowd Pathfinding Using Flow Field Tiles" (Emerson)
- openage v0.6.0 flow field implementation (SFTtech)
- ORCA paper (van den Berg et al. 2011, UNC)
- RVO2 reference implementation (UNC)

---

## Future Work

### Planned
- **Formation drag preview** — right-click drag to set facing direction (UI feature)
- **Eikonal terrain costs** — different terrain = different movement speed
- **Threat-aware flow fields** — avoid enemy towers
- **Rendering optimization** — the actual FPS bottleneck (blood decals, corpse decay)

### Considered
- **VertexPathfinder edge caching** — deferred, complex cross-platform determinism
- **Pushing parallelization (checkerboard)** — deferred, desync risk
- **Async flow field generation** — generate sectors between turns via TaskManager
- **ORCA parallelization** — independent per-agent, natural fit for TaskManager
