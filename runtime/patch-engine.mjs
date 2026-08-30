import { createHash } from 'node:crypto';

export class PatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.details = details;
  }
}

const hash = (value) => createHash('sha256').update(value).digest('hex');

function pathCheck(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.startsWith('/') || filePath.includes('\\') || filePath.split('/').includes('..')) {
    throw new PatchError('PATCH_PATH_INVALID', `invalid patch path: ${filePath}`);
  }
  return filePath;
}

function parseFileHeader(line) {
  const match = /^(?:---|\+\++) (.+?)(?:\t.*)?$/.exec(line);
  if (!match) throw new PatchError('PATCH_HEADER_INVALID', `invalid file header: ${line}`);
  const value = match[1].replace(/^([ab])\//, '');
  if (value === '/dev/null') return null;
  return pathCheck(value);
}

export function parseUnifiedPatch(patch) {
  if (typeof patch !== 'string' || !patch.trim()) throw new PatchError('PATCH_EMPTY', 'patch is empty');
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  const files = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].startsWith('--- ')) { i += 1; continue; }
    const oldPath = parseFileHeader(lines[i]);
    if (!lines[i + 1]?.startsWith('+++ ')) throw new PatchError('PATCH_HEADER_INVALID', 'missing +++ header');
    const newPath = parseFileHeader(lines[i + 1]);
    if (!oldPath && !newPath) throw new PatchError('PATCH_PATH_INVALID', 'both patch paths are null');
    const hunks = [];
    i += 2;
    while (i < lines.length && !lines[i].startsWith('--- ')) {
      if (lines[i].startsWith('@@ ')) {
        const header = lines[i];
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
        if (!match) throw new PatchError('HUNK_HEADER_INVALID', header);
        const oldStart = Number(match[1]);
        const oldCount = Number(match[2] ?? 1);
        const newStart = Number(match[3]);
        const newCount = Number(match[4] ?? 1);
        const body = [];
        i += 1;
        while (i < lines.length && !lines[i].startsWith('@@ ') && !lines[i].startsWith('--- ')) {
          if (lines[i] === '') { i += 1; continue; }
          if (lines[i].trim() === '\\ No newline at end of file') { i += 1; continue; }
          if (![' ', '+', '-'].includes(lines[i][0])) throw new PatchError('HUNK_LINE_INVALID', lines[i]);
          body.push(lines[i]);
          i += 1;
        }
        const oldActual = body.filter((line) => line[0] === ' ' || line[0] === '-').length;
        const newActual = body.filter((line) => line[0] === ' ' || line[0] === '+').length;
        if (oldActual !== oldCount || newActual !== newCount) throw new PatchError('HUNK_COUNT_MISMATCH', header, { oldCount, oldActual, newCount, newActual });
        hunks.push({ header, oldStart, oldCount, newStart, newCount, body });
      } else i += 1;
    }
    if (!hunks.length) throw new PatchError('PATCH_NO_HUNKS', `${oldPath ?? newPath} has no hunks`);
    files.push(Object.freeze({ oldPath, newPath, hunks }));
  }
  if (!files.length) throw new PatchError('PATCH_NO_FILES', 'no files found in patch');
  const fileKeys = files.map(({ oldPath, newPath }) => `${oldPath ?? '/dev/null'}=>${newPath ?? '/dev/null'}`);
  if (new Set(fileKeys).size !== fileKeys.length) throw new PatchError('PATCH_DUPLICATE_PATH', 'same file appears more than once');
  const paths = files.flatMap(({ oldPath, newPath }) => [oldPath, newPath].filter(Boolean));
  return Object.freeze({ files, patchHash: hash(patch), paths: Object.freeze([...new Set(paths)]) });
}

export function validatePatchTargets(parsed, declaredPaths) {
  const declared = new Set(declaredPaths ?? []);
  const undeclared = parsed.paths.filter((filePath) => !declared.has(filePath));
  if (undeclared.length) throw new PatchError('PATCH_TARGET_UNDECLARED', 'patch changes undeclared files', { undeclared });
  return true;
}
