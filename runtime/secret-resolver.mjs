const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const KEYCHAIN_NAME = /^[A-Za-z0-9._:-]{1,127}$/;
const MAX_REF_LENGTH = 256;
const MAX_SECRET_LENGTH = 8192;

export class SecretResolverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretResolverError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SecretResolverError(code, message);
}

export function parseSecretRef(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_REF_LENGTH || /[\0\r\n]/.test(value)) fail('SECRET_REF_INVALID', 'secret reference is invalid');
  const separator = value.indexOf(':');
  const kind = separator > 0 ? value.slice(0, separator) : '';
  const name = separator > 0 ? value.slice(separator + 1) : '';
  if ((kind !== 'env' || !ENV_NAME.test(name)) && (kind !== 'keychain' || !KEYCHAIN_NAME.test(name))) fail('SECRET_REF_INVALID', 'secret reference is invalid');
  return Object.freeze({ kind, name });
}

function validateResolvedValue(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_SECRET_LENGTH || /[\0\r\n]/.test(value)) fail('SECRET_VALUE_INVALID', 'secret reference did not resolve to a usable value');
  return value;
}

export function createSecretResolver({ env = process.env, keychainProvider } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new SecretResolverError('SECRET_ENV_INVALID', 'secret environment source is invalid');
  if (keychainProvider !== undefined && typeof keychainProvider !== 'function') throw new SecretResolverError('SECRET_PROVIDER_INVALID', 'keychain provider is invalid');
  return Object.freeze({
    async resolve(secretRef, { signal } = {}) {
      if (signal?.aborted) fail('SECRET_ABORTED', 'secret reference could not be resolved');
      const parsed = parseSecretRef(secretRef);
      if (parsed.kind === 'env') {
        if (!Object.prototype.hasOwnProperty.call(env, parsed.name)) fail('SECRET_NOT_FOUND', 'secret reference could not be resolved');
        return validateResolvedValue(env[parsed.name]);
      }
      if (!keychainProvider) fail('SECRET_PROVIDER_UNAVAILABLE', 'secret reference could not be resolved');
      let value;
      try { value = await keychainProvider(parsed.name, { signal }); } catch { fail('SECRET_PROVIDER_FAILED', 'secret reference could not be resolved'); }
      if (value === null || value === undefined) fail('SECRET_NOT_FOUND', 'secret reference could not be resolved');
      return validateResolvedValue(value);
    },
  });
}
