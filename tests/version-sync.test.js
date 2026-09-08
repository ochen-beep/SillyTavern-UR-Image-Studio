// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

test('version-sync: manifest, package.json and lockfile declare the same version', () => {
    const { version: manifestVersion } = readJson('../manifest.json');
    const pkg = readJson('../package.json');
    const lock = readJson('../package-lock.json');

    assert.equal(pkg.version, manifestVersion, 'package.json version must match manifest.json');
    assert.equal(lock.version, manifestVersion, 'package-lock.json top-level version must match manifest.json');
    assert.equal(lock.packages[''].version, manifestVersion, 'package-lock.json root package version must match manifest.json');
});
