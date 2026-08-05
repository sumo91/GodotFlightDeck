class_name FlightDeckScenarioRunner
extends RefCounted

var scenario_path := ""
var scenario: Dictionary = {}
var steps: Array = []
var assertions: Array = []
var current_step := 0
var step_frame := 0
var step_event_offset := 0
var preserve_event_offset_for_next_wait := false
var status := "idle"
var failure := ""
var failure_kind := "none"
var failure_details: Dictionary = {}
var assertion_results: Array[Dictionary] = []
var active_actions: Dictionary = {}
var trace_events := false

func load_file(path: String) -> bool:
	scenario_path = path
	if not FileAccess.file_exists(path):
		_fail("Scenario file not found: %s" % path)
		return false
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		_fail("Cannot read scenario: %s" % path)
		return false
	var parsed = JSON.parse_string(file.get_as_text())
	if not parsed is Dictionary:
		_fail("Scenario must be a JSON object: %s" % path)
		return false
	scenario = parsed
	steps = scenario.get("steps", [])
	assertions = scenario.get("assertions", [])
	trace_events = bool(scenario.get("traceEvents", false)) or OS.get_environment("GDECK_TRACE_EVENTS") == "1"
	if not steps is Array or steps.is_empty():
		_fail("Scenario has no steps: %s" % path)
		return false
	if not assertions is Array:
		_fail("Scenario assertions must be an array")
		return false
	status = "running"
	return true

func tick(probe: Node) -> void:
	if status != "running":
		return
	if current_step >= steps.size():
		_evaluate_assertions(probe)
		return
	var step = steps[current_step]
	if not step is Dictionary:
		_fail("Step %d must be an object" % current_step)
		return
	if step_frame == 0:
		_begin_step_window(probe, step)
		probe.event("scenario_step_started", {"index": current_step, "step": step})

	if step.has("wait_frames"):
		step_frame += 1
		if step_frame >= maxi(1, int(step.wait_frames)):
			_complete_step(probe)
		return

	if step.has("press") or step.has("hold"):
		var action_name := str(step.get("press", step.get("hold", "")))
		var duration := maxi(1, int(step.get("frames", 2)))
		if step_frame == 0:
			_press_action(action_name)
		step_frame += 1
		if step_frame >= duration:
			_release_action(action_name)
			_complete_step(probe)
		return

	if step.has("move_mouse"):
		var coordinates = step.move_mouse
		if not coordinates is Array or coordinates.size() < 2:
			_fail("Step %d move_mouse must be [x, y]" % current_step)
			return
		var position := Vector2(float(coordinates[0]), float(coordinates[1]))
		Input.warp_mouse(position)
		var motion := InputEventMouseMotion.new()
		motion.position = position
		motion.global_position = position
		Input.parse_input_event(motion)
		_complete_step(probe)
		return

	if step.has("scroll"):
		var scroll_coordinates = step.scroll
		if not scroll_coordinates is Array or scroll_coordinates.size() < 2:
			_fail("Step %d scroll must be [x, y]" % current_step)
			return
		var scroll_position := Vector2(float(scroll_coordinates[0]), float(scroll_coordinates[1]))
		var factor := float(step.get("factor", 1.0))
		var repeat := maxi(1, int(step.get("frames", 1)))
		if step_frame == 0:
			_scroll_at(scroll_position, factor)
		step_frame += 1
		if step_frame >= repeat:
			_complete_step(probe)
		return

	if step.has("drag"):
		var drag_points = step.drag
		if not drag_points is Array or drag_points.size() < 2:
			_fail("Step %d drag must be [[x1, y1], [x2, y2], ...]" % current_step)
			return
		var drag_frames := maxi(2, int(step.get("frames", 12)))
		var drag_from := Vector2(float(drag_points[0][0]), float(drag_points[0][1]))
		var drag_to := Vector2(float(drag_points[-1][0]), float(drag_points[-1][1]))
		if step_frame == 0:
			_press_mouse_at(drag_from)
		elif step_frame >= drag_frames:
			_release_mouse()
			_complete_step(probe)
			return
		else:
			var drag_t := float(step_frame) / float(drag_frames - 1)
			_move_mouse_to(drag_from.lerp(drag_to, drag_t))
		step_frame += 1
		return

	if step.has("wait_event"):
		var event_name := str(step.wait_event)
		var where_value = step.get("where", {})
		if not where_value is Dictionary:
			_fail("Step %d wait_event where must be an object" % current_step)
			return
		var where: Dictionary = where_value
		var timeout := maxi(1, int(step.get("timeout_frames", 600)))
		var required_count := maxi(1, int(step.get("count_gte", 1)))
		var matches_in_window: int = probe.count_semantic_events(event_name, where, step_event_offset)
		if matches_in_window >= required_count:
			_complete_step(probe)
			return
		step_frame += 1
		if step_frame >= timeout:
			failure_details = {
				"kind": "wait_event_timeout",
				"step_index": current_step,
				"event": event_name,
				"where": where,
				"required_count": required_count,
				"matches_in_window": matches_in_window,
				"event_window_start": step_event_offset,
				"event_window_end": probe.semantic_events.size(),
				"prior_matches": probe.matching_semantic_events_before(event_name, where, step_event_offset),
			}
			if trace_events or bool(step.get("traceEvents", false)):
				failure_details["trace"] = _event_trace_summary(probe, event_name, where)
			_fail("Step %d timed out waiting for event '%s'" % [current_step, event_name], "expectation")
		return

	if step.has("command"):
		probe.issue_command(str(step.command), step.get("payload", {}))
		_complete_step(probe)
		return

	_fail("Unsupported scenario step %d: %s" % [current_step, JSON.stringify(step)])

func abort(reason: String) -> void:
	_release_all_actions()
	_fail(reason, "expectation")

func result() -> Dictionary:
	return {
		"name": scenario.get("name", scenario_path.get_file().get_basename()),
		"path": scenario_path,
		"status": status,
		"steps_completed": current_step,
		"steps_total": steps.size(),
		"failure": failure,
		"failure_kind": failure_kind,
		"failure_details": failure_details,
		"assertions": assertion_results,
		"trace_events": trace_events,
	}

func _begin_step_window(probe: Node, step: Dictionary) -> void:
	var include_history := bool(step.get("includeHistory", false)) or bool(step.get("include_history", false))
	var since_value := str(step.get("since", ""))
	if step.has("wait_event") and include_history:
		step_event_offset = 0
		preserve_event_offset_for_next_wait = false
		return
	if step.has("wait_event") and since_value == "command":
		var command_index := _last_scenario_command_index(probe)
		step_event_offset = command_index + 1 if command_index >= 0 else probe.semantic_events.size()
		preserve_event_offset_for_next_wait = false
		return
	if current_step == 0 and step.has("wait_event"):
		step_event_offset = 0
	elif not step.has("wait_event") or not preserve_event_offset_for_next_wait:
		step_event_offset = probe.semantic_events.size()
	preserve_event_offset_for_next_wait = false

func _last_scenario_command_index(probe: Node) -> int:
	for index in range(probe.semantic_events.size() - 1, -1, -1):
		var candidate: Dictionary = probe.semantic_events[index]
		if str(candidate.get("name", "")) == "scenario_command":
			return index
	return -1

func _event_trace_summary(probe: Node, event_name: String, where: Dictionary) -> Dictionary:
	var recent: Array = []
	var start := maxi(0, probe.semantic_events.size() - 12)
	for index in range(start, probe.semantic_events.size()):
		var candidate: Dictionary = probe.semantic_events[index]
		recent.append({
			"index": index,
			"name": candidate.get("name", ""),
			"frame": candidate.get("frame", -1),
		})
	return {
		"offset": step_event_offset,
		"total_events": probe.semantic_events.size(),
		"matches_in_window": probe.count_semantic_events(event_name, where, step_event_offset),
		"prior_matches": probe.matching_semantic_events_before(event_name, where, step_event_offset),
		"recent_events": recent,
	}

func _complete_step(probe: Node) -> void:
	var completed_step = steps[current_step]
	probe.event("scenario_step_completed", {"index": current_step})
	preserve_event_offset_for_next_wait = completed_step is Dictionary and not completed_step.has("wait_event")
	current_step += 1
	step_frame = 0
	if not preserve_event_offset_for_next_wait:
		step_event_offset = probe.semantic_events.size()

func _evaluate_assertions(probe: Node) -> void:
	assertion_results.clear()
	var all_passed := true
	var invalid_definition := false
	for assertion_index in range(assertions.size()):
		var assertion = assertions[assertion_index]
		if not assertion is Dictionary:
			assertion_results.append({"index": assertion_index, "passed": false, "reason": "Assertion must be an object", "failure_kind": "precondition"})
			all_passed = false
			invalid_definition = true
			continue
		var event_name := str(assertion.get("event", ""))
		var where_value = assertion.get("where", {})
		if not where_value is Dictionary:
			assertion_results.append({"index": assertion_index, "passed": false, "reason": "Assertion where must be an object", "failure_kind": "precondition"})
			all_passed = false
			invalid_definition = true
			continue
		var where: Dictionary = where_value
		var minimum := int(assertion.get("count_gte", 1))
		var maximum := int(assertion.get("count_lte", 2147483647))
		var count: int = int(probe.count_semantic_events(event_name, where))
		var valid_definition: bool = not event_name.is_empty() and minimum <= maximum
		var passed: bool = valid_definition and count >= minimum and count <= maximum
		if not valid_definition:
			invalid_definition = true
		var reason := "event '%s' count %d, expected %d..%d" % [event_name, count, minimum, maximum]
		assertion_results.append({
			"index": assertion_index,
			"passed": passed,
			"failure_kind": "expectation" if valid_definition else "precondition",
			"event": event_name,
			"where": where,
			"count": count,
			"expected_count_gte": minimum,
			"expected_count_lte": maximum,
			"reason": reason,
		})
		if not passed:
			all_passed = false
	_release_all_actions()
	status = "passed" if all_passed else "failed"
	if not all_passed:
		failure_kind = "precondition" if invalid_definition else "expectation"
		failure = "One or more scenario assertions failed"

func _press_action(action_name: String) -> void:
	if action_name.is_empty():
		_fail("Input action cannot be empty")
		return
	var input_event := InputEventAction.new()
	input_event.action = action_name
	input_event.pressed = true
	input_event.strength = 1.0
	Input.parse_input_event(input_event)
	active_actions[action_name] = true

func _release_action(action_name: String) -> void:
	if action_name.is_empty():
		return
	var input_event := InputEventAction.new()
	input_event.action = action_name
	input_event.pressed = false
	input_event.strength = 0.0
	Input.parse_input_event(input_event)
	active_actions.erase(action_name)

func _move_mouse_to(position: Vector2) -> void:
	var motion := InputEventMouseMotion.new()
	motion.position = position
	motion.global_position = position
	Input.parse_input_event(motion)

func _press_mouse_at(position: Vector2) -> void:
	Input.warp_mouse(position)
	var button := InputEventMouseButton.new()
	button.button_index = MOUSE_BUTTON_LEFT
	button.pressed = true
	button.position = position
	button.global_position = position
	Input.parse_input_event(button)

func _release_mouse() -> void:
	var button := InputEventMouseButton.new()
	button.button_index = MOUSE_BUTTON_LEFT
	button.pressed = false
	Input.parse_input_event(button)

func _scroll_at(position: Vector2, factor: float) -> void:
	Input.warp_mouse(position)
	var button := InputEventMouseButton.new()
	button.button_index = MOUSE_BUTTON_WHEEL_UP if factor >= 0.0 else MOUSE_BUTTON_WHEEL_DOWN
	button.pressed = true
	button.factor = absf(factor)
	button.position = position
	button.global_position = position
	Input.parse_input_event(button)
	var release := InputEventMouseButton.new()
	release.button_index = button.button_index
	release.pressed = false
	release.position = position
	release.global_position = position
	Input.parse_input_event(release)

func _release_all_actions() -> void:
	for action_name in active_actions.keys():
		_release_action(str(action_name))
	active_actions.clear()

func _fail(reason: String, kind: String = "precondition") -> void:
	_release_all_actions()
	status = "failed"
	failure = reason
	failure_kind = kind
