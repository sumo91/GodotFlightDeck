extends SceneTree
## gdeck scene set runner
##
## Structured single-property edit of a .tscn without the editor:
##   load -> instantiate -> locate node -> JSON-typed set -> pack -> save
## Values are parsed from JSON so booleans/numbers keep their types (a raw
## string "false" would coerce to true in set()).
##
## Usage (invoked by the gdeck CLI):
##   godot --headless --path <project> -s <this-file> -- <scene> <node-path> <property> <json-value> [dry|apply]

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 5:
		push_error("gdeck scene set: expected <scene> <node-path> <property> <json-value> <dry|apply>")
		quit(1)
		return
	var scene_path := args[0]
	var node_path := args[1]
	var property := args[2]
	var json_value := args[3]
	var mode := args[4]
	var packed: PackedScene = load(scene_path)
	if packed == null:
		push_error("gdeck scene set: cannot load scene: %s" % scene_path)
		quit(1)
		return
	var node := packed.instantiate()
	if node == null:
		push_error("gdeck scene set: cannot instantiate: %s" % scene_path)
		quit(1)
		return
	var target := node
	if not node_path.is_empty() and node_path != ".":
		target = node.get_node_or_null(NodePath(node_path))
		if target == null:
			node.free()
			push_error("gdeck scene set: node not found: %s" % node_path)
			quit(1)
			return
	var property_found := false
	for entry in target.get_property_list():
		if entry is Dictionary and str(entry.get("name", "")) == property:
			property_found = true
			break
	if not property_found:
		node.free()
		push_error("gdeck scene set: property not found: %s" % property)
		quit(1)
		return
	var parsed_value: Variant = JSON.parse_string(json_value)
	if json_value != "null" and parsed_value == null:
		node.free()
		push_error("gdeck scene set: value must be valid JSON: %s" % json_value)
		quit(1)
		return
	var old_value: Variant = target.get(property)
	print("EDIT_PREVIEW %s %s.%s old=%s new=%s" % [scene_path, node_path, property, str(old_value), str(parsed_value)])
	if mode == "dry":
		node.free()
		quit(0)
		return
	target.set(property, parsed_value)
	var applied_value: Variant = target.get(property)
	if str(applied_value) != str(parsed_value):
		node.free()
		push_error("gdeck scene set: set did not apply for %s.%s (got %s)" % [node_path, property, str(applied_value)])
		quit(1)
		return
	var repacked := PackedScene.new()
	var pack_error := repacked.pack(node)
	node.free()
	if pack_error != OK:
		push_error("gdeck scene set: pack failed: %s" % error_string(pack_error))
		quit(1)
		return
	var save_error := ResourceSaver.save(repacked, scene_path)
	if save_error != OK:
		push_error("gdeck scene set: save failed: %s" % error_string(save_error))
		quit(1)
		return
	print("EDIT_APPLIED %s" % scene_path)
	quit(0)
