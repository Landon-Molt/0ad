function Formation() {}

Formation.prototype.Schema =
	"<element name='RequiredMemberCount' a:help='Minimum number of entities the formation should contain (at least 2).'>" +
		"<data type='integer'>" +
		  "<param name='minInclusive'>"+
		    "2"+
		  "</param>"+
		"</data>" +
	"</element>" +
	"<element name='DisabledTooltip' a:help='Tooltip shown when the formation is disabled.'>" +
		"<optional>" +
			"<attribute name='context'>" +
				"<text/>" +
			"</attribute>" +
		"</optional>" +
		"<optional>" +
			"<attribute name='comment'>" +
				"<text/>" +
			"</attribute>" +
		"</optional>" +
		"<text/>" +
	"</element>" +
	"<element name='SpeedMultiplier' a:help='The speed of the formation is determined by the minimum speed of all members, multiplied with this number.'>" +
		"<ref name='nonNegativeDecimal'/>" +
	"</element>" +
	"<element name='FormationShape' a:help='Formation shape, currently supported are square, triangle and special, where special will be defined in the source code.'>" +
		"<text/>" +
	"</element>" +
	"<element name='MaxTurningAngle' a:help='The turning angle in radian under which the formation attempts to turn and over which the formation positions are recomputed.'>" +
		"<ref name='nonNegativeDecimal'/>" +
	"</element>" +
	"<element name='ShiftRows' a:help='Set the value to true to shift subsequent rows.'>" +
		"<text/>" +
	"</element>" +
	"<element name='SortingClasses' a:help='Determine units` position in formation based on class hierarchy. Use | to separate priority levels. Within a level, + creates AND combinations. Example: &#x201C;Heavy+Melee Melee Heavy Light | Cavalry Infantry&#x201D; positions &#x201C;Heavy Melee Cavalry&#x201D; units first, then &#x201C;Heavy Melee Infantry&#x201D;, then any &#x201C;Melee&#x201D; unit etc.'>" +
		"<text/>" +
	"</element>" +
	"<optional>" +
	"<element name='SortingOrder' a:help='The order of sorting. This defaults to an order where the formation is filled from the first row to the last, and each row from the center to the sides. Other possible sort orders are &#x201C;fillFromTheSides&#x201D;, where the most important units are on the sides of each row, and &#x201C;fillToTheCenter&#x201D;, where the most vulnerable units are in the center of the formation.'>" +
			"<text/>" +
		"</element>" +
	"</optional>" +
	"<element name='WidthDepthRatio' a:help='Average width-to-depth ratio, counted in number of units.'>" +
		"<ref name='nonNegativeDecimal'/>" +
	"</element>" +
	"<element name='Sloppiness' a:help='The maximum difference between the actual and the perfectly aligned formation position, in meters.'>" +
		"<ref name='nonNegativeDecimal'/>" +
	"</element>" +
	"<optional>" +
		"<element name='MinColumns' a:help='When possible, this number of columns will be created. Overriding the wanted width-to-depth ratio.'>" +
			"<data type='nonNegativeInteger'/>" +
		"</element>" +
	"</optional>" +
	"<optional>" +
		"<element name='MaxColumns' a:help='When possible within the number of units, and the maximum number of rows, this will be the maximum number of columns.'>" +
			"<data type='nonNegativeInteger'/>" +
		"</element>" +
	"</optional>" +
	"<optional>" +
		"<element name='MaxRows' a:help='The maximum number of rows in the formation.'>" +
			"<data type='nonNegativeInteger'/>" +
		"</element>" +
	"</optional>" +
	"<optional>" +
		"<element name='CenterGap' a:help='The size of the central gap, expressed in number of units wide.'>" +
			"<ref name='nonNegativeDecimal'/>" +
		"</element>" +
	"</optional>" +
	"<element name='UnitSeparationWidthMultiplier' a:help='Place the units in the formation closer or further to each other. The standard separation is the footprint size.'>" +
		"<ref name='nonNegativeDecimal'/>" +
	"</element>" +
	"<element name='UnitSeparationDepthMultiplier' a:help='Place the units in the formation closer or further to each other. The standard separation is the footprint size.'>" +
		"<ref name='nonNegativeDecimal'/>" +
	"</element>" +
	"<element name='AnimationVariants' a:help='Give a list of animation variants to use for the particular formation members, based on their positions.'>" +
		"<text a:help='example text: &#x201C;1..1,1..-1:animationVariant1;2..2,1..-1;animationVariant2&#x201D;, this will set animationVariant1 for the first row, and animation2 for the second row. The first part of the numbers (1..1 and 2..2) means the row range. Every row between (and including) those values will switch animationvariants. The second part of the numbers (1..-1) denote the columns inside those rows that will be affected. Note that in both cases, you can use -1 for the last row/column, -2 for the second to last, etc.'/>" +
	"</element>";

// Distance under which the formation will not try to turn towards the target position.
var g_RotateDistanceThreshold = 1;

Formation.prototype.variablesToSerialize = [
	"lastOrderVariant",
	"members",
	"memberPositions",
	"maxRowsUsed",
	"maxColumnsUsed",
	"finishedEntities",
	"formationMembersWithAura",
	"width",
	"depth",
	"twinFormations",
	"formationSeparation",
	"offsets"
];

Formation.prototype.Init = function(deserialized = false)
{
	this.shape = this.template.FormationShape;
	this.maxTurningAngle = +this.template.MaxTurningAngle;

	this.memberClassCombinationCache = new Map();
	this.allMatchingClassCombinations = this.GenerateAllMatchingClassCombinations(this.template.SortingClasses);

	this.sortingOrder = this.template.SortingOrder;
	this.shiftRows = this.template.ShiftRows == "true";
	this.separationMultiplier = {
		"width": +this.template.UnitSeparationWidthMultiplier,
		"depth": +this.template.UnitSeparationDepthMultiplier
	};
	this.sloppiness = +this.template.Sloppiness;
	this.widthDepthRatio = +this.template.WidthDepthRatio;
	this.minColumns = +(this.template.MinColumns || 0);
	this.maxColumns = +(this.template.MaxColumns || 0);
	this.maxRows = +(this.template.MaxRows || 0);
	this.centerGap = +(this.template.CenterGap || 0);

	if (this.template.AnimationVariants)
	{
		this.animationvariants = [];
		const differentAnimationVariants = this.template.AnimationVariants.split(/\s*;\s*/);
		// Loop over the different rectangulars that will map to different animation variants.
		for (const rectAnimationVariant of differentAnimationVariants)
		{
			const [rect, replacementAnimationVariant] = rectAnimationVariant.split(/\s*:\s*/);
			const [rows, columns] = rect.split(/\s*,\s*/);
			const [minRow, maxRow] = rows.split(/\s*\.\.\s*/);
			const [minColumn, maxColumn] = columns.split(/\s*\.\.\s*/);
			this.animationvariants.push({
				"minRow": +minRow,
				"maxRow": +maxRow,
				"minColumn": +minColumn,
				"maxColumn": +maxColumn,
				"name": replacementAnimationVariant
			});
		}
	}

	this.lastOrderVariant = undefined;
	// Entity IDs currently belonging to this formation.
	this.members = [];
	this.memberPositions = {};
	this.maxRowsUsed = 0;
	this.maxColumnsUsed = [];
	// Entities that have finished the original task.
	this.finishedEntities = new Set();
	// Members with a formation aura.
	this.formationMembersWithAura = [];
	this.width = 0;
	this.depth = 0;
	this.twinFormations = [];
	// Distance from which two twin formations will merge into one.
	this.formationSeparation = 0;

	if (deserialized)
		return;

	Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer)
		.SetInterval(this.entity, IID_Formation, "UpdateTwinFormationsForMerge", 1000, 1000, null);
};

Formation.prototype.Serialize = function()
{
	const result = {};
	for (const key of this.variablesToSerialize)
		result[key] = this[key];

	return result;
};

Formation.prototype.Deserialize = function(data)
{
	this.Init(true);
	for (const key in data)
		this[key] = data[key];
};

/**
 * Set the value from which two twin formations will become one.
 */
Formation.prototype.SetFormationSeparation = function(value)
{
	this.formationSeparation = value;
};

Formation.prototype.GetSize = function()
{
	return { "width": this.width, "depth": this.depth };
};

Formation.prototype.GetSpeedMultiplier = function()
{
	return +this.template.SpeedMultiplier;
};

Formation.prototype.GetMemberCount = function()
{
	return this.members.length;
};

Formation.prototype.GetMembers = function()
{
	return this.members;
};

/**
 * Finds the closest formation member to a given position.
 *
 * @param {Vector2D} position - The 2D position to find the closest formation member to
 * @param {function} [filter] - Optional filter function that takes an entity ID and
 *                             returns true if the entity should be considered
 * @returns {number} Entity ID of the closest formation member, or INVALID_ENTITY
 *                   if no suitable member is found
 */
Formation.prototype.GetClosestMemberToPosition = function(targetPosition, filter)
{
	let closestMember = INVALID_ENTITY;
	let closestDistance = Infinity;

	for (const member of this.members)
	{
		if (filter && !filter(member))
			continue;

		const cmpMemberPosition = Engine.QueryInterface(member, IID_Position);
		if (!cmpMemberPosition || !cmpMemberPosition.IsInWorld())
			continue;

		const memberPos = cmpMemberPosition.GetPosition2D();
		const memberPositionVector = new Vector2D(memberPos.x, memberPos.y);
		const targetPositionVector = new Vector2D(targetPosition.x, targetPosition.y);
		const dist = targetPositionVector.distanceToSquared(memberPositionVector);
		if (dist < closestDistance)
		{
			closestMember = member;
			closestDistance = dist;
		}
	}
	return closestMember;
};

/**
 * Finds the closest formation member to a given entity.
 *
 * @param {number} ent - The entity ID to find the closest formation member to
 * @param {function} [filter] - Optional filter function that takes an entity ID and
 *                             returns true if the entity should be considered
 * @returns {number} Entity ID of the closest formation member, or INVALID_ENTITY
 *                   if no suitable member is found or the reference entity is invalid
 */
Formation.prototype.GetClosestMemberToEntity = function(ent, filter)
{
	const cmpEntPosition = Engine.QueryInterface(ent, IID_Position);
	if (!cmpEntPosition || !cmpEntPosition.IsInWorld())
		return INVALID_ENTITY;

	const entPosition = cmpEntPosition.GetPosition2D();
	return this.GetClosestMemberToPosition(entPosition, filter);
};

/**
 * Returns the 'primary' member of this formation (typically the most
 * important unit type), for e.g. playing a representative sound.
 * Returns undefined if no members.
 * TODO: Actually implement something like that. Currently this just returns
 * the arbitrary first one.
 */
Formation.prototype.GetPrimaryMember = function()
{
	return this.members[0];
};

/**
 * Get the formation animation variant for a certain member of this formation.
 * @param entity The entity ID to get the animation for.
 * @return The name of the animation variant as defined in the template,
 * e.g. "testudo_front" or undefined if does not exist.
 */
Formation.prototype.GetFormationAnimationVariant = function(entity)
{
	if (!this.animationvariants || !this.animationvariants.length || !this.memberPositions[entity])
		return undefined;
	const row = this.memberPositions[entity].row;
	const column = this.memberPositions[entity].column;
	for (let i = 0; i < this.animationvariants.length; ++i)
	{
		let minRow = this.animationvariants[i].minRow;
		if (minRow < 0)
			minRow += this.maxRowsUsed + 1;
		if (row < minRow)
			continue;

		let maxRow = this.animationvariants[i].maxRow;
		if (maxRow < 0)
			maxRow += this.maxRowsUsed + 1;
		if (row > maxRow)
			continue;

		let minColumn = this.animationvariants[i].minColumn;
		if (minColumn < 0)
			minColumn += this.maxColumnsUsed[row] + 1;
		if (column < minColumn)
			continue;

		let maxColumn = this.animationvariants[i].maxColumn;
		if (maxColumn < 0)
			maxColumn += this.maxColumnsUsed[row] + 1;
		if (column > maxColumn)
			continue;

		return this.animationvariants[i].name;
	}
	return undefined;
};

Formation.prototype.SetFinishedEntity = function(ent)
{
	// Rotate the entity to the correct angle.
	const cmpPosition = Engine.QueryInterface(this.entity, IID_Position);
	const cmpEntPosition = Engine.QueryInterface(ent, IID_Position);
	if (cmpEntPosition && cmpEntPosition.IsInWorld() && cmpPosition && cmpPosition.IsInWorld())
		cmpEntPosition.TurnTo(cmpPosition.GetRotation().y);

	this.finishedEntities.add(ent);
};

Formation.prototype.UnsetFinishedEntity = function(ent)
{
	this.finishedEntities.delete(ent);
};

Formation.prototype.ResetFinishedEntities = function()
{
	this.finishedEntities.clear();
};

Formation.prototype.AreAllMembersFinished = function()
{
	return this.finishedEntities.size === this.members.length;
};

/**
 * Initialize the members of this formation.
 * Must only be called once.
 * All members must implement UnitAI.
 */
Formation.prototype.SetMembers = function(ents)
{
	this.members = ents;

	for (const ent of this.members)
	{
		const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
		cmpUnitAI.SetFormationController(this.entity);

		const cmpAuras = Engine.QueryInterface(ent, IID_Auras);
		if (cmpAuras && cmpAuras.HasFormationAura())
		{
			this.formationMembersWithAura.push(ent);
			cmpAuras.ApplyFormationAura(ents);
		}
	}
	// Note: We don't add the members to this.memberClassCombinationCache right away,
	// it is filled lazily in ComputeFormationOffsets.

	this.offsets = undefined;
	// Locate this formation controller in the middle of its members.
	this.MoveToMembersCenter();

	// Compute the speed etc. of the formation.
	this.ComputeMotionParameters();
};

/**
 * Removes entities from the formation member list.
 * The entities must already be members of this formation.
 *
 * Formation geometry and member positions are not recalculated.
 * As we let UnitAI define proper times and conditions to do so.
 * This avoids reordering in situations we don't want it to happen like in combat.
 *
 * @param {Array} ents - Array of entity IDs to remove from the formation
 * @param {boolean} rename - Whether the removal was part of an entity rename
 *                           (prevents disbanding when under the member limit)
 */
Formation.prototype.RemoveMembers = function(ents, renamed = false)
{
	if (!ents.length)
		return;

	if (!renamed)
		this.offsets = undefined;

	this.members = this.members.filter(ent => !ents.includes(ent));

	for (const ent of ents)
	{
		this.finishedEntities.delete(ent);
		const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
		cmpUnitAI.UpdateWorkOrders();
		cmpUnitAI.UnsetFormationController();

		// Clear cached member class
		if (this.memberClassCombinationCache)
			this.memberClassCombinationCache.delete(ent);
	}

	for (const ent of this.formationMembersWithAura)
	{
		const cmpAuras = Engine.QueryInterface(ent, IID_Auras);
		cmpAuras.RemoveFormationAura(ents);

		// The unit with the aura is also removed from the formation.
		if (ents.includes(ent))
			cmpAuras.RemoveFormationAura(this.members);
	}

	this.formationMembersWithAura = this.formationMembersWithAura.filter(ent => !ents.includes(ent));

	if (renamed)
		return;

	// If there's nobody left, destroy the formation
	// unless this is a rename where we can have 0 members temporarily.
	if (this.members.length < +this.template.RequiredMemberCount)
	{
		this.Disband();
		return;
	}

	this.ComputeMotionParameters();
};

/**
 * Adds entities to the formation member list.
 *
 * Formation geometry and member positions are not recalculated.
 * As we let UnitAI define proper times and conditions to do so.
 * This avoids reordering in situations we don't want it to happen like in combat.
 *
 * @param {Array} ents - Array of entity IDs to add to the formation
 *
 * @see ArrangeFormation - To update formation layout after adding members
 */
Formation.prototype.AddMembers = function(ents, renamed = false)
{
	if (!renamed)
		this.offsets = undefined;

	for (const ent of this.formationMembersWithAura)
	{
		const cmpAuras = Engine.QueryInterface(ent, IID_Auras);
		cmpAuras.ApplyFormationAura(ents);
	}

	this.members = this.members.concat(ents);

	for (const ent of ents)
	{
		const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
		cmpUnitAI.SetFormationController(this.entity);
		if (!cmpUnitAI.GetOrders().length)
			cmpUnitAI.SetNextState("FORMATIONMEMBER.IDLE");

		const cmpAuras = Engine.QueryInterface(ent, IID_Auras);
		if (cmpAuras && cmpAuras.HasFormationAura())
		{
			this.formationMembersWithAura.push(ent);
			cmpAuras.ApplyFormationAura(this.members);
		}
		// Note: We don't add the new members to this.memberClassCombinationCache right away, it is filled lazily.
	}

	this.ComputeMotionParameters();
};

/**
 * Remove all members and destroy the formation.
 */
Formation.prototype.Disband = function()
{
	this.RemoveMembers(this.members);

	// Hack: switch to a clean state to stop timers.
	const cmpUnitAI = Engine.QueryInterface(this.entity, IID_UnitAI);
	cmpUnitAI.UnitFsm.SwitchToNextState(cmpUnitAI, "");
	Engine.QueryInterface(this.entity, IID_Position).MoveOutOfWorld();
	this.DeleteTwinFormations();
	Engine.DestroyEntity(this.entity);
};

/**
 * Set all members to form up into the formation shape.
 * @param {boolean} moveCenter - The formation center will be reinitialized
 * to the center of the units.
 * @param {boolean} force - All individual orders of the formation units are replaced,
 * otherwise the order to walk into formation is just pushed to the front.
 * @param {string | undefined} variant - Variant to be passed as order parameter.
 */
Formation.prototype.ArrangeFormation = function(moveCenter, force, variant)
{
	if (!this.members.length)
		return;

	// In responsive mode, use the SC2-style movement system.
	const cmpGroupMovement = Engine.QueryInterface(SYSTEM_ENTITY, IID_GroupMovementManager);
	if (cmpGroupMovement && cmpGroupMovement.IsResponsive())
	{
		this.MoveMembersResponsive(moveCenter, force, variant);
		return;
	}

	const active = [];
	const positions = [];

	for (const ent of this.members)
	{
		const cmpPosition = Engine.QueryInterface(ent, IID_Position);
		if (!cmpPosition || !cmpPosition.IsInWorld())
			continue;

		active.push(ent);
		// Query the 2D position as the exact height calculation isn't needed,
		// but bring the position to the correct coordinates.
		positions.push(cmpPosition.GetPosition2D());
	}

	const cmpFormationUnitAI = Engine.QueryInterface(this.entity, IID_UnitAI);
	const cmpPosition = Engine.QueryInterface(this.entity, IID_Position);
	// Reposition the formation if we're told to or if we don't already have a position.
	if (cmpPosition && (moveCenter || !cmpPosition.IsInWorld()))
	{
		const avgpos = Vector2D.average(positions);
		const targetPosition = cmpFormationUnitAI.GetTargetPositions()[0];

		const oldRotation = cmpPosition.GetRotation().y;
		const newRotation = targetPosition !== undefined && avgpos.distanceToSquared(targetPosition) > g_RotateDistanceThreshold ? avgpos.angleTo(targetPosition) : oldRotation;

		// When we are out of world or the angle difference is big, trigger repositioning.
		// Do this before setting up the position, because then we will always be in world.
		if (!cmpPosition.IsInWorld() || !this.DoesAngleDifferenceAllowTurning(newRotation, oldRotation))
			this.offsets = undefined;

		this.SetupPositionAndHandleRotation(avgpos.x, avgpos.y, newRotation, true);
	}

	this.lastOrderVariant = variant;

	let offsetsChanged = false;
	if (!this.offsets)
	{
		this.offsets = this.ComputeFormationOffsets(active, positions);
		offsetsChanged = true;
	}

	let xMax = 0;
	let yMax = 0;
	let xMin = 0;
	let yMin = 0;

	if (force)
		// Reset finishedEntities as FormationWalk is called.
		this.ResetFinishedEntities();

	for (let i = 0; i < this.offsets.length; ++i)
	{
		const offset = this.offsets[i];

		const cmpUnitAI = Engine.QueryInterface(offset.ent, IID_UnitAI);
		if (!cmpUnitAI)
		{
			warn("Entities without UnitAI in formation are not supported.");
			continue;
		}

		const data =
			{
				"target": this.entity,
				"x": offset.x,
				"z": offset.y,
				"offsetsChanged": offsetsChanged,
				"variant": variant
			};
		cmpUnitAI.AddOrder("FormationWalk", data, !force);
		xMax = Math.max(xMax, offset.x);
		yMax = Math.max(yMax, offset.y);
		xMin = Math.min(xMin, offset.x);
		yMin = Math.min(yMin, offset.y);
	}
	this.width = xMax - xMin;
	this.depth = yMax - yMin;
};

Formation.prototype.MoveToMembersCenter = function()
{
	const positions = [];
	let rotations = 0;

	for (const ent of this.members)
	{
		const cmpPosition = Engine.QueryInterface(ent, IID_Position);
		if (!cmpPosition || !cmpPosition.IsInWorld())
			continue;

		positions.push(cmpPosition.GetPosition2D());
		rotations += cmpPosition.GetRotation().y;
	}

	const avgpos = Vector2D.average(positions);
	this.SetupPositionAndHandleRotation(avgpos.x, avgpos.y, rotations / positions.length, false);
};

/**
 * Set formation position.
 * If formation is not in world at time this is called, set new rotation and flag
 * for rangeManager. Also set the rotation if it is forced.
 */
Formation.prototype.SetupPositionAndHandleRotation = function(x, y, rot, forceRotation)
{
	const cmpPosition = Engine.QueryInterface(this.entity, IID_Position);
	if (!cmpPosition)
		return;
	const wasInWorld = cmpPosition.IsInWorld();
	cmpPosition.JumpTo(x, y);

	if (!forceRotation && wasInWorld)
		return;

	cmpPosition.TurnTo(rot);
	if (!wasInWorld)
		Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager).SetEntityFlag(this.entity, "normal", false);
};

Formation.prototype.GetAvgFootprint = function(active)
{
	const footprints = [];
	for (const ent of active)
	{
		const cmpFootprint = Engine.QueryInterface(ent, IID_Footprint);
		if (cmpFootprint)
			footprints.push(cmpFootprint.GetShape());
	}
	if (!footprints.length)
		return { "width": 1, "depth": 1 };

	const r = { "width": 0, "depth": 0 };
	for (const shape of footprints)
	{
		if (shape.type == "circle")
		{
			r.width += shape.radius * 2;
			r.depth += shape.radius * 2;
		}
		else if (shape.type == "square")
		{
			r.width += shape.width;
			r.depth += shape.depth;
		}
	}
	r.width /= footprints.length;
	r.depth /= footprints.length;
	return r;
};

/**
 * Convert SortingClasses template into usable class combinations for member sorting.
 *
 * @param {string} sortingClassesText - The SortingClasses template value
 * @example "Level1 | Level2 | Level3" where earlier levels have higher priority.
 * Within each level, space-separated classes are separate possibilities.
 * Classes from different levels are combined with '+' for AND logic.
 *
 * Example: "Melee Ranged | Cavalry Infantry | Citizen Champion Hero" creates:
 * 1. "Melee+Cavalry+Citizen"    (Level1 AND Level2 AND Level3)
 * 2. "Melee+Cavalry+Champion"
 * 3. "Melee+Cavalry+Hero"
 * etc ...
 *
 * A member matches "Melee+Cavalry+Citizen" only if it has ALL THREE classes.
 * The "+" delimiter indicates AND logic between levels.
 *
 * Note: The "+" sign can also be used within a level to create pre-made combinations,
 * e.g., "Heavy+Infantry Light+Infantry" at a single level to set specific class combination entries.
 *
 * Each level implicitly includes an placeholder.
 * This allows matching entities that don't have a class at that specific level.
 *
 * Example, with levels: "Melee | Infantry | Champion":
 * - Generated combinations include:
 * 1. "Melee+Infantry+Champion" (complete match)
 * 2. "Melee+Infantry"           (missing level 3)
 * 3. "Melee+Champion"           (missing level 2)
 * etc ...
 *
 * @returns {Set<string>} All possible class combinations, plus "Unsorted" as final fallback
 */
Formation.prototype.GenerateAllMatchingClassCombinations = function(sortingClassesText)
{
	if (!sortingClassesText)
		return new Set([this.UNSORTED_CLASS_COMBINATION]);

	const levels = sortingClassesText.split(/\s*\|\s*/)
		.map(level => level.split(/\s+/).filter(cls => cls.length && cls !== this.UNSORTED_CLASS_COMBINATION))
		.filter(level => level.length);

	// Adding the placeholder ("") ensures partial matches are caught rather than dropped to unsorted
	const levelsWithPlaceholder = levels.map(level => level.concat(""));

	// Generate combinations with '+' separator
	const combinations = cartesianProduct(levelsWithPlaceholder).map(classes => classes.filter(cl => cl).join('+'));
	return new Set(combinations.concat(this.UNSORTED_CLASS_COMBINATION));
};

Formation.prototype.GetMemberClassCombinations = function(ent)
{
	const cached = this.memberClassCombinationCache.get(ent);
	if (cached !== undefined)
		return cached;

	const classes = Engine.QueryInterface(ent, IID_Identity).GetClassesList();

	const matchedClassCombination = Array.from(this.allMatchingClassCombinations).find(classCombination =>
		MatchesClassList(classes, classCombination)
	) || this.UNSORTED_CLASS_COMBINATION;

	this.memberClassCombinationCache.set(ent, matchedClassCombination);
	return matchedClassCombination;
};

Formation.prototype.ComputeFormationOffsets = function(active, positions)
{
	const separation = this.GetAvgFootprint(active);
	separation.width *= this.separationMultiplier.width;
	separation.depth *= this.separationMultiplier.depth;

	// Group entities by their classCombination
	const classCombinations = {};
	for (const classCombination of this.allMatchingClassCombinations)
		classCombinations[classCombination] = [];

	for (const i in active)
	{
		const ent = active[i];
		const matchedClassCombinations = this.GetMemberClassCombinations(ent);
		classCombinations[matchedClassCombinations].push({ "ent": ent, "pos": positions[i] });
	}

	const count = active.length;
	let offsets = [];

	let depth = Math.sqrt(count / this.widthDepthRatio);
	if (this.maxRows && depth > this.maxRows)
		depth = this.maxRows;

	// Choose a sensible size/shape for the various formations, depending on number of units.
	let cols = Math.ceil(count / Math.ceil(depth) + (this.shiftRows ? 0.5 : 0));
	if (cols < this.minColumns)
		cols = Math.min(count, this.minColumns);
	if (this.maxColumns && cols > this.maxColumns && this.maxRows != depth)
		cols = this.maxColumns;

	// Define special formations here.
	if (this.template.FormationShape == "special" && Engine.QueryInterface(this.entity, IID_Identity).GetGenericName() == "Scatter")
	{
		const width = Math.sqrt(count) * (separation.width + separation.depth) * 2.5;

		for (let i = 0; i < count; ++i)
		{
			const obj = new Vector2D(randFloat(0, width), randFloat(0, width));
			obj.row = 1;
			obj.column = i + 1;
			offsets.push(obj);
		}
	}

	// For non-special formations, calculate the positions based on the number of entities.
	this.maxColumnsUsed = [];
	this.maxRowsUsed = 0;
	if (this.shape != "special")
	{
		offsets = [];
		let r = 0;
		let left = count;
		// While there are units left, start a new row in the formation.
		while (left > 0)
		{
			// Save the position of the row.
			const z = -r * separation.depth;
			// Alternate between the left and right side of the center to have a symmetrical distribution.
			let side = 1;
			let n;
			// Determine the number of entities in this row of the formation.
			if (this.shape == "square")
			{
				n = cols;
				if (this.shiftRows)
					n -= r % 2;
			}
			else if (this.shape == "triangle")
			{
				if (this.shiftRows)
					n = r + 1;
				else
					n = r * 2 + 1;
			}
			if (!this.shiftRows && n > left)
				n = left;
			for (let c = 0; c < n && left > 0; ++c)
			{
				// Switch sides for the next entity.
				side *= -1;
				let x;
				if (n % 2 == 0)
					x = side * (Math.floor(c / 2) + 0.5) * separation.width;
				else
					x = side * Math.ceil(c / 2) * separation.width;
				if (this.centerGap)
				{
					// Don't use the center position with a center gap.
					if (x == 0)
						continue;
					x += side * this.centerGap / 2;
				}
				const column = Math.ceil(n / 2) + Math.ceil(c / 2) * side;
				const r1 = randFloat(-1, 1) * this.sloppiness;
				const r2 = randFloat(-1, 1) * this.sloppiness;

				offsets.push(new Vector2D(x + r1, z + r2));
				offsets[offsets.length - 1].row = r + 1;
				offsets[offsets.length - 1].column = column;
				left--;
			}
			++r;
			this.maxColumnsUsed[r] = n;
		}
		this.maxRowsUsed = r;
	}

	// Make sure the average offset is zero, as the formation is centered around that
	// calculating offset distances without a zero average makes no sense, as the formation
	// will jump to a different position any time.
	const avgoffset = Vector2D.average(offsets);
	offsets.forEach(function(o) {o.sub(avgoffset);});

	// Sort the available places in certain ways.
	// The places first in the list will contain the heaviest units as defined by the order
	// of the classCombinations list.
	if (this.sortingOrder == "fillFromTheSides")
		offsets.sort(function(o1, o2) { return Math.abs(o1.x) < Math.abs(o2.x);});
	else if (this.sortingOrder == "fillToTheCenter")
		offsets.sort(function(o1, o2)
		{
			return Math.max(Math.abs(o1.x), Math.abs(o1.y)) < Math.max(Math.abs(o2.x), Math.abs(o2.y));
		});

	// Query the 2D position of the formation.
	const realPositions = this.GetRealOffsetPositions(offsets);

	// Use realistic place assignment,
	// every soldier searches the closest available place in the formation.
	const newOffsets = [];
	for (const i of [...this.allMatchingClassCombinations].reverse())
	{
		const t = classCombinations[i];
		if (!t.length)
			continue;
		const usedOffsets = offsets.splice(-t.length);
		const usedRealPositions = realPositions.splice(-t.length);
		for (const entPos of t)
		{
			const closestOffsetId = this.TakeClosestOffset(entPos, usedRealPositions, usedOffsets);
			usedRealPositions.splice(closestOffsetId, 1);
			newOffsets.push(usedOffsets.splice(closestOffsetId, 1)[0]);
			newOffsets[newOffsets.length - 1].ent = entPos.ent;
		}
	}

	return newOffsets;
};

/**
 * Search the closest position in the realPositions list to the given entity.
 * @param entPos - Object with entity position and entity ID.
 * @param realPositions - The world coordinates of the available offsets.
 * @param offsets
 * @return The index of the closest offset position.
 */
Formation.prototype.TakeClosestOffset = function(entPos, realPositions, offsets)
{
	const pos = entPos.pos;
	let closestOffsetId = -1;
	let offsetDistanceSq = Infinity;
	for (let i = 0; i < realPositions.length; ++i)
	{
		const distSq = pos.distanceToSquared(realPositions[i]);
		if (distSq < offsetDistanceSq)
		{
			offsetDistanceSq = distSq;
			closestOffsetId = i;
		}
	}
	this.memberPositions[entPos.ent] = { "row": offsets[closestOffsetId].row, "column": offsets[closestOffsetId].column };
	return closestOffsetId;
};

/**
 * Get the world positions for a list of offsets in this formation.
 */
Formation.prototype.GetRealOffsetPositions = function(offsets)
{
	const cmpPosition = Engine.QueryInterface(this.entity, IID_Position);
	const pos = cmpPosition.GetPosition2D();
	const rot = cmpPosition.GetRotation().y;
	const sin = Math.sin(rot);
	const cos = Math.cos(rot);
	const offsetPositions = [];
	// Calculate the world positions.
	for (const o of offsets)
		offsetPositions.push(new Vector2D(pos.x + o.y * sin + o.x * cos, pos.y + o.y * cos - o.x * sin));

	return offsetPositions;
};

/**
 * Returns true if the difference between two given angles (in radians)
 * are smaller than the maximum turning angle of the formation and therfore allow
 * the formation turn without reassigning positions.
 */

Formation.prototype.DoesAngleDifferenceAllowTurning = function(a1, a2)
{
	const d = Math.abs(a1 - a2) % (2 * Math.PI);
	return d < this.maxTurningAngle || d > 2 * Math.PI - this.maxTurningAngle;
};

/**
 * Set formation controller's speed based on its current members.
 */
Formation.prototype.ComputeMotionParameters = function()
{
	if (!this.members.length)
		return;

	let minSpeed = Infinity;
	let minAcceleration = Infinity;
	let maxClearance = 0;
	let maxPassClass = "default";

	const cmpPathfinder = Engine.QueryInterface(SYSTEM_ENTITY, IID_Pathfinder);
	for (const ent of this.members)
	{
		const cmpUnitMotion = Engine.QueryInterface(ent, IID_UnitMotion);
		if (!cmpUnitMotion)
			continue;
		minSpeed = Math.min(minSpeed, cmpUnitMotion.GetWalkSpeed());
		minAcceleration = Math.min(minAcceleration, cmpUnitMotion.GetAcceleration());

		const passClass = cmpUnitMotion.GetPassabilityClassName();
		const clearance = cmpPathfinder.GetClearance(cmpPathfinder.GetPassabilityClass(passClass));
		if (clearance > maxClearance)
		{
			maxClearance = clearance;
			maxPassClass = passClass;
		}
	}
	minSpeed *= this.GetSpeedMultiplier();

	const cmpUnitMotion = Engine.QueryInterface(this.entity, IID_UnitMotion);
	cmpUnitMotion.SetSpeedMultiplier(minSpeed / cmpUnitMotion.GetWalkSpeed());
	cmpUnitMotion.SetAcceleration(minAcceleration);
	cmpUnitMotion.SetPassabilityClassName(maxPassClass);
};

Formation.prototype.UpdateTwinFormationsForMerge = function()
{
	const cmpUnitAI = Engine.QueryInterface(this.entity, IID_UnitAI);

	// If one of the formations is idle, we don't want to merge into that one.
	// Because the formation controller should keep moving towards the destination
	// instead of staying at middle point.
	if (!this.IsRearrangementAllowed() || cmpUnitAI.isIdle)
		return;

	const thisSize = this.GetSize();
	const thisMaxHalf = Math.max(thisSize.width, thisSize.depth) / 2;
	const baseDistance = thisMaxHalf + this.formationSeparation;

	// Check the distance to twin formations, and merge if
	// the formations could collide.
	for (let i = this.twinFormations.length - 1; i >= 0; --i)
	{
		const otherFormationID = this.twinFormations[i];

		// Skip invalid entities and self
		if (otherFormationID == INVALID_ENTITY || otherFormationID == this.entity)
			continue;

		const otherFormationAI = Engine.QueryInterface(otherFormationID, IID_UnitAI);

		// If both formations aren't idle, we can do the distance check on only one side,
		// so skip one of them.
		if (!otherFormationAI.isIdle && otherFormationID <= this.entity)
			continue;

		const cmpPosition = Engine.QueryInterface(this.entity, IID_Position);
		const cmpOtherPosition = Engine.QueryInterface(otherFormationID, IID_Position);
		const cmpOtherFormation = Engine.QueryInterface(otherFormationID, IID_Formation);

		if (!cmpPosition || !cmpOtherPosition || !cmpOtherFormation ||
		     !cmpPosition.IsInWorld() || !cmpOtherPosition.IsInWorld())
			continue;

		const thisPosition = cmpPosition.GetPosition2D();
		const otherPosition = cmpOtherPosition.GetPosition2D();

		const dist = thisPosition.distanceTo(otherPosition);

		const otherSize = cmpOtherFormation.GetSize();
		const minDist = baseDistance + Math.max(otherSize.width, otherSize.depth) / 2;

		if (minDist < dist)
			continue;

		const otherMembers = cmpOtherFormation.members;
		// The other formation will get disbanded for having no members
		cmpOtherFormation.RemoveMembers(otherMembers);
		// Merge the members from the other formation into this one
		this.AddMembers(otherMembers, true);
		// Remove the merged formation from twin formations list
		this.twinFormations.splice(i, 1);

		this.UpdateFormation(true, true);
	}
};

Formation.prototype.ResetOrderVariant = function()
{
	this.lastOrderVariant = undefined;
};

Formation.prototype.OnGlobalOwnershipChanged = function(msg)
{
	// When an entity is captured or destroyed, it should no longer be
	// controlled by this formation.
	if (this.members.indexOf(msg.entity) != -1)
		this.RemoveMembers([msg.entity]);
	if (msg.entity === this.entity && msg.to !== INVALID_PLAYER)
		Engine.QueryInterface(this.entity, IID_Visual)?.SetVariant("animationVariant", QueryPlayerIDInterface(msg.to, IID_Identity).GetCiv());
};

Formation.prototype.OnGlobalEntityRenamed = function(msg)
{
	if (this.members.indexOf(msg.entity) === -1)
		return;

	if (this.finishedEntities.delete(msg.entity))
		this.finishedEntities.add(msg.newentity);

	// First remove the old member to be able to reuse its position.
	this.RemoveMembers([msg.entity], true);
	this.AddMembers([msg.newentity], true);
	this.memberPositions[msg.newentity] = this.memberPositions[msg.entity];
	delete this.memberPositions[msg.entity];

	if (this.resetOffsetsScheduled === undefined)
	{
		this.resetOffsetsScheduled = true;

		// Schedule offset reset for the next tick so that it reorders if necessary.
		const cmpTimer = Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer);
		cmpTimer.SetTimeout(this.entity, IID_Formation, "ResetOffsetsAndUpdate", 0, null);
	}
};

Formation.prototype.ResetOffsetsAndUpdate = function()
{
	this.resetOffsetsScheduled = undefined;
	this.offsets = undefined;
	this.UpdateFormation(false, false);
};

Formation.prototype.RegisterTwinFormation = function(entity)
{
	const cmpFormation = Engine.QueryInterface(entity, IID_Formation);
	if (!cmpFormation)
		return;
	this.twinFormations.push(entity);
	cmpFormation.twinFormations.push(this.entity);
};

Formation.prototype.DeleteTwinFormations = function()
{
	for (const ent of this.twinFormations)
	{
		const cmpFormation = Engine.QueryInterface(ent, IID_Formation);
		if (cmpFormation)
			cmpFormation.twinFormations.splice(cmpFormation.twinFormations.indexOf(this.entity), 1);
	}
	this.twinFormations = [];
};

Formation.prototype.LoadFormation = function(newTemplate)
{
	const newFormation = ChangeEntityTemplate(this.entity, newTemplate);
	return Engine.QueryInterface(newFormation, IID_UnitAI);
};

/**
 * Updates formation members' positions based on current state.
 * Moves members into appropriate formation type if rearrangement is allowed.
 *
 * @param {boolean} moveCenter - Whether to move the formation center
 * @param {boolean} force - Force rearrangement regardless of state
 * @param {string} formationType - Formation variant to be passed as order parameter.
 */
Formation.prototype.UpdateFormation = function(moveCenter = false, force = false, formationType = "default")
{
	// Move members into appropriate formation type
	if (this.IsRearrangementAllowed() || force)
		this.ArrangeFormation(moveCenter, force, formationType);
};

/**
 * Checks if the formation should rearrange based on controller and member states.
 * Prevents rearrangement during critical combat or activity states.
 *
 * @returns {boolean} True if formation should rearrange, false otherwise
 */
Formation.prototype.IsRearrangementAllowed = function()
{
	if (this.IsControllerBlockingRearrangement())
		return false;

	return !this.AreMembersBlockingRearrangement();
};

/**
 * Checks if the formation controller is in a state that prevents rearrangement.
 *
 * @returns {boolean} True if controller is in a no-rearrange state
 */
Formation.prototype.IsControllerBlockingRearrangement = function()
{
	const cmpControllerAI = Engine.QueryInterface(this.entity, IID_UnitAI);

	const noRearrangeStates = [
		"COMBAT.ATTACKING"
	];
	const state = cmpControllerAI.GetCurrentState();
	return noRearrangeStates.some(noState => state.includes(noState));
};

/**
 * Checks if any formation members are in critical states that shouldn't be interrupted.
 * Uses a threshold to allow rearrangement when only a small percentage are busy.
 *
 * @returns {boolean} True if significant number of members are in critical states
 */
Formation.prototype.AreMembersBlockingRearrangement = function()
{
	const criticalStates = new Set([
		"COMBAT.ATTACKING",
		"COMBAT.CHASING",
		"COMBAT.APPROACHING",
		"HEAL.HEALING",
		"GATHER",
		"REPAIR"
	]);

	let totalMembers = 0;
	let criticalMembers = 0;

	for (const member of this.members)
	{
		const cmpMemberAI = Engine.QueryInterface(member, IID_UnitAI);
		if (!cmpMemberAI)
			continue;

		totalMembers++;
		const state = cmpMemberAI.GetCurrentState();

		for (const criticalState of criticalStates)
		{
			if (state.includes(criticalState))
			{
				criticalMembers++;
				break;
			}
		}
	}

	// If no valid members, return false
	if (totalMembers === 0)
		return false;

	// Return true if more than 5% are in critical states.
	// Cover edge cases where a few members would be stuck
	// somewhere and still fighting for example.
	return (criticalMembers / totalMembers) > 0.05;
};

Formation.prototype.OnEntityRenamed = function(msg)
{
	const members = clone(this.members);
	this.Disband();
	Engine.QueryInterface(msg.newentity, IID_Formation).SetMembers(members);
};

/**
 * Final fallback class combination for entities that don't match any combination.
 * Unsorted members are generally placed at the back/last of the formation.
 */
Formation.prototype.UNSORTED_CLASS_COMBINATION = "Unsorted";

/**
 * SC2-style responsive movement. Units move immediately with SmartCenter clustering.
 * Uses consistent offsets throughout — no phase switching that causes visible retightening.
 */
Formation.prototype.MoveMembersResponsive = function(moveCenter, force, variant)
{
	if (!this.members.length)
		return;

	let active = [];
	let positions = [];

	for (let ent of this.members)
	{
		let cmpPosition = Engine.QueryInterface(ent, IID_Position);
		if (!cmpPosition || !cmpPosition.IsInWorld())
			continue;
		active.push(ent);
		positions.push(cmpPosition.GetPosition2D());
	}

	if (!active.length)
		return;

	let cmpGroupMovement = Engine.QueryInterface(SYSTEM_ENTITY, IID_GroupMovementManager);
	let cmpFormationUnitAI = Engine.QueryInterface(this.entity, IID_UnitAI);
	let cmpPosition = Engine.QueryInterface(this.entity, IID_Position);

	// Reposition formation controller.
	if (cmpPosition && (moveCenter || !cmpPosition.IsInWorld()))
	{
		let avgpos = Vector2D.average(positions);
		let targetPositions = cmpFormationUnitAI.GetTargetPositions();
		let targetPosition = targetPositions.length ? targetPositions[0] : undefined;

		// In responsive mode, when the controller is already in the world, don't snap
		// back to the group average — that causes front units to turn backward.
		// Instead, keep the controller at the leading edge (biased toward the target).
		if (cmpPosition.IsInWorld() && targetPosition !== undefined)
		{
			let dx = targetPosition.x - avgpos.x;
			let dy = targetPosition.y - avgpos.y;
			let dist = Math.sqrt(dx * dx + dy * dy);
			if (dist > 1)
			{
				// Shift the center 30% toward the target from the average.
				avgpos.x += dx * 0.3;
				avgpos.y += dy * 0.3;
			}
		}

		let oldRotation = cmpPosition.GetRotation().y;
		let newRotation = targetPosition !== undefined && avgpos.distanceToSquared(targetPosition) > g_RotateDistanceThreshold ?
			avgpos.angleTo(targetPosition) : oldRotation;

		this.SetupPositionAndHandleRotation(avgpos.x, avgpos.y, newRotation, true);
	}

	// Compute SmartCenter for group classification.
	let sc = cmpGroupMovement.ComputeSmartCenter(positions);

	// Get target for scattered mode's DistributeAround.
	let targetPositions = cmpFormationUnitAI.GetTargetPositions();
	let target = targetPositions.length ? targetPositions[0] : undefined;

	// Register group for transitive bumping.
	cmpGroupMovement.RegisterGroup(this.entity, active);

	// On new move commands, compute one shared strategic path for the entire group.
	if (force && target)
	{
		let avgpos = Vector2D.average(positions);
		let cmpUnitMotion = Engine.QueryInterface(active[0], IID_UnitMotion);
		let passClassName = cmpUnitMotion ? cmpUnitMotion.GetPassabilityClassName() : "default";
		cmpGroupMovement.ComputeSharedPath(this.entity, avgpos.x, avgpos.y, target.x, target.y, passClassName);
		// Shift path waypoints away from obstacles at corners.
		cmpGroupMovement.AdjustPathForObstacles(this.entity, sc.sigma, passClassName);
	}

	this.lastOrderVariant = variant;

	if (force)
		this.ResetFinishedEntities();

	// Only recompute offsets when they don't exist (first call) or when forced (new move command).
	// This prevents the idle timer from constantly reshuffling settled units.
	let offsetsChanged = false;
	if (!this.offsets || force)
	{
		if (sc.mode === "scattered" && target)
		{
			// SCATTERED: use DistributeAround to spread units in a spiral around the target.
			let cmpPathfinder = Engine.QueryInterface(SYSTEM_ENTITY, IID_Pathfinder);
			let distributed = cmpPathfinder.DistributeAround(active, target.x, target.y);
			this.offsets = [];
			for (let i = 0; i < active.length; ++i)
				this.offsets.push({
					"ent": active[i],
					"x": distributed[i].x - target.x,
					"y": distributed[i].y - target.y
				});
		}
		else if (sc.mode === "outlier_collapse")
		{
			// OUTLIER COLLAPSE: inliers keep full offsets, outliers get pulled inward.
			this.offsets = this.ComputeFormationOffsets(active, positions);
			for (let i = 0; i < this.offsets.length; ++i)
			{
				let entIdx = active.indexOf(this.offsets[i].ent);
				if (sc.outliers.indexOf(entIdx) !== -1)
				{
					// Article formula: clamp outlier offset to 1 sigma, preserving direction.
					let ox = this.offsets[i].x;
					let oy = this.offsets[i].y;
					let len = Math.sqrt(ox * ox + oy * oy);
					if (len > 0)
					{
						this.offsets[i].x = (ox / len) * sc.sigma;
						this.offsets[i].y = (oy / len) * sc.sigma;
					}
				}
			}
		}
		else
		{
			// TIGHT: consistent full offsets.
			this.offsets = this.ComputeFormationOffsets(active, positions);
		}
		offsetsChanged = true;
	}

	this.IssueFormationOrders(this.offsets, force, variant);
};

/**
 * Helper to issue FormationWalk orders from a computed offsets array.
 */
Formation.prototype.IssueFormationOrders = function(offsets, force, variant)
{
	let xMax = 0;
	let yMax = 0;
	let xMin = 0;
	let yMin = 0;

	for (let i = 0; i < offsets.length; ++i)
	{
		let offset = offsets[i];
		let cmpUnitAI = Engine.QueryInterface(offset.ent, IID_UnitAI);
		if (!cmpUnitAI)
			continue;

		cmpUnitAI.AddOrder("FormationWalk", {
			"target": this.entity,
			"x": offset.x,
			"z": offset.y,
			"offsetsChanged": true,
			"variant": variant
		}, !force);

		xMax = Math.max(xMax, offset.x);
		yMax = Math.max(yMax, offset.y);
		xMin = Math.min(xMin, offset.x);
		yMin = Math.min(yMin, offset.y);
	}
	this.width = xMax - xMin;
	this.depth = yMax - yMin;
};

Engine.RegisterComponentType(IID_Formation, "Formation", Formation);
