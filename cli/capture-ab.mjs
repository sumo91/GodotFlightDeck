import { readFileSync, lstatSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const IMAGE_KEYS = ['a', 'b', 'restored', 'side_by_side', 'diff'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Validate every file before publishing the invocation-owned directory as one unit.
export function publishCapturePairs(report, staging, destination, expectedSteps) {
  const pairs = report.capture_ab;
  if (!Array.isArray(pairs) || pairs.length !== expectedSteps.length || pairs.length < 1 || pairs.length > 4 || existsSync(destination)) {
    throw new Error('A/B publication does not match the planned capture steps');
  }
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (pair?.step !== expectedSteps[index] || pair.status !== 'completed' || pair.restored !== true
      || pair.control?.same_process !== true || pair.control?.restored_image_identical !== true
      || !Number.isInteger(pair.width) || !Number.isInteger(pair.height) || pair.width < 1 || pair.height < 1
      || pair.width * pair.height > 8388608) throw new Error('A/B comparison is incomplete or uncontrolled');
    const directory = join(staging, `pair-${pair.step}`);
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid A/B artifact directory');
    if (readdirSync(directory).sort().join(',') !== IMAGE_KEYS.map(key => `${key}.png`).sort().join(',')) throw new Error('Unexpected A/B artifact files');
    for (const key of IMAGE_KEYS) {
      const path = join(directory, `${key}.png`);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 24 || stat.size > 80 * 1024 * 1024) throw new Error('Invalid A/B image');
      const bytes = readFileSync(path);
      if (hash(bytes) !== pair.files?.[key]?.sha256 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        || bytes.readUInt32BE(16) !== pair.width * (key === 'side_by_side' ? 2 : 1) || bytes.readUInt32BE(20) !== pair.height) {
        throw new Error('A/B image does not match this invocation');
      }
    }
  }
  if (readdirSync(staging).sort().join(',') !== pairs.map(pair => `pair-${pair.step}`).sort().join(',')) throw new Error('Unexpected A/B artifact directories');
  for (const pair of pairs) {
    pair.published = true;
    pair.artifacts = Object.fromEntries(IMAGE_KEYS.map(key => [key, join(destination, `pair-${pair.step}`, `${key}.png`)]));
    pair.artifacts.report = join(destination, `pair-${pair.step}`, 'comparison.json');
    writeFileSync(join(staging, `pair-${pair.step}`, 'comparison.json'), `${JSON.stringify(pair, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  renameSync(staging, destination);
}

// Keep arbitrary project values out of MCP and aggregate report projections.
export function capturePairSummary(pairs) {
  return (Array.isArray(pairs) ? pairs : []).slice(0, 4).map(pair => ({
    step: Number.isInteger(pair?.step) ? pair.step : null,
    status: pair?.status === 'completed' ? 'completed' : 'inconclusive', published: pair?.published === true,
    restored: pair?.restored === true,
    ...(Number.isFinite(pair?.changed_ratio) ? { changed_ratio: pair.changed_ratio } : {}),
    ...(pair?.published === true ? { artifacts: Object.fromEntries([...IMAGE_KEYS, 'report']
      .filter(key => typeof pair?.artifacts?.[key] === 'string' && pair.artifacts[key].length <= 2048 && !/[\u0000-\u001f]/.test(pair.artifacts[key]))
      .map(key => [key, pair.artifacts[key]])) } : {}),
  }));
}
