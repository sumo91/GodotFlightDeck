// Godot consumes --fixed-fps before exposing OS.get_cmdline_args(). Carry the
// launcher's actual engine choice through the reserved probe argument namespace.
export function withRuntimeClockMetadata(args) {
  const separator = args.indexOf('--');
  if (separator < 0) return args;
  const engineArgs = args.slice(0, separator);
  const index = engineArgs.indexOf('--fixed-fps');
  const value = index < 0 ? 0 : Number(engineArgs[index + 1]);
  const fixedFps = Number.isSafeInteger(value) && value >= 0 ? value : -1;
  return [...args, `--gdeck-fixed-fps=${fixedFps}`];
}
