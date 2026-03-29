GameSettings.prototype.Attributes.GroupMovement = class GroupMovement extends GameSetting
{
	init()
	{
		this.mode = "classic";
		this.settings.map.watch(() => this.onMapChange(), ["map"]);
	}

	toInitAttributes(attribs)
	{
		attribs.settings.GroupMovement = this.mode;
	}

	fromInitAttributes(attribs)
	{
		let val = this.getLegacySetting(attribs, "GroupMovement");
		if (val)
			this.mode = val;
	}

	onMapChange()
	{
		if (this.settings.map.type != "scenario")
			return;
		let val = this.getMapSetting("GroupMovement");
		if (val)
			this.setMode(val);
	}

	setMode(mode)
	{
		this.mode = mode;
	}
};
