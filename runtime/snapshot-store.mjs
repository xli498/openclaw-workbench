import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`${sep}..${sep}`));
}

export function assertSafeSnapshotPath({ root, storePath, ErrorType, code, message }) {
  const declaredRoot = resolve(root);
  const realRoot = realpathSync(declaredRoot);
  if (declaredRoot !== realRoot) throw new ErrorType(code, message);
  const target = resolve(storePath);
  if (!inside(realRoot, target)) throw new ErrorType(code, message);
  let current = realRoot;
  for (const segment of relative(realRoot, dirname(target)).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ErrorType(code, message);
  }
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ErrorType(code, message);
  }
}

export function writeSnapshotAtomically({ root, storePath, payload, ErrorType, code, message, temporaryName }) {
  assertSafeSnapshotPath({ root, storePath, ErrorType, code, message });
  mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
  assertSafeSnapshotPath({ root, storePath, ErrorType, code, message });
  const temporary = `${storePath}.${temporaryName}.tmp`;
  writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(temporary, storePath);
    chmodSync(storePath, 0o600);
  } catch (error) {
    throw error;
  }
}
