extends SceneTree
## gdeck check --file runner
##
## Compiled through a SceneTree so project autoloads are registered before the
## target script is loaded. `--check-only --script` would report false
## "Identifier not found" errors for autoload references, so this runner is the
## canonical single-script validation path.
##
## Usage (invoked by the gdeck CLI):
##   godot --headless --path <project> -s <this-file> -- <absolute-or-project-relative .gd>

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		push_error("gdeck check --file: no target script provided")
		quit(1)
		return
	var target := args[0]
	var script: Variant = load(target)
	if script == null:
		# A failed parse usually raises instead of returning null; keep the guard
		# for robustness and let ERROR_PATTERN classification decide the exit.
		push_error("gdeck check --file: failed to load script: ", target)
		quit(1)
		return
	quit(0)
