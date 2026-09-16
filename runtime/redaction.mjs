const SENSITIVE_KEY = /^(?:authorization|bearer|cookie|set-cookie|token|password|passwd|secret|api[_ -]?key|apikey|access[_ -]?key|access[_ -]?token|refresh[_ -]?token|clientsecret|key)$/i;
const SECRET_ASSIGNMENT = /((["']?(?:authorization|bearer|cookie|set-cookie|token|password|passwd|secret|api[_ -]?key|apikey|access[_ -]?key|access[_ -]?token|refresh[_ -]?token|clientsecret|key)["']?\s*[:=]\s*))("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_PREFIX = /\b(?:sk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]+\b/g;

export function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_KEY.test(key.trim());
}

export function redactText(value, maxLength = 16 * 1024) {
  if (typeof value !== 'string') return '';
  let output = value.replace(SECRET_ASSIGNMENT, (match, prefix, rawValue) => {
    const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : '';
    return `${prefix}${quote}[redacted]${quote}`;
  });
  output = output.replace(BEARER_VALUE, 'Bearer [redacted]');
  output = output.replace(TOKEN_PREFIX, '[redacted]');
  return output.length <= maxLength ? output : `${output.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function redactValue(value, { depth = 0, maxDepth = 8, maxStringLength = 16 * 1024 } = {}) {
  if (depth > maxDepth) return '[redacted]';
  if (typeof value === 'string') return redactText(value, maxStringLength);
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => redactValue(item, { depth: depth + 1, maxDepth, maxStringLength }));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 256).map(([key, item]) => [
      redactText(key, 256),
      isSensitiveKey(key) ? '[redacted]' : redactValue(item, { depth: depth + 1, maxDepth, maxStringLength }),
    ]));
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return '[redacted]';
}

export function boundedJson(value, maxBytes, code = 'OUTPUT_LIMIT') {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { const error = new Error('value is not JSON serializable'); error.code = code; throw error; }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    const error = new Error('value exceeds the configured limit');
    error.code = code;
    throw error;
  }
  return encoded;
}
