import { createToolRegistry, LEGACY_TO_CANONICAL, ToolRegistryError } from './tool-registry.mjs';

// Compatibility facade for the original three-tool API. New code should use
// createToolRegistry so mode and session boundaries are explicit.
export class WorkspaceToolError extends ToolRegistryError {}

const LEGACY_TO_NEW = LEGACY_TO_CANONICAL;
const NEW_TO_LEGACY = Object.freeze(Object.fromEntries(Object.entries(LEGACY_TO_NEW).map(([legacy, current]) => [current, legacy])));

export function createWorkspaceToolRegistry({ root, audit, onProposal } = {}) {
  const registry = createToolRegistry({ root, audit, onProposal });
  const names = () => Object.freeze(Object.keys(LEGACY_TO_NEW));
  const definitions = () => Object.freeze(registry.definitions({ mode: 'Ask' }).map((definition) => {
    const name = definition.function.name;
    const legacy = NEW_TO_LEGACY[name];
    return legacy ? { ...definition, function: { ...definition.function, name: legacy } } : definition;
  }).filter((definition) => names().includes(definition.function.name)));
  async function call(first, second) {
    if (typeof first === 'string') {
      const current = LEGACY_TO_NEW[first];
      if (!current) throw new WorkspaceToolError('TOOL_NOT_ALLOWED', 'tool is not allowlisted');
      let input = second ?? {};
      if (current === 'workspace.read_files') input = { paths: [input.path] };
      const result = await registry.call({ mode: 'Ask', name: current, input });
      if (current === 'workspace.read_files') return { path: result.files[0].path, content: result.files[0].content };
      if (current === 'workspace.list_directory') {
        const scope = typeof input.path === 'string' ? input.path.replaceAll('\\', '/').replace(/\/$/, '') : '';
        const files = scope && scope !== '.' && !result.entries.some((entry) => entry.path === scope)
          ? [{ path: scope, type: 'directory' }, ...result.entries]
          : result.entries;
        return { files };
      }
      return result;
    }
    if (first && typeof first === 'object') {
      const current = LEGACY_TO_NEW[first.name] ?? first.name;
      let input = first.input ?? {};
      const legacyRead = current === 'workspace.read_files' && first.name === 'workspace.read_file';
      if (legacyRead) input = { paths: [input.path] };
      const result = await registry.call({ ...first, name: current, input });
      return legacyRead ? { path: result.files[0].path, content: result.files[0].content } : result;
    }
    throw new WorkspaceToolError('TOOL_INPUT_INVALID', 'tool call is invalid');
  }
  return Object.freeze({ names, definitions, call });
}
