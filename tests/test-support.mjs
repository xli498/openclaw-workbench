import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export async function symlinkOrSkip(t, target, link, type) {
  try {
    const { symlink } = await import('node:fs/promises');
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('Windows symlink creation requires Developer Mode or SeCreateSymbolicLinkPrivilege');
      return false;
    }
    throw error;
  }
}

export function symlinkSyncOrSkip(t, target, link, type) {
  try {
    const { symlinkSync } = require('node:fs');
    symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('Windows symlink creation requires Developer Mode or SeCreateSymbolicLinkPrivilege');
      return false;
    }
    throw error;
  }
}
