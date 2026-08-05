@tool
extends EditorPlugin

const VERSION := "1.6.3-cursor.2"
const EditorBridge := preload("res://addons/flight_deck/editor_bridge.gd")

var bridge: FlightDeckEditorBridge

func _enter_tree() -> void:
	bridge = EditorBridge.new(self)
	bridge.start()
	set_process(true)
	add_tool_menu_item("Flight Deck: Copy diagnostics", _copy_diagnostics)

func _exit_tree() -> void:
	set_process(false)
	if bridge:
		bridge.stop()
	remove_tool_menu_item("Flight Deck: Copy diagnostics")

func _process(_delta: float) -> void:
	if bridge:
		bridge.poll()

func _copy_diagnostics() -> void:
	var summary := "Godot Flight Deck %s\nGodot %s\nProject %s\nEditor Bridge %s" % [
		VERSION,
		Engine.get_version_info().get("string", "unknown"),
		ProjectSettings.globalize_path("res://"),
		bridge.endpoint() if bridge and bridge.running else "disabled",
	]
	DisplayServer.clipboard_set(summary)
	print(summary)
