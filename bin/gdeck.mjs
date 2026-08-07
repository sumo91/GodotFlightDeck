#!/usr/bin/env node
/**
 * Agent-friendly launcher for Godot Flight Deck.
 * Sets compat defaults then loads cli/gdeck.mjs in-process (no nested Node spawn).
 */
if (process.env.GDECK_CURSOR_COMPAT === undefined) {
  process.env.GDECK_CURSOR_COMPAT = '1';
}

if (!process.env.GODOT_BIN) {
  process.env.GODOT_BIN = 'D:\\03_Godot\\01_Engine\\Godot_v4.7.1-stable_win64.exe';
}

await import('../cli/gdeck.mjs');
