extends "res://addons/flight_deck/test_case.gd"

func _sample(delay_usec: int) -> Dictionary:
	var probe = load("res://addons/flight_deck/runtime_probe.gd").new()
	probe.target_frames = 1000
	probe._configure_clock(PackedStringArray(["--gdeck-fixed-fps=60"]))
	for index in range(12):
		if delay_usec > 0:
			OS.delay_usec(delay_usec)
		probe._process(1.0 / 60.0)
	var clocks: Dictionary = probe._clock_report()
	probe.free()
	return clocks

func test_simulated_seconds_stay_fixed_while_wall_clock_changes() -> void:
	var fast := _sample(0)
	var slow := _sample(2000)
	assert_equal(fast.mode, "fixed_step_throughput")
	assert_approx(fast.fixed_step_seconds, 1.0 / 60.0, 0.000001)
	assert_approx(fast.simulation_seconds, 0.2, 0.000001)
	assert_approx(slow.simulation_seconds, fast.simulation_seconds, 0.000001)
	assert_true(slow.wall_seconds > fast.wall_seconds)
	assert_true(slow.sampling_wall_seconds > 0.0)
	assert_approx(slow.wall_seconds, slow.warmup_wall_seconds + slow.sampling_wall_seconds, 0.000001)
	assert_equal(slow.fixture_control.measurement, "synchronous_callbacks_only")
	assert_equal(slow.fixture_control.async_continuations_measured, false)

func test_clock_configuration_does_not_assume_scenario_mode() -> void:
	var probe = load("res://addons/flight_deck/runtime_probe.gd").new()
	probe._configure_clock(PackedStringArray())
	assert_equal(probe._clock_report().mode, "unknown")
	assert_equal(probe._clock_report().fixed_step_seconds, null)
	probe._configure_clock(PackedStringArray(["--gdeck-fixed-fps=0"]))
	assert_equal(probe._clock_report().mode, "real_time")
	probe._configure_clock(PackedStringArray(["--gdeck-fixed-fps=120"]))
	assert_approx(probe._clock_report().fixed_step_seconds, 1.0 / 120.0, 0.000001)
	probe.free()
