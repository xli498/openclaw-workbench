import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSnapshot, snapshotDigest, writeSnapshotAtomically } from './snapshot-store.mjs';

const MAX_CONFIG_BYTES = 1_048_576;
const BACKUP_DIRECTORY = '.openclaw-workbench/config-backups';
const BACKUP_PATTERN = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

export class ConfigError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ConfigError'; this.code = code; this.details = details; }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function configRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) throw new ConfigError('CONFIG_PATH_INVALID', 'config path must be relative');
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('/') || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/i.test(normalized) || normalized.toLowerCase().startsWith('.openclaw-workbench/')) {
    throw new ConfigError('CONFIG_PATH_INVALID', 'config path must be a relative JSON file');
  }
  return normalized.split('/').join(path.sep);
}

function backupIdOf(value) {
  if (typeof value !== 'string' || !BACKUP_PATTERN.test(value) || value.includes('/') || value.includes('\\')) throw new ConfigError('BACKUP_PATH_INVALID', 'backup id is invalid');
  return value;
}

export function validateBackupId(value) { return backupIdOf(value); }

async function rootPath(root) {
  if (typeof root !== 'string' || !root) throw new ConfigError('ROOT_REQUIRED', 'root is required');
  try { return await realpath(root); } catch { throw new ConfigError('ROOT_UNAVAILABLE', 'workspace root unavailable'); }
}

async function pathsOf(root, relativePath) {
  const rootReal = await rootPath(root);
  const normalized = configRelativePath(relativePath);
  const target = path.resolve(rootReal, normalized);
  if (!inside(rootReal, target)) throw new ConfigError('CONFIG_PATH_INVALID', 'config path escapes workspace');
  return Object.freeze({ rootReal, normalized, target, backupRoot: path.resolve(rootReal, BACKUP_DIRECTORY) });
}

function parseConfig(content) {
  if (content === null) return null;
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) throw new ConfigError('CONFIG_TOO_LARGE', 'config exceeds size limit');
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be a JSON object');
    return value;
  } catch { throw new ConfigError('CONFIG_INVALID', 'config must contain a valid JSON object'); }
}

function snapshotOptions(ErrorType = ConfigError) {
  return { ErrorType, code: 'CONFIG_UNAVAILABLE', message: 'config file is unavailable', busyCode: 'CONFIG_BUSY', busyMessage: 'config file is busy', conflictCode: 'CONFIG_CONFLICT', conflictMessage: 'config changed before the operation completed' };
}

function readRaw(root, target) {
  return readSnapshot({ root, storePath: target, ...snapshotOptions() });
}

export async function readConfig({ root, relativePath = 'openclaw.json' } = {}) {
  const paths = await pathsOf(root, relativePath);
  const stored = readRaw(paths.rootReal, paths.target);
  const value = parseConfig(stored.content);
  return Object.freeze({ status: stored.content === null ? 'missing' : 'ready', relativePath: paths.normalized.split(path.sep).join('/'), size: stored.content === null ? 0 : Buffer.byteLength(stored.content), hash: stored.digest, ...(value === null ? {} : { keys: Object.freeze(Object.keys(value).slice(0, 128)) }) });
}

function assertExpectedHash(value) {
  if (value !== null && (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value))) throw new ConfigError('CONFIG_HASH_INVALID', 'expectedHash must be a SHA-256 digest or null');
}

function writeFile({ root, target, payload, expectedDigest }) {
  return writeSnapshotAtomically({ root, storePath: target, payload, expectedDigest, temporaryName: randomUUID(), ...snapshotOptions() });
}

export async function importConfig({ root, relativePath = 'openclaw.json', expectedHash = null, content } = {}) {
  const paths = await pathsOf(root, relativePath);
  assertExpectedHash(expectedHash);
  if (typeof content !== 'string') throw new ConfigError('CONFIG_CONTENT_INVALID', 'config content must be a string');
  parseConfig(content);
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) throw new ConfigError('CONFIG_TOO_LARGE', 'config exceeds size limit');
  const current = readRaw(paths.rootReal, paths.target);
  parseConfig(current.content);
  if (current.digest !== expectedHash) throw new ConfigError('CONFIG_CONFLICT', 'config changed before import', { expectedHash, actualHash: current.digest });
  let backupId;
  let backupPath;
  if (current.content !== null) {
    backupId = `${Date.now()}-${randomUUID()}.json`;
    backupPath = path.join(paths.backupRoot, backupId);
    writeFile({ root: paths.rootReal, target: backupPath, payload: current.content, expectedDigest: null });
    writeFile({ root: paths.rootReal, target: `${backupPath}.meta.json`, payload: JSON.stringify({ version: 1, backupId, relativePath: paths.normalized.split(path.sep).join('/'), contentHash: current.digest }), expectedDigest: null });
  }
  const afterHash = writeFile({ root: paths.rootReal, target: paths.target, payload: content, expectedDigest: current.digest });
  return Object.freeze({ status: 'verified', relativePath: paths.normalized.split(path.sep).join('/'), beforeHash: current.digest, afterHash, ...(backupId ? { backupId, backupPath } : {}) });
}

export async function rollbackConfig({ root, relativePath = 'openclaw.json', backupId, expectedHash } = {}) {
  const paths = await pathsOf(root, relativePath);
  assertExpectedHash(expectedHash);
  const id = backupIdOf(backupId);
  const backupPath = path.join(paths.backupRoot, id);
  const backup = readRaw(paths.rootReal, backupPath);
  if (backup.content === null) throw new ConfigError('BACKUP_UNAVAILABLE', 'config backup is unavailable');
  parseConfig(backup.content);
  const metadata = readRaw(paths.rootReal, `${backupPath}.meta.json`);
  if (metadata.content === null) throw new ConfigError('BACKUP_INVALID', 'config backup metadata is unavailable');
  let metadataValue;
  try { metadataValue = parseConfig(metadata.content); } catch { throw new ConfigError('BACKUP_INVALID', 'config backup metadata is invalid'); }
  if (metadataValue?.version !== 1 || metadataValue.backupId !== id || metadataValue.relativePath !== paths.normalized.split(path.sep).join('/') || metadataValue.contentHash !== backup.digest) throw new ConfigError('BACKUP_TARGET_MISMATCH', 'config backup is bound to another target or has changed');
  const current = readRaw(paths.rootReal, paths.target);
  parseConfig(current.content);
  if (current.digest !== expectedHash) throw new ConfigError('CONFIG_CONFLICT', 'config changed before rollback', { expectedHash, actualHash: current.digest });
  const afterHash = writeFile({ root: paths.rootReal, target: paths.target, payload: backup.content, expectedDigest: current.digest });
  return Object.freeze({ status: 'verified', relativePath: paths.normalized.split(path.sep).join('/'), backupId: id, beforeHash: current.digest, afterHash });
}

export { MAX_CONFIG_BYTES };
