GameSettingControls.GroupMovement = class GroupMovement extends GameSettingControlDropdown
{
	constructor(...args)
	{
		super(...args);

		g_GameSettings.groupMovement.watch(() => this.render(), ["mode"]);
		this.render();
	}

	onLoad()
	{
		this.render();
	}

	render()
	{
		this.setEnabled(g_GameSettings.map.type != "scenario");

		this.dropdown.list = [
			translate("Classic"),
			translate("Responsive (SC2-style)")
		];
		this.dropdown.list_data = ["classic", "responsive"];

		this.setSelectedValue(g_GameSettings.groupMovement.mode);
	}

	onSelectionChange(itemIdx)
	{
		g_GameSettings.groupMovement.setMode(this.dropdown.list_data[itemIdx]);
		this.gameSettingsController.setNetworkInitAttributes();
	}
};

GameSettingControls.GroupMovement.prototype.TitleCaption =
	translate("Group Movement");

GameSettingControls.GroupMovement.prototype.Tooltip =
	translate("Classic: standard formation movement. Responsive: units move immediately without reforming first. Groups share a single strategic path instead of computing one per unit, scattered units spread naturally, and stuck units recover faster. Best for large armies.");
