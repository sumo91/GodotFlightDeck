import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_FILE = fileURLToPath(new URL('./gdeck.mjs', import.meta.url));
export const TOOL_ROOT = resolve(dirname(CLI_FILE), '..');
export const ADDON_SOURCE = join(TOOL_ROOT, 'godot', 'addons', 'flight_deck');
export const PROCESS_RUNNER = join(TOOL_ROOT, 'cli', 'process-runner.mjs');
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const TOOL_VERSION = JSON.parse(readFileSync(join(TOOL_ROOT, 'package.json'), 'utf8')).version;
export const ERROR_PATTERN = /SCRIPT ERROR|Parse Error|ERROR:|FATAL:/;
export const PROCESS_CLEANUP_TIMEOUT_MS = 750;
export const PROCESS_WATCHDOG_GRACE_MS = 750;

export const color = {
  green: (value) => process.stdout.isTTY ? `\u001b[32m${value}\u001b[0m` : value,
  yellow: (value) => process.stdout.isTTY ? `\u001b[33m${value}\u001b[0m` : value,
  red: (value) => process.stdout.isTTY ? `\u001b[31m${value}\u001b[0m` : value,
  muted: (value) => process.stdout.isTTY ? `\u001b[2m${value}\u001b[0m` : value,
};

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

