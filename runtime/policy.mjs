const MODE_LEVEL = Object.freeze({ Ask: 1, Plan: 2, Code: 3, Terminal: 4, External: 5 });
const ACTION_LEVEL = Object.freeze({ read: 1, plan: 2, patch: 3, command: 4, external: 5 });
const COMMAND_CLASSES = Object.freeze({ readonly: 'readonly', validation: 'validation', blocked: 'blocked', unknown: 'unknown' });
const READONLY_COMMANDS = new Set(['cat', 'cut', 'find', 'grep', 'head', 'ls', 'pwd', 'sed', 'sort', 'tail']);
const READONLY_GIT_SUBCOMMANDS = new Set(['diff', 'log', 'rev-parse', 'show', 'status']);
const BLOCKED_COMMANDS = new Set(['bash', 'chown', 'curl', 'dd', 'kill', 'mkfs', 'mount', 'powershell', 'rm', 'rmdir', 'sh', 'sudo', 'wget']);

function commandName(argv) {
  return typeof argv?.[0] === 'string' ? argv[0].split(/[\\/]/).pop().toLowerCase() : '';
}

function hasShellSyntax(argv) {
  return argv.slice(1).some((item) => [';', '&&', '||', '|', '>', '<'].includes(item.trim()) || /(^|\s)[;&|<>](?=\s|$)/.test(item) || /(^|\s)(\$\(|`)/.test(item));
}

export function classifyCommand(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some((item) => typeof item !== 'string' || !item)) return Object.freeze({ class: COMMAND_CLASSES.blocked, reason: 'invalid_command' });
  const name = commandName(argv);
  if (hasShellSyntax(argv)) return Object.freeze({ class: COMMAND_CLASSES.blocked, command: name, reason: 'shell_syntax' });
  if (BLOCKED_COMMANDS.has(name)) return Object.freeze({ class: COMMAND_CLASSES.blocked, command: name, reason: 'blocked_command' });
  if (name === 'git' && (argv.includes('push') || argv.includes('reset') && argv.includes('--hard') || argv.includes('clean'))) return Object.freeze({ class: COMMAND_CLASSES.blocked, command: name, reason: 'destructive_git_operation' });
  if (name === 'git') return READONLY_GIT_SUBCOMMANDS.has(argv[1]) ? Object.freeze({ class: COMMAND_CLASSES.readonly, command: name, reason: 'allowlisted_git_subcommand' }) : Object.freeze({ class: COMMAND_CLASSES.blocked, command: name, reason: 'not_allowlisted' });
  if (name === 'npm' && argv.includes('publish')) return Object.freeze({ class: COMMAND_CLASSES.blocked, command: name, reason: 'package_publish' });
  if (READONLY_COMMANDS.has(name)) return Object.freeze({ class: COMMAND_CLASSES.readonly, command: name, reason: 'known_command' });
  return Object.freeze({ class: COMMAND_CLASSES.blocked, command: name, reason: 'not_allowlisted' });
}

export function decide({ mode, actionType, approved = false, targetSensitive = false }) {
  if (!(mode in MODE_LEVEL)) throw new Error(`unknown mode: ${mode}`);
  if (!(actionType in ACTION_LEVEL)) throw new Error(`unknown action type: ${actionType}`);
  const level = ACTION_LEVEL[actionType];
  const modeLevel = MODE_LEVEL[mode];
  const approvalRequired = level >= 3 || targetSensitive;
  const allowed = level <= modeLevel && (!approvalRequired || approved);
  return Object.freeze({ allowed, approvalRequired, reason: allowed ? 'policy_allowed' : level > modeLevel ? 'mode_insufficient' : 'approval_required' });
}

export { ACTION_LEVEL, MODE_LEVEL, COMMAND_CLASSES };
