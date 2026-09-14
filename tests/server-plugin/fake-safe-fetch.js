function makeHeaders(headers = {}) {
  const values = new Headers(headers);
  return values;
}

function makeResponse(spec = {}) {
  const status = spec.status ?? 200;
  const body = spec.body ?? '';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: spec.statusText ?? '',
    headers: makeHeaders(spec.headers),
    url: spec.url ?? '',
    async text() { return text; },
    async json() { return JSON.parse(text); },
    async arrayBuffer() {
      const bytes = Buffer.from(text);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

export function createFakeSafeFetch(responses = []) {
  const queue = [...responses];
  const calls = [];
  const safeRequest = async options => {
    calls.push({
      ...options,
      headers: Object.fromEntries(new Headers(options?.headers).entries()),
    });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(options);
    if (!next) throw new Error('Unexpected safeRequest call');
    return makeResponse({ ...next, url: next.url ?? options.url });
  };
  return { calls, safeRequest };
}
