import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCloudEndpoint } from '../server-plugin/src/network/endpoint.js';
import {
  isBlockedAddress,
  resolveAllowedDestination,
} from '../server-plugin/src/network/destination-policy.js';

const acceptedEndpoints = [
  'https://api.example.com',
  'https://api.example.com/v1',
  'https://api.example.com/custom/v1',
  'https://api.example.com:8443/custom',
];

for (const endpoint of acceptedEndpoints) {
  test(`accepts endpoint ${endpoint}`, () => {
    const url = normalizeCloudEndpoint(endpoint);
    assert.equal(url.protocol, 'https:');
  });
}

test('preserves custom endpoint path and explicit port', () => {
  const url = normalizeCloudEndpoint('https://api.example.com:8443/custom/v1');
  assert.equal(url.port, '8443');
  assert.equal(url.pathname, '/custom/v1');
});

const rejectedEndpoints = [
  'http://api.example.com',
  'https://user:pass@api.example.com',
  'https://api.example.com/path?token=x',
  'https://api.example.com/path#fragment',
  'file:///tmp/a',
];

for (const endpoint of rejectedEndpoints) {
  test(`rejects endpoint ${endpoint}`, () => {
    assert.throws(
      () => normalizeCloudEndpoint(endpoint),
      (error) => error.code === 'INVALID_ENDPOINT',
    );
  });
}

const blockedAddresses = [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.0.1',
  '169.254.169.254',
  '0.0.0.0',
  '::1',
  '::',
  'fc00::1',
  'fe80::1',
  '::ffff:127.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:7f00:1',
  '::ffff:a9fe:a9fe',
  '100.64.0.1',
  '100.100.100.200',
  '100.127.255.254',
  '192.0.0.1',
  '192.0.0.170',
  '192.0.2.1',
  '198.18.0.1',
  '198.19.255.254',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '240.0.0.1',
  '255.255.255.255',
  'ff02::1',
];

for (const address of blockedAddresses) {
  test(`blocks destination ${address}`, () => {
    assert.equal(isBlockedAddress(address), true);
  });
}

for (const address of ['8.8.8.8', '2606:4700:4700::1111']) {
  test(`allows public destination ${address}`, () => {
    assert.equal(isBlockedAddress(address), false);
  });
}

test('returns validated resolved addresses', async () => {
  const addresses = await resolveAllowedDestination(
    new URL('https://api.example.com'),
    async () => ['8.8.8.8'],
  );
  assert.deepEqual(addresses, ['8.8.8.8']);
});

test('rejects a blocked resolved address', async () => {
  await assert.rejects(
    resolveAllowedDestination(new URL('https://api.example.com'), async () => ['127.0.0.1']),
    (error) => error.code === 'DESTINATION_BLOCKED',
  );
});

test('rejects a mixed public and blocked DNS result', async () => {
  await assert.rejects(
    resolveAllowedDestination(
      new URL('https://api.example.com'),
      async () => ['8.8.8.8', '10.0.0.1'],
    ),
    (error) => error.code === 'DESTINATION_BLOCKED',
  );
});
