extends Node

## Runtime probe installed as an autoload by `gdeck init`.
## It only responds to explicit --gdeck-* command-line arguments.

signal command_requested(command_name: String, payload: Dictionary)

const VERSION := "1.6.3-cursor.2"
const DIAGNOSTIC_EVENT_LIMIT := 10
const DIAGNOSTIC_COLLECTION_LIMIT := 16
const DIAGNOSTIC_STRING_LIMIT := 256
const DIAGNOSTIC_DEPTH_LIMIT := 4
const PERFORMANCE_TIMING_SAMPLE_LIMIT := 32
const PERFORMANCE_SLOWEST_FRAME_LIMIT := 8
const QUERY_TREE_NODE_LIMIT := 200

var target_frames := -1
var random_seed_value := 42
var current_frame := 0
var capture_path := ""
var report_path := ""
var scenario_path := ""
var query_json := ""
var fixture_adapter_path := ""
var fixture_adapter_capability := ""
var fixture_adapter: Node
var benchmark_enabled := false
var benchmark_warmup_frames := 0
var finishing := false
var exit_code := 0
var frame_ms_sum := 0.0
var process_ms_sum := 0.0
var physics_ms_sum := 0.0
var worst_frame_ms := 0.0
var worst_process_ms := 0.0
var last_process_usec := 0
var last_monitor_process_ms := -1.0
var sample_count := 0
var performance_timing_samples: Array[Dictionary] = []
var performance_slowest_frames: Array[Dictionary] = []
var semantic_events: Array[Dictionary] = []
var scenario_runner: FlightDeckScenarioRunner
var query_definitions: Array[Dictionary] = []
var query_results: Array[Dictionary] = []

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_parse_arguments(OS.get_cmdline_user_args())
	_parse_query_definitions()
	if target_frames < 0:
		set_process(false)
		return
	if not scenario_path.is_empty():
		scenario_runner = FlightDeckScenarioRunner.new()
		if not scenario_runner.load_file(scenario_path):
			exit_code = 3
			finishing = true
			_finish_run.call_deferred()
			return
	if not fixture_adapter_path.is_empty() and not _load_fixture_adapter():
		exit_code = 3
		finishing = true
		_finish_run.call_deferred()
		return
	print("GDECK_READY version=%s frames=%d" % [VERSION, target_frames])

func _process(delta: float) -> void:
	if target_frames < 0 or finishing:
		return
	current_frame += 1
	var now_usec := Time.get_ticks_usec()
	var frame_ms := 0.0
	if last_process_usec > 0:
		frame_ms = float(now_usec - last_process_usec) / 1000.0
	last_process_usec = now_usec
	var sampling_starts_after := benchmark_warmup_frames if benchmark_enabled else 5
	# Warmup may be zero; require a prior _process tick so frame_ms is a real interval.
	if current_frame > sampling_starts_after and last_process_usec > 0 and frame_ms > 0.0:
		_sample_performance(delta, frame_ms)
	if scenario_runner != null:
		scenario_runner.tick(self)
		if scenario_runner.status == "passed":
			event("scenario_completed", {"status": "passed"})
			finishing = true
			_finish_run.call_deferred()
			return
		if scenario_runner.status == "failed":
			event("scenario_completed", {"status": "failed", "reason": scenario_runner.failure})
			exit_code = 3
			finishing = true
			_finish_run.call_deferred()
			return
	if current_frame >= target_frames:
		if scenario_runner != null and scenario_runner.status == "running":
			scenario_runner.abort("Scenario exceeded global timeout of %d frames" % target_frames)
			exit_code = 3
		finishing = true
		_finish_run.call_deferred()

## Games may call FlightDeckProbe.event("quota_completed", {"ore": 80}).
func event(event_name: String, payload: Dictionary = {}) -> void:
	if not is_active():
		return
	semantic_events.append({
		"name": event_name,
		"frame": current_frame,
		"payload": payload,
	})
	print("GDECK_EVENT %s %s" % [event_name, JSON.stringify(payload)])

func is_active() -> bool:
	return target_frames >= 0

func run_seed() -> int:
	return random_seed_value

func issue_command(command_name: String, payload: Dictionary = {}) -> void:
	event("scenario_command", {"command": command_name, "payload": payload})
	command_requested.emit(command_name, payload)

func find_semantic_event(event_name: String, where: Dictionary = {}, from_index: int = 0) -> int:
	for index in range(maxi(0, from_index), semantic_events.size()):
		var candidate := semantic_events[index]
		if str(candidate.get("name", "")) != event_name:
			continue
		if _payload_matches(candidate.get("payload", {}), where):
			return index
	return -1

func count_semantic_events(event_name: String, where: Dictionary = {}, from_index: int = 0) -> int:
	var count := 0
	for index in range(maxi(0, from_index), semantic_events.size()):
		var candidate := semantic_events[index]
		if str(candidate.get("name", "")) == event_name and _payload_matches(candidate.get("payload", {}), where):
			count += 1
	return count

func matching_semantic_events_before(event_name: String, where: Dictionary, before_index: int) -> Dictionary:
	var matches: Array = []
	var total := 0
	var end_index := clampi(before_index, 0, semantic_events.size())
	for index in range(end_index):
		var candidate := semantic_events[index]
		if str(candidate.get("name", "")) != event_name or not _payload_matches(candidate.get("payload", {}), where):
			continue
		total += 1
		if matches.size() < DIAGNOSTIC_EVENT_LIMIT:
			matches.append({
				"event_index": index,
				"name": str(candidate.get("name", "")),
				"frame": int(candidate.get("frame", 0)),
				"payload": _bounded_diagnostic_value(candidate.get("payload", {})),
			})
	return {
		"total": total,
		"events": matches,
		"limit": DIAGNOSTIC_EVENT_LIMIT,
		"truncated": total > matches.size(),
	}

func _bounded_diagnostic_value(value: Variant, depth: int = 0) -> Variant:
	if value is String:
		if value.length() <= DIAGNOSTIC_STRING_LIMIT:
			return value
		return {
			"value": value.left(DIAGNOSTIC_STRING_LIMIT),
			"original_length": value.length(),
			"truncated": true,
		}
	if value is Dictionary:
		var dictionary_value: Dictionary = value
		if depth >= DIAGNOSTIC_DEPTH_LIMIT:
			return {"truncated": true, "original_type": "Dictionary", "original_size": dictionary_value.size()}
		var bounded_dictionary := {}
		var keys: Array = dictionary_value.keys()
		for index in range(mini(keys.size(), DIAGNOSTIC_COLLECTION_LIMIT)):
			var key = keys[index]
			bounded_dictionary[str(key)] = _bounded_diagnostic_value(dictionary_value[key], depth + 1)
		if keys.size() > DIAGNOSTIC_COLLECTION_LIMIT:
			bounded_dictionary["_gdeck_truncated_entries"] = keys.size() - DIAGNOSTIC_COLLECTION_LIMIT
		return bounded_dictionary
	if value is Array:
		var array_value: Array = value
		if depth >= DIAGNOSTIC_DEPTH_LIMIT:
			return [{"truncated": true, "original_type": "Array", "original_size": array_value.size()}]
		var bounded_array := []
		for index in range(mini(array_value.size(), DIAGNOSTIC_COLLECTION_LIMIT)):
			bounded_array.append(_bounded_diagnostic_value(array_value[index], depth + 1))
		if array_value.size() > DIAGNOSTIC_COLLECTION_LIMIT:
			bounded_array.append({"truncated_items": array_value.size() - DIAGNOSTIC_COLLECTION_LIMIT})
		return bounded_array
	return value

func _payload_matches(payload: Dictionary, where: Dictionary) -> bool:
	for key in where:
		if not payload.has(key) or payload[key] != where[key]:
			return false
	return true

func _parse_arguments(args: PackedStringArray) -> void:
	for argument in args:
		if argument.begins_with("--gdeck-capture="):
			capture_path = argument.trim_prefix("--gdeck-capture=")
		elif argument.begins_with("--gdeck-report="):
			report_path = argument.trim_prefix("--gdeck-report=")
		elif argument.begins_with("--gdeck-scenario="):
			scenario_path = argument.trim_prefix("--gdeck-scenario=")
		elif argument.begins_with("--gdeck-query="):
			query_json = argument.trim_prefix("--gdeck-query=")
		elif argument.begins_with("--gdeck-fixture-adapter="):
			fixture_adapter_path = argument.trim_prefix("--gdeck-fixture-adapter=")
		elif argument.begins_with("--gdeck-fixture-capability="):
			fixture_adapter_capability = argument.trim_prefix("--gdeck-fixture-capability=")
		elif argument.begins_with("--gdeck-after-frames="):
			target_frames = maxi(1, int(argument.trim_prefix("--gdeck-after-frames=")))
		elif argument.begins_with("--gdeck-seed="):
			random_seed_value = int(argument.trim_prefix("--gdeck-seed="))
			seed(random_seed_value)
		elif argument.begins_with("--gdeck-warmup-frames="):
			benchmark_warmup_frames = maxi(0, int(argument.trim_prefix("--gdeck-warmup-frames=")))
		elif argument == "--gdeck-benchmark":
			benchmark_enabled = true
	if (not capture_path.is_empty() or not report_path.is_empty() or not scenario_path.is_empty() or not query_json.is_empty()) and target_frames < 0:
		target_frames = 30

func _parse_query_definitions() -> void:
	if query_json.is_empty():
		return
	var parsed: Variant = JSON.parse_string(query_json)
	if not parsed is Array:
		push_error("Flight Deck query must be a JSON array of query definitions")
		exit_code = 3
		finishing = true
		_finish_run.call_deferred()
		return
	for entry: Variant in parsed:
		if not entry is Dictionary:
			continue
		var kind := str(entry.get("type", ""))
		if kind not in ["property", "tree", "signals", "group"]:
			push_error("Flight Deck query type must be property/tree/signals/group, got: %s" % kind)
			exit_code = 3
			finishing = true
			_finish_run.call_deferred()
			return
		query_definitions.append(entry)

func _resolve_query_node(definition: Dictionary) -> Node:
	var path := str(definition.get("path", ""))
	if path.is_empty():
		return null
	var tree_root := get_tree().root
	var node := tree_root.get_node_or_null(NodePath(path))
	if node == null and path.begins_with("/root"):
		node = tree_root.get_node_or_null(NodePath(path.trim_prefix("/root")))
	if node == null:
		var scene := get_tree().current_scene
		if scene != null:
			node = scene.get_node_or_null(NodePath(path.trim_prefix("/")))
	return node

func _collect_queries() -> void:
	for definition in query_definitions:
		var definition_value: Dictionary = definition
		var kind := str(definition_value.get("type", ""))
		var result := {"id": str(definition_value.get("id", "query-%d" % query_results.size())), "type": kind, "ok": true}
		var query_result := {}
		match kind:
			"property":
				query_result = _query_property(definition_value)
			"tree":
				query_result = _query_tree(definition_value)
			"signals":
				query_result = _query_signals(definition_value)
			"group":
				query_result = _query_group(definition_value)
		result["result"] = query_result
		if not bool(query_result.get("ok", true)):
			result["ok"] = false
			result.erase("result")
		query_results.append(result)

func _query_property(definition: Dictionary) -> Dictionary:
	var node := _resolve_query_node(definition)
	if node == null:
		return {"ok": false, "error": "node not found: %s" % str(definition.get("path", ""))}
	var property := str(definition.get("property", ""))
	var has_property := false
	if not property.is_empty():
		for property_entry in node.get_property_list():
			if property_entry is Dictionary and str(property_entry.get("name", "")) == property:
				has_property = true
				break
	if not has_property:
		return {"ok": false, "error": "property not found: %s" % property}
	return {"ok": true, "path": node.get_path().get_concatenated_names(), "property": property, "value": _bounded_diagnostic_value(node.get(property))}

func _query_tree(definition: Dictionary) -> Dictionary:
	var node := _resolve_query_node(definition)
	if node == null:
		return {"ok": false, "error": "node not found: %s" % str(definition.get("path", ""))}
	var max_depth := maxi(1, int(definition.get("max_depth", 3)))
	var nodes: Array[Dictionary] = []
	var pending: Array = [{"node": node, "depth": 0}]
	while not pending.is_empty():
		var entry: Dictionary = pending.pop_front()
		var current: Node = entry["node"]
		var depth := int(entry["depth"])
		var children: Array[Node] = current.get_children()
		nodes.append({
			"name": current.name,
			"type": current.get_class(),
			"depth": depth,
			"child_count": children.size(),
		})
		if nodes.size() >= QUERY_TREE_NODE_LIMIT:
			break
		if depth >= max_depth:
			continue
		for child in children:
			pending.append({"node": child, "depth": depth + 1})
	return {"ok": true, "path": node.get_path().get_concatenated_names(), "nodes": nodes, "truncated": nodes.size() >= QUERY_TREE_NODE_LIMIT}

func _query_signals(definition: Dictionary) -> Dictionary:
	var node := _resolve_query_node(definition)
	if node == null:
		return {"ok": false, "error": "node not found: %s" % str(definition.get("path", ""))}
	var signal_names: Array[String] = []
	for signal_def in node.get_signal_list():
		if signal_def is Dictionary:
			signal_names.append(str(signal_def.get("name", "")))
		if signal_names.size() >= DIAGNOSTIC_COLLECTION_LIMIT:
			break
	var connections: Array = []
	for signal_name in signal_names:
		for connection in node.get_signal_connection_list(StringName(signal_name)):
			var callable: Callable = connection.get("callable", Callable())
			var target := callable.get_object()
			connections.append({
				"signal": signal_name,
				"target": callable.get_method() if target != null else "(builtin)",
				"target_node": target.get_path().get_concatenated_names() if target is Node else "",
			})
	return {"ok": true, "path": node.get_path().get_concatenated_names(), "signals": signal_names, "connections": connections}

func _query_group(definition: Dictionary) -> Dictionary:
	var group_name := str(definition.get("name", ""))
	if group_name.is_empty():
		return {"ok": false, "error": "group name required"}
	var members: Array = []
	for member in get_tree().get_nodes_in_group(group_name):
		if member is Node:
			members.append(member.get_path().get_concatenated_names())
		if members.size() >= QUERY_TREE_NODE_LIMIT:
			break
	return {"ok": true, "group": group_name, "members": members, "count": members.size()}

func _load_fixture_adapter() -> bool:
	var expected_capability := OS.get_environment("GDECK_FIXTURE_CAPABILITY")
	if fixture_adapter_capability.length() != 64 or expected_capability.length() != 64 or fixture_adapter_capability != expected_capability:
		push_error("Flight Deck fixture adapter capability is missing or invalid; adapters only run through an isolated test profile")
		return false
	if not _fixture_adapter_path_is_safe(fixture_adapter_path):
		push_error("Flight Deck fixture adapter must be a non-symlink res://tests/ or res://qa/ .gd file: %s" % fixture_adapter_path)
		return false
	var script := load(fixture_adapter_path)
	if not script is GDScript or not script.can_instantiate():
		push_error("Flight Deck fixture adapter is not an instantiable GDScript: %s" % fixture_adapter_path)
		return false
	var candidate = script.new()
	if not candidate is Node:
		if candidate != null and candidate.has_method("free"):
			candidate.free()
		push_error("Flight Deck fixture adapter must extend Node: %s" % fixture_adapter_path)
		return false
	fixture_adapter = candidate
	add_child(fixture_adapter)
	if fixture_adapter.has_method("gdeck_setup"):
		fixture_adapter.call("gdeck_setup", self)
	return true

func _fixture_adapter_path_is_safe(path: String) -> bool:
	if not path.ends_with(".gd") or "\\" in path:
		return false
	var relative_path := path.trim_prefix("res://")
	if relative_path == path:
		return false
	var components := relative_path.split("/", false)
	if components.size() < 2 or (components[0] != "tests" and components[0] != "qa"):
		return false
	for component in components:
		if component.is_empty() or component == "." or component == "..":
			return false
	var project_directory := DirAccess.open("res://")
	if project_directory == null:
		return false
	var current := ""
	for component in components:
		current = current.path_join(component)
		if project_directory.is_link(current):
			return false
	return FileAccess.file_exists(path)

func _sample_performance(_delta: float, frame_ms: float) -> void:
	# TIME_PROCESS is a Godot monitor average, not a real per-frame wall-clock sample.
	var process_ms := float(Performance.get_monitor(Performance.TIME_PROCESS)) * 1000.0
	var physics_ms := float(Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS)) * 1000.0
	var monitor_is_duplicate := last_monitor_process_ms >= 0.0 and is_equal_approx(process_ms, last_monitor_process_ms)
	last_monitor_process_ms = process_ms
	var fps := 1000.0 / maxf(frame_ms, 0.0001)
	frame_ms_sum += frame_ms
	process_ms_sum += process_ms
	physics_ms_sum += physics_ms
	worst_frame_ms = maxf(worst_frame_ms, frame_ms)
	if not monitor_is_duplicate:
		worst_process_ms = maxf(worst_process_ms, process_ms)
	sample_count += 1
	var expected_samples := maxi(1, target_frames - (benchmark_warmup_frames if benchmark_enabled else 5))
	var sample_stride := maxi(1, ceili(float(expected_samples) / float(PERFORMANCE_TIMING_SAMPLE_LIMIT)))
	if performance_timing_samples.size() < PERFORMANCE_TIMING_SAMPLE_LIMIT and ((sample_count - 1) % sample_stride == 0 or current_frame >= target_frames):
		performance_timing_samples.append(_performance_timing_fact(fps, frame_ms, process_ms, physics_ms))
	var replacement_index := performance_slowest_frames.size()
	if replacement_index >= PERFORMANCE_SLOWEST_FRAME_LIMIT:
		replacement_index = 0
		for index in range(1, performance_slowest_frames.size()):
			var current_weakest: Dictionary = performance_slowest_frames[replacement_index]
			var candidate_weakest: Dictionary = performance_slowest_frames[index]
			if float(candidate_weakest.frame_ms) < float(current_weakest.frame_ms) or (float(candidate_weakest.frame_ms) == float(current_weakest.frame_ms) and int(candidate_weakest.frame) > int(current_weakest.frame)):
				replacement_index = index
		var weakest: Dictionary = performance_slowest_frames[replacement_index]
		if frame_ms < float(weakest.frame_ms) or (frame_ms == float(weakest.frame_ms) and current_frame >= int(weakest.frame)):
			return
	var slow_fact := _performance_timing_fact(fps, frame_ms, process_ms, physics_ms)
	if performance_slowest_frames.size() < PERFORMANCE_SLOWEST_FRAME_LIMIT:
		performance_slowest_frames.append(slow_fact)
	else:
		performance_slowest_frames[replacement_index] = slow_fact

func _performance_timing_fact(fps: float, frame_ms: float, process_ms: float, physics_ms: float) -> Dictionary:
	return {
		"sample_index": sample_count - 1,
		"frame": current_frame,
		"fps": fps,
		"frame_ms": frame_ms,
		"process_ms": process_ms,
		"physics_ms": physics_ms,
	}

func _finish_run() -> void:
	await RenderingServer.frame_post_draw
	_collect_queries()
	var capture_error := OK
	if not capture_path.is_empty():
		DirAccess.make_dir_recursive_absolute(capture_path.get_base_dir())
		var image := get_viewport().get_texture().get_image()
		if image == null:
			capture_error = ERR_CANT_CREATE
		else:
			capture_error = image.save_png(capture_path)
		if capture_error == OK:
			print("GDECK_CAPTURED %s" % capture_path)
		else:
			push_error("Flight Deck could not save capture: %s" % capture_path)
			exit_code = 2
	if not report_path.is_empty():
		_write_report(capture_error)
	get_tree().quit(exit_code)

func _write_report(capture_error: Error) -> void:
	DirAccess.make_dir_recursive_absolute(report_path.get_base_dir())
	performance_slowest_frames.sort_custom(func(left: Dictionary, right: Dictionary) -> bool:
		if float(left.frame_ms) == float(right.frame_ms):
			return int(left.frame) < int(right.frame)
		return float(left.frame_ms) > float(right.frame_ms)
	)
	var divisor := maxf(1.0, sample_count)
	var average_frame_ms := frame_ms_sum / divisor
	var performance := {
		"average_frame_ms": average_frame_ms,
		"worst_frame_ms": worst_frame_ms,
		"average_fps": 1000.0 / maxf(average_frame_ms, 0.0001),
		"average_process_ms": process_ms_sum / divisor,
		"average_physics_ms": physics_ms_sum / divisor,
		# Compatibility: monitor-derived, not real per-frame wall-clock data.
		"worst_process_ms": worst_process_ms,
		"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		"nodes": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"objects": Performance.get_monitor(Performance.OBJECT_COUNT),
		"static_memory_bytes": Performance.get_monitor(Performance.MEMORY_STATIC),
		"active_2d_objects": Performance.get_monitor(Performance.PHYSICS_2D_ACTIVE_OBJECTS),
	}
	var report := {
		"schema_version": 3,
		"flight_deck_version": VERSION,
		"godot_version": Engine.get_version_info().get("string", "unknown"),
		"project": ProjectSettings.get_setting("application/config/name", "Unnamed"),
		"frames": sample_count if benchmark_enabled else current_frame,
		"total_frames": current_frame,
		"capture": capture_path,
		"capture_error": capture_error,
		"benchmark": benchmark_enabled,
		"benchmark_window": {
			"warmup_frames": benchmark_warmup_frames if benchmark_enabled else 5,
			"stable_frames": sample_count,
			"total_frames": current_frame,
		},
		"performance": performance,
		"stable_performance": performance.duplicate(true),
		"performance_timing": {
			"sample_limit": PERFORMANCE_TIMING_SAMPLE_LIMIT,
			"slowest_frame_limit": PERFORMANCE_SLOWEST_FRAME_LIMIT,
			"sample_count": sample_count,
			"frame_timing": "adjacent_process_wall_clock",
			"process_monitor_note": "TIME_PROCESS is not real-time per-frame data",
			"samples": performance_timing_samples,
			"samples_truncated": sample_count > performance_timing_samples.size(),
			"slowest_frames": performance_slowest_frames,
		},
		"memory_semantics": {
			"metric": "Performance.MEMORY_STATIC",
			"kind": "completion_snapshot",
			"is_process_rss": false,
			"is_peak_memory": false,
			"bytes_per_mebibyte": 1048576,
		},
		"events": semantic_events,
		"scenario": scenario_runner.result() if scenario_runner != null else null,
		"queries": {
			"schemaVersion": 1,
			"seed": random_seed_value,
			"frames": target_frames,
			"count": query_results.size(),
			"results": query_results,
		} if not query_json.is_empty() else null,
	}
	var file := FileAccess.open(report_path, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(report, "  "))
		print("GDECK_REPORTED %s" % report_path)
	else:
		push_error("Flight Deck could not write report: %s" % report_path)
