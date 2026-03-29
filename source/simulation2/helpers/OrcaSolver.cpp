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

#include "OrcaSolver.h"

#include "ps/Profile.h"

static const fixed EPSILON = fixed::FromFraction(1, 1000);

// Helper: 2D cross product (determinant): a.X * b.Y - a.Y * b.X
static inline fixed Det(const CFixedVector2D& a, const CFixedVector2D& b)
{
	return a.X.Multiply(b.Y) - a.Y.Multiply(b.X);
}

// Helper: squared length
static inline fixed LengthSq(const CFixedVector2D& v)
{
	return v.Dot(v);
}

CFixedVector2D OrcaSolver::ComputeNewVelocity(
	const OrcaAgent& agent,
	const std::vector<const OrcaAgent*>& neighbors,
	fixed dt)
{
	PROFILE2("ORCA_ComputeNewVelocity");

	std::vector<OrcaLine> orcaLines;
	orcaLines.reserve(neighbors.size());

	fixed invTimeHorizon = fixed::FromInt(1) / fixed::FromInt(ORCA_TIME_HORIZON);
	if (invTimeHorizon < EPSILON)
		invTimeHorizon = EPSILON;

	for (const OrcaAgent* neighbor : neighbors)
	{
		if (!neighbor)
			continue;

		OrcaLine line = ComputeOrcaLine(agent, *neighbor, invTimeHorizon);
		orcaLines.push_back(line);
	}

	CFixedVector2D result = agent.prefVelocity;
	if (!LinearProgram2(orcaLines, agent.maxSpeed, agent.prefVelocity, false, result))
	{
		// Infeasible — minimize penetration.
		LinearProgram3(orcaLines, agent.maxSpeed, 0, result);
	}

	return result;
}

OrcaLine OrcaSolver::ComputeOrcaLine(
	const OrcaAgent& agent,
	const OrcaAgent& neighbor,
	fixed invTimeHorizon)
{
	OrcaLine line;

	CFixedVector2D relativePosition = neighbor.position - agent.position;
	CFixedVector2D relativeVelocity = agent.velocity - neighbor.velocity;
	fixed distSq = LengthSq(relativePosition);
	fixed combinedRadius = agent.radius + neighbor.radius;
	fixed combinedRadiusSq = combinedRadius.Multiply(combinedRadius);

	// Vector from cutoff center to relative velocity.
	CFixedVector2D w = relativeVelocity - relativePosition.Multiply(invTimeHorizon);
	fixed wLengthSq = LengthSq(w);

	fixed dotProduct1 = w.Dot(relativePosition);

	if (distSq > combinedRadiusSq)
	{
		// No collision — project on cut-off circle.
		fixed wLength = w.Length();
		if (wLength < EPSILON)
			wLength = EPSILON;

		CFixedVector2D unitW(w.X / wLength, w.Y / wLength);

		line.direction = CFixedVector2D(unitW.Y, -unitW.X);

		// u = (combinedRadius * invTimeHorizon - wLength) * unitW
		fixed uLen = combinedRadius.Multiply(invTimeHorizon) - wLength;
		CFixedVector2D u(unitW.X.Multiply(uLen), unitW.Y.Multiply(uLen));

		// Half responsibility: line.point = agent.velocity + 0.5 * u
		line.point.X = agent.velocity.X + u.X / fixed::FromInt(2);
		line.point.Y = agent.velocity.Y + u.Y / fixed::FromInt(2);
	}
	else
	{
		// Collision — project on cut-off circle at time now.
		fixed invDt = fixed::FromInt(1) / fixed::FromInt(1); // Use 1 step lookahead for collision
		CFixedVector2D wCol = relativeVelocity - relativePosition.Multiply(invDt);
		fixed wColLen = wCol.Length();
		if (wColLen < EPSILON)
			wColLen = EPSILON;

		CFixedVector2D unitWCol(wCol.X / wColLen, wCol.Y / wColLen);

		line.direction = CFixedVector2D(unitWCol.Y, -unitWCol.X);

		fixed uLen = combinedRadius.Multiply(invDt) - wColLen;
		CFixedVector2D u(unitWCol.X.Multiply(uLen), unitWCol.Y.Multiply(uLen));

		line.point.X = agent.velocity.X + u.X / fixed::FromInt(2);
		line.point.Y = agent.velocity.Y + u.Y / fixed::FromInt(2);
	}

	return line;
}

bool OrcaSolver::LinearProgram1(
	const std::vector<OrcaLine>& lines,
	size_t lineNo,
	entity_pos_t maxSpeed,
	const CFixedVector2D& optVelocity,
	bool directionOpt,
	CFixedVector2D& result)
{
	fixed dotProduct = lines[lineNo].point.Dot(lines[lineNo].direction);
	fixed discriminant = dotProduct.Multiply(dotProduct) +
		maxSpeed.Multiply(maxSpeed) - LengthSq(lines[lineNo].point);

	if (discriminant < fixed::Zero())
		return false; // Max speed circle fully on the wrong side.

	// Approximate sqrt for fixed point.
	fixed sqrtDisc = discriminant.IsZero() ? fixed::Zero() : fixed::FromFloat(sqrtf(discriminant.ToFloat()));

	fixed tLeft = -dotProduct - sqrtDisc;
	fixed tRight = -dotProduct + sqrtDisc;

	for (size_t i = 0; i < lineNo; ++i)
	{
		fixed denom = Det(lines[lineNo].direction, lines[i].direction);
		fixed numer = Det(lines[i].direction, lines[lineNo].point - lines[i].point);

		if (denom.IsZero() || (denom > -EPSILON && denom < EPSILON))
		{
			// Lines are nearly parallel.
			if (numer < fixed::Zero())
				return false;
			continue;
		}

		fixed t = numer / denom;
		if (denom > fixed::Zero())
			tRight = std::min(tRight, t);
		else
			tLeft = std::max(tLeft, t);

		if (tLeft > tRight)
			return false;
	}

	if (directionOpt)
	{
		// Optimize direction.
		if (optVelocity.Dot(lines[lineNo].direction) > fixed::Zero())
			result = lines[lineNo].point + lines[lineNo].direction.Multiply(tRight);
		else
			result = lines[lineNo].point + lines[lineNo].direction.Multiply(tLeft);
	}
	else
	{
		// Optimize closest point.
		fixed t = lines[lineNo].direction.Dot(optVelocity - lines[lineNo].point);
		t = std::max(tLeft, std::min(tRight, t));
		result = lines[lineNo].point + lines[lineNo].direction.Multiply(t);
	}

	return true;
}

bool OrcaSolver::LinearProgram2(
	const std::vector<OrcaLine>& lines,
	entity_pos_t maxSpeed,
	const CFixedVector2D& optVelocity,
	bool directionOpt,
	CFixedVector2D& result)
{
	if (directionOpt)
	{
		// Optimize direction: result = optVelocity * maxSpeed (normalized).
		result.X = optVelocity.X.Multiply(maxSpeed);
		result.Y = optVelocity.Y.Multiply(maxSpeed);
	}
	else if (LengthSq(optVelocity) > maxSpeed.Multiply(maxSpeed))
	{
		// Clamp to max speed circle.
		fixed len = optVelocity.Length();
		if (len < EPSILON)
			result = CFixedVector2D(fixed::Zero(), fixed::Zero());
		else
		{
			result.X = optVelocity.X.Multiply(maxSpeed) / len;
			result.Y = optVelocity.Y.Multiply(maxSpeed) / len;
		}
	}
	else
	{
		result = optVelocity;
	}

	for (size_t i = 0; i < lines.size(); ++i)
	{
		// Check if result violates constraint i.
		if (Det(lines[i].direction, lines[i].point - result) > fixed::Zero())
		{
			// Violated — project onto this constraint.
			CFixedVector2D tempResult = result;
			if (!LinearProgram1(lines, i, maxSpeed, optVelocity, directionOpt, result))
			{
				result = tempResult;
				return false;
			}
		}
	}

	return true;
}

void OrcaSolver::LinearProgram3(
	const std::vector<OrcaLine>& lines,
	entity_pos_t maxSpeed,
	size_t numObstLines,
	CFixedVector2D& result)
{
	// Fallback: try to satisfy as many constraints as possible.
	// Simple approach: just clamp result to max speed.
	fixed lenSq = LengthSq(result);
	fixed maxSpeedSq = maxSpeed.Multiply(maxSpeed);

	if (lenSq > maxSpeedSq)
	{
		fixed len = result.Length();
		if (len > EPSILON)
		{
			result.X = result.X.Multiply(maxSpeed) / len;
			result.Y = result.Y.Multiply(maxSpeed) / len;
		}
		else
		{
			result = CFixedVector2D(fixed::Zero(), fixed::Zero());
		}
	}
}
