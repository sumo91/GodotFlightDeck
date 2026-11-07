import { runProcess } from './execution.mjs';
import { pathContainsSymlink } from './safety.mjs';
import { TOOL_VERSION } from './tool-context.mjs';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function releaseManifestPath(project) {
  const path = join(project, 'build', 'release-manifest.json');
  if (pathContainsSymlink(project, path)) {
    throw new Error(`Release manifest path must not contain symbolic links: ${path}`);
  }
  return path;
}

export async function releaseGitSha(project) {
  const result = await runProcess('git', ['-C', project, 'rev-parse', 'HEAD'], { quiet: true, timeoutMs: 10_000 });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

export async function writeReleaseManifest(project, values) {
  const manifest = {
    schemaVersion: 1,
    flightDeckVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    gitSha: values.gitSha ?? await releaseGitSha(project),
    debug: Boolean(values.debug),
    publishRequested: Boolean(values.publishRequested),
    publishReady: false,
    artifacts: values.artifacts ?? [],
  };
  const manifestPath = releaseManifestPath(project);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const temporaryManifest = `${manifestPath}.partial-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporaryManifest, manifestPath);
  return manifest;
}
