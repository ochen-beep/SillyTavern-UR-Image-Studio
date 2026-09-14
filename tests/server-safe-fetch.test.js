import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerImageError } from '../server-plugin/src/errors.js';
import { safeRequest } from '../server-plugin/src/network/safe-fetch.js';

const publicResolver = async () => ['8.8.8.8'];

function response({ status = 200, statusText = 'OK', headers = {}, body = '' } = {}) {
  const bytes = Buffer.from(body);
  return {
    status,
    statusText,
    headers: new Headers(headers),
    url: 'https://transport.invalid/',
    body: {
      async *[Symbol.asyncIterator]() {
        if (bytes.byteLength) yield bytes;
      },
    },
  };
}

test('awaits beforeDispatch immediately before transport starts the body', async () => {
  const events = [];
  const result = await safeRequest({
    url: 'https://api.example.com/generate',
    method: 'POST',
    body: 'prompt',
    resolver: publicResolver,
    beforeDispatch: async () => {
      events.push('before-start');
      await Promise.resolve();
      events.push('before-done');
    },
    transport: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      events.push('bodyStarted');
      return response({ body: 'ok' });
    },
  });

  assert.deepEqual(events, ['before-start', 'before-done', 'bodyStarted']);
  assert.equal(await result.text(), 'ok');
});

test('uses manual redirects and revalidates an allowed redirect', async () => {
  const resolved = [];
  const calls = [];
  const result = await safeRequest({
    url: 'https://api.example.com/start',
    maxRedirects: 1,
    resolver: async (hostname) => {
      resolved.push(hostname);
      return ['8.8.8.8'];
    },
    transport: async (url, init) => {
      calls.push({ url: String(url), redirect: init.redirect });
      if (calls.length === 1) {
        return response({ status: 302, headers: { location: '/finish' } });
      }
      return response({ body: 'done' });
    },
  });

  assert.deepEqual(resolved, ['api.example.com', 'api.example.com']);
  assert.deepEqual(calls, [
    { url: 'https://api.example.com/start', redirect: 'manual' },
    { url: 'https://api.example.com/finish', redirect: 'manual' },
  ]);
  assert.equal(await result.text(), 'done');
});

test('does not follow redirects unless explicitly enabled', async () => {
  let calls = 0;
  await assert.rejects(
    safeRequest({
      url: 'https://api.example.com/start',
      resolver: publicResolver,
      transport: async () => {
        calls += 1;
        return response({ status: 302, headers: { location: '/finish' } });
      },
    }),
    (error) => error instanceof ServerImageError && error.code === 'TOO_MANY_REDIRECTS',
  );
  assert.equal(calls, 1);
});

test('bounds redirect count', async () => {
  let calls = 0;
  await assert.rejects(
    safeRequest({
      url: 'https://api.example.com/one',
      maxRedirects: 1,
      resolver: publicResolver,
      transport: async () => {
        calls += 1;
        return response({ status: 302, headers: { location: `/${calls + 1}` } });
      },
    }),
    (error) => error instanceof ServerImageError && error.code === 'TOO_MANY_REDIRECTS',
  );
  assert.equal(calls, 2);
});

test('rejects a blocked redirect before a second transport call', async () => {
  let calls = 0;
  await assert.rejects(
    safeRequest({
      url: 'https://api.example.com/start',
      maxRedirects: 1,
      resolver: async (hostname) => hostname === 'blocked.example.com'
        ? ['127.0.0.1']
        : ['8.8.8.8'],
      transport: async () => {
        calls += 1;
        return response({ status: 307, headers: { location: 'https://blocked.example.com/private' } });
      },
    }),
    (error) => error instanceof ServerImageError && error.code === 'DESTINATION_BLOCKED',
  );
  assert.equal(calls, 1);
});

test('disposes redirect bodies before rejecting malformed or disallowed targets', async () => {
  for (const location of ['http://api.example.com/insecure', 'http://[::1']) {
    let destroyed = 0;

    await assert.rejects(
      safeRequest({
        url: 'https://api.example.com/start',
        maxRedirects: 1,
        resolver: publicResolver,
        transport: async () => ({
          ...response({ status: 302, headers: { location } }),
          body: { destroy() { destroyed += 1; } },
        }),
      }),
      (error) => error instanceof ServerImageError && error.code === 'INVALID_REDIRECT',
    );

    assert.equal(destroyed, 1, `redirect body should be disposed for ${location}`);
  }
});

test('strips credentials and key query parameters on cross-origin redirects', async () => {
  const calls = [];
  await safeRequest({
    url: 'https://api.example.com/start',
    maxRedirects: 1,
    headers: {
      authorization: 'Bearer top-secret',
      'x-goog-api-key': 'google-secret',
      'content-type': 'application/json',
    },
    resolver: publicResolver,
    transport: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      if (calls.length === 1) {
        return response({
          status: 302,
          headers: {
            location: 'https://cdn.example.net/result?key=signed-secret&X-Goog-Signature=signature-secret&part=1',
          },
        });
      }
      return response();
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://cdn.example.net/result?part=1');
  assert.equal(calls[1].headers.has('authorization'), false);
  assert.equal(calls[1].headers.has('x-goog-api-key'), false);
  assert.equal(calls[1].headers.get('content-type'), 'application/json');
});

test('rejects an oversized request before transport dispatch', async () => {
  let calls = 0;
  await assert.rejects(
    safeRequest({
      url: 'https://api.example.com/generate',
      method: 'POST',
      body: '12345',
      maxRequestBytes: 4,
      resolver: publicResolver,
      transport: async () => {
        calls += 1;
        return response();
      },
    }),
    (error) => error instanceof ServerImageError && error.code === 'REQUEST_TOO_LARGE',
  );
  assert.equal(calls, 0);
});

test('cancels the response body when Content-Length exceeds the limit', async () => {
  let cancelled = 0;
  const bounded = await safeRequest({
    url: 'https://api.example.com/result',
    maxResponseBytes: 4,
    resolver: publicResolver,
    transport: async () => ({
      ...response({ headers: { 'content-length': '5' } }),
      body: { cancel() { cancelled += 1; } },
    }),
  });

  await assert.rejects(bounded.arrayBuffer(), (error) => error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(cancelled, 1);
});

test('rejects response bodies without a bounded streaming API', async () => {
  let arrayBufferCalls = 0;
  const bounded = await safeRequest({
    url: 'https://api.example.com/result',
    resolver: publicResolver,
    transport: async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      async arrayBuffer() {
        arrayBufferCalls += 1;
        return new ArrayBuffer(100);
      },
    }),
  });

  await assert.rejects(bounded.arrayBuffer(), (error) => error.code === 'UNBOUNDED_RESPONSE_BODY');
  assert.equal(arrayBufferCalls, 0);
});

test('bounds and caches response consumption', async () => {
  let reads = 0;
  const bounded = await safeRequest({
    url: 'https://api.example.com/result',
    maxResponseBytes: 4,
    resolver: publicResolver,
    transport: async () => ({
      ...response(),
      body: {
        async *[Symbol.asyncIterator]() {
          reads += 1;
          yield Buffer.from('12345');
        },
      },
    }),
  });

  await assert.rejects(
    bounded.arrayBuffer(),
    (error) => error instanceof ServerImageError && error.code === 'RESPONSE_TOO_LARGE',
  );
  await assert.rejects(bounded.text(), (error) => error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(reads, 1);
});

test('propagates caller AbortSignal to transport', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const pending = safeRequest({
    url: 'https://api.example.com/result',
    signal: controller.signal,
    resolver: publicResolver,
    transport: async (_url, init) => {
      receivedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('caller secret reason'));
  await assert.rejects(pending, (error) => error instanceof ServerImageError && error.code === 'REQUEST_ABORTED');
  assert.equal(receivedSignal.aborted, true);
});

test('times out promptly while DNS resolution is stalled', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    safeRequest({
      url: 'https://api.example.com/result',
      timeoutMs: 10,
      resolver: async () => new Promise(() => {}),
      transport: async () => response(),
    }),
    (error) => error instanceof ServerImageError && error.code === 'REQUEST_TIMEOUT',
  );
  assert.ok(Date.now() - startedAt < 500, 'DNS timeout should settle promptly');
});

test('aborts transport when timeout elapses', async () => {
  let receivedSignal;
  await assert.rejects(
    safeRequest({
      url: 'https://api.example.com/result',
      timeoutMs: 10,
      resolver: publicResolver,
      transport: async (_url, init) => {
        receivedSignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      },
    }),
    (error) => error instanceof ServerImageError && error.code === 'REQUEST_TIMEOUT',
  );
  assert.equal(receivedSignal.aborted, true);
});

test('keeps timeout active while consuming the response body', async () => {
  const bounded = await safeRequest({
    url: 'https://api.example.com/result',
    timeoutMs: 10,
    resolver: publicResolver,
    transport: async (_url, init) => ({
      ...response(),
      body: {
        async *[Symbol.asyncIterator]() {
          await new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        },
      },
    }),
  });

  await assert.rejects(
    bounded.arrayBuffer(),
    (error) => error instanceof ServerImageError && error.code === 'REQUEST_TIMEOUT',
  );
});

test('wraps response body failures without leaking their messages', async () => {
  const bounded = await safeRequest({
    url: 'https://api.example.com/result',
    resolver: publicResolver,
    transport: async () => ({
      ...response(),
      body: {
        async *[Symbol.asyncIterator]() {
          throw new Error('data:image/png;base64,RESPONSE_SECRET');
        },
      },
    }),
  });

  await assert.rejects(bounded.text(), (error) => {
    assert.ok(error instanceof ServerImageError);
    assert.equal(error.code, 'OUTBOUND_RESPONSE_FAILED');
    assert.equal(error.message.includes('RESPONSE_SECRET'), false);
    return true;
  });
});

test('does not automatically retry transport failures', async () => {
  let calls = 0;
  await assert.rejects(
    safeRequest({
      url: 'https://api.example.com/result',
      resolver: publicResolver,
      transport: async () => {
        calls += 1;
        throw new Error('connection failed');
      },
    }),
    (error) => error instanceof ServerImageError && error.code === 'OUTBOUND_REQUEST_FAILED',
  );
  assert.equal(calls, 1);
});

test('redacts credential query values from transport diagnostics', async () => {
  const secret = 'gemini-native-query-secret';
  const diagnostics = [];
  const originalConsoleError = console.error;
  console.error = (...args) => diagnostics.push(args.map(String).join(' '));

  try {
    await assert.rejects(
      safeRequest({
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=${secret}`,
        resolver: publicResolver,
        transport: async () => {
          throw new Error(`transport failed for https://user:password@generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=${secret}`);
        },
      }),
      (error) => error instanceof ServerImageError && error.code === 'OUTBOUND_REQUEST_FAILED',
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(diagnostics.join('\n').includes(secret), false);
  assert.equal(diagnostics.join('\n').includes('password'), false);
});

test('returns safe errors without request secrets', async () => {
  const secrets = [
    'Bearer auth-secret',
    'private prompt words',
    'data:image/png;base64,AAA_SECRET',
    'signed-query-secret',
  ];

  await assert.rejects(
    safeRequest({
      url: `https://api.example.com/result?X-Goog-Signature=${secrets[3]}`,
      method: 'POST',
      headers: { authorization: secrets[0] },
      body: JSON.stringify({ prompt: secrets[1], image: secrets[2] }),
      resolver: publicResolver,
      transport: async () => {
        throw new Error(secrets.join(' | '));
      },
    }),
    (error) => {
      assert.ok(error instanceof ServerImageError);
      for (const secret of secrets) assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
