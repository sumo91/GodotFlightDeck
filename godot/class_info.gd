extends SceneTree

func _type_info(info: Dictionary, is_return: bool = false) -> Dictionary:
	var result := info.duplicate(true)
	if info.has("type"):
		result["typeName"] = type_string(info.type)
		if info.type == TYPE_NIL:
			result["typeName"] = "Variant" if info.get("usage", 0) & PROPERTY_USAGE_NIL_IS_VARIANT else ("void" if is_return else "null")
	return result

func _members(kind: String, owner: String, seen: Dictionary, issues: Array) -> Array:
	var source: Array
	match kind:
		"methods": source = ClassDB.class_get_method_list(owner, true)
		"properties": source = ClassDB.class_get_property_list(owner, true)
		"signals": source = ClassDB.class_get_signal_list(owner, true)
	var result: Array = []
	for raw in source:
		if kind == "properties" and raw.get("usage", 0) & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
			continue
		if seen.has(raw.name):
			continue
		seen[raw.name] = true
		var item: Dictionary = _type_info(raw) if kind == "properties" else raw.duplicate(true)
		item["declaredIn"] = owner
		var required := ["type", "usage", "class_name"] if kind == "properties" else ["args", "default_args", "return", "flags"]
		var missing: Array = []
		for key in required:
			if not raw.has(key): missing.append(key)
		if raw.has("args"):
			item.args = []
			for argument in raw.args:
				if not argument.has("type"): missing.append("args.type")
				item.args.append(_type_info(argument))
		if raw.has("return"):
			if not raw["return"].has("type"): missing.append("return.type")
			item["return"] = _type_info(raw["return"], true)
		if raw.has("default_args"):
			item.default_args = []
			# JSON alone loses Variant types such as Vector2, StringName and NodePath.
			for value in raw.default_args:
				item.default_args.append({"type": typeof(value), "typeName": type_string(typeof(value)), "text": var_to_str(value)})
		if not missing.is_empty():
			issues.append({"code": "metadata_missing", "member": "%s.%s" % [owner, raw.name], "fields": missing})
		result.append(item)
	return result

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 2:
		push_error("class-info expects a class name and report path")
		quit(1)
		return
	var target := args[0]
	var report := {
		"schemaVersion": 1, "className": target, "complete": false, "status": "error",
		"engine": {"executable": OS.get_executable_path(), "version": Engine.get_version_info()},
		"issues": [], "inheritance": [], "methods": [], "properties": [], "signals": [],
	}
	if not ClassDB.class_exists(target):
		report.issues.append({"code": "class_not_found", "message": "No built-in ClassDB class named '%s'. Project script classes and custom extensions are outside this query's scope." % target})
	elif ClassDB.class_get_api_type(target) not in [ClassDB.API_CORE, ClassDB.API_EDITOR]:
		report.issues.append({"code": "class_out_of_scope", "message": "Only built-in core and editor classes are supported."})
	else:
		report["apiType"] = "editor" if ClassDB.class_get_api_type(target) == ClassDB.API_EDITOR else "core"
		var owner := target
		var seen := {"methods": {}, "properties": {}, "signals": {}}
		while not owner.is_empty():
			if owner != target: report.inheritance.append(owner)
			for kind in seen:
				report[kind].append_array(_members(kind, owner, seen[kind], report.issues))
			owner = ClassDB.get_parent_class(owner)
		if report.methods.is_empty():
			report.issues.append({"code": "metadata_missing", "message": "The engine returned no method metadata, including Object methods."})
		report.complete = report.issues.is_empty()
		report.status = "ok" if report.complete else "incomplete"
	var file := FileAccess.open(args[1], FileAccess.WRITE)
	if file == null:
		push_error("Cannot write class-info report")
		quit(1)
		return
	file.store_string(JSON.stringify(report))
	file.close()
	quit(0)
