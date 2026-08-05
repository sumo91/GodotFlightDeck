extends SceneTree
## gdeck scene doctor loading pass
##
## Authoritative reference check for every .tscn under res://scenes (or a
## res:// subdirectory passed as the first user argument). Godot load()
## resolves ext_resource chains, scripts and sub-resources; a broken scene
## prints SCRIPT ERROR/ERROR lines and load() returns null.

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var root_path := "res://scenes"
	if not args.is_empty() and not args[0].is_empty():
		root_path = args[0]
		if not root_path.begins_with("res://"):
			push_error("gdeck scene doctor: root must be a res:// path, got: %s" % root_path)
			quit(1)
			return
	var files: Array[String] = []
	var dir := DirAccess.open(root_path)
	if dir == null:
		push_error("gdeck scene doctor: cannot open %s" % root_path)
		quit(1)
		return
	_collect(dir, root_path, files)
	files.sort()
	var failures := 0
	for path in files:
		var scene: Variant = load(path)
		if scene == null:
			failures += 1
			print("SCENE_FAIL %s" % path)
		else:
			print("SCENE_OK %s" % path)
	print("SCENE_SCAN root=%s total=%d failures=%d" % [root_path, files.size(), failures])
	quit(1 if failures > 0 else 0)


func _collect(dir: DirAccess, base: String, out: Array[String]) -> void:
	dir.list_dir_begin()
	var name := dir.get_next()
	while not name.is_empty():
		if dir.current_is_dir() and not name.begins_with("."):
			var sub := DirAccess.open(base.path_join(name))
			if sub != null:
				_collect(sub, base.path_join(name), out)
		elif name.ends_with(".tscn"):
			out.append(base.path_join(name))
		name = dir.get_next()
	dir.list_dir_end()
