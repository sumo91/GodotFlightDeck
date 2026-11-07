extends "res://addons/flight_deck/test_case.gd"

class Probe extends "res://addons/flight_deck/runtime_probe.gd":
	var failure_scanned := 0
	func event(event_name: String, payload: Dictionary = {}) -> void:
		semantic_events.append({"name": event_name, "frame": current_frame, "payload": payload})
	func find_semantic_event(event_name: String, where: Dictionary = {}, from_index: int = 0) -> int:
		failure_scanned += maxi(0, semantic_events.size() - from_index)
		return super.find_semantic_event(event_name, where, from_index)

func _runner(test_steps: Array) -> FlightDeckScenarioRunner:
	var runner := FlightDeckScenarioRunner.new()
	runner.steps = test_steps
	runner.status = "running"
	return runner

func test_state_is_inactive_by_default_and_snapshots_payload() -> void:
	var probe := Probe.new()
	probe.state("menu", {"open": true})
	assert_true(probe.semantic_states.is_empty())
	probe.target_frames = 100
	var payload := {"nested": {"value": 1}}
	probe.state("menu", payload)
	payload.nested.value = 2
	assert_equal(probe.semantic_states.menu.payload.nested.value, 1)
	probe.state("menu", {"open": false})
	assert_equal(probe.semantic_states.size(), 1)
	assert_equal(probe.semantic_states.menu.payload, {"open": false})
	probe.free()

func test_wait_state_observes_current_snapshot_without_event_history() -> void:
	var probe := Probe.new()
	probe.target_frames = 100
	probe.state("menu", {"open": false})
	var runner := _runner([{"wait_state": "menu", "where": {"open": true}, "timeout_frames": 5}])
	runner.tick(probe)
	assert_equal(runner.current_step, 0)
	probe.state("menu", {"open": true})
	runner.tick(probe)
	runner.tick(probe)
	assert_equal(runner.status, "passed")
	probe.free()

func test_missing_state_cannot_satisfy_empty_where() -> void:
	var probe := Probe.new()
	var runner := _runner([{"wait_state": "missing", "timeout_frames": 1}])
	runner.tick(probe)
	assert_equal(runner.failure_details.kind, "wait_state_timeout")
	assert_equal(runner.failure_details.available, false)
	assert_equal(runner.failure_kind, "expectation")
	probe.free()

func test_state_failure_matches_request_and_takes_precedence_over_success() -> void:
	var probe := Probe.new()
	probe.target_frames = 100
	probe.state("request", {"id": "old", "ok": false})
	var runner := _runner([{"wait_state": "request", "where": {"id": "new"}, "fail_where": {"id": "new", "ok": false}}])
	runner.tick(probe)
	assert_equal(runner.status, "running")
	probe.state("request", {"id": "new", "ok": false})
	runner.tick(probe)
	assert_equal(runner.failure_details.kind, "wait_state_failed")
	assert_equal(runner.failure_kind, "expectation")
	probe.free()

func test_event_failure_uses_same_window_and_scans_only_new_events() -> void:
	var probe := Probe.new()
	probe.event("reply", {"id": "old", "ok": false})
	var runner := _runner([{"command": "start"}, {"wait_frames": 1},
		{"wait_event": "reply", "since": "command", "where": {"id": "new", "ok": true},
		"fail_where": {"id": "new", "ok": false}, "timeout_frames": 2000}])
	runner.tick(probe)
	runner.tick(probe)
	for index in range(1000):
		probe.event("noise")
		runner.tick(probe)
	probe.event("reply", {"id": "new", "ok": true})
	probe.event("reply", {"id": "new", "ok": false})
	runner.tick(probe)
	assert_equal(runner.status, "failed")
	assert_equal(runner.failure_details.kind, "wait_event_failed")
	assert_true(probe.failure_scanned < 1010, "Failure matching must retain the incremental cursor")
	probe.free()

func test_event_fail_where_is_opt_in_and_ignores_previous_windows() -> void:
	for opt_in in [false, true]:
		var probe := Probe.new()
		probe.event("reply", {"ok": false})
		var wait_step := {"wait_event": "reply", "where": {"ok": true}}
		if opt_in:
			wait_step["fail_where"] = {"ok": false}
		var runner := _runner([{"wait_event": "reply"}, wait_step])
		runner.tick(probe)
		runner.tick(probe)
		probe.event("reply", {"ok": true})
		runner.tick(probe)
		runner.tick(probe)
		assert_equal(runner.status, "passed")
		probe.free()

func test_invalid_failure_matcher_is_precondition_and_failure_releases_input() -> void:
	for wait_key in ["wait_state", "wait_event"]:
		var probe := Probe.new()
		var step := {"fail_where": false}
		step[wait_key] = "reply"
		var runner := _runner([step])
		InputMap.add_action("gdeck_release_test")
		runner._press_action("gdeck_release_test")
		runner._press_mouse_at(Vector2(10, 20))
		runner.tick(probe)
		assert_equal(runner.failure_kind, "precondition")
		assert_true(runner.active_actions.is_empty())
		assert_false(runner.mouse_pressed)
		assert_false(Input.is_action_pressed("gdeck_release_test"))
		InputMap.erase_action("gdeck_release_test")
		probe.free()
