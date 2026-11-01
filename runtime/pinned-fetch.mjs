import https from 'node:https';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function headersForRequest(headers) {
  if (!headers) return undefined;
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return headers;
}

/**
 * Turn the result of dns.lookup(..., { all: true }) into a lookup callback
 * backed only by the already checked addresses. It never performs another DNS
 * query, which closes the lookup/fetch rebinding window.
 */
export function createPinnedLookup(resolved = []) {
  const entries = (Array.isArray(resolved) ? resolved : [resolved])
    .map((entry) => ({ address: typeof entry === 'string' ? entry : entry?.address, family: typeof entry === 'object' ? entry?.family : undefined }))
    .filter((entry) => typeof entry.address === 'string' && isIP(entry.address));
  return (_hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof callback !== 'function') throw new TypeError('lookup callback is required');
    const family = Number.isSafeInteger(options?.family) ? options.family : 0;
    const matching = family === 4 || family === 6 ? entries.filter((entry) => entry.family === family || isIP(entry.address) === family) : entries;
    if (!matching.length) {
      const error = Object.assign(new Error('No checked provider address is available'), { code: 'ENOTFOUND', hostname: _hostname });
      callback(error);
      return;
    }
    if (options?.all === true) callback(null, matching.map((entry) => ({ address: entry.address, family: entry.family || isIP(entry.address) })));
    else {
      const entry = matching[0];
      callback(null, entry.address, entry.family || isIP(entry.address));
    }
  };
}

/**
 * Minimal fetch-compatible HTTPS transport. The URL hostname remains intact
 * for TLS SNI/certificate validation, while node:https connects through the
 * caller-supplied pinned lookup callback.
 */
export function createPinnedHttpsFetch() {
  return function pinnedHttpsFetch(input, options = {}) {
    let url;
    try { url = new URL(String(input)); } catch { return Promise.reject(new TypeError('invalid URL')); }
    if (url.protocol !== 'https:') return Promise.reject(new TypeError('only HTTPS model endpoints are supported'));
    if (options.signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeResponse;
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        const error = abortError();
        if (!settled) {
          request.destroy(error);
          settled = true;
          cleanup();
          reject(error);
          return;
        }
        activeResponse?.destroy(error);
      };
      const request = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers: headersForRequest(options.headers),
        lookup: options.lookup,
        ...(options.ca !== undefined ? { ca: options.ca } : {}),
        // Keep the original hostname for certificate verification and SNI.
        servername: url.hostname,
      }, (response) => {
        activeResponse = response;
        const headers = {};
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
        const body = Readable.toWeb(response);
        response.once('close', cleanup);
        try {
          settled = true;
          resolve(new Response(body, { status: response.statusCode ?? 0, statusText: response.statusMessage ?? '', headers }));
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      request.once('error', (error) => {
        cleanup();
        if (!settled) { settled = true; reject(error); }
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.body !== undefined && options.body !== null) request.write(options.body);
      request.end();
    });
  };
}

export const pinnedHttpsFetch = createPinnedHttpsFetch();
