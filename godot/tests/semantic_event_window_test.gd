extends "res://addons/flight_deck/test_case.gd"

class CountingProbe extends "res://addons/flight_deck/runtime_probe.gd":
	var scanned := 0
	func count_semantic_events(event_name: String, where: Dictionary = {}, from_index: int = 0) -> int:
		scanned += maxi(0, semantic_events.size() - from_index)
		return super.count_semantic_events(event_name, where, from_index)
	func event(event_name: String, payload: Dictionary = {}) -> void:
		semantic_events.append({"name": event_name, "frame": current_frame, "payload": payload})

func _runner(test_steps: Array, test_assertions: Array = []) -> FlightDeckScenarioRunner:
	var runner := FlightDeckScenarioRunner.new()
	runner.steps = test_steps
	runner.assertions = test_assertions
	runner.status = "running"
	return runner

func test_wait_scans_each_new_event_once() -> void:
	var probe := CountingProbe.new()
	var runner := _runner([{"wait_event": "done", "timeout_frames": 2000}])
	for index in range(1000):
		probe.event("noise", {"index": index})
		runner.tick(probe)
	probe.event("done")
	runner.tick(probe)
	var scanned_before_assertions := probe.scanned
	runner.tick(probe)
	assert_equal(runner.status, "passed")
	assert_equal(scanned_before_assertions, 1002, "1000 noise + step start + done must each be scanned once")
	probe.free()

func test_history_where_and_same_frame_counts() -> void:
	for history_key in ["include_history", "includeHistory"]:
		var probe := CountingProbe.new()
		probe.event("done", {"ok": false})
		probe.event("done", {"ok": true})
		probe.event("done", {"ok": true})
		var wait_step := {"wait_event": "done", "where": {"ok": true}, "count_gte": 2, "timeout_frames": 2}
		wait_step[history_key] = true
		var runner := _runner([{"wait_frames": 1}, wait_step], [{"event": "done", "count_gte": 3, "count_lte": 3}])
		for index in range(3):
			runner.tick(probe)
		assert_equal(runner.status, "passed")
		assert_equal(runner.assertion_results[0].count, 3)
		probe.free()

func test_later_window_excludes_old_matches_and_reports_them() -> void:
	var probe := CountingProbe.new()
	probe.event("done", {"ok": true})
	var runner := _runner([{"wait_event": "done"}, {"wait_event": "done", "timeout_frames": 2}])
	for index in range(3):
		runner.tick(probe)
	assert_equal(runner.status, "failed")
	assert_equal(runner.failure_details.matches_in_window, 0)
	assert_equal(runner.failure_details.prior_matches.total, 1)
	assert_equal(runner.failure_details.prior_matches.events[0].event_index, 0)
	probe.free()

func test_command_window_and_action_window() -> void:
	for use_since in [false, true]:
		var probe := CountingProbe.new()
		probe.event("done")
		var wait_step := {"wait_event": "done", "count_gte": 2, "timeout_frames": 4}
		var test_steps: Array = [{"command": "start"}]
		if use_since:
			wait_step["since"] = "command"
			test_steps.append({"wait_frames": 1})
		test_steps.append(wait_step)
		var runner := _runner(test_steps)
		runner.tick(probe)
		probe.event("done")
		probe.event("done")
		for index in range(test_steps.size()):
			runner.tick(probe)
		assert_equal(runner.status, "passed")
		probe.free()
