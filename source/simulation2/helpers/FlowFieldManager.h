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

#ifndef INCLUDED_FLOWFIELDMANAGER
#define INCLUDED_FLOWFIELDMANAGER

#include "maths/Fixed.h"
#include "maths/FixedVector2D.h"
#include "simulation2/helpers/Grid.h"
#include "simulation2/helpers/Pathfinding.h"

#include <map>
#include <queue>
#include <unordered_map>
#include <vector>

/**
 * Flow field tile-based pathfinding system.
 *
 * Divides the navcell grid into small sectors (16x16 navcells each).
 * For each sector, precomputes a cost field from passability data.
 * Portals (contiguous passable spans on sector boundaries) form a
 * high-level graph for hierarchical A*.
 *
 * When a path is requested:
 * 1. Portal A* finds which sectors the path traverses
 * 2. Dijkstra flood-fill generates an integration field per sector
 * 3. Gradient descent produces a flow field (direction per cell)
 * 4. Units read their local cell direction: O(1) per tick
 *
 * Flow fields are cached by (portal, sector, passClass) and invalidated
 * when terrain changes.
 */

static constexpr int SECTOR_SIZE = 16;
static constexpr u8 COST_IMPASSABLE = 255;
static constexpr u16 INTEGRATION_MAX = 65535;

// 8 directions encoded in 3 bits + flags in upper bits
enum FlowDirection : u8
{
	FLOW_NONE = 0,
	FLOW_N = 1,
	FLOW_NE = 2,
	FLOW_E = 3,
	FLOW_SE = 4,
	FLOW_S = 5,
	FLOW_SW = 6,
	FLOW_W = 7,
	FLOW_NW = 8,
	FLOW_LOS = 0x80  // Flag: direct line of sight to goal
};

struct Portal
{
	u32 id;
	u16 sectorAx, sectorAy;
	u16 sectorBx, sectorBy;
	u16 startCell, endCell; // Span along the shared boundary
	enum Side : u8 { NORTH, SOUTH, EAST, WEST } side;
	CFixedVector2D centerPos; // World position of portal midpoint
};

struct FlowFieldSector
{
	u16 sectorX, sectorY;

	u8 costField[SECTOR_SIZE][SECTOR_SIZE];
	u16 integrationField[SECTOR_SIZE][SECTOR_SIZE];         // Dijkstra discrete
	u8 flowField[SECTOR_SIZE][SECTOR_SIZE];                 // 8-direction discrete

	// Eikonal continuous fields (smooth movement).
	float eikonalField[SECTOR_SIZE][SECTOR_SIZE];           // Continuous travel time
	CFixedVector2D smoothFlowField[SECTOR_SIZE][SECTOR_SIZE]; // Continuous gradient direction
	bool hasEikonal = false;                                // Whether Eikonal was computed

	std::vector<u32> portalIds;

	bool costDirty = true;

	void ResetIntegration()
	{
		for (int j = 0; j < SECTOR_SIZE; ++j)
			for (int i = 0; i < SECTOR_SIZE; ++i)
				integrationField[j][i] = INTEGRATION_MAX;
	}

	void ResetFlow()
	{
		for (int j = 0; j < SECTOR_SIZE; ++j)
			for (int i = 0; i < SECTOR_SIZE; ++i)
				flowField[j][i] = FLOW_NONE;
	}

	void ResetEikonal()
	{
		for (int j = 0; j < SECTOR_SIZE; ++j)
			for (int i = 0; i < SECTOR_SIZE; ++i)
			{
				eikonalField[j][i] = 1e30f;
				smoothFlowField[j][i] = CFixedVector2D(fixed::Zero(), fixed::Zero());
			}
		hasEikonal = false;
	}
};

struct FlowFieldCacheKey
{
	u32 portalId; // 0 = goal sector
	u16 sectorX, sectorY;
	pass_class_t passClass;

	bool operator==(const FlowFieldCacheKey& o) const
	{
		return portalId == o.portalId && sectorX == o.sectorX &&
			sectorY == o.sectorY && passClass == o.passClass;
	}
};

struct FlowFieldCacheKeyHash
{
	size_t operator()(const FlowFieldCacheKey& k) const
	{
		size_t h = k.portalId;
		h ^= (size_t)k.sectorX << 16;
		h ^= (size_t)k.sectorY << 24;
		h ^= (size_t)k.passClass << 8;
		return h;
	}
};

class FlowFieldManager
{
public:
	FlowFieldManager() = default;

	/**
	 * Initialize the sector grid and build cost fields + portals.
	 */
	void Init(u16 gridSize, const Grid<NavcellData>& grid, pass_class_t passClass);

	/**
	 * Rebuild cost fields for sectors whose navcells changed.
	 */
	void UpdateDirtySectors(const Grid<NavcellData>& grid, pass_class_t passClass,
		const GridUpdateInformation& dirtiness);

	/**
	 * Find a portal-level path from start to goal.
	 * Returns ordered list of portal IDs.
	 */
	std::vector<u32> FindPortalPath(CFixedVector2D start, CFixedVector2D goal,
		pass_class_t passClass) const;

	/**
	 * Generate a flow field for a sector, with goal cells as seeds.
	 * Caches the result.
	 */
	void GenerateFlowField(u16 sectorX, u16 sectorY,
		const std::vector<std::pair<u16, u16>>& goalCells,
		pass_class_t passClass, u32 portalId = 0);

	/**
	 * Generate a smooth Eikonal flow field for a sector (Fast Marching Method).
	 * Produces continuous gradient vectors instead of 8 discrete directions.
	 */
	void GenerateFlowFieldEikonal(u16 sectorX, u16 sectorY,
		const std::vector<std::pair<u16, u16>>& goalCells,
		pass_class_t passClass, u32 portalId = 0);

	/**
	 * Get the flow direction at a world position.
	 * Returns smooth Eikonal direction if available, else discrete direction.
	 * Returns FLOW_NONE (as zero vector) if no flow field available.
	 */
	u8 GetFlowDirection(entity_pos_t worldX, entity_pos_t worldZ,
		pass_class_t passClass) const;

	/**
	 * Get smooth flow vector at a world position (from Eikonal solver).
	 * Returns zero vector if unavailable.
	 */
	CFixedVector2D GetSmoothFlowDirection(entity_pos_t worldX, entity_pos_t worldZ,
		pass_class_t passClass) const;

	/**
	 * Convert a flow direction enum to a unit movement vector.
	 */
	static CFixedVector2D DirectionToVector(u8 dir);

	/**
	 * Get the number of sectors.
	 */
	u16 GetSectorsW() const { return m_SectorsW; }
	u16 GetSectorsH() const { return m_SectorsH; }

	const std::vector<Portal>& GetPortals() const { return m_Portals; }

private:
	void BuildCostField(FlowFieldSector& sector, const Grid<NavcellData>& grid,
		pass_class_t passClass);
	void BuildPortals(const Grid<NavcellData>& grid, pass_class_t passClass);
	void BuildPortalsForEdge(const Grid<NavcellData>& grid, pass_class_t passClass,
		u16 sx1, u16 sy1, u16 sx2, u16 sy2, Portal::Side side);

	FlowFieldSector& GetSector(u16 sx, u16 sy) { return m_Sectors[sy * m_SectorsW + sx]; }
	const FlowFieldSector& GetSector(u16 sx, u16 sy) const { return m_Sectors[sy * m_SectorsW + sx]; }

	u16 m_SectorsW = 0;
	u16 m_SectorsH = 0;
	u16 m_GridSize = 0;

	std::vector<FlowFieldSector> m_Sectors;
	std::vector<Portal> m_Portals;

	// Portal adjacency for A*: portalId -> list of (connected portalId, cost)
	std::map<u32, std::vector<std::pair<u32, fixed>>> m_PortalGraph;

	// Cached flow fields
	std::unordered_map<FlowFieldCacheKey, FlowFieldSector, FlowFieldCacheKeyHash> m_FlowFieldCache;
};

#endif // INCLUDED_FLOWFIELDMANAGER
