extends RefCounted

const Diff = preload("res://addons/flight_deck/visual_diff.gd")
const MAX_PIXELS := 8388608

## Only temporary visual properties; no methods, resources or arbitrary script setters.
static func _value(node: Node, property: String, value: Variant) -> Dictionary:
	if property == "visible" and (node is CanvasItem or node is Node3D) and value is bool:
		return {"value": value}
	if node is CanvasItem and property in ["modulate", "self_modulate"] and _numbers(value, 4):
		for component in value:
			if component < 0.0 or component > 1.0:
				return {}
		return {"value": Color(value[0], value[1], value[2], value[3])}
	if node is Camera3D:
		if property in ["position", "rotation_degrees"] and _numbers(value, 3):
			return {"value": Vector3(value[0], value[1], value[2])}
		if property in ["fov", "size"] and (value is float or value is int) and is_finite(float(value)):
			if (property == "fov" and value >= 1.0 and value <= 179.0) or (property == "size" and value > 0.0):
				return {"value": float(value)}
	if node is Camera2D:
		if property in ["position", "offset", "zoom"] and _numbers(value, 2):
			if property != "zoom" or (value[0] > 0.0 and value[1] > 0.0):
				return {"value": Vector2(value[0], value[1])}
	return {}

static func _numbers(value: Variant, count: int) -> bool:
	if not value is Array or value.size() != count:
		return false
	for component in value:
		if not (component is float or component is int) or not is_finite(float(component)):
			return false
	return true

static func _node(scene: Node, path: Variant) -> Node:
	if not path is String or path.is_empty() or path.length() > 512 or path.begins_with("/") or ":" in path or "\\" in path:
		return null
	if ".." in path.split("/"):
		return null
	return scene.get_node_or_null(NodePath(path))

static func _nodes(root: Node) -> Array[Node]:
	var nodes: Array[Node] = [root]
	var index := 0
	while index < nodes.size():
		nodes.append_array(nodes[index].get_children())
		index += 1
	return nodes

static func _fingerprint(probe: Node, changes: Array) -> String:
	if probe.get_tree().current_scene == null:
		return ""
	var viewport: Viewport = probe.get_viewport()
	var camera: Node = viewport.get_camera_3d()
	var properties := ["global_transform", "fov", "size", "projection", "near", "far", "h_offset", "v_offset"]
	if camera == null:
		camera = viewport.get_camera_2d()
		properties = ["global_transform", "zoom", "offset"]
	var observation := {"scene": probe.get_tree().current_scene.get_instance_id(), "viewport": viewport.get_visible_rect(),
		"states": probe.semantic_states.duplicate(true), "nodes": [], "camera": {}}
	for node in _nodes(probe.get_tree().root):
		observation.nodes.append([node.get_instance_id(), node.process_mode])
	if probe.fixture_adapter.has_method("gdeck_capture_state"):
		var guard = probe.fixture_adapter.call("gdeck_capture_state")
		if not guard is String or guard.is_empty() or guard.length() > 4096:
			return ""
		observation["project_guard"] = guard
	if camera != null:
		observation.camera["id"] = camera.get_instance_id()
		for property in properties:
			var intentional := false
			for change in changes:
				if change.node == camera and (change.property == property or (property == "global_transform" and change.property in ["position", "rotation_degrees"])):
					intentional = true
			if not intentional:
				observation.camera[property] = camera.get(property)
	return var_to_bytes(observation).hex_encode().sha256_text()

static func _image(viewport: Viewport) -> Image:
	# Two complete draws avoid reading the previous frame after a property update.
	await RenderingServer.frame_post_draw
	await RenderingServer.frame_post_draw
	var image := viewport.get_texture().get_image()
	if image != null:
		image.convert(Image.FORMAT_RGBA8)
	return image

static func _valid_image(image: Image) -> bool:
	return image != null and not image.is_empty() and image.get_width() * image.get_height() <= MAX_PIXELS

static func _properties_match(changes: Array, key: String) -> bool:
	for change in changes:
		if not is_instance_valid(change.node) or change.node.get(change.property) != change[key]:
			return false
	return true

static func _json_value(value: Variant) -> Variant:
	if value is Vector2:
		return [value.x, value.y]
	if value is Vector3:
		return [value.x, value.y, value.z]
	if value is Color:
		return [value.r, value.g, value.b, value.a]
	return value

static func run(probe: Node, definition: Variant, step: int) -> Dictionary:
	var result := {"step": step, "status": "inconclusive", "published": false, "reason": "invalid_definition"}
	if not definition is Dictionary or not definition.get("changes") is Array or definition.changes.is_empty() or definition.changes.size() > 8:
		return result
	if not definition.get("name", "") is String or definition.get("name", "").length() > 80:
		return result
	result["name"] = definition.get("name", "")
	if DisplayServer.get_name() == "headless" or probe.capture_ab_root.is_empty() or probe.fixture_adapter == null:
		result.reason = "isolated_rendered_profile_required"
		return result
	var scene: Node = probe.get_tree().current_scene
	var viewport: Viewport = probe.get_viewport()
	if scene == null or viewport.get_visible_rect().size.x * viewport.get_visible_rect().size.y > MAX_PIXELS:
		result.reason = "invalid_viewport"
		return result
	var changes: Array = []
	var seen := {}
	for change in definition.changes:
		if not change is Dictionary or not change.get("property") is String:
			return result
		var node := _node(scene, change.get("path"))
		if node == null:
			result.reason = "node_missing"
			return result
		var converted := _value(node, change.property, change.get("value"))
		var key := "%s:%s" % [node.get_instance_id(), change.property]
		if converted.is_empty() or seen.has(key):
			return result
		seen[key] = true
		changes.append({"node": node, "path": change.path, "property": change.property, "before": node.get(change.property), "after": converted.value})
	var tree: SceneTree = probe.get_tree()
	var paused := tree.paused
	var modes: Array = []
	for node in _nodes(tree.root):
		modes.append({"node": node, "mode": node.process_mode})
		if node != probe and node != tree.root:
			node.process_mode = Node.PROCESS_MODE_DISABLED
	tree.paused = true
	var fingerprint := _fingerprint(probe, changes)
	var error := ""
	var a: Image = await _image(viewport)
	if not _valid_image(a):
		error = "capture_failed"
	elif fingerprint.is_empty() or fingerprint != _fingerprint(probe, changes) or not _properties_match(changes, "before"):
		error = "state_changed"
	if error.is_empty():
		for change in changes:
			if is_instance_valid(change.node):
				change.node.set(change.property, change.after)
				if change.node is Camera2D:
					change.node.force_update_scroll()
				if change.node.get(change.property) != change.after:
					error = "change_rejected"
			else:
				error = "node_missing"
	var b: Image
	if error.is_empty():
		b = await _image(viewport)
		if not _valid_image(b) or b.get_size() != a.get_size():
			error = "capture_failed"
		elif not _properties_match(changes, "after"):
			error = "change_rejected"
		elif fingerprint != _fingerprint(probe, changes):
			error = "state_changed"
	# Restore properties even when capture or invariants failed.
	var restored := true
	for change in changes:
		if is_instance_valid(change.node):
			change.node.set(change.property, change.before)
			if change.node is Camera2D:
				change.node.force_update_scroll()
			restored = restored and change.node.get(change.property) == change.before
		else:
			restored = false
	var control: Image
	if error.is_empty() and restored:
		control = await _image(viewport)
		if not _valid_image(control) or control.get_size() != a.get_size():
			error = "capture_failed"
		elif fingerprint != _fingerprint(probe, changes) or not _properties_match(changes, "before"):
			error = "state_changed"
		elif a.get_data() != control.get_data():
			error = "restore_image_changed"
	for entry in modes:
		if is_instance_valid(entry.node):
			entry.node.process_mode = entry.mode
	tree.paused = paused
	result["restored"] = restored
	if not restored:
		error = "restore_failed"
	if not error.is_empty():
		result.reason = error
		return result
	var comparison := Diff.compare_images(a, b)
	var beside := Image.create(a.get_width() * 2, a.get_height(), false, Image.FORMAT_RGBA8)
	beside.blit_rect(a, Rect2i(Vector2i.ZERO, a.get_size()), Vector2i.ZERO)
	beside.blit_rect(b, Rect2i(Vector2i.ZERO, b.get_size()), Vector2i(a.get_width(), 0))
	var images := {"a": a, "b": b, "restored": control, "side_by_side": beside, "diff": comparison.image}
	var directory: String = probe.capture_ab_root.path_join("pair-%d" % step)
	if DirAccess.make_dir_recursive_absolute(directory) != OK:
		result.reason = "write_failed"
		return result
	var files := {}
	for key in images:
		var path := directory.path_join("%s.png" % key)
		if images[key].save_png(path) != OK:
			result.reason = "write_failed"
			return result
		files[key] = {"sha256": FileAccess.get_sha256(path)}
	var recorded_changes: Array = []
	for change in changes:
		recorded_changes.append({"path": change.path, "property": change.property, "before": _json_value(change.before), "after": _json_value(change.after)})
	result.merge({"status": "completed", "reason": "", "files": files, "changes": recorded_changes,
		"width": a.get_width(), "height": a.get_height(), "changed_pixels": comparison.changed_pixels,
		"changed_ratio": float(comparison.changed_pixels) / comparison.total_pixels, "pixel_threshold": 0.05,
		"control": {"same_process": true, "process_id": OS.get_process_id(), "probe_frame": probe.current_frame,
			"tree_paused": true, "node_processing_disabled": true, "restored_image_identical": true,
			"project_state_guard": "fixture_hook" if probe.fixture_adapter.has_method("gdeck_capture_state") else "semantic_snapshots_only",
			"state_camera_viewport_fingerprint": fingerprint, "layout": "left_a_right_b"}}, true)
	return result
