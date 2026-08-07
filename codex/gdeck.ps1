# GodotFlightDeck — Codex wrapper.
# Selects the in-process direct mode (GDECK_CODEX_DIRECT=1) and defaults
# GODOT_BIN to the local Godot 4.7.1 executable when not already set.
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Command,
  [Parameter(ValueFromRemainingArguments = $true, Position = 1)]
  [string[]] $Arguments
)

$toolRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $toolRoot 'cli\gdeck.mjs'
$env:GDECK_CODEX_DIRECT = '1'
$defaultGodot = 'D:\03_Godot\01_Engine\Godot_v4.7.1-stable_win64.exe'
if (-not $env:GODOT_BIN -and (Test-Path -LiteralPath $defaultGodot)) {
  $env:GODOT_BIN = $defaultGodot
}

& node $cliPath $Command @Arguments
exit $LASTEXITCODE
