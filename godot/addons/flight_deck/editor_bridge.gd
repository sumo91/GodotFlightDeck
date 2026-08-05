@tool
class_name FlightDeckEditorBridge
extends RefCounted

const VERSION := "1.6.3-cursor.2"
const ALLOWED_RESOURCE_CLASSES := [&"Theme", &"StyleBoxFlat", &"SystemFont", &"Gradient", &"Curve", &"PhysicsMaterial"]
const ALLOWED_NODE_CLASSES := [
	&"Node", &"Node2D", &"Control", &"CanvasLayer", &"Label", &"Button", &"ColorRect",
	&"PanelContainer", &"HBoxContainer", &"VBoxContainer", &"GridContainer", &"MarginContainer",
	&"CenterContainer", &"ScrollContainer", &"TextureRect", &"ProgressBar", &"HSeparator", &"VSeparator",
	&"Marker2D", &"Area2D", &"StaticBody2D", &"CollisionShape2D",
]
const MAX_REQUEST_BYTES := 65536
const DEFAULT_PORT := 47835
const HOST := "127.0.0.1"

var plugin: EditorPlugin
var server := TCPServer.new()
var clients: Array = []
var token := ""
var port := DEFAULT_PORT
var allow_writes := false
var supplementary_enabled := false
var resource_roots: Array[String] = ["res://resources/"]
var last_history_id := -1
var history_operation_error := ""
var running := false
var instance_id := ""
var started_unix := 0.0
var session_path := ""
var event_log: Array[String] = []

func _init(editor_plugin: EditorPlugin) -> void:
	plugin = editor_plugin

func start() -> bool:
	_load_configuration()
	if token.is_empty():
		push_warning("Flight Deck Editor Bridge disabled: .gdeck/editor-token is missing")
		return false
	var requested_port := port
	var error := server.listen(port, HOST)
	if error != OK:
		for offset in range(1, 33):
			var candidate := requested_port + offset
			if candidate > 65535:
				break
			error = server.listen(candidate, HOST)
			if error == OK:
				port = candidate
				push_warning("Flight Deck Editor Bridge port %d was unavailable; using %d for this Editor session" % [requested_port, port])
				break
	if error != OK:
		push_warning("Flight Deck Editor Bridge could not listen on %s:%d or the next 32 ports (error %d)" % [HOST, requested_port, error])
		return false
	running = true
	instance_id = Crypto.new().generate_random_bytes(16).hex_encode()
	started_unix = Time.get_unix_time_from_system()
	session_path = ProjectSettings.globalize_path("res://.gdeck/editor-session-%s.json" % instance_id)
	if not _write_session():
		server.stop()
		running = false
		return false
	_record("Bridge listening on %s:%d" % [HOST, port])
	return true

func stop() -> void:
	for client in clients:
		var peer: StreamPeerTCP = client.peer
		peer.disconnect_from_host()
	clients.clear()
	server.stop()
	running = false
	_remove_session_if_owned()

func poll() -> void:
	if not running:
		return
	while server.is_connection_available():
		var peer := server.take_connection()
		peer.set_no_delay(true)
		clients.append({"peer": peer, "buffer": ""})
	for client in clients.duplicate():
		var peer: StreamPeerTCP = client.peer
		peer.poll()
		if peer.get_status() == StreamPeerTCP.STATUS_ERROR or peer.get_status() == StreamPeerTCP.STATUS_NONE:
			clients.erase(client)
			continue
		var available := peer.get_available_bytes()
		if available <= 0:
			continue
		client.buffer += peer.get_utf8_string(available)
		if client.buffer.length() > MAX_REQUEST_BYTES:
			_send(peer, {"id": null, "ok": false, "error": "request_too_large", "version": VERSION})
			clients.erase(client)
			peer.disconnect_from_host()
			continue
		var newline: int = client.buffer.find("\n")
		while newline >= 0:
			var line: String = client.buffer.substr(0, newline).strip_edges()
			client.buffer = client.buffer.substr(newline + 1)
			if not line.is_empty():
				_handle_request(peer, line)
			newline = client.buffer.find("\n")

func endpoint() -> String:
	return "%s:%d" % [HOST, port]

func _session_directory() -> DirAccess:
	var project_root := ProjectSettings.globalize_path("res://")
	var root := DirAccess.open(project_root)
	if root == null or root.is_link(".gdeck"):
		return null
	return DirAccess.open(ProjectSettings.globalize_path("res://.gdeck"))

func _write_session() -> bool:
	var directory := _session_directory()
	var session_name := session_path.get_file()
	if directory == null or directory.is_link(session_name):
		push_warning("Flight Deck Editor Bridge refused unsafe session metadata path")
		return false
	if FileAccess.file_exists(session_path):
		push_warning("Flight Deck Editor Bridge session metadata already exists; close the other Editor or use confirmed gdeck editor cleanup-sessions for metadata whose process is conclusively dead")
		return false
	var temporary_name := ".%s.tmp" % session_name
	if directory.is_link(temporary_name):
		push_warning("Flight Deck Editor Bridge refused unsafe temporary session path")
		return false
	var temporary_path := ProjectSettings.globalize_path("res://.gdeck/%s" % temporary_name)
	var file := FileAccess.open(temporary_path, FileAccess.WRITE)
	if file == null:
		push_warning("Flight Deck Editor Bridge could not write temporary session metadata")
		return false
	file.store_string(JSON.stringify({
		"schema_version": 1,
		"bridge_version": VERSION,
		"project": ProjectSettings.globalize_path("res://"),
		"host": HOST,
		"port": port,
		"pid": OS.get_process_id(),
		"instance_id": instance_id,
		"started_unix": started_unix,
	}, "  "))
	file.flush()
	file = null
	var rename_error := DirAccess.rename_absolute(temporary_path, session_path)
	if rename_error != OK:
		DirAccess.remove_absolute(temporary_path)
		push_warning("Flight Deck Editor Bridge could not atomically publish session metadata (error %d)" % rename_error)
		return false
	return true

func _remove_session_if_owned() -> void:
	if session_path.is_empty() or not FileAccess.file_exists(session_path):
		return
	var directory := _session_directory()
	if directory == null or directory.is_link(session_path.get_file()):
		return
	var file := FileAccess.open(session_path, FileAccess.READ)
	var parsed = JSON.parse_string(file.get_as_text()) if file else null
	if parsed is Dictionary and str(parsed.get("instance_id", "")) == instance_id:
		DirAccess.remove_absolute(session_path)

func _load_configuration() -> void:
	var token_path := ProjectSettings.globalize_path("res://.gdeck/editor-token")
	var token_file := FileAccess.open(token_path, FileAccess.READ)
	if token_file:
		token = token_file.get_as_text().strip_edges()
	var config_path := ProjectSettings.globalize_path("res://.gdeck/config.json")
	var config_file := FileAccess.open(config_path, FileAccess.READ)
	if not config_file:
		return
	var parsed = JSON.parse_string(config_file.get_as_text())
	if parsed is Dictionary:
		var bridge: Dictionary = parsed.get("editorBridge", {})
		port = clampi(int(bridge.get("port", DEFAULT_PORT)), 1024, 65535)
		allow_writes = bool(bridge.get("allowWrites", false))
		supplementary_enabled = bool(bridge.get("supplementaryEnabled", false))
		var configured_roots = bridge.get("resourceRoots", resource_roots)
		if configured_roots is Array and not configured_roots.is_empty():
			resource_roots.clear()
			for root in configured_roots:
				var root_path := str(root)
				if root_path.begins_with("res://") and ".." not in root_path:
					resource_roots.append(root_path.trim_suffix("/") + "/")

func _handle_request(peer: StreamPeerTCP, line: String) -> void:
	var request = JSON.parse_string(line)
	if not request is Dictionary:
		_send(peer, {"id": null, "ok": false, "error": "invalid_json", "version": VERSION})
		return
	var request_id = request.get("id")
	if not _constant_time_equal(str(request.get("token", "")), token):
		_send(peer, {"id": request_id, "ok": false, "error": "unauthorized", "version": VERSION})
		return
	var action := str(request.get("action", ""))
	_record("Request: %s" % action)
	var params: Dictionary = request.get("params", {}) if request.get("params", {}) is Dictionary else {}
	var write_actions := [&"set", &"create", &"delete", &"reorder", &"resource-create", &"resource-set", &"resource-delete", &"resource-assign", &"batch", &"undo", &"redo", &"save"]
	var supplementary_actions := [&"reorder", &"resource-create", &"resource-set", &"resource-assign", &"resource-delete"]
	var destructive_actions := [&"delete", &"resource-delete"]
	var is_dry_run := action == "batch" and bool(params.get("dry_run", false))
	var confirm_apply := bool(params.get("confirm_apply", false))
	var client_version := str(request.get("client_version", ""))
	var expected_instance_id := str(request.get("expected_instance_id", ""))
	if StringName(action) in write_actions and not is_dry_run and expected_instance_id != instance_id:
		_send(peer, {"id": request_id, "ok": false, "error": "instance_mismatch", "version": VERSION})
		return
	if StringName(action) in write_actions and not is_dry_run and client_version != VERSION:
		_send(peer, {"id": request_id, "ok": false, "error": "version_mismatch: expected %s" % VERSION, "version": VERSION})
		return
	if StringName(action) in write_actions and not allow_writes and not is_dry_run:
		_send(peer, {"id": request_id, "ok": false, "error": "writes_disabled", "version": VERSION})
		return
	if StringName(action) in supplementary_actions and not supplementary_enabled and not is_dry_run:
		_send(peer, {"id": request_id, "ok": false, "error": "supplementary_disabled", "version": VERSION})
		return
	if StringName(action) in destructive_actions and not confirm_apply:
		_send(peer, {"id": request_id, "ok": false, "error": "apply_required", "version": VERSION})
		return
	if action == "batch" and not is_dry_run and not confirm_apply:
		_send(peer, {"id": request_id, "ok": false, "error": "apply_required", "version": VERSION})
		return
	if action == "batch":
		var batch_policy := _validate_batch_policy(params.get("operations", []))
		if not batch_policy.ok:
			_send(peer, {"id": request_id, "ok": false, "error": batch_policy.error, "version": VERSION})
			return
	var result: Dictionary
	match action:
		"status": result = _status()
		"tree": result = _scene_tree(params)
		"inspect": result = _inspect_node(str(params.get("path", ".")))
		"logs": result = _logs(clampi(int(params.get("limit", 100)), 1, 1000))
		"resource-inspect": result = _inspect_resource(str(params.get("resource", "")))
		"set": result = _set_property(str(params.get("path", ".")), str(params.get("property", "")), params.get("value"))
		"create": result = _create_node(str(params.get("parent", ".")), str(params.get("class", "")), str(params.get("name", "")))
		"delete": result = _delete_node(str(params.get("path", "")))
		"reorder": result = _reorder_node(str(params.get("path", "")), int(params.get("index", -1)))
		"resource-create": result = _create_resource(str(params.get("resource_class", "")), str(params.get("resource", "")))
		"resource-set": result = _set_resource_property(str(params.get("resource", "")), str(params.get("property", "")), params.get("value"))
		"resource-delete": result = _delete_resource(str(params.get("resource", "")))
		"resource-assign": result = _assign_resource(str(params.get("path", ".")), str(params.get("property", "")), str(params.get("resource", "")))
		"batch": result = _batch(params)
		"undo": result = _undo()
		"redo": result = _redo()
		"save": result = _save_scene()
		_:
			_send(peer, {"id": request_id, "ok": false, "error": "unsupported_action", "version": VERSION})
			return
	if result.has("_error"):
		_send(peer, {"id": request_id, "ok": false, "error": result._error, "version": VERSION})
	else:
		_send(peer, {"id": request_id, "ok": true, "result": result, "version": VERSION})

func _validate_batch_policy(operations: Variant) -> Dictionary:
	if not operations is Array:
		return {"ok": false, "error": "batch_operations_must_be_array"}
	for index in range(operations.size()):
		var operation = operations[index]
		if not operation is Dictionary:
			return {"ok": false, "error": "batch[%d]: operation_must_be_object" % index}
		var op_action := str(operation.get("action", ""))
		match op_action:
			"set":
				pass
			"resource-set", "resource-assign":
				if not supplementary_enabled:
					return {"ok": false, "error": "batch[%d]: supplementary_disabled" % index}
			_:
				return {"ok": false, "error": "batch[%d]: unsupported_action" % index}
	return {"ok": true}

func _send(peer: StreamPeerTCP, payload: Dictionary) -> void:
	peer.put_data((JSON.stringify(payload) + "\n").to_utf8_buffer())

func _constant_time_equal(candidate: String, expected: String) -> bool:
	if candidate.length() != expected.length():
		return false
	var difference := 0
	for index in range(candidate.length()):
		difference |= candidate.unicode_at(index) ^ expected.unicode_at(index)
	return difference == 0

func _valid_node_path(path: String) -> Dictionary:
	if path.is_empty() or path == ".":
		return {"ok": true}
	if path.begins_with("/") or NodePath(path).is_absolute():
		return {"ok": false, "error": "absolute_node_path_not_allowed"}
	for segment in path.split("/"):
		if segment == "..":
			return {"ok": false, "error": "parent_path_segment_not_allowed"}
		if segment.is_empty() or segment == "." or ":" in segment:
			return {"ok": false, "error": "invalid_node_path"}
	return {"ok": true}

func _resolve_scene_node(path: String) -> Dictionary:
	var validation := _valid_node_path(path)
	if not validation.ok:
		return validation
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"ok": false, "error": "no_edited_scene"}
	var node: Node = root if path.is_empty() or path == "." else root.get_node_or_null(NodePath(path))
	if node == null:
		return {"ok": false, "error": "node_not_found: %s" % path}
	if node != root and not root.is_ancestor_of(node):
		return {"ok": false, "error": "node_outside_edited_scene"}
	return {"ok": true, "root": root, "node": node}

func _status() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var selected: Array[String] = []
	if root:
		for node in EditorInterface.get_selection().get_selected_nodes():
			if node == root:
				selected.append(".")
			elif root.is_ancestor_of(node):
				selected.append(str(root.get_path_to(node)))
	var history = _last_history()
	return {
		"flight_deck_version": VERSION,
		"instance_id": instance_id,
		"pid": OS.get_process_id(),
		"started_unix": started_unix,
		"godot_version": Engine.get_version_info().get("string", "unknown"),
		"project": ProjectSettings.globalize_path("res://"),
		"edited_scene": root.scene_file_path if root else "",
		"scene_root": root.name if root else "",
		"is_playing": EditorInterface.is_playing_scene(),
		"playing_scene": EditorInterface.get_playing_scene(),
		"selected_nodes": selected,
		"bridge": endpoint(),
		"allow_writes": allow_writes,
		"can_undo": history != null and history.has_undo(),
		"can_redo": history != null and history.has_redo(),
	}

func _scene_tree(params: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"_error": "no_edited_scene"}
	var context := {
		"nodes": [],
		"limit": clampi(int(params.get("limit", 500)), 1, 5000),
		"max_depth": clampi(int(params.get("depth", 8)), 0, 64),
		"truncated": false,
	}
	_append_node(root, root, 0, context)
	return {
		"scene": root.scene_file_path,
		"root": root.name,
		"nodes": context.nodes,
		"count": context.nodes.size(),
		"limit": context.limit,
		"max_depth": context.max_depth,
		"truncated": context.truncated,
	}

func _append_node(node: Node, root: Node, depth: int, context: Dictionary) -> void:
	if context.nodes.size() >= context.limit:
		context.truncated = true
		return
	var script_path := ""
	var script = node.get_script()
	if script is Script:
		script_path = script.resource_path
	context.nodes.append({
		"name": node.name,
		"path": "." if node == root else str(root.get_path_to(node)),
		"class": node.get_class(),
		"script": script_path,
		"depth": depth,
		"index": node.get_index(),
		"child_count": node.get_child_count(),
	})
	if depth >= context.max_depth:
		if node.get_child_count() > 0:
			context.truncated = true
		return
	for child in node.get_children():
		_append_node(child, root, depth + 1, context)

func _inspect_node(path: String) -> Dictionary:
	var resolved := _resolve_scene_node(path)
	if not resolved.ok:
		return {"_error": resolved.error}
	var root: Node = resolved.root
	var node: Node = resolved.node
	var properties: Array[Dictionary] = []
	for info in node.get_property_list():
		var usage := int(info.get("usage", 0))
		if (usage & PROPERTY_USAGE_EDITOR) == 0 and (usage & PROPERTY_USAGE_SCRIPT_VARIABLE) == 0:
			continue
		var property_name := str(info.get("name", ""))
		if property_name.is_empty() or property_name.begins_with("metadata/"):
			continue
		var value = node.get(property_name)
		properties.append({
			"name": property_name,
			"type": type_string(int(info.get("type", TYPE_NIL))),
			"value": _json_value(value, 0),
			"read_only": (usage & PROPERTY_USAGE_READ_ONLY) != 0,
		})
	var script_path := ""
	var script = node.get_script()
	if script is Script:
		script_path = script.resource_path
	return {
		"name": node.name,
		"path": "." if node == root else str(root.get_path_to(node)),
		"class": node.get_class(),
		"script": script_path,
		"properties": properties,
	}

func _batch(params: Dictionary) -> Dictionary:
	var operations = params.get("operations", [])
	if not operations is Array or operations.is_empty() or operations.size() > 100:
		return {"_error": "batch_operations_must_contain_1_to_100_items"}
	var prepared := _prepare_batch(operations)
	if not prepared.ok:
		return {"_error": prepared.error}
	var transaction_name := str(params.get("name", "Flight Deck batch")).strip_edges()
	if transaction_name.is_empty():
		transaction_name = "Flight Deck batch"
	transaction_name = transaction_name.left(80)
	var dry_run := bool(params.get("dry_run", false))
	if dry_run:
		return {
			"name": transaction_name,
			"dry_run": true,
			"valid": true,
			"count": prepared.changes.size(),
			"operations": prepared.summary,
		}
	var applied := _apply_batch_changes_checked(prepared.changes)
	if not applied.ok:
		return {"_error": applied.error}
	var history_context := _batch_history_context(prepared.changes)
	var manager := plugin.get_undo_redo()
	manager.create_action(transaction_name, UndoRedo.MERGE_DISABLE, history_context, false, true)
	manager.add_do_method(self, &"_apply_batch_changes", prepared.changes, true)
	manager.add_undo_method(self, &"_apply_batch_changes", prepared.changes, false)
	manager.commit_action(false)
	if history_context is Node:
		EditorInterface.mark_scene_as_unsaved()
	last_history_id = manager.get_object_history_id(history_context)
	return {
		"name": transaction_name,
		"dry_run": false,
		"committed": true,
		"count": prepared.changes.size(),
		"operations": prepared.summary,
		"undo_registered": true,
	}

func _batch_history_context(changes: Array) -> Object:
	for change in changes:
		if change.object is Node:
			return EditorInterface.get_edited_scene_root()
	return plugin

func _prepare_batch(operations: Array) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var changes: Array = []
	var summary: Array[Dictionary] = []
	var targets := {}
	for index in range(operations.size()):
		var operation = operations[index]
		if not operation is Dictionary:
			return {"ok": false, "error": "batch[%d]: operation_must_be_object" % index}
		var action := str(operation.get("action", ""))
		var object: Object
		var property_name := str(operation.get("property", ""))
		var resource_path := ""
		var display_target := ""
		var property_info: Dictionary
		var converted: Dictionary
		match action:
			"set":
				var node_path := str(operation.get("path", "."))
				var resolved := _resolve_scene_node(node_path)
				if not resolved.ok:
					return {"ok": false, "error": "batch[%d]: %s" % [index, resolved.error]}
				var node: Node = resolved.node
				if property_name.is_empty() or property_name in ["script", "owner", "scene_file_path"]:
					return {"ok": false, "error": "batch[%d]: property_not_writable: %s" % [index, property_name]}
				object = node
				display_target = node_path
				property_info = _find_property(node, property_name)
			"resource-set":
				resource_path = str(operation.get("resource", ""))
				var validation := _valid_resource_path(resource_path, true)
				if not validation.ok:
					return {"ok": false, "error": "batch[%d]: %s" % [index, validation.error]}
				var resource := ResourceLoader.load(resource_path)
				if resource == null:
					return {"ok": false, "error": "batch[%d]: resource_load_failed" % index}
				var resource_security := _validate_loaded_resource(resource)
				if not resource_security.ok:
					return {"ok": false, "error": "batch[%d]: %s" % [index, resource_security.error]}
				if property_name.is_empty() or property_name in ["script", "resource_path", "resource_name"]:
					return {"ok": false, "error": "batch[%d]: property_not_writable: %s" % [index, property_name]}
				object = resource
				display_target = resource_path
				property_info = _find_property(resource, property_name)
			"resource-assign":
				var node_path := str(operation.get("path", "."))
				var resolved := _resolve_scene_node(node_path)
				if not resolved.ok:
					return {"ok": false, "error": "batch[%d]: %s" % [index, resolved.error]}
				var node: Node = resolved.node
				resource_path = str(operation.get("resource", ""))
				var validation := _valid_resource_path(resource_path, true)
				if not validation.ok:
					return {"ok": false, "error": "batch[%d]: %s" % [index, validation.error]}
				var resource := ResourceLoader.load(resource_path)
				if resource == null:
					return {"ok": false, "error": "batch[%d]: resource_load_failed" % index}
				var resource_security := _validate_loaded_resource(resource)
				if not resource_security.ok:
					return {"ok": false, "error": "batch[%d]: %s" % [index, resource_security.error]}
				property_info = _find_property(node, property_name)
				if property_info.is_empty() or int(property_info.get("type", TYPE_NIL)) != TYPE_OBJECT:
					return {"ok": false, "error": "batch[%d]: resource_property_not_found: %s" % [index, property_name]}
				var expected_class := str(property_info.get("class_name", ""))
				if not expected_class.is_empty() and not resource.is_class(expected_class):
					return {"ok": false, "error": "batch[%d]: resource_type_mismatch: expected %s" % [index, expected_class]}
				object = node
				display_target = node_path
				converted = {"ok": true, "value": resource}
			_:
				return {"ok": false, "error": "batch[%d]: unsupported_action: %s" % [index, action]}
		if property_info.is_empty():
			return {"ok": false, "error": "batch[%d]: property_not_found: %s" % [index, property_name]}
		var usage := int(property_info.get("usage", 0))
		if (usage & PROPERTY_USAGE_EDITOR) == 0 or (usage & PROPERTY_USAGE_READ_ONLY) != 0:
			return {"ok": false, "error": "batch[%d]: property_not_writable: %s" % [index, property_name]}
		if converted.is_empty():
			converted = _convert_property_value(operation.get("value"), property_info)
		if not converted.ok:
			return {"ok": false, "error": "batch[%d]: %s" % [index, converted.error]}
		var target_key := "%d:%s" % [object.get_instance_id(), property_name]
		if targets.has(target_key):
			return {"ok": false, "error": "batch[%d]: duplicate_target: %s.%s" % [index, display_target, property_name]}
		targets[target_key] = true
		var old_value = object.get(property_name)
		changes.append({
			"object": object,
			"property": property_name,
			"old_value": old_value,
			"new_value": converted.value,
			"resource_path": resource_path if action == "resource-set" else "",
		})
		summary.append({
			"action": action,
			"target": display_target,
			"property": property_name,
			"type": type_string(int(property_info.get("type", TYPE_NIL))),
			"old_value": _json_value(old_value, 0),
			"value": _json_value(converted.value, 0),
		})
	return {"ok": true, "changes": changes, "summary": summary}

func _apply_batch_changes_checked(changes: Array) -> Dictionary:
	return _apply_batch_values_checked(changes, true)

func _apply_batch_values_checked(changes: Array, use_new_values: bool) -> Dictionary:
	var file_snapshots := {}
	var value_snapshots: Array = []
	var scene_changed := false
	for change in changes:
		var object: Object = change.object
		if not is_instance_valid(object):
			return {"ok": false, "error": "batch_object_invalid"}
		value_snapshots.append({"object": object, "property": change.property, "value": object.get(StringName(change.property))})
		var path := str(change.resource_path)
		if not path.is_empty() and not file_snapshots.has(path):
			file_snapshots[path] = FileAccess.get_file_as_bytes(ProjectSettings.globalize_path(path))
	for change in changes:
		var object: Object = change.object
		object.set(StringName(change.property), change.new_value if use_new_values else change.old_value)
		if object is Resource:
			object.emit_changed()
		if object is Node:
			scene_changed = true
	for path in file_snapshots:
		var resource_to_save: Resource
		for change in changes:
			if str(change.resource_path) == path and change.object is Resource:
				resource_to_save = change.object
				break
		if resource_to_save != null and not _save_resource_checked(resource_to_save, path):
			for snapshot in value_snapshots:
				var rollback_object: Object = snapshot.object
				if is_instance_valid(rollback_object):
					rollback_object.set(StringName(snapshot.property), snapshot.value)
			var rollback_ok := true
			for snapshot_path in file_snapshots:
				rollback_ok = _restore_file_bytes(snapshot_path, file_snapshots[snapshot_path]) and rollback_ok
			return {"ok": false, "error": "resource_save_failed: %s" % path if rollback_ok else "batch_rollback_failed"}
	if scene_changed:
		EditorInterface.mark_scene_as_unsaved()
	return {"ok": true}

func _apply_batch_changes(changes: Array, use_new_values: bool) -> void:
	var result := _apply_batch_values_checked(changes, use_new_values)
	if not result.ok:
		history_operation_error = result.error

func _path_contains_symlink(path: String, include_last: bool) -> bool:
	var relative_path := path.trim_prefix("res://")
	var parts := relative_path.split("/", false)
	var current := ProjectSettings.globalize_path("res://").trim_suffix("/")
	var count := parts.size() if include_last else maxi(0, parts.size() - 1)
	for index in range(count):
		var directory := DirAccess.open(current)
		if directory == null:
			return false
		var component := str(parts[index])
		if directory.is_link(component):
			return true
		current = current.path_join(component)
	return false

func _valid_resource_path(path: String, require_existing: bool) -> Dictionary:
	if not path.begins_with("res://") or ".." in path or not path.ends_with(".tres") or "\\" in path:
		return {"ok": false, "error": "invalid_resource_path"}
	var allowed := false
	for root in resource_roots:
		if path.begins_with(root):
			allowed = true
			break
	if not allowed:
		return {"ok": false, "error": "resource_path_outside_allowed_roots"}
	var absolute := ProjectSettings.globalize_path(path).simplify_path()
	var project_root := ProjectSettings.globalize_path("res://").simplify_path().trim_suffix("/")
	if absolute != project_root and not absolute.begins_with(project_root + "/"):
		return {"ok": false, "error": "resource_path_outside_project"}
	var exists := FileAccess.file_exists(absolute)
	if _path_contains_symlink(path, true):
		return {"ok": false, "error": "resource_path_contains_symlink"}
	if require_existing and not exists:
		return {"ok": false, "error": "resource_not_found: %s" % path}
	if not require_existing and exists:
		return {"ok": false, "error": "resource_already_exists: %s" % path}
	return {"ok": true}

func _validate_loaded_resource(resource: Resource) -> Dictionary:
	if resource is Script or resource.get_script() != null:
		return {"ok": false, "error": "script_resource_not_allowed"}
	if StringName(resource.get_class()) not in ALLOWED_RESOURCE_CLASSES:
		return {"ok": false, "error": "resource_class_not_allowed: %s" % resource.get_class()}
	return {"ok": true}

func _inspect_resource(path: String) -> Dictionary:
	var validation := _valid_resource_path(path, true)
	if not validation.ok:
		return {"_error": validation.error}
	var resource := ResourceLoader.load(path)
	if resource == null:
		return {"_error": "resource_load_failed: %s" % path}
	var security := _validate_loaded_resource(resource)
	if not security.ok:
		return {"_error": security.error}
	return {
		"path": path,
		"class": resource.get_class(),
		"properties": _editable_properties(resource),
	}

func _editable_properties(object: Object) -> Array[Dictionary]:
	var properties: Array[Dictionary] = []
	for info in object.get_property_list():
		var usage := int(info.get("usage", 0))
		if (usage & PROPERTY_USAGE_EDITOR) == 0:
			continue
		var property_name := str(info.get("name", ""))
		if property_name.is_empty() or property_name.begins_with("metadata/"):
			continue
		properties.append({
			"name": property_name,
			"type": type_string(int(info.get("type", TYPE_NIL))),
			"class": str(info.get("class_name", "")),
			"value": _json_value(object.get(property_name), 0),
			"read_only": (usage & PROPERTY_USAGE_READ_ONLY) != 0,
		})
	return properties

func _create_resource(resource_class: String, path: String) -> Dictionary:
	var validation := _valid_resource_path(path, false)
	if not validation.ok:
		return {"_error": validation.error}
	if StringName(resource_class) not in ALLOWED_RESOURCE_CLASSES:
		return {"_error": "resource_class_not_allowed: %s" % resource_class}
	var instance = ClassDB.instantiate(StringName(resource_class))
	if not instance is Resource:
		return {"_error": "cannot_instantiate_resource: %s" % resource_class}
	var resource := instance as Resource
	if not _save_resource_checked(resource, path):
		_remove_resource_checked(path)
		return {"_error": "resource_save_failed: %s" % path}
	var manager := plugin.get_undo_redo()
	manager.create_action("Flight Deck: Create %s" % path, UndoRedo.MERGE_DISABLE, plugin, false, true)
	manager.add_do_method(self, &"_save_resource_file", resource, path)
	manager.add_undo_method(self, &"_remove_resource_file", path)
	manager.commit_action(false)
	last_history_id = manager.get_object_history_id(plugin)
	return {"created": true, "path": path, "class": resource_class, "undo_registered": true}

func _set_resource_property(path: String, property_name: String, requested_value: Variant) -> Dictionary:
	var validation := _valid_resource_path(path, true)
	if not validation.ok:
		return {"_error": validation.error}
	var resource := ResourceLoader.load(path)
	if resource == null:
		return {"_error": "resource_load_failed: %s" % path}
	var security := _validate_loaded_resource(resource)
	if not security.ok:
		return {"_error": security.error}
	if property_name.is_empty() or property_name in ["script", "resource_path", "resource_name"]:
		return {"_error": "property_not_writable: %s" % property_name}
	var property_info := _find_property(resource, property_name)
	if property_info.is_empty():
		return {"_error": "property_not_found: %s" % property_name}
	var usage := int(property_info.get("usage", 0))
	if (usage & PROPERTY_USAGE_EDITOR) == 0 or (usage & PROPERTY_USAGE_READ_ONLY) != 0:
		return {"_error": "property_not_writable: %s" % property_name}
	var converted := _convert_property_value(requested_value, property_info)
	if not converted.ok:
		return {"_error": converted.error}
	var old_value = resource.get(property_name)
	var original_bytes := FileAccess.get_file_as_bytes(ProjectSettings.globalize_path(path))
	resource.set(StringName(property_name), converted.value)
	resource.emit_changed()
	if not _save_resource_checked(resource, path):
		resource.set(StringName(property_name), old_value)
		_restore_file_bytes(path, original_bytes)
		return {"_error": "resource_save_failed: %s" % path}
	var manager := plugin.get_undo_redo()
	manager.create_action("Flight Deck: Set %s.%s" % [path, property_name], UndoRedo.MERGE_DISABLE, plugin, false, true)
	manager.add_do_property(resource, StringName(property_name), converted.value)
	manager.add_do_method(self, &"_save_resource_file", resource, path)
	manager.add_undo_property(resource, StringName(property_name), old_value)
	manager.add_undo_method(self, &"_save_resource_file", resource, path)
	manager.commit_action(false)
	last_history_id = manager.get_object_history_id(plugin)
	return {
		"path": path,
		"property": property_name,
		"type": type_string(int(property_info.get("type", TYPE_NIL))),
		"old_value": _json_value(old_value, 0),
		"value": _json_value(resource.get(property_name), 0),
		"undo_registered": true,
	}

func _delete_resource(path: String) -> Dictionary:
	var validation := _valid_resource_path(path, true)
	if not validation.ok:
		return {"_error": validation.error}
	var resource := ResourceLoader.load(path)
	if resource == null:
		return {"_error": "resource_load_failed: %s" % path}
	var security := _validate_loaded_resource(resource)
	if not security.ok:
		return {"_error": security.error}
	var original_bytes := FileAccess.get_file_as_bytes(ProjectSettings.globalize_path(path))
	if original_bytes.is_empty() or not _remove_resource_checked(path):
		return {"_error": "resource_delete_failed: %s" % path}
	var manager := plugin.get_undo_redo()
	manager.create_action("Flight Deck: Delete %s" % path, UndoRedo.MERGE_DISABLE, plugin, false, true)
	manager.add_do_method(self, &"_remove_resource_file", path)
	manager.add_undo_method(self, &"_restore_file_bytes_action", path, original_bytes)
	manager.commit_action(false)
	last_history_id = manager.get_object_history_id(plugin)
	return {"deleted": true, "path": path, "class": resource.get_class(), "undo_registered": true}

func _assign_resource(node_path: String, property_name: String, resource_path: String) -> Dictionary:
	var validation := _valid_resource_path(resource_path, true)
	if not validation.ok:
		return {"_error": validation.error}
	var resolved := _resolve_scene_node(node_path)
	if not resolved.ok:
		return {"_error": resolved.error}
	var root: Node = resolved.root
	var node: Node = resolved.node
	var property_info := _find_property(node, property_name)
	if property_info.is_empty() or int(property_info.get("type", TYPE_NIL)) != TYPE_OBJECT:
		return {"_error": "resource_property_not_found: %s" % property_name}
	var usage := int(property_info.get("usage", 0))
	if (usage & PROPERTY_USAGE_EDITOR) == 0 or (usage & PROPERTY_USAGE_READ_ONLY) != 0:
		return {"_error": "property_not_writable: %s" % property_name}
	var resource := ResourceLoader.load(resource_path)
	if resource == null:
		return {"_error": "resource_load_failed: %s" % resource_path}
	var security := _validate_loaded_resource(resource)
	if not security.ok:
		return {"_error": security.error}
	var expected_class := str(property_info.get("class_name", ""))
	if not expected_class.is_empty() and not resource.is_class(expected_class):
		return {"_error": "resource_type_mismatch: expected %s" % expected_class}
	var old_value = node.get(property_name)
	var manager := plugin.get_undo_redo()
	manager.create_action("Flight Deck: Assign %s to %s.%s" % [resource_path, node_path, property_name], UndoRedo.MERGE_DISABLE, root, false, true)
	manager.add_do_property(node, StringName(property_name), resource)
	manager.add_undo_property(node, StringName(property_name), old_value)
	manager.commit_action()
	EditorInterface.mark_scene_as_unsaved()
	last_history_id = manager.get_object_history_id(root)
	return {"assigned": true, "path": node_path, "property": property_name, "resource": resource_path, "undo_registered": true}

func _find_property(object: Object, property_name: String) -> Dictionary:
	for info in object.get_property_list():
		if str(info.get("name", "")) == property_name:
			return info
	return {}

func _save_resource_checked(resource: Resource, path: String) -> bool:
	var absolute_directory := ProjectSettings.globalize_path(path.get_base_dir())
	if DirAccess.make_dir_recursive_absolute(absolute_directory) != OK:
		return false
	return ResourceSaver.save(resource, path) == OK and FileAccess.file_exists(ProjectSettings.globalize_path(path))

func _scan_resource_filesystem() -> void:
	var filesystem := EditorInterface.get_resource_filesystem()
	if filesystem != null:
		filesystem.scan()

func _save_resource_file(resource: Resource, path: String) -> void:
	if not _save_resource_checked(resource, path):
		history_operation_error = "resource_save_failed: %s" % path
	_scan_resource_filesystem()

func _remove_resource_checked(path: String) -> bool:
	var absolute := ProjectSettings.globalize_path(path)
	return DirAccess.remove_absolute(absolute) == OK and not FileAccess.file_exists(absolute)

func _remove_resource_file(path: String) -> void:
	if not _remove_resource_checked(path):
		history_operation_error = "resource_delete_failed: %s" % path
	_scan_resource_filesystem()

func _restore_file_bytes(path: String, bytes: PackedByteArray) -> bool:
	var absolute := ProjectSettings.globalize_path(path)
	if DirAccess.make_dir_recursive_absolute(absolute.get_base_dir()) != OK:
		return false
	var file := FileAccess.open(absolute, FileAccess.WRITE)
	if file == null:
		return false
	file.store_buffer(bytes)
	file.flush()
	var succeeded := file.get_error() == OK
	file.close()
	_scan_resource_filesystem()
	return succeeded

func _restore_file_bytes_action(path: String, bytes: PackedByteArray) -> void:
	if not _restore_file_bytes(path, bytes):
		history_operation_error = "resource_restore_failed: %s" % path

func _create_node(parent_path: String, node_class: String, node_name: String) -> Dictionary:
	var resolved := _resolve_scene_node(parent_path)
	if not resolved.ok:
		return {"_error": resolved.error}
	var root: Node = resolved.root
	var parent: Node = resolved.node
	if StringName(node_class) not in ALLOWED_NODE_CLASSES:
		return {"_error": "node_class_not_allowed: %s" % node_class}
	if node_name.is_empty() or node_name.validate_node_name() != node_name:
		return {"_error": "invalid_node_name"}
	if parent.has_node(NodePath(node_name)):
		return {"_error": "node_name_already_exists: %s" % node_name}
	var instance = ClassDB.instantiate(StringName(node_class))
	if not instance is Node:
		return {"_error": "cannot_instantiate_node: %s" % node_class}
	var node := instance as Node
	node.name = node_name
	var manager := plugin.get_undo_redo()
	manager.create_action("Flight Deck: Create %s" % node_name, UndoRedo.MERGE_DISABLE, root, false, true)
	manager.add_do_method(parent, &"add_child", node)
	manager.add_do_method(node, &"set_owner", root)
	manager.add_do_reference(node)
	manager.add_undo_method(parent, &"remove_child", node)
	manager.commit_action()
	EditorInterface.mark_scene_as_unsaved()
	last_history_id = manager.get_object_history_id(root)
	return {
		"created": true,
		"path": str(root.get_path_to(node)),
		"parent": parent_path,
		"class": node_class,
		"name": node.name,
		"undo_registered": true,
	}

func _delete_node(path: String) -> Dictionary:
	var resolved := _resolve_scene_node(path)
	if not resolved.ok:
		return {"_error": resolved.error}
	var root: Node = resolved.root
	var node: Node = resolved.node
	if node == root:
		return {"_error": "cannot_delete_scene_root"}
	var parent := node.get_parent()
	var old_index := node.get_index()
	var old_owner := node.owner
	var manager := plugin.get_undo_redo()
	manager.create_action("Flight Deck: Delete %s" % path, UndoRedo.MERGE_DISABLE, root, false, true)
	manager.add_do_method(parent, &"remove_child", node)
	manager.add_undo_method(parent, &"add_child", node)
	manager.add_undo_method(parent, &"move_child", node, old_index)
	manager.add_undo_method(node, &"set_owner", old_owner)
	manager.add_undo_reference(node)
	manager.commit_action()
	EditorInterface.mark_scene_as_unsaved()
	last_history_id = manager.get_object_history_id(root)
	return {"deleted": true, "path": path, "old_index": old_index, "undo_registered": true}

func _reorder_node(path: String, requested_index: int) -> Dictionary:
	var resolved := _resolve_scene_node(path)
	if not resolved.ok:
		return {"_error": resolved.error}
	var root: Node = resolved.root
	var node: Node = resolved.node
	if node == root:
		return {"_error": "cannot_reorder_scene_root"}
	var parent := node.get_parent()
	var old_index := node.get_index()
	var new_index := clampi(requested_index, 0, parent.get_child_count() - 1)
	if new_index == old_index:
		return {"_error": "node_already_at_index: %d" % new_index}
	var manager := plugin.get_undo_redo()
	manager.create_action("Flight Deck: Reorder %s" % path, UndoRedo.MERGE_DISABLE, root, false, true)
	manager.add_do_method(parent, &"move_child", node, new_index)
	manager.add_undo_method(parent, &"move_child", node, old_index)
	manager.commit_action()
	EditorInterface.mark_scene_as_unsaved()
	last_history_id = manager.get_object_history_id(root)
	return {"reordered": true, "path": path, "old_index": old_index, "index": node.get_index(), "undo_registered": true}

func _set_property(path: String, property_name: String, requested_value: Variant) -> Dictionary:
	var resolved := _resolve_scene_node(path)
	if not resolved.ok:
		return {"_error": resolved.error}
	var root: Node = resolved.root
	var node: Node = resolved.node
	if property_name.is_empty() or property_name in ["script", "owner", "scene_file_path"]:
		return {"_error": "property_not_writable: %s" % property_name}
	var property_info: Dictionary = {}
	for info in node.get_property_list():
		if str(info.get("name", "")) == property_name:
			property_info = info
			break
	if property_info.is_empty():
		return {"_error": "property_not_found: %s" % property_name}
	var usage := int(property_info.get("usage", 0))
	if (usage & PROPERTY_USAGE_EDITOR) == 0 or (usage & PROPERTY_USAGE_READ_ONLY) != 0:
		return {"_error": "property_not_writable: %s" % property_name}
	var converted := _convert_property_value(requested_value, property_info)
	if not converted.ok:
		return {"_error": converted.error}
	var old_value = node.get(property_name)
	var manager := plugin.get_undo_redo()
	manager.create_action("Flight Deck: Set %s.%s" % [path, property_name], UndoRedo.MERGE_DISABLE, root, false, true)
	manager.add_do_property(node, StringName(property_name), converted.value)
	manager.add_undo_property(node, StringName(property_name), old_value)
	manager.commit_action()
	EditorInterface.mark_scene_as_unsaved()
	last_history_id = manager.get_object_history_id(root)
	return {
		"path": path,
		"property": property_name,
		"type": type_string(int(property_info.get("type", TYPE_NIL))),
		"old_value": _json_value(old_value, 0),
		"value": _json_value(node.get(property_name), 0),
		"undo_registered": true,
	}

func _convert_property_value(value: Variant, info: Dictionary) -> Dictionary:
	var expected := int(info.get("type", TYPE_NIL))
	match expected:
		TYPE_BOOL:
			if value is bool: return {"ok": true, "value": value}
		TYPE_INT:
			if value is int or value is float:
				var converted := int(value)
				if int(info.get("hint", PROPERTY_HINT_NONE)) == PROPERTY_HINT_ENUM:
					var allowed: Array[int] = []
					var entries := str(info.get("hint_string", "")).split(",")
					for index in range(entries.size()):
						var parts := entries[index].split(":")
						allowed.append(int(parts[1]) if parts.size() > 1 else index)
					if converted not in allowed:
						return {"ok": false, "error": "enum_value_out_of_range"}
				return {"ok": true, "value": converted}
		TYPE_FLOAT:
			if value is int or value is float: return {"ok": true, "value": float(value)}
		TYPE_STRING:
			if value is String: return {"ok": true, "value": value}
		TYPE_STRING_NAME:
			if value is String: return {"ok": true, "value": StringName(value)}
		TYPE_NODE_PATH:
			if value is String:
				var path_validation := _valid_node_path(value)
				if path_validation.ok:
					return {"ok": true, "value": NodePath(value)}
				return {"ok": false, "error": path_validation.error}
		TYPE_VECTOR2:
			if value is Array and value.size() == 2 and _all_numbers(value): return {"ok": true, "value": Vector2(float(value[0]), float(value[1]))}
			if value is Dictionary and value.has("x") and value.has("y") and _is_number(value.x) and _is_number(value.y): return {"ok": true, "value": Vector2(float(value.x), float(value.y))}
		TYPE_VECTOR2I:
			if value is Array and value.size() == 2 and _all_numbers(value): return {"ok": true, "value": Vector2i(int(value[0]), int(value[1]))}
			if value is Dictionary and value.has("x") and value.has("y") and _is_number(value.x) and _is_number(value.y): return {"ok": true, "value": Vector2i(int(value.x), int(value.y))}
		TYPE_COLOR:
			if value is String:
				var sentinel := Color(2.0, 2.0, 2.0, 2.0)
				var color := Color.from_string(value, sentinel)
				if color != sentinel: return {"ok": true, "value": color}
			if value is Array and value.size() in [3, 4] and _all_numbers(value):
				return {"ok": true, "value": Color(float(value[0]), float(value[1]), float(value[2]), float(value[3]) if value.size() == 4 else 1.0)}
		TYPE_RECT2:
			if value is Array and value.size() == 4 and _all_numbers(value): return {"ok": true, "value": Rect2(float(value[0]), float(value[1]), float(value[2]), float(value[3]))}
	return {"ok": false, "error": "type_mismatch: expected %s" % type_string(expected)}

func _is_number(value: Variant) -> bool:
	return value is int or value is float

func _all_numbers(values: Array) -> bool:
	for value in values:
		if not _is_number(value):
			return false
	return true

func _last_history():
	if last_history_id < 0:
		return null
	return plugin.get_undo_redo().get_history_undo_redo(last_history_id)

func _undo() -> Dictionary:
	var history = _last_history()
	if history == null or not history.has_undo():
		return {"_error": "nothing_to_undo"}
	var action := history.get_current_action_name()
	history_operation_error = ""
	history.undo()
	if not history_operation_error.is_empty():
		var failure := history_operation_error
		history_operation_error = ""
		if history.has_redo():
			history.redo()
		var recovery_failure := history_operation_error
		history_operation_error = ""
		return {"_error": "undo_failed: %s%s" % [failure, "" if recovery_failure.is_empty() else "; recovery_failed: %s" % recovery_failure]}
	return {"action": action, "undone": true, "can_redo": history.has_redo()}

func _redo() -> Dictionary:
	var history = _last_history()
	if history == null or not history.has_redo():
		return {"_error": "nothing_to_redo"}
	history_operation_error = ""
	history.redo()
	if not history_operation_error.is_empty():
		var failure := history_operation_error
		history_operation_error = ""
		if history.has_undo():
			history.undo()
		var recovery_failure := history_operation_error
		history_operation_error = ""
		return {"_error": "redo_failed: %s%s" % [failure, "" if recovery_failure.is_empty() else "; recovery_failed: %s" % recovery_failure]}
	return {"redone": true, "can_undo": history.has_undo()}

func _save_scene() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"_error": "no_edited_scene"}
	var error := EditorInterface.save_scene()
	if error != OK:
		return {"_error": "save_failed: %d" % error}
	return {"saved": true, "scene": root.scene_file_path}

func _json_value(value: Variant, depth: int) -> Variant:
	if depth > 3:
		return "<max depth>"
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(value)
		TYPE_ARRAY:
			var output: Array = []
			for index in range(mini(value.size(), 50)):
				output.append(_json_value(value[index], depth + 1))
			return output
		TYPE_DICTIONARY:
			var output := {}
			var count := 0
			for key in value:
				if count >= 50:
					break
				output[str(key)] = _json_value(value[key], depth + 1)
				count += 1
			return output
		TYPE_OBJECT:
			if value == null:
				return null
			if value is Resource and not value.resource_path.is_empty():
				return value.resource_path
			return "<%s>" % value.get_class()
		_:
			return str(value)

func _logs(limit: int) -> Dictionary:
	var path := ProjectSettings.globalize_path("user://logs/godot.log")
	var lines: Array[String] = []
	var file := FileAccess.open(path, FileAccess.READ)
	if file:
		var all_lines := file.get_as_text().split("\n")
		var start := maxi(0, all_lines.size() - limit)
		for index in range(start, all_lines.size()):
			lines.append(all_lines[index])
	return {
		"path": path,
		"modified_unix": FileAccess.get_modified_time(path) if FileAccess.file_exists(path) else 0,
		"lines": lines,
		"bridge_events": event_log.duplicate(),
	}

func _record(message: String) -> void:
	var line := "%s %s" % [Time.get_datetime_string_from_system(), message]
	event_log.append(line)
	if event_log.size() > 100:
		event_log.pop_front()
	print("Flight Deck: %s" % message)
