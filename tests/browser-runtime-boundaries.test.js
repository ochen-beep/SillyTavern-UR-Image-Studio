// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
async function source(path) {
    return readFile(new URL(path, root), 'utf8');
}

test('route IDs use a synchronous browser-compatible derivation', async () => {
    const schema = await source('src/image-connection-schema.js');
    assert.doesNotMatch(schema, /node:crypto|crypto\.createHash/);
});

test('normal connection lookup does not inspect legacy localforage server records', async () => {
    const connections = await source('src/connections.js');
    assert.doesNotMatch(connections, /getLegacyServerConnection|uris_connections/);
});

test('ordinary v7 backup paths are plugin-free', async () => {
    const dataPort = await source('src/data-port.js');
    assert.doesNotMatch(dataPort, /server-image-api\.js/);
    assert.doesNotMatch(dataPort, /exportServerConnections|importServerConnections|rollbackServerImport/);
});

test('normal browser generation has no legacy server dispatch or recovery dependency', async () => {
    const stage2 = await source('src/pipeline-stage2.js');
    const generateTab = await source('src/ui/tab-generate.js');
    const imageApi = await source('src/image-api.js');
    assert.doesNotMatch(stage2, /server-image-api\.js|savePendingServerRequest|materializeServerResult/);
    assert.doesNotMatch(generateTab, /from '\.\/image-recovery\.js'|resumeServerRequest|PendingServer/);
    assert.doesNotMatch(imageApi, /from '\.\/image-recovery\.js'/);
});
