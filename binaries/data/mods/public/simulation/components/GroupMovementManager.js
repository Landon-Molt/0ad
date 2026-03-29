// SmartCenter clustering thresholds (meters).
var g_SmartCenterTightThreshold = 20;
var g_SmartCenterScatteredThreshold = 80;

function GroupMovementManager() {}

GroupMovementManager.prototype.Schema = "<a:component type='system'/><empty/>";

GroupMovementManager.prototype.Init = function()
{
	this.mode = "classic";

	// Transitive bumping state (Phase 3).
	// Map of group id -> Set of arrived entity ids.
	this.arrivedByGroup = {};
	// Map of group id -> array of member entity ids.
	this.activeGroups = {};
};

GroupMovementManager.prototype.SetMode = function(mode)
{
	this.mode = mode;
};

GroupMovementManager.prototype.GetMode = function()
{
	return this.mode;
};

GroupMovementManager.prototype.IsResponsive = function()
{
	return this.mode === "responsive";
};

/**
 * Compute the SmartCenter of a set of 2D positions.
 * Returns { centerX, centerY, sigma, mode, inliers[], outliers[] }
 * where inliers/outliers are indices into the input array.
 */
GroupMovementManager.prototype.ComputeSmartCenter = function(positions)
{
	let n = positions.length;
	if (n === 0)
		return { "centerX": 0, "centerY": 0, "sigma": 0, "mode": "tight", "inliers": [], "outliers": [] };

	// Step 1: average position.
	let avgX = 0;
	let avgY = 0;
	for (let p of positions)
	{
		avgX += p.x;
		avgY += p.y;
	}
	avgX /= n;
	avgY /= n;

	// Step 2: squared distances — avoid sqrt per unit.
	let distSqSum = 0;
	let distancesSq = [];
	for (let p of positions)
	{
		let dx = p.x - avgX;
		let dy = p.y - avgY;
		let distSq = dx * dx + dy * dy;
		distancesSq.push(distSq);
		distSqSum += distSq;
	}
	let sigmaSq = distSqSum / n;

	// Step 3: classify inliers vs outliers (distSq > sigmaSq means beyond 1 sigma).
	let inliers = [];
	let outliers = [];
	for (let i = 0; i < n; ++i)
	{
		if (distancesSq[i] > sigmaSq)
			outliers.push(i);
		else
			inliers.push(i);
	}

	// Step 4: recalculate center from inliers only.
	if (inliers.length > 0)
	{
		avgX = 0;
		avgY = 0;
		for (let i of inliers)
		{
			avgX += positions[i].x;
			avgY += positions[i].y;
		}
		avgX /= inliers.length;
		avgY /= inliers.length;
	}

	// Step 5: classify dispersion using squared thresholds (no sqrt needed).
	let mode;
	let tightSq = g_SmartCenterTightThreshold * g_SmartCenterTightThreshold;     // 400
	let scatteredSq = g_SmartCenterScatteredThreshold * g_SmartCenterScatteredThreshold; // 6400
	if (sigmaSq < tightSq)
		mode = "tight";
	else if (sigmaSq > scatteredSq)
		mode = "scattered";
	else
		mode = "outlier_collapse";

	// Only compute actual sigma when needed (outlier offset formula, path adjustment).
	let sigma = (mode === "outlier_collapse" || mode === "scattered") ? Math.sqrt(sigmaSq) : 0;

	return {
		"centerX": avgX,
		"centerY": avgY,
		"sigma": sigma,
		"mode": mode,
		"inliers": inliers,
		"outliers": outliers
	};
};

// ---- Path sharing ----

/**
 * Compute and cache a single strategic path for a group.
 * Returns an array of {x, y} waypoints, or empty array if unreachable.
 */
GroupMovementManager.prototype.ComputeSharedPath = function(groupId, fromX, fromZ, toX, toZ, passClassName)
{
	let cmpPathfinder = Engine.QueryInterface(SYSTEM_ENTITY, IID_Pathfinder);
	// Use flow field path when in responsive mode (portal A* + sector flow fields).
	// Falls back to JPS-based ComputeGroupPath otherwise.
	let waypoints;
	if (this.IsResponsive())
		waypoints = cmpPathfinder.ComputeFlowFieldPath(fromX, fromZ, toX, toZ, passClassName);
	else
		waypoints = cmpPathfinder.ComputeGroupPath(fromX, fromZ, toX, toZ, passClassName);
	if (!this.sharedPaths)
		this.sharedPaths = {};
	this.sharedPaths[groupId] = waypoints;
	return waypoints;
};

/**
 * Get the cached shared path for a group, or undefined if none.
 */
GroupMovementManager.prototype.GetSharedPath = function(groupId)
{
	return this.sharedPaths && this.sharedPaths[groupId];
};

/**
 * Compute tactical surround positions for attacking a large target (building).
 * Classifies units by role: melee (inner ring), ranged (outer ring), cavalry (patrol), guard (overflow).
 * Returns { melee: [{ent, x, z}], ranged: [{ent, x, z}], cavalry: [{ent, startAngle, patrolRadius}], guard: [{ent, x, z}], buildingPos: {x, y} }
 */
GroupMovementManager.prototype.ComputeSurroundPositions = function(target, members, groupCenter)
{
	let result = { "melee": [], "ranged": [], "cavalry": [], "guard": [], "buildingPos": null };
	if (!members.length)
		return result;

	// Get building position and size.
	let cmpTargetPos = Engine.QueryInterface(target, IID_Position);
	if (!cmpTargetPos || !cmpTargetPos.IsInWorld())
		return result;
	let bPos = cmpTargetPos.GetPosition2D();
	result.buildingPos = bPos;

	let cmpObstruction = Engine.QueryInterface(target, IID_Obstruction);
	let buildingRadius = cmpObstruction ? cmpObstruction.GetSize() : 4;

	// Classify members by role.
	let meleeMembers = [];
	let rangedMembers = [];
	let cavalryMembers = [];
	let memberPositions = {};
	let meleeRange = 6;
	let rangedRange = 20;

	// Batch-query all positions in one C++ call (eliminates N boundary crossings).
	let cmpPathfinder = Engine.QueryInterface(SYSTEM_ENTITY, IID_Pathfinder);
	let batchPositions = cmpPathfinder.GetEntityPositionsBatch(members);

	for (let idx = 0; idx < members.length; ++idx)
	{
		let ent = members[idx];
		let pos = batchPositions[idx];
		if (pos.x === 0 && pos.y === 0)
			continue; // Not in world.
		memberPositions[ent] = pos;

		let cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		let cmpAttack = Engine.QueryInterface(ent, IID_Attack);

		// Ranged-only units go to ranged ring. Everything else (melee, cavalry,
		// mixed) goes to the inner attack ring. Cavalry is tracked separately
		// so overflow cavalry can patrol instead of standing guard.
		let isRangedOnly = cmpAttack && cmpAttack.GetAttackTypes().indexOf("Ranged") !== -1
			&& cmpAttack.GetAttackTypes().indexOf("Melee") === -1;
		let isCavalry = cmpIdentity && cmpIdentity.HasClass("Cavalry");

		if (isRangedOnly && !isCavalry)
		{
			rangedMembers.push(ent);
			let range = cmpAttack.GetRange("Ranged");
			if (range)
				rangedRange = Math.max(rangedRange, range.max);
		}
		else
		{
			meleeMembers.push(ent);
			if (isCavalry)
				cavalryMembers.push(ent); // Also track as cavalry for patrol overflow.
			if (cmpAttack)
			{
				let bestType = cmpAttack.GetBestAttackAgainst(target, true);
				if (bestType)
					meleeRange = Math.max(meleeRange, cmpAttack.GetRange(bestType).max);
			}
		}
	}

	// Approach direction for pincer split.
	let dx = bPos.x - groupCenter.x;
	let dz = bPos.y - groupCenter.y;
	let approachAngle = Math.atan2(dz, dx);
	let perpX = -dz;
	let perpZ = dx;

	// Helper: assign units to positions by nearest-available.
	let assignNearest = function(unitList, posList)
	{
		let assignments = [];
		let usedPositions = new Set();
		for (let ent of unitList)
		{
			if (!memberPositions[ent] || !posList.length)
				break;
			let bestIdx = -1;
			let bestDistSq = Infinity;
			for (let j = 0; j < posList.length; ++j)
			{
				if (usedPositions.has(j))
					continue;
				let ddx = memberPositions[ent].x - posList[j].x;
				let ddz = memberPositions[ent].y - posList[j].z;
				let distSq = ddx * ddx + ddz * ddz;
				if (distSq < bestDistSq)
				{
					bestDistSq = distSq;
					bestIdx = j;
				}
			}
			if (bestIdx >= 0)
			{
				usedPositions.add(bestIdx);
				assignments.push({ "ent": ent, "x": posList[bestIdx].x, "z": posList[bestIdx].z });
			}
		}
		return assignments;
	};

	// Helper: generate ring positions and split into left/right for pincer.
	let generatePincerRing = function(radius, count, spacing)
	{
		let cap = Math.max(4, Math.floor(2 * Math.PI * radius / spacing));
		let n = Math.min(count, cap);
		let positions = [];
		for (let i = 0; i < n; ++i)
		{
			let angle = approachAngle + (i / n) * 2 * Math.PI;
			positions.push({
				"x": bPos.x + Math.cos(angle) * radius,
				"z": bPos.y + Math.sin(angle) * radius,
				"angle": angle
			});
		}
		return { "positions": positions, "capacity": cap };
	};

	// Helper: split units into left/right by approach line.
	let splitLeftRight = function(unitList)
	{
		let left = [], right = [];
		for (let ent of unitList)
		{
			if (!memberPositions[ent]) continue;
			let mDx = memberPositions[ent].x - groupCenter.x;
			let mDz = memberPositions[ent].y - groupCenter.y;
			if (mDx * perpX + mDz * perpZ >= 0)
				left.push(ent);
			else
				right.push(ent);
		}
		return { "left": left, "right": right };
	};

	// Helper: split positions into left/right halves.
	let splitPositions = function(positions)
	{
		let left = [], right = [];
		for (let p of positions)
		{
			let relAngle = p.angle - approachAngle;
			while (relAngle > Math.PI) relAngle -= 2 * Math.PI;
			while (relAngle < -Math.PI) relAngle += 2 * Math.PI;
			if (relAngle >= 0) left.push(p);
			else right.push(p);
		}
		return { "left": left, "right": right };
	};

	// --- MELEE RING: inner, pincer split ---
	let meleeRadius = buildingRadius + meleeRange;
	let meleeRing = generatePincerRing(meleeRadius, meleeMembers.length, 1.92);
	let meleeSides = splitLeftRight(meleeMembers);
	let meleePosSides = splitPositions(meleeRing.positions);
	result.melee = assignNearest(meleeSides.left, meleePosSides.left)
		.concat(assignNearest(meleeSides.right, meleePosSides.right));

	let meleeAssigned = new Set(result.melee.map(a => a.ent));
	let meleeOverflow = meleeMembers.filter(e => !meleeAssigned.has(e));

	// --- RANGED RING: just behind melee. Melee overflow fills this ring too. ---
	let rangedRadius = meleeRadius + 2;
	let allRangedPool = rangedMembers.concat(meleeOverflow);
	let rangedRing = generatePincerRing(rangedRadius, allRangedPool.length, 1.8);
	let rangedSides = splitLeftRight(allRangedPool);
	let rangedPosSides = splitPositions(rangedRing.positions);
	result.ranged = assignNearest(rangedSides.left, rangedPosSides.left)
		.concat(assignNearest(rangedSides.right, rangedPosSides.right));

	let rangedAssigned = new Set(result.ranged.map(a => a.ent));
	let attackOverflow = allRangedPool.filter(e => !rangedAssigned.has(e));

	// --- CAVALRY PATROL: only cavalry that overflowed from the melee ring ---
	let guardRingStart = rangedRadius + 5;
	let patrolRadius = guardRingStart + 12;
	let meleeOverflowCavalry = attackOverflow.filter(e => cavalryMembers.indexOf(e) !== -1);
	// Remove patrol cavalry from the general overflow pool.
	attackOverflow = attackOverflow.filter(e => cavalryMembers.indexOf(e) === -1);
	for (let i = 0; i < meleeOverflowCavalry.length; ++i)
	{
		result.cavalry.push({
			"ent": meleeOverflowCavalry[i],
			"startAngle": approachAngle + (i / Math.max(meleeOverflowCavalry.length, 1)) * 2 * Math.PI,
			"patrolRadius": patrolRadius
		});
	}

	// --- GUARD RING: only units that couldn't fit on either attack ring ---
	let guardMembers = attackOverflow;
	if (guardMembers.length > 0)
	{
		let guardSpacing = 4;
		let guardPositions = [];
		let ringRadius = rangedRadius + 5; // Just outside the attack rings, not the cavalry circle.
		let remaining = guardMembers.length;
		while (remaining > 0)
		{
			let ringCapacity = Math.max(4, Math.floor(2 * Math.PI * ringRadius / guardSpacing));
			let ringCount = Math.min(remaining, ringCapacity);
			for (let i = 0; i < ringCount; ++i)
			{
				let angle = (i / ringCount) * 2 * Math.PI;
				guardPositions.push({
					"x": bPos.x + Math.cos(angle) * ringRadius,
					"z": bPos.y + Math.sin(angle) * ringRadius
				});
			}
			remaining -= ringCount;
			ringRadius += 6;
		}
		result.guard = assignNearest(guardMembers, guardPositions);
	}

	return result;
};

/**
 * Adjust the shared path to avoid obstacles at corners.
 * At each turn, computes the perpendicular axis and shifts the waypoint
 * away from the narrower side by sigma (the group's spread).
 */
GroupMovementManager.prototype.AdjustPathForObstacles = function(groupId, sigma, passClassName)
{
	let waypoints = this.GetSharedPath(groupId);
	if (!waypoints || waypoints.length < 3)
		return;

	let cmpPathfinder = Engine.QueryInterface(SYSTEM_ENTITY, IID_Pathfinder);
	let sideWidths = cmpPathfinder.GetPathSideWidths(waypoints, passClassName);

	// For each intermediate waypoint, shift away from the narrower side.
	for (let i = 1; i < waypoints.length - 1; ++i)
	{
		let leftW = sideWidths[i].x;
		let rightW = sideWidths[i].y;

		// Only adjust if there's a significant asymmetry (obstacle on one side).
		if (Math.abs(leftW - rightW) < 3)
			continue;

		// Compute perpendicular direction (same as C++ code).
		let dx = waypoints[i + 1].x - waypoints[i - 1].x;
		let dy = waypoints[i + 1].y - waypoints[i - 1].y;
		let len = Math.sqrt(dx * dx + dy * dy);
		if (len < 0.01)
			continue;

		// Perpendicular: left = (-dy, dx), right = (dy, -dx)
		let perpX = -dy / len;
		let perpY = dx / len;

		// Shift away from the narrower side.
		let shift = Math.min(sigma, 8); // Cap shift at 8m to avoid overshooting.
		if (leftW < rightW)
		{
			// Obstacle on left → shift right (negative perpendicular).
			waypoints[i].x -= perpX * shift;
			waypoints[i].y -= perpY * shift;
		}
		else
		{
			// Obstacle on right → shift left (positive perpendicular).
			waypoints[i].x += perpX * shift;
			waypoints[i].y += perpY * shift;
		}
	}
};

/**
 * Get and reset pathfinding stats. Returns [longPathRequests, shortPathRequests].
 * Call this from the game console to compare Classic vs Responsive performance.
 */
GroupMovementManager.prototype.GetPathStats = function()
{
	let cmpPathfinder = Engine.QueryInterface(SYSTEM_ENTITY, IID_Pathfinder);
	return cmpPathfinder.GetAndResetPathStats();
};

// ---- Transitive bumping ----

/**
 * Register a group of entities for transitive arrival tracking.
 */
GroupMovementManager.prototype.RegisterGroup = function(groupId, memberEnts)
{
	this.activeGroups[groupId] = memberEnts.slice();
	this.arrivedByGroup[groupId] = {};
};

/**
 * Mark an entity as arrived within its group.
 */
GroupMovementManager.prototype.MarkArrived = function(ent, groupId)
{
	if (!this.arrivedByGroup[groupId])
		this.arrivedByGroup[groupId] = {};
	this.arrivedByGroup[groupId][ent] = true;
};

/**
 * Check if an entity has been marked as arrived.
 */
GroupMovementManager.prototype.IsArrived = function(ent, groupId)
{
	return !!(this.arrivedByGroup[groupId] && this.arrivedByGroup[groupId][ent]);
};

/**
 * Check if all members in the group have arrived (directly or transitively).
 */
GroupMovementManager.prototype.AreAllArrived = function(groupId)
{
	let members = this.activeGroups[groupId];
	if (!members)
		return true;
	let arrived = this.arrivedByGroup[groupId] || {};
	for (let ent of members)
		if (!arrived[ent])
			return false;
	return true;
};

/**
 * Propagate arrival through physical contact chains.
 * Any unit within contactRadius of an arrived unit also becomes arrived.
 */
GroupMovementManager.prototype.PropagateArrival = function(groupId)
{
	let members = this.activeGroups[groupId];
	if (!members)
		return;
	let arrived = this.arrivedByGroup[groupId];
	if (!arrived)
		return;

	// Gather positions of all living members.
	let posMap = {};
	for (let ent of members)
	{
		let cmpPosition = Engine.QueryInterface(ent, IID_Position);
		if (!cmpPosition || !cmpPosition.IsInWorld())
			continue;
		posMap[ent] = cmpPosition.GetPosition2D();
	}

	let contactRadiusSq = 4 * 4; // 4 meters squared

	let changed = true;
	while (changed)
	{
		changed = false;
		for (let ent of members)
		{
			if (arrived[ent] || !posMap[ent])
				continue;
			let pos = posMap[ent];
			for (let other of members)
			{
				if (!arrived[other] || !posMap[other])
					continue;
				let oPos = posMap[other];
				let dx = pos.x - oPos.x;
				let dy = pos.y - oPos.y;
				if (dx * dx + dy * dy < contactRadiusSq)
				{
					arrived[ent] = true;
					changed = true;
					break;
				}
			}
		}
	}
};

/**
 * Clean up a group's arrival tracking state.
 */
GroupMovementManager.prototype.ClearGroup = function(groupId)
{
	delete this.activeGroups[groupId];
	delete this.arrivedByGroup[groupId];
};

Engine.RegisterSystemComponentType(IID_GroupMovementManager, "GroupMovementManager", GroupMovementManager);
