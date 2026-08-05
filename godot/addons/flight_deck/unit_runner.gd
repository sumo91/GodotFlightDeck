extends SceneTree

var tests_root := "res://tests"
var report_path := ""
var filter_text := ""
var unit_binding: Dictionary = {}
var cases: Array[Dictionary] = []
var started_msec := 0
var progress_sequence := 0
var total_case_count := 0
var total_case_count_known := false
var discovered_case_count := 0
var current_case: Variant = null

func _init() -> void:
	started_msec = Time.get_ticks_msec()
	_parse_arguments(OS.get_cmdline_user_args())
	if report_path.is_empty() or not _valid_unit_binding(unit_binding):
		printerr("GDECK_UNIT_ERROR A bound report path is required")
		quit(2)
		return
	if str(unit_binding.get("output_path", "")) != report_path:
		printerr("GDECK_UNIT_ERROR Unit output binding mismatch")
		quit(2)
		return
	# Defer until SceneTree + Autoloads are ready (Godot 4 --script path).
	call_deferred("_execute_tests")


func _execute_tests() -> void:
	var files: Array[String] = []
	_discover_tests(tests_root, files)
	files.sort()
	if not _publish_report(false):
		quit(6)
		return
	for index in range(files.size()):
		if not _run_test_file(files[index], index == files.size() - 1):
			quit(6)
			return
	current_case = null
	if not _publish_report(true):
		quit(6)
		return
	var failed := cases.filter(func(item: Dictionary): return not bool(item.passed)).size()
	if failed == 0:
		print("GDECK_UNIT_PASSED cases=%d" % cases.size())
		quit(0)
	else:
		print("GDECK_UNIT_FAILED failed=%d total=%d" % [failed, cases.size()])
		quit(5)

func _parse_arguments(args: PackedStringArray) -> void:
	for argument in args:
		if argument.begins_with("--tests="):
			tests_root = argument.trim_prefix("--tests=")
		elif argument.begins_with("--report="):
			report_path = argument.trim_prefix("--report=")
		elif argument.begins_with("--filter="):
			filter_text = argument.trim_prefix("--filter=").to_lower()
		elif argument.begins_with("--gdeck-unit-binding="):
			var encoded := argument.trim_prefix("--gdeck-unit-binding=").replace("-", "+").replace("_", "/")
			while encoded.length() % 4 != 0:
				encoded += "="
			var decoded := Marshalls.base64_to_utf8(encoded)
			var parsed = JSON.parse_string(decoded)
			if parsed is Dictionary:
				unit_binding = parsed

func _valid_hex_identity(value: Variant) -> bool:
	if not value is String or value.length() != 64:
		return false
	for character in value:
		if not character in "0123456789abcdef":
			return false
	return true

func _valid_unit_binding(value: Dictionary) -> bool:
	return int(value.get("schema_version", 0)) == 1 \
		and _valid_hex_identity(value.get("invocation_identity")) \
		and _valid_hex_identity(value.get("owner_nonce")) \
		and _valid_hex_identity(value.get("runtime_arguments_sha256")) \
		and str(value.get("project", "")).is_absolute_path() \
		and str(value.get("output_path", "")).is_absolute_path() \
		and int(value.get("timeout_ms", 0)) > 0

func _discover_tests(directory_path: String, output: Array[String]) -> void:
	var directory := DirAccess.open(directory_path)
	if directory == null:
		return
	directory.list_dir_begin()
	var entry := directory.get_next()
	while not entry.is_empty():
		if entry.begins_with("."):
			entry = directory.get_next()
			continue
		var child := directory_path.path_join(entry)
		if directory.current_is_dir():
			_discover_tests(child, output)
		elif entry.ends_with("_test.gd"):
			output.append(child)
		entry = directory.get_next()
	directory.list_dir_end()

func _case_progress(ordinal: int) -> Dictionary:
	return {"ordinal": ordinal, "token": "case-%04d" % ordinal}

func _mark_discovered(count: int, is_last_file: bool) -> void:
	discovered_case_count += count
	if is_last_file:
		total_case_count = discovered_case_count
		total_case_count_known = true

func _run_test_file(path: String, is_last_file: bool) -> bool:
	var script = load(path)
	if script == null:
		_mark_discovered(1, is_last_file)
		var ordinal := cases.size() + 1
		current_case = _case_progress(ordinal)
		if not _publish_report(false):
			return false
		cases.append({"name": path, "file": path, "passed": false, "assertions": 0, "failures": ["Cannot load test script"], "failure_details": [{"assertion": "test_load"}], "failure_kind": "test_load", "duration_ms": 0})
		current_case = null
		return _publish_report(false)
	var instance = script.new()
	if instance == null or not instance.has_method("_begin_test") or not instance.has_method("_result"):
		_mark_discovered(1, is_last_file)
		var ordinal := cases.size() + 1
		current_case = _case_progress(ordinal)
		if not _publish_report(false):
			return false
		cases.append({"name": path, "file": path, "passed": false, "assertions": 0, "failures": ["Test script must extend FlightDeckTest"], "failure_details": [{"assertion": "test_contract"}], "failure_kind": "test_contract", "duration_ms": 0})
		current_case = null
		return _publish_report(false)
	var methods: Array[String] = []
	for method in instance.get_method_list():
		var method_name := str(method.get("name", ""))
		var full_name := "%s::%s" % [path, method_name]
		if method_name.begins_with("test_") and (filter_text.is_empty() or filter_text in full_name.to_lower()):
			methods.append(method_name)
	methods.sort()
	_mark_discovered(methods.size(), is_last_file)
	for method_name in methods:
		var ordinal := cases.size() + 1
		current_case = _case_progress(ordinal)
		if not _publish_report(false):
			return false
		var case_started := Time.get_ticks_usec()
		instance._begin_test()
		if instance.has_method("before_each"):
			instance.call("before_each")
		instance.call(method_name)
		if instance.has_method("after_each"):
			instance.call("after_each")
		var result: Dictionary = instance._result()
		result["name"] = method_name
		result["file"] = path
		result["failure_kind"] = "none" if bool(result.passed) else "assertion"
		result["duration_ms"] = float(Time.get_ticks_usec() - case_started) / 1000.0
		cases.append(result)
		current_case = null
		print("GDECK_UNIT_CASE %s ordinal=%d" % ["PASS" if result.passed else "FAIL", ordinal])
		if not _publish_report(false):
			return false
	return true

func _progress() -> Dictionary:
	return {
		"sequence": progress_sequence,
		"elapsed_ms": Time.get_ticks_msec() - started_msec,
		"completed_cases": cases.size(),
		"total_cases": total_case_count if total_case_count_known else null,
		"current_case": current_case,
	}

func _terminal_report() -> Dictionary:
	var passed := cases.filter(func(item: Dictionary): return bool(item.passed)).size()
	var assertion_count := 0
	for item in cases:
		assertion_count += int(item.assertions)
	return {
		"schema_version": 2,
		"complete": true,
		"unit_binding": unit_binding,
		"flight_deck_version": "1.6.3-cursor.2",
		"godot_version": Engine.get_version_info().get("string", "unknown"),
		"tests_root": tests_root,
		"filter": filter_text,
		"status": "passed" if passed == cases.size() else "failed",
		"summary": {
			"total": cases.size(),
			"passed": passed,
			"failed": cases.size() - passed,
			"assertions": assertion_count,
			"duration_ms": Time.get_ticks_msec() - started_msec,
		},
		"cases": cases,
	}

func _incomplete_report() -> Dictionary:
	return {
		"schema_version": 2,
		"complete": false,
		"unit_binding": unit_binding,
		"progress": _progress(),
	}

func _existing_report_is_owned() -> bool:
	if not FileAccess.file_exists(report_path):
		return true
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(report_path))
	if not parsed is Dictionary or not parsed.get("unit_binding") is Dictionary:
		return false
	var existing: Dictionary = parsed.unit_binding
	for key in ["schema_version", "invocation_identity", "owner_nonce", "project", "output_path", "timeout_ms", "runtime_arguments_sha256"]:
		if existing.get(key) != unit_binding.get(key):
			return false
	return true

func _publish_report(complete: bool) -> bool:
	progress_sequence += 1
	var report := _terminal_report() if complete else _incomplete_report()
	DirAccess.make_dir_recursive_absolute(report_path.get_base_dir())
	var temporary_path := "%s.%s.tmp" % [report_path, str(unit_binding.owner_nonce).left(16)]
	var file := FileAccess.open(temporary_path, FileAccess.WRITE)
	if file == null:
		printerr("GDECK_UNIT_ERROR Cannot open private Unit report snapshot")
		return false
	file.store_string(JSON.stringify(report, "  "))
	file.flush()
	file = null
	FileAccess.set_unix_permissions(temporary_path, 384)
	if not _existing_report_is_owned():
		DirAccess.remove_absolute(temporary_path)
		printerr("GDECK_UNIT_ERROR Unit report ownership changed before publication")
		return false
	var rename_error := DirAccess.rename_absolute(temporary_path, report_path)
	if rename_error != OK:
		DirAccess.remove_absolute(temporary_path)
		printerr("GDECK_UNIT_ERROR Cannot atomically publish Unit report snapshot code=%d" % rename_error)
		return false
	if complete:
		print("GDECK_UNIT_REPORTED")
	return true
