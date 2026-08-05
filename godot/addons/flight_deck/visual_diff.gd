extends SceneTree

## Headless image comparison utility invoked by `gdeck visual-test`.

var baseline_path := ""
var actual_path := ""
var diff_path := ""
var report_path := ""
var pixel_threshold := 0.05
var tolerance := 0.001

func _init() -> void:
	_parse_arguments(OS.get_cmdline_user_args())
	var validation_error := _validate_arguments()
	if not validation_error.is_empty():
		printerr("GDECK_VISUAL_ERROR %s" % validation_error)
		quit(2)
		return
	var report := _compare()
	if not _write_report(report):
		printerr("GDECK_VISUAL_ERROR report_write_failed: %s" % report_path)
		quit(6)
		return
	if bool(report.get("passed", false)):
		print("GDECK_VISUAL_PASSED ratio=%.8f" % float(report.get("changed_ratio", 1.0)))
		quit(0)
	else:
		print("GDECK_VISUAL_FAILED ratio=%.8f" % float(report.get("changed_ratio", 1.0)))
		quit(4)

func _parse_arguments(args: PackedStringArray) -> void:
	for argument in args:
		if argument.begins_with("--baseline="):
			baseline_path = argument.trim_prefix("--baseline=")
		elif argument.begins_with("--actual="):
			actual_path = argument.trim_prefix("--actual=")
		elif argument.begins_with("--diff="):
			diff_path = argument.trim_prefix("--diff=")
		elif argument.begins_with("--report="):
			report_path = argument.trim_prefix("--report=")
		elif argument.begins_with("--threshold="):
			pixel_threshold = clampf(float(argument.trim_prefix("--threshold=")), 0.0, 1.0)
		elif argument.begins_with("--tolerance="):
			tolerance = clampf(float(argument.trim_prefix("--tolerance=")), 0.0, 1.0)

func _validate_arguments() -> String:
	if baseline_path.is_empty() or not FileAccess.file_exists(baseline_path):
		return "Baseline image not found: %s" % baseline_path
	if actual_path.is_empty() or not FileAccess.file_exists(actual_path):
		return "Actual image not found: %s" % actual_path
	if diff_path.is_empty():
		return "Diff output path is required"
	if report_path.is_empty():
		return "Report output path is required"
	return ""

func _compare() -> Dictionary:
	var baseline := Image.load_from_file(baseline_path)
	var actual := Image.load_from_file(actual_path)
	if baseline == null or baseline.is_empty():
		return {"schema_version": 1, "passed": false, "reason": "baseline_load_failed", "changed_ratio": 1.0}
	if actual == null or actual.is_empty():
		return {"schema_version": 1, "passed": false, "reason": "actual_load_failed", "changed_ratio": 1.0}
	var baseline_size := baseline.get_size()
	var actual_size := actual.get_size()
	if baseline_size != actual_size:
		return {
			"schema_version": 1,
			"passed": false,
			"reason": "Image dimensions differ",
			"baseline_size": [baseline_size.x, baseline_size.y],
			"actual_size": [actual_size.x, actual_size.y],
			"changed_pixels": maxi(baseline_size.x * baseline_size.y, actual_size.x * actual_size.y),
			"total_pixels": maxi(1, baseline_size.x * baseline_size.y),
			"changed_ratio": 1.0,
			"mean_absolute_error": 1.0,
			"maximum_channel_error": 1.0,
			"pixel_threshold": pixel_threshold,
			"tolerance": tolerance,
		}

	baseline.convert(Image.FORMAT_RGBA8)
	actual.convert(Image.FORMAT_RGBA8)
	var baseline_bytes := baseline.get_data()
	var actual_bytes := actual.get_data()
	var diff_bytes := PackedByteArray()
	diff_bytes.resize(actual_bytes.size())
	var changed_pixels := 0
	var absolute_error_sum := 0.0
	var maximum_error := 0.0
	var total_pixels := baseline_size.x * baseline_size.y

	for byte_index in range(0, baseline_bytes.size(), 4):
		var red_error := absf(float(baseline_bytes[byte_index]) - float(actual_bytes[byte_index])) / 255.0
		var green_error := absf(float(baseline_bytes[byte_index + 1]) - float(actual_bytes[byte_index + 1])) / 255.0
		var blue_error := absf(float(baseline_bytes[byte_index + 2]) - float(actual_bytes[byte_index + 2])) / 255.0
		var alpha_error := absf(float(baseline_bytes[byte_index + 3]) - float(actual_bytes[byte_index + 3])) / 255.0
		var pixel_error := maxf(maxf(red_error, green_error), maxf(blue_error, alpha_error))
		absolute_error_sum += red_error + green_error + blue_error + alpha_error
		maximum_error = maxf(maximum_error, pixel_error)
		if pixel_error > pixel_threshold:
			changed_pixels += 1
			var intensity := int(clampf(pixel_error * 2.5, 0.25, 1.0) * 255.0)
			diff_bytes[byte_index] = 255
			diff_bytes[byte_index + 1] = maxi(24, 180 - intensity / 2)
			diff_bytes[byte_index + 2] = intensity
		else:
			diff_bytes[byte_index] = int(actual_bytes[byte_index] * 0.12)
			diff_bytes[byte_index + 1] = int(actual_bytes[byte_index + 1] * 0.12)
			diff_bytes[byte_index + 2] = int(actual_bytes[byte_index + 2] * 0.12)
		diff_bytes[byte_index + 3] = 255

	var changed_ratio := float(changed_pixels) / maxf(1.0, total_pixels)
	var mean_error := absolute_error_sum / maxf(1.0, total_pixels * 4.0)
	var passed := changed_ratio <= tolerance
	var directory_error := DirAccess.make_dir_recursive_absolute(diff_path.get_base_dir())
	var diff_error := directory_error
	if directory_error == OK:
		var diff_image := Image.create_from_data(baseline_size.x, baseline_size.y, false, Image.FORMAT_RGBA8, diff_bytes)
		diff_error = diff_image.save_png(diff_path)
	if diff_error != OK:
		passed = false
	return {
		"schema_version": 1,
		"passed": passed,
		"reason": "diff_write_failed" if diff_error != OK else ("Within tolerance" if passed else "Changed pixel ratio exceeds tolerance"),
		"baseline": baseline_path,
		"actual": actual_path,
		"diff": diff_path,
		"diff_error": diff_error,
		"width": baseline_size.x,
		"height": baseline_size.y,
		"changed_pixels": changed_pixels,
		"total_pixels": total_pixels,
		"changed_ratio": changed_ratio,
		"mean_absolute_error": mean_error,
		"maximum_channel_error": maximum_error,
		"pixel_threshold": pixel_threshold,
		"tolerance": tolerance,
	}

func _write_report(report: Dictionary) -> bool:
	if DirAccess.make_dir_recursive_absolute(report_path.get_base_dir()) != OK:
		return false
	var file := FileAccess.open(report_path, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(JSON.stringify(report, "  "))
	file.flush()
	if file.get_error() != OK:
		return false
	print("GDECK_VISUAL_REPORTED %s" % report_path)
	return true
