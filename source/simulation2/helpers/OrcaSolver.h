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

#ifndef INCLUDED_ORCASOLVER
#define INCLUDED_ORCASOLVER

#include "maths/Fixed.h"
#include "maths/FixedVector2D.h"
#include "simulation2/helpers/Position.h"

#include <vector>

/**
 * ORCA (Optimal Reciprocal Collision Avoidance) solver.
 *
 * Given an agent's preferred velocity and nearby neighbors, computes
 * a collision-free velocity via 2D linear programming over half-plane
 * constraints. Each agent takes half responsibility for avoiding each
 * pairwise collision.
 *
 * Based on the ORCA paper by van den Berg et al. (2011) and the
 * RVO2 reference implementation by UNC.
 *
 * All math uses fixed-point (entity_pos_t / CFixedVector2D) for
 * deterministic lockstep simulation.
 */

struct OrcaAgent
{
	CFixedVector2D position;
	CFixedVector2D velocity;
	CFixedVector2D prefVelocity;
	CFixedVector2D newVelocity;
	entity_pos_t radius;
	entity_pos_t maxSpeed;
};

struct OrcaLine
{
	CFixedVector2D point;     // A point on the half-plane boundary
	CFixedVector2D direction; // Direction of the boundary (valid region is to the left)
};

// Default ORCA parameters
static constexpr int ORCA_TIME_HORIZON = 8;       // Lookahead in simulation steps
static constexpr int ORCA_MAX_NEIGHBORS = 10;      // Max neighbors per agent
static constexpr int ORCA_NEIGHBOR_DIST = 15;      // Search radius in meters

class OrcaSolver
{
public:
	/**
	 * Compute a collision-free velocity for the given agent.
	 * @param agent The agent (position, velocity, prefVelocity, radius, maxSpeed)
	 * @param neighbors Nearby agents to avoid
	 * @param dt Time step duration
	 * @return Collision-free velocity closest to prefVelocity
	 */
	static CFixedVector2D ComputeNewVelocity(
		const OrcaAgent& agent,
		const std::vector<const OrcaAgent*>& neighbors,
		fixed dt);

private:
	/**
	 * Compute the ORCA half-plane constraint for one agent-neighbor pair.
	 */
	static OrcaLine ComputeOrcaLine(
		const OrcaAgent& agent,
		const OrcaAgent& neighbor,
		fixed invTimeHorizon);

	/**
	 * 2D linear program: find velocity closest to optVelocity
	 * satisfying all half-plane constraints within maxSpeed circle.
	 * Returns true if feasible.
	 */
	static bool LinearProgram2(
		const std::vector<OrcaLine>& lines,
		entity_pos_t maxSpeed,
		const CFixedVector2D& optVelocity,
		bool directionOpt,
		CFixedVector2D& result);

	/**
	 * Solve a single LP1 sub-problem: project result onto line lineNo
	 * while satisfying all prior constraints.
	 */
	static bool LinearProgram1(
		const std::vector<OrcaLine>& lines,
		size_t lineNo,
		entity_pos_t maxSpeed,
		const CFixedVector2D& optVelocity,
		bool directionOpt,
		CFixedVector2D& result);

	/**
	 * Fallback when LP2 is infeasible: minimize maximum constraint penetration.
	 */
	static void LinearProgram3(
		const std::vector<OrcaLine>& lines,
		entity_pos_t maxSpeed,
		size_t numObstLines,
		CFixedVector2D& result);
};

#endif // INCLUDED_ORCASOLVER
