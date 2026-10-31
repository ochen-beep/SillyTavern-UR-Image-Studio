// @ts-check
// Secret redaction at the surfaces that leave the machine: the log buffer
// (diagnostic dump) and the error feed. Connection URLs carrying `?key=…`,
// userinfo authority and the wider secret-param set must not survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { error, dumpProblemLog } from '../src/core.js';
import { scrubUrl } from '../src/netdump.js';
import { recordUrisError, listUrisErrors } from '../src/error-pool.js';

test('log buffer never carries a key embedded in a connection URL', () => {
    error('gemini.generateText: network error', 'https://gw.test/v1beta?key=AIzaSECRET123', 'boom');
    const dump = dumpProblemLog();
    assert.equal(dump.includes('AIzaSECRET123'), false, 'dump has no key value');
    assert.ok(dump.includes('<redacted>'), 'param value redacted');
    assert.ok(dump.includes('/v1beta'), 'URL path stays for diagnostics');
});

test('userinfo credentials do not survive the log buffer', () => {
    error('basic auth endpoint', 'https://user:pass@gw.test/v1', 'boom');
    const dump = dumpProblemLog();
    assert.equal(dump.includes('user:pass@'), false);
    assert.ok(dump.includes('<redacted>@'));
});

test('netdump scrubUrl clears userinfo and the wider secret-param set', () => {
    const scrubbed = scrubUrl('https://u:p@h.test/x?key=k&sig=s&token=t&ok=1');
    assert.equal(scrubbed.includes('u:p@'), false, 'userinfo stripped');
    assert.ok(scrubbed.includes('key=%3Credacted%3E') || scrubbed.includes('key=<redacted>'), 'key redacted');
    assert.ok(scrubbed.includes('ok=1'), 'non-secret params stay');
    assert.equal(/(?:^|[?&])sig=s/.test(scrubbed), false, 'sig redacted');
});

test('error pool redacts secrets from reported messages', () => {
    recordUrisError({ scope: 'test', message: 'POST https://gw.test/v1?key=TOPSECRET failed' });
    const entry = listUrisErrors().at(-1);
    assert.equal(JSON.stringify(entry).includes('TOPSECRET'), false);
});
