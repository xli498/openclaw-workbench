import { lstat, open, readFile, readlink, readdir, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_REVISION_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_REVISION_ENTRIES = 100_000;
const INTERNAL_STATE_DIRECTORY = '.openclaw-workbench';
const DEFAULT_SENSITIVE = [
  /(^|[\\/])\.env(?:\.|$)/i,
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])id_[^/\\]+$/i,
  /\.(pem|key|p12|pfx|kdbx)$/i,
  /(^|[\\/])credentials?\.(json|ya?ml|toml)$/i,
];

export function isSensitiveWorkspacePath(relativePath, patterns = DEFAULT_SENSITIVE) {
  if (typeof relativePath !== 'string') return false;
  const normalized = relativePath.replaceAll('\\', '/');
  return patterns.some((pattern) => pattern.test(normalized));
}

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

export async function createWorkspace(root, { sensitivePatterns = DEFAULT_SENSITIVE, maxReadBytes = DEFAULT_MAX_BYTES, maxRevisionBytes = DEFAULT_MAX_REVISION_BYTES, maxRevisionEntries = DEFAULT_MAX_REVISION_ENTRIES } = {}) {
  const rootReal = await realpath(root).catch((error) => {
    throw new WorkspaceError('ROOT_UNAVAILABLE', `workspace root unavailable: ${error.message}`);
  });
  const isSensitive = (relativePath) => isSensitiveWorkspacePath(relativePath, sensitivePatterns);
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
    async tree({ maxEntries = 2_000, maxDepth = 8 } = {}) {
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) throw new WorkspaceError('TREE_LIMIT', 'maxEntries must be between 1 and 10000');
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) throw new WorkspaceError('TREE_LIMIT', 'maxDepth must be between 0 and 32');
      let count = 0;
      const walk = async (directory, prefix, depth) => {
        const entries = await readdir(directory, { withFileTypes: true });
        const nodes = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
          if (relativePath === INTERNAL_STATE_DIRECTORY || relativePath.startsWith(`${INTERNAL_STATE_DIRECTORY}${path.sep}`) || isSensitive(relativePath)) continue;
          count += 1;
          if (count > maxEntries) throw new WorkspaceError('TREE_LIMIT', 'workspace tree exceeds entry limit', { maxEntries });
          const absolutePath = path.join(directory, entry.name);
          const info = await lstat(absolutePath);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) {
            const node = { path: relativePath, type: 'directory' };
            if (depth < maxDepth) node.children = await walk(absolutePath, relativePath, depth + 1);
            nodes.push(node);
          } else if (info.isFile()) {
            nodes.push({ path: relativePath, type: 'file', size: info.size });
          }
        }
        return nodes;
      };
      return walk(rootReal, '', 0);
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
    async workspaceRevision() {
      let revisionBytes = 0;
      let revisionEntries = 0;
      const accountEntry = (bytes = 0) => {
        revisionEntries += 1;
        revisionBytes += bytes;
        if (revisionEntries > maxRevisionEntries || revisionBytes > maxRevisionBytes) {
          throw new WorkspaceError('REVISION_LIMIT', 'workspace is too large to compute a bounded revision', { revisionEntries, revisionBytes, maxRevisionEntries, maxRevisionBytes });
        }
      };
      const accountBytes = (bytes) => {
        revisionBytes += bytes;
        if (revisionBytes > maxRevisionBytes) {
          throw new WorkspaceError('REVISION_LIMIT', 'workspace is too large to compute a bounded revision', { revisionEntries, revisionBytes, maxRevisionEntries, maxRevisionBytes });
        }
      };
      const hashRegularFile = async (digest, filePath, expectedInfo, relativePath) => {
        accountBytes(expectedInfo.size);
        let handle;
        try {
          handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== expectedInfo.dev || opened.ino !== expectedInfo.ino || opened.size !== expectedInfo.size) {
            throw new WorkspaceError('REVISION_RACE', 'workspace file changed during revision scan', { path: relativePath });
          }
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let position = 0;
          while (position < opened.size) {
            const length = Math.min(buffer.length, opened.size - position);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            if (bytesRead === 0) throw new WorkspaceError('REVISION_RACE', 'workspace file changed during revision scan', { path: relativePath });
            digest.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
          const after = await handle.stat();
          if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
            throw new WorkspaceError('REVISION_RACE', 'workspace file changed during revision scan', { path: relativePath });
          }
        } catch (error) {
          if (error instanceof WorkspaceError) throw error;
          throw new WorkspaceError('REVISION_RACE', `workspace file became unstable during revision scan: ${error.message}`, { path: relativePath });
        } finally {
          await handle?.close();
        }
      };
      try {
        const [{ stdout: head }, { stdout: tracked }, { stdout: untracked }] = await Promise.all([
          execFileAsync('/usr/bin/git', ['-C', rootReal, 'rev-parse', 'HEAD'], { timeout: 5_000, maxBuffer: 64 * 1024 }),
          execFileAsync('/usr/bin/git', ['-C', rootReal, 'ls-files', '-z'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
          execFileAsync('/usr/bin/git', ['-C', rootReal, 'ls-files', '--others', '--exclude-standard', '-z'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
        ]);
        const digest = createHash('sha256').update(head).update('\0');
        for (const relativePath of [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))].sort()) {
          if (isSensitive(relativePath) || relativePath === '.openclaw-workbench' || relativePath.startsWith(`.openclaw-workbench${path.sep}`)) continue;
          accountEntry();
          const resolved = await resolveSafe(relativePath, { allowMissing: true });
          const targetRelative = path.relative(rootReal, resolved.targetReal);
          if (targetRelative === INTERNAL_STATE_DIRECTORY || targetRelative.startsWith(`${INTERNAL_STATE_DIRECTORY}${path.sep}`) || isSensitive(targetRelative)) {
            throw new WorkspaceError('SENSITIVE_PATH', 'workspace revision encountered an alias to excluded state', { path: relativePath, target: targetRelative });
          }
          const info = await stat(resolved.targetReal).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!info) { digest.update(relativePath).update('\0deleted\0'); continue; }
          if (!info.isFile()) continue;
          digest.update(relativePath).update('\0');
          await hashRegularFile(digest, resolved.targetReal, info, relativePath);
          digest.update('\0');
        }
        return `sha256:${digest.digest('hex')}`;
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        if (error.code === 128 || /not a git repository/i.test(error.stderr ?? '')) {
          const digest = createHash('sha256').update('non-git\0');
          const visitedDirectories = new Set();
          const scan = async (directory, prefix = '') => {
            const directoryReal = await realpath(directory);
            if (visitedDirectories.has(directoryReal)) { digest.update(prefix).update('\0directory-cycle\0'); return; }
            if (directoryReal !== rootReal && !directoryReal.startsWith(`${rootReal}${path.sep}`)) throw new WorkspaceError('SYMLINK_ESCAPE', 'workspace revision encountered a directory outside the workspace', { path: prefix });
            visitedDirectories.add(directoryReal);
            const entries = await readdir(directory, { withFileTypes: true });
            for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
              const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
              if (relativePath === INTERNAL_STATE_DIRECTORY || relativePath.startsWith(`${INTERNAL_STATE_DIRECTORY}${path.sep}`) || isSensitive(relativePath)) continue;
              accountEntry();
              const absolutePath = path.join(directory, entry.name);
              const info = await lstat(absolutePath);
              if (info.isSymbolicLink()) {
                const link = await readlink(absolutePath);
                const targetReal = await realpath(absolutePath);
                if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) throw new WorkspaceError('SYMLINK_ESCAPE', 'workspace revision encountered a symlink outside the workspace', { path: relativePath });
                const targetRelative = path.relative(rootReal, targetReal);
                if (targetRelative === INTERNAL_STATE_DIRECTORY || targetRelative.startsWith(`${INTERNAL_STATE_DIRECTORY}${path.sep}`) || isSensitive(targetRelative)) {
                  throw new WorkspaceError('SENSITIVE_PATH', 'workspace revision encountered a symlink to excluded state', { path: relativePath, target: targetRelative });
                }
                digest.update(relativePath).update('\0symlink\0').update(link).update('\0');
                const targetInfo = await stat(targetReal);
                if (targetInfo.isFile()) {
                  await hashRegularFile(digest, targetReal, targetInfo, relativePath);
                  digest.update('\0');
                }
                else if (targetInfo.isDirectory()) await scan(targetReal, relativePath);
              } else if (info.isDirectory()) {
                digest.update(relativePath).update('\0directory\0');
                await scan(absolutePath, relativePath);
              } else if (info.isFile()) {
                digest.update(relativePath).update('\0file\0');
                await hashRegularFile(digest, absolutePath, info, relativePath);
                digest.update('\0');
              } else {
                digest.update(relativePath).update('\0special\0');
              }
            }
          };
          await scan(rootReal);
          return `sha256:${digest.digest('hex')}`;
        }
        if (['ENOENT', 'ELOOP', 'ENOTDIR', 'ESTALE'].includes(error.code)) {
          throw new WorkspaceError('REVISION_RACE', `workspace changed during revision scan: ${error.message}`);
        }
        throw new WorkspaceError('GIT_UNAVAILABLE', `cannot compute workspace revision: ${error.message}`);
      }
    },
  });
}

export { DEFAULT_SENSITIVE };
