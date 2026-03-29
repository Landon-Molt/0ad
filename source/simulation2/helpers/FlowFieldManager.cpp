/* Copyright (C) 2026 Wildfire Games.
 * This file is part of 0 A.D.
 *
 * 0 A.D. is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * 0 A.D. is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with 0 A.D.  If not, see <http://www.gnu.org/licenses/>.
 */

#include "precompiled.h"

#include "FlowFieldManager.h"

#include "ps/Profile.h"

// Direction vectors for the 8 cardinal + diagonal directions.
static const int DX[] = { 0,  0, 1, 1,  1,  0, -1, -1, -1 }; // indexed by FlowDirection
static const int DZ[] = { 0, -1,-1, 0,  1,  1,  1,  0, -1 };

// Diagonal cost multiplier: 1.4 approximated as 14/10
static constexpr u16 DIAGONAL_COST_MULT = 14;
static constexpr u16 STRAIGHT_COST_MULT = 10;

void FlowFieldManager::Init(u16 gridSize, const Grid<NavcellData>& grid, pass_class_t passClass)
{
	PROFILE2("FlowField_Init");

	m_GridSize = gridSize;
	m_SectorsW = (gridSize + SECTOR_SIZE - 1) / SECTOR_SIZE;
	m_SectorsH = (gridSize + SECTOR_SIZE - 1) / SECTOR_SIZE;

	m_Sectors.resize(m_SectorsW * m_SectorsH);

	for (u16 sy = 0; sy < m_SectorsH; ++sy)
	{
		for (u16 sx = 0; sx < m_SectorsW; ++sx)
		{
			FlowFieldSector& sector = GetSector(sx, sy);
			sector.sectorX = sx;
			sector.sectorY = sy;
			BuildCostField(sector, grid, passClass);
		}
	}

	BuildPortals(grid, passClass);
}

void FlowFieldManager::BuildCostField(FlowFieldSector& sector, const Grid<NavcellData>& grid,
	pass_class_t passClass)
{
	u16 baseX = sector.sectorX * SECTOR_SIZE;
	u16 baseY = sector.sectorY * SECTOR_SIZE;

	for (int j = 0; j < SECTOR_SIZE; ++j)
	{
		for (int i = 0; i < SECTOR_SIZE; ++i)
		{
			u16 gx = baseX + i;
			u16 gy = baseY + j;
			if (gx >= m_GridSize || gy >= m_GridSize)
			{
				sector.costField[j][i] = COST_IMPASSABLE;
				continue;
			}
			NavcellData cell = grid.get(gx, gy);
			sector.costField[j][i] = IS_PASSABLE(cell, passClass) ? 1 : COST_IMPASSABLE;
		}
	}
	sector.costDirty = false;
}

void FlowFieldManager::BuildPortals(const Grid<NavcellData>& grid, pass_class_t passClass)
{
	PROFILE2("FlowField_BuildPortals");

	m_Portals.clear();
	m_PortalGraph.clear();

	// Clear portal lists from sectors.
	for (auto& sector : m_Sectors)
		sector.portalIds.clear();

	// Horizontal edges (between sector (sx, sy) and (sx+1, sy))
	for (u16 sy = 0; sy < m_SectorsH; ++sy)
		for (u16 sx = 0; sx + 1 < m_SectorsW; ++sx)
			BuildPortalsForEdge(grid, passClass, sx, sy, sx + 1, sy, Portal::EAST);

	// Vertical edges (between sector (sx, sy) and (sx, sy+1))
	for (u16 sy = 0; sy + 1 < m_SectorsH; ++sy)
		for (u16 sx = 0; sx < m_SectorsW; ++sx)
			BuildPortalsForEdge(grid, passClass, sx, sy, sx, sy + 1, Portal::SOUTH);

	// Build portal adjacency graph for A*.
	// Portals in the same sector are connected with cost = distance between centers.
	for (auto& sector : m_Sectors)
	{
		for (size_t a = 0; a < sector.portalIds.size(); ++a)
		{
			for (size_t b = a + 1; b < sector.portalIds.size(); ++b)
			{
				u32 idA = sector.portalIds[a];
				u32 idB = sector.portalIds[b];
				const Portal& pA = m_Portals[idA];
				const Portal& pB = m_Portals[idB];
				fixed dist = (pA.centerPos - pB.centerPos).Length();
				m_PortalGraph[idA].push_back({idB, dist});
				m_PortalGraph[idB].push_back({idA, dist});
			}
		}
	}

	// Portals also connect across the sector boundary (cost = 1 navcell = minimal).
	// Portal pairs share the same boundary — they're the same portal from both sides.
	// The portal itself IS the connection, so the A* graph edge has near-zero cost.
	// (Already handled above since both sectors add the same portal ID to their list.)
}

void FlowFieldManager::BuildPortalsForEdge(const Grid<NavcellData>& grid, pass_class_t passClass,
	u16 sx1, u16 sy1, u16 sx2, u16 sy2, Portal::Side side)
{
	// Scan the shared boundary for contiguous passable spans.
	bool inSpan = false;
	u16 spanStart = 0;

	for (u16 c = 0; c < SECTOR_SIZE; ++c)
	{
		u16 gx1, gy1, gx2, gy2;
		if (side == Portal::EAST)
		{
			gx1 = sx1 * SECTOR_SIZE + (SECTOR_SIZE - 1);
			gy1 = sy1 * SECTOR_SIZE + c;
			gx2 = sx2 * SECTOR_SIZE;
			gy2 = sy2 * SECTOR_SIZE + c;
		}
		else // SOUTH
		{
			gx1 = sx1 * SECTOR_SIZE + c;
			gy1 = sy1 * SECTOR_SIZE + (SECTOR_SIZE - 1);
			gx2 = sx2 * SECTOR_SIZE + c;
			gy2 = sy2 * SECTOR_SIZE;
		}

		bool passable = (gx1 < m_GridSize && gy1 < m_GridSize && gx2 < m_GridSize && gy2 < m_GridSize)
			&& IS_PASSABLE(grid.get(gx1, gy1), passClass)
			&& IS_PASSABLE(grid.get(gx2, gy2), passClass);

		if (passable && !inSpan)
		{
			spanStart = c;
			inSpan = true;
		}
		else if (!passable && inSpan)
		{
			// End of span — create portal.
			Portal portal;
			portal.id = (u32)m_Portals.size();
			portal.sectorAx = sx1;
			portal.sectorAy = sy1;
			portal.sectorBx = sx2;
			portal.sectorBy = sy2;
			portal.startCell = spanStart;
			portal.endCell = c - 1;
			portal.side = side;

			// Compute center position in world coordinates.
			u16 midCell = (spanStart + c - 1) / 2;
			if (side == Portal::EAST)
				portal.centerPos = CFixedVector2D(
					entity_pos_t::FromInt(sx2 * SECTOR_SIZE),
					entity_pos_t::FromInt(sy1 * SECTOR_SIZE + midCell));
			else
				portal.centerPos = CFixedVector2D(
					entity_pos_t::FromInt(sx1 * SECTOR_SIZE + midCell),
					entity_pos_t::FromInt(sy2 * SECTOR_SIZE));

			GetSector(sx1, sy1).portalIds.push_back(portal.id);
			GetSector(sx2, sy2).portalIds.push_back(portal.id);
			m_Portals.push_back(portal);

			inSpan = false;
		}
	}

	// Handle span that reaches the end.
	if (inSpan)
	{
		Portal portal;
		portal.id = (u32)m_Portals.size();
		portal.sectorAx = sx1;
		portal.sectorAy = sy1;
		portal.sectorBx = sx2;
		portal.sectorBy = sy2;
		portal.startCell = spanStart;
		portal.endCell = SECTOR_SIZE - 1;
		portal.side = side;

		u16 midCell = (spanStart + SECTOR_SIZE - 1) / 2;
		if (side == Portal::EAST)
			portal.centerPos = CFixedVector2D(
				entity_pos_t::FromInt(sx2 * SECTOR_SIZE),
				entity_pos_t::FromInt(sy1 * SECTOR_SIZE + midCell));
		else
			portal.centerPos = CFixedVector2D(
				entity_pos_t::FromInt(sx1 * SECTOR_SIZE + midCell),
				entity_pos_t::FromInt(sy2 * SECTOR_SIZE));

		GetSector(sx1, sy1).portalIds.push_back(portal.id);
		GetSector(sx2, sy2).portalIds.push_back(portal.id);
		m_Portals.push_back(portal);
	}
}

void FlowFieldManager::GenerateFlowField(u16 sectorX, u16 sectorY,
	const std::vector<std::pair<u16, u16>>& goalCells,
	pass_class_t passClass, u32 portalId)
{
	PROFILE2("FlowField_Generate");

	// Check cache.
	FlowFieldCacheKey key{portalId, sectorX, sectorY, passClass};
	auto it = m_FlowFieldCache.find(key);
	if (it != m_FlowFieldCache.end())
		return; // Already cached.

	FlowFieldSector& sector = GetSector(sectorX, sectorY);
	sector.ResetIntegration();
	sector.ResetFlow();

	// Step 1: Integration field via Dijkstra.
	// Priority queue: (cost, cellIndex)
	using PQEntry = std::pair<u16, u16>; // (cost, j*SECTOR_SIZE+i)
	std::priority_queue<PQEntry, std::vector<PQEntry>, std::greater<PQEntry>> open;

	for (auto& [gi, gj] : goalCells)
	{
		if (gi < SECTOR_SIZE && gj < SECTOR_SIZE)
		{
			sector.integrationField[gj][gi] = 0;
			open.push({0, (u16)(gj * SECTOR_SIZE + gi)});
		}
	}

	while (!open.empty())
	{
		auto [cost, idx] = open.top();
		open.pop();

		u16 ci = idx % SECTOR_SIZE;
		u16 cj = idx / SECTOR_SIZE;

		if (cost > sector.integrationField[cj][ci])
			continue; // Stale entry.

		// 8 neighbors.
		for (int d = 1; d <= 8; ++d)
		{
			int ni = ci + DX[d];
			int nj = cj + DZ[d];
			if (ni < 0 || ni >= SECTOR_SIZE || nj < 0 || nj >= SECTOR_SIZE)
				continue;

			u8 ncost = sector.costField[nj][ni];
			if (ncost == COST_IMPASSABLE)
				continue;

			bool diagonal = (DX[d] != 0 && DZ[d] != 0);
			u16 moveCost = (u16)ncost * (diagonal ? DIAGONAL_COST_MULT : STRAIGHT_COST_MULT);
			u16 newCost = cost + moveCost;

			if (newCost < sector.integrationField[nj][ni])
			{
				sector.integrationField[nj][ni] = newCost;
				open.push({newCost, (u16)(nj * SECTOR_SIZE + ni)});
			}
		}
	}

	// Step 2: Flow field (gradient descent).
	for (int j = 0; j < SECTOR_SIZE; ++j)
	{
		for (int i = 0; i < SECTOR_SIZE; ++i)
		{
			if (sector.costField[j][i] == COST_IMPASSABLE)
			{
				sector.flowField[j][i] = FLOW_NONE;
				continue;
			}
			if (sector.integrationField[j][i] == 0)
			{
				sector.flowField[j][i] = FLOW_NONE; // At goal.
				continue;
			}

			u16 bestCost = sector.integrationField[j][i];
			u8 bestDir = FLOW_NONE;

			for (int d = 1; d <= 8; ++d)
			{
				int ni = i + DX[d];
				int nj = j + DZ[d];
				if (ni < 0 || ni >= SECTOR_SIZE || nj < 0 || nj >= SECTOR_SIZE)
					continue;
				if (sector.integrationField[nj][ni] < bestCost)
				{
					bestCost = sector.integrationField[nj][ni];
					bestDir = (u8)d;
				}
			}

			sector.flowField[j][i] = bestDir;
		}
	}

	// Cache the result.
	m_FlowFieldCache[key] = sector;
}

void FlowFieldManager::GenerateFlowFieldEikonal(u16 sectorX, u16 sectorY,
	const std::vector<std::pair<u16, u16>>& goalCells,
	pass_class_t passClass, u32 portalId)
{
	PROFILE2("FlowField_Eikonal");

	// First generate the Dijkstra flow field as fallback.
	GenerateFlowField(sectorX, sectorY, goalCells, passClass, portalId);

	FlowFieldSector& sector = GetSector(sectorX, sectorY);
	sector.ResetEikonal();

	// Fast Marching Method (FMM) for Eikonal equation |∇T| = f(x).
	// T = travel time, f = cost. Produces a continuous distance field.
	// Uses float for intermediate computation, converts to fixed at the end.

	// Priority queue: (travel time, cellIndex)
	using FMMEntry = std::pair<float, u16>;
	std::priority_queue<FMMEntry, std::vector<FMMEntry>, std::greater<FMMEntry>> narrow;

	// Status: 0 = far, 1 = narrow band, 2 = frozen
	u8 status[SECTOR_SIZE][SECTOR_SIZE] = {};

	// Initialize goal cells.
	for (auto& [gi, gj] : goalCells)
	{
		if (gi < SECTOR_SIZE && gj < SECTOR_SIZE && sector.costField[gj][gi] != COST_IMPASSABLE)
		{
			sector.eikonalField[gj][gi] = 0.0f;
			status[gj][gi] = 2; // Frozen
			// Add neighbors to narrow band.
			for (int d = 1; d <= 4; ++d) // 4-connected for FMM (N,E,S,W)
			{
				int ni = gi + DX[d * 2 - 1]; // N=1, E=3, S=5, W=7 → use cardinal only
				int nj = gj + DZ[d * 2 - 1];
				// Use proper cardinal indices: N=1, E=3, S=5, W=7
			}
		}
	}

	// Proper 4-connected cardinal directions for FMM.
	static const int CDX[] = { 0, 1, 0, -1 }; // E, S, W, N... no, let's be explicit:
	// Right(+x), Up(-z), Left(-x), Down(+z) — but grid is [j][i] where i=x, j=z
	static const int FMM_DX[] = { 1, -1, 0, 0 };
	static const int FMM_DZ[] = { 0, 0, 1, -1 };

	// Re-initialize: seed goal cells and push neighbors.
	for (auto& [gi, gj] : goalCells)
	{
		if (gi >= SECTOR_SIZE || gj >= SECTOR_SIZE || sector.costField[gj][gi] == COST_IMPASSABLE)
			continue;
		sector.eikonalField[gj][gi] = 0.0f;
		status[gj][gi] = 2;

		for (int d = 0; d < 4; ++d)
		{
			int ni = gi + FMM_DX[d];
			int nj = gj + FMM_DZ[d];
			if (ni < 0 || ni >= SECTOR_SIZE || nj < 0 || nj >= SECTOR_SIZE)
				continue;
			if (sector.costField[nj][ni] == COST_IMPASSABLE || status[nj][ni] != 0)
				continue;

			// Solve Eikonal for this cell.
			float cost = (float)sector.costField[nj][ni];
			// Simple 1D case: T = T_neighbor + cost
			sector.eikonalField[nj][ni] = sector.eikonalField[gj][gi] + cost;
			status[nj][ni] = 1;
			narrow.push({sector.eikonalField[nj][ni], (u16)(nj * SECTOR_SIZE + ni)});
		}
	}

	// FMM main loop.
	while (!narrow.empty())
	{
		auto [t, idx] = narrow.top();
		narrow.pop();

		u16 ci = idx % SECTOR_SIZE;
		u16 cj = idx / SECTOR_SIZE;

		if (status[cj][ci] == 2)
			continue; // Already frozen.

		status[cj][ci] = 2; // Freeze this cell.
		sector.eikonalField[cj][ci] = t;

		// Update 4-connected neighbors.
		for (int d = 0; d < 4; ++d)
		{
			int ni = ci + FMM_DX[d];
			int nj = cj + FMM_DZ[d];
			if (ni < 0 || ni >= SECTOR_SIZE || nj < 0 || nj >= SECTOR_SIZE)
				continue;
			if (sector.costField[nj][ni] == COST_IMPASSABLE || status[nj][ni] == 2)
				continue;

			float cost = (float)sector.costField[nj][ni];

			// Solve the Eikonal equation using the two-axis upwind scheme:
			// max((T - Tx)^2, 0) + max((T - Tz)^2, 0) = cost^2
			// where Tx = min(T_left, T_right), Tz = min(T_up, T_down)
			float Tx = 1e30f, Tz = 1e30f;

			// Horizontal axis (x neighbors).
			if (ni > 0 && status[nj][ni - 1] == 2)
				Tx = std::min(Tx, sector.eikonalField[nj][ni - 1]);
			if (ni + 1 < SECTOR_SIZE && status[nj][ni + 1] == 2)
				Tx = std::min(Tx, sector.eikonalField[nj][ni + 1]);

			// Vertical axis (z neighbors).
			if (nj > 0 && status[nj - 1][ni] == 2)
				Tz = std::min(Tz, sector.eikonalField[nj - 1][ni]);
			if (nj + 1 < SECTOR_SIZE && status[nj + 1][ni] == 2)
				Tz = std::min(Tz, sector.eikonalField[nj + 1][ni]);

			float newT;
			if (Tx > 1e20f && Tz > 1e20f)
				continue; // No frozen neighbors — shouldn't happen in normal FMM.
			else if (Tx > 1e20f)
				newT = Tz + cost; // Only vertical neighbor available.
			else if (Tz > 1e20f)
				newT = Tx + cost; // Only horizontal neighbor available.
			else
			{
				// Full 2D Eikonal solve: (T-Tx)^2 + (T-Tz)^2 = cost^2
				float diff = Tx - Tz;
				float disc = 2.0f * cost * cost - diff * diff;
				if (disc >= 0.0f)
					newT = (Tx + Tz + sqrtf(disc)) / 2.0f;
				else
					newT = std::min(Tx, Tz) + cost; // Fallback to 1D.
			}

			if (newT < sector.eikonalField[nj][ni])
			{
				sector.eikonalField[nj][ni] = newT;
				status[nj][ni] = 1;
				narrow.push({newT, (u16)(nj * SECTOR_SIZE + ni)});
			}
		}
	}

	// Step 2: Compute smooth gradient from the continuous Eikonal field.
	// Gradient = -∇T (points toward decreasing travel time = toward goal).
	for (int j = 0; j < SECTOR_SIZE; ++j)
	{
		for (int i = 0; i < SECTOR_SIZE; ++i)
		{
			if (sector.costField[j][i] == COST_IMPASSABLE || sector.eikonalField[j][i] > 1e20f)
				continue;

			// Central differences for gradient.
			float dTdx = 0.0f, dTdz = 0.0f;

			if (i > 0 && i + 1 < SECTOR_SIZE &&
				sector.eikonalField[j][i - 1] < 1e20f && sector.eikonalField[j][i + 1] < 1e20f)
				dTdx = (sector.eikonalField[j][i + 1] - sector.eikonalField[j][i - 1]) / 2.0f;
			else if (i > 0 && sector.eikonalField[j][i - 1] < 1e20f)
				dTdx = sector.eikonalField[j][i] - sector.eikonalField[j][i - 1];
			else if (i + 1 < SECTOR_SIZE && sector.eikonalField[j][i + 1] < 1e20f)
				dTdx = sector.eikonalField[j][i + 1] - sector.eikonalField[j][i];

			if (j > 0 && j + 1 < SECTOR_SIZE &&
				sector.eikonalField[j - 1][i] < 1e20f && sector.eikonalField[j + 1][i] < 1e20f)
				dTdz = (sector.eikonalField[j + 1][i] - sector.eikonalField[j - 1][i]) / 2.0f;
			else if (j > 0 && sector.eikonalField[j - 1][i] < 1e20f)
				dTdz = sector.eikonalField[j][i] - sector.eikonalField[j - 1][i];
			else if (j + 1 < SECTOR_SIZE && sector.eikonalField[j + 1][i] < 1e20f)
				dTdz = sector.eikonalField[j + 1][i] - sector.eikonalField[j][i];

			// Negate gradient (we want to move TOWARD goal = decreasing T).
			float gx = -dTdx;
			float gz = -dTdz;

			// Normalize.
			float len = sqrtf(gx * gx + gz * gz);
			if (len > 0.001f)
			{
				gx /= len;
				gz /= len;
			}

			// Convert to fixed-point.
			sector.smoothFlowField[j][i] = CFixedVector2D(
				fixed::FromFloat(gx), fixed::FromFloat(gz));
		}
	}

	sector.hasEikonal = true;

	// Update cache with Eikonal data.
	FlowFieldCacheKey key{portalId, sectorX, sectorY, passClass};
	m_FlowFieldCache[key] = sector;
}

CFixedVector2D FlowFieldManager::GetSmoothFlowDirection(entity_pos_t worldX, entity_pos_t worldZ,
	pass_class_t passClass) const
{
	int gx = (worldX / Pathfinding::NAVCELL_SIZE).ToInt_RoundToZero();
	int gz = (worldZ / Pathfinding::NAVCELL_SIZE).ToInt_RoundToZero();

	u16 sx = gx / SECTOR_SIZE;
	u16 sy = gz / SECTOR_SIZE;
	u16 cx = gx % SECTOR_SIZE;
	u16 cy = gz % SECTOR_SIZE;

	if (sx >= m_SectorsW || sy >= m_SectorsH)
		return CFixedVector2D(fixed::Zero(), fixed::Zero());

	for (auto& [key, cached] : m_FlowFieldCache)
	{
		if (key.sectorX == sx && key.sectorY == sy && key.passClass == passClass)
		{
			if (cached.hasEikonal)
				return cached.smoothFlowField[cy][cx];
			break;
		}
	}

	return CFixedVector2D(fixed::Zero(), fixed::Zero());
}

u8 FlowFieldManager::GetFlowDirection(entity_pos_t worldX, entity_pos_t worldZ,
	pass_class_t passClass) const
{
	int gx = (worldX / Pathfinding::NAVCELL_SIZE).ToInt_RoundToZero();
	int gz = (worldZ / Pathfinding::NAVCELL_SIZE).ToInt_RoundToZero();

	u16 sx = gx / SECTOR_SIZE;
	u16 sy = gz / SECTOR_SIZE;
	u16 cx = gx % SECTOR_SIZE;
	u16 cy = gz % SECTOR_SIZE;

	if (sx >= m_SectorsW || sy >= m_SectorsH)
		return FLOW_NONE;

	// Check cache for any flow field covering this sector.
	// (Simple linear search — could be optimized with spatial index.)
	for (auto& [key, cached] : m_FlowFieldCache)
	{
		if (key.sectorX == sx && key.sectorY == sy && key.passClass == passClass)
			return cached.flowField[cy][cx];
	}

	return FLOW_NONE;
}

std::vector<u32> FlowFieldManager::FindPortalPath(CFixedVector2D start, CFixedVector2D goal,
	pass_class_t /*passClass*/) const
{
	PROFILE2("FlowField_PortalAStar");

	std::vector<u32> path;

	u16 startSX = (start.X / Pathfinding::NAVCELL_SIZE).ToInt_RoundToZero() / SECTOR_SIZE;
	u16 startSY = (start.Y / Pathfinding::NAVCELL_SIZE).ToInt_RoundToZero() / SECTOR_SIZE;
	u16 goalSX = (goal.X / Pathfinding::NAVCELL_SIZE).ToInt_RoundToZero() / SECTOR_SIZE;
	u16 goalSY = (goal.Y / Pathfinding::NAVCELL_SIZE).ToInt_RoundToZero() / SECTOR_SIZE;

	if (startSX >= m_SectorsW || startSY >= m_SectorsH ||
		goalSX >= m_SectorsW || goalSY >= m_SectorsH)
		return path;

	// Same sector — no portals needed.
	if (startSX == goalSX && startSY == goalSY)
		return path;

	// Find portals reachable from start sector and goal sector.
	const FlowFieldSector& startSector = GetSector(startSX, startSY);
	const FlowFieldSector& goalSector = GetSector(goalSX, goalSY);

	if (startSector.portalIds.empty() || goalSector.portalIds.empty())
		return path; // Isolated sectors.

	// A* over portal graph.
	struct AStarNode {
		fixed f; // g + h
		u32 portalId;
		bool operator>(const AStarNode& o) const { return f > o.f; }
	};

	std::unordered_map<u32, fixed> gCost;
	std::unordered_map<u32, u32> cameFrom;
	std::priority_queue<AStarNode, std::vector<AStarNode>, std::greater<AStarNode>> openSet;

	// Initialize with start sector portals.
	for (u32 pid : startSector.portalIds)
	{
		fixed g = (start - m_Portals[pid].centerPos).Length();
		fixed h = (m_Portals[pid].centerPos - goal).Length();
		gCost[pid] = g;
		openSet.push({g + h, pid});
	}

	u32 goalPortal = UINT32_MAX;

	while (!openSet.empty())
	{
		auto [f, current] = openSet.top();
		openSet.pop();

		// Check if we reached a goal sector portal.
		const Portal& cp = m_Portals[current];
		if ((cp.sectorAx == goalSX && cp.sectorAy == goalSY) ||
			(cp.sectorBx == goalSX && cp.sectorBy == goalSY))
		{
			goalPortal = current;
			break;
		}

		auto graphIt = m_PortalGraph.find(current);
		if (graphIt == m_PortalGraph.end())
			continue;

		for (auto& [neighbor, edgeCost] : graphIt->second)
		{
			fixed tentG = gCost[current] + edgeCost;
			auto it = gCost.find(neighbor);
			if (it != gCost.end() && tentG >= it->second)
				continue;

			gCost[neighbor] = tentG;
			cameFrom[neighbor] = current;
			fixed h = (m_Portals[neighbor].centerPos - goal).Length();
			openSet.push({tentG + h, neighbor});
		}
	}

	// Reconstruct path.
	if (goalPortal != UINT32_MAX)
	{
		u32 current = goalPortal;
		while (cameFrom.count(current))
		{
			path.push_back(current);
			current = cameFrom[current];
		}
		path.push_back(current);
		std::reverse(path.begin(), path.end());
	}

	return path;
}

void FlowFieldManager::UpdateDirtySectors(const Grid<NavcellData>& grid, pass_class_t passClass,
	const GridUpdateInformation& dirtiness)
{
	if (!dirtiness.dirty)
		return;

	PROFILE2("FlowField_UpdateDirty");

	// Find which sectors have dirty navcells.
	for (u16 sy = 0; sy < m_SectorsH; ++sy)
	{
		for (u16 sx = 0; sx < m_SectorsW; ++sx)
		{
			u16 baseX = sx * SECTOR_SIZE;
			u16 baseY = sy * SECTOR_SIZE;
			bool dirty = false;

			if (dirtiness.globallyDirty)
				dirty = true;
			else
			{
				for (int j = 0; j < SECTOR_SIZE && !dirty; ++j)
					for (int i = 0; i < SECTOR_SIZE && !dirty; ++i)
						if (baseX + i < m_GridSize && baseY + j < m_GridSize)
							if (dirtiness.dirtinessGrid.get(baseX + i, baseY + j))
								dirty = true;
			}

			if (dirty)
			{
				FlowFieldSector& sector = GetSector(sx, sy);
				BuildCostField(sector, grid, passClass);

				// Evict cached flow fields for this sector.
				for (auto it = m_FlowFieldCache.begin(); it != m_FlowFieldCache.end(); )
				{
					if (it->first.sectorX == sx && it->first.sectorY == sy)
						it = m_FlowFieldCache.erase(it);
					else
						++it;
				}
			}
		}
	}

	// Rebuild portals (some may have changed).
	BuildPortals(grid, passClass);
}

CFixedVector2D FlowFieldManager::DirectionToVector(u8 dir)
{
	u8 d = dir & 0x0F; // Mask out flags.
	if (d == FLOW_NONE || d > 8)
		return CFixedVector2D(fixed::Zero(), fixed::Zero());

	// Convert DX/DZ to fixed-point unit vector.
	fixed dx = fixed::FromInt(DX[d]);
	fixed dz = fixed::FromInt(DZ[d]);

	// Normalize diagonals.
	if (DX[d] != 0 && DZ[d] != 0)
	{
		// 1/sqrt(2) ≈ 0.707 ≈ 181/256
		dx = dx.Multiply(fixed::FromFraction(181, 256));
		dz = dz.Multiply(fixed::FromFraction(181, 256));
	}

	return CFixedVector2D(dx, dz);
}
