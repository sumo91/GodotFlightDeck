class_name FlightDeckTest
extends RefCounted

var _failures: Array[String] = []
var _failure_details: Array[Dictionary] = []
var _assertion_count := 0

func _begin_test() -> void:
	_failures.clear()
	_failure_details.clear()
	_assertion_count = 0

func _result() -> Dictionary:
	return {
		"passed": _failures.is_empty(),
		"failures": _failures.duplicate(),
		"failure_details": _failure_details.duplicate(true),
		"assertions": _assertion_count,
	}

func _safe_evidence_value(value: Variant) -> Variant:
	if value == null or value is bool or value is int or value is float:
		return value
	if value is String:
		return {"type": "String", "length": value.length()}
	return {"type": type_string(typeof(value))}

func _record_failure(assertion: String, message: String, expected: Variant = null, actual: Variant = null, extra: Dictionary = {}) -> void:
	_failures.append(message)
	var detail := {
		"assertion": assertion,
		"expected": _safe_evidence_value(expected),
		"actual": _safe_evidence_value(actual),
	}
	for key in extra:
		detail[key] = extra[key]
	_failure_details.append(detail)

func fail(message: String) -> void:
	_assertion_count += 1
	_record_failure("fail", message)

func assert_true(value: bool, message: String = "Expected value to be true") -> void:
	_assertion_count += 1
	if not value:
		_record_failure("true", message, true, value)

func assert_false(value: bool, message: String = "Expected value to be false") -> void:
	_assertion_count += 1
	if value:
		_record_failure("false", message, false, value)

func assert_equal(actual: Variant, expected: Variant, message: String = "") -> void:
	_assertion_count += 1
	if actual != expected:
		_record_failure("equal", message if not message.is_empty() else "Expected %s, received %s" % [str(expected), str(actual)], expected, actual)

func assert_not_equal(actual: Variant, expected: Variant, message: String = "") -> void:
	_assertion_count += 1
	if actual == expected:
		_record_failure("not_equal", message if not message.is_empty() else "Expected values to differ, both were %s" % str(actual), expected, actual)

func assert_approx(actual: float, expected: float, epsilon: float = 0.0001, message: String = "") -> void:
	_assertion_count += 1
	if not is_equal_approx(actual, expected) and absf(actual - expected) > epsilon:
		_record_failure("approx", message if not message.is_empty() else "Expected %.6f ± %.6f, received %.6f" % [expected, epsilon, actual], expected, actual, {"epsilon": epsilon})

func assert_greater(actual: float, minimum: float, message: String = "") -> void:
	_assertion_count += 1
	if actual <= minimum:
		_record_failure("greater", message if not message.is_empty() else "Expected %.6f to be greater than %.6f" % [actual, minimum], minimum, actual)

func assert_greater_equal(actual: float, minimum: float, message: String = "") -> void:
	_assertion_count += 1
	if actual < minimum:
		_record_failure("greater_equal", message if not message.is_empty() else "Expected %.6f to be at least %.6f" % [actual, minimum], minimum, actual)

func assert_less_equal(actual: float, maximum: float, message: String = "") -> void:
	_assertion_count += 1
	if actual > maximum:
		_record_failure("less_equal", message if not message.is_empty() else "Expected %.6f to be at most %.6f" % [actual, maximum], maximum, actual)

func assert_has(dictionary: Dictionary, key: Variant, message: String = "") -> void:
	_assertion_count += 1
	if not dictionary.has(key):
		_record_failure("has_key", message if not message.is_empty() else "Expected dictionary to contain key %s" % str(key), key, null)
