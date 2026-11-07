import { TOOL_VERSION } from './tool-context.mjs';
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export function isProjectDirectory(candidate) {
  if (!candidate) return false;
  const directory = resolve(candidate);
  return existsSync(join(directory, 'project.godot'));
}

export function resolveProject(candidate) {
  const project = resolve(candidate ?? process.cwd());
  if (!existsSync(join(project, 'project.godot'))) {
    throw new Error(`Not a Godot project: ${project}`);
  }
  return project;
}

export function projectAndProfile(positional) {
  if (positional.length === 0) return { project: resolveProject(), profile: 'default' };
  if (isProjectDirectory(positional[0])) {
    return { project: resolveProject(positional[0]), profile: 'default' };
  }
  return {
    profile: positional[0],
    project: resolveProject(positional[1] ?? process.cwd()),
  };
}

export function configPath(project) {
  return join(project, '.gdeck', 'config.json');
}

export function defaultConfig() {
  return {
    schemaVersion: 1,
    flightDeckVersion: TOOL_VERSION,
    godotPath: '',
    editorBridge: {
      host: '127.0.0.1',
      port: 47835,
      allowWrites: false,
      // reorder / resource-* writes; keep false unless Agent needs them
      supplementaryEnabled: false,
      resourceRoots: ['res://resources/'],
    },
    pi: {
      confirmationTimeoutSeconds: 90,
      approvalLeaseSeconds: 120,
    },
    profiles: {
      default: {
        description: 'Main project scene',
        frames: 30,
        benchmarkWarmupFrames: 60,
        seed: 42,
        userArgs: [],
      },
    },
  };
}

export function loadConfig(project) {
  const path = configPath(project);
  if (!existsSync(path)) return defaultConfig();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config root must be an object');
    const defaults = defaultConfig();
    return {
      ...defaults,
      ...parsed,
      editorBridge: { ...defaults.editorBridge, ...(parsed.editorBridge ?? {}) },
      pi: { ...defaults.pi, ...(parsed.pi ?? {}) },
      profiles: parsed.profiles ?? defaults.profiles,
    };
  } catch (error) {
    throw new Error(`Invalid Flight Deck config at ${path}: ${error.message}`);
  }
}

function executableExists(path) {
  if (!path) return false;
  if (isAbsolute(path)) return existsSync(path);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  const candidates = String(process.env.PATH ?? '').split(delimiter).filter(Boolean)
      .flatMap((directory) => extensions.map((extension) => join(directory, `${path}${extension}`)));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function findGodot(config = {}, override = '') {
  const candidates = [
    override,
    process.env.GODOT_BIN,
    config.godotPath,
    'godot',
    'godot4',
    '/Applications/Godot.app/Contents/MacOS/Godot',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (executableExists(candidate)) return candidate;
  }
  throw new Error('Godot executable not found. Set GODOT_BIN or .gdeck/config.json godotPath.');
}

