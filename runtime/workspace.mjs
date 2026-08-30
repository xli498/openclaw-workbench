import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_SENSITIVE = [
  /^\.env(?:\.|$)/i,
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])id_[^/\\]+$/i,
  /\.(pem|key|p12|pfx|kdbx)$/i,
  /(^|[\\/])credentials?\.(json|ya?ml|toml)$/i,
];

export class WorkspaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = details;
  }
}

function assertRelative(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new WorkspaceError('INVALID_PATH', 'path must be a non-empty relative path');
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new WorkspaceError('PATH_ESCAPE', 'path escapes workspace root');
  }
  return normalized;
}

export async function createWorkspace(root, { sensitivePatterns = DEFAULT_SENSITIVE, maxReadBytes = DEFAULT_MAX_BYTES } = {}) {
  const rootReal = await realpath(root).catch((error) => {
    throw new WorkspaceError('ROOT_UNAVAILABLE', `workspace root unavailable: ${error.message}`);
  });
  const isSensitive = (relativePath) => sensitivePatterns.some((pattern) => pattern.test(relativePath));
  const resolveSafe = async (relativePath, { allowMissing = false } = {}) => {
    const normalized = assertRelative(relativePath);
    if (isSensitive(normalized)) throw new WorkspaceError('SENSITIVE_PATH', 'access to sensitive path is denied', { path: normalized });
    const candidate = path.resolve(rootReal, normalized);
    if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`)) {
      throw new WorkspaceError('PATH_ESCAPE', 'path escapes workspace root');
    }
    try {
      const targetReal = await realpath(candidate);
      if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new WorkspaceError('SYMLINK_ESCAPE', 'symbolic link escapes workspace root', { path: normalized });
      }
      return { normalized, candidate, targetReal };
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return { normalized, candidate, targetReal: candidate };
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('PATH_UNAVAILABLE', `path unavailable: ${error.message}`, { path: normalized });
    }
  };

  return Object.freeze({
    root: rootReal,
    async read(relativePath, { maxBytes = maxReadBytes, encoding = 'utf8' } = {}) {
      const resolved = await resolveSafe(relativePath);
      const info = await stat(resolved.targetReal);
      if (!info.isFile()) throw new WorkspaceError('NOT_A_FILE', 'target is not a regular file', { path: resolved.normalized });
      if (info.size > maxBytes) throw new WorkspaceError('READ_LIMIT', `file exceeds ${maxBytes} bytes`, { path: resolved.normalized, size: info.size });
      return readFile(resolved.targetReal, { encoding });
    },
    async inspect(relativePath) {
      const resolved = await resolveSafe(relativePath);
      const info = await stat(resolved.targetReal);
      return Object.freeze({ path: resolved.normalized, size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() });
    },
    async gitRevision() {
      try {
        const { stdout } = await execFileAsync('git', ['-C', rootReal, 'rev-parse', 'HEAD'], { timeout: 5_000, maxBuffer: 64 * 1024 });
        return stdout.trim() || null;
      } catch (error) {
        if (error.code === 128 || /not a git repository/i.test(error.stderr ?? '')) return null;
        throw new WorkspaceError('GIT_UNAVAILABLE', `cannot read git revision: ${error.message}`);
      }
    },
  });
}

export { DEFAULT_SENSITIVE };
