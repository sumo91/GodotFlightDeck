import { lstatSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function pathIsInside(parent, candidate) {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !relation.startsWith(sep));
}

export function pathContainsSymlink(parent, candidate) {
  const root = resolve(parent);
  const target = resolve(candidate);
  if (!pathIsInside(root, target)) return false;
  const components = [root, ...relative(root, target).split(sep).filter(Boolean)];
  let current = components[0];
  for (let index = 0; index < components.length; index += 1) {
    if (index > 0) current = join(current, components[index]);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return false;
}
