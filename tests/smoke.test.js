// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {} }),
};

const { executeStage1 } = await import('../src/template-runtime.js');

test('stage 1 smoke: base template produces a plain prompt', async () => {
    const result = await executeStage1({
        template: null,
        messageText: 'Aria enters the room.',
        snapshot: {
            msgId: 1,
            contextRevision: 1,
            stage1Descriptions: [],
        },
        generateText: async () => 'A cinematic image prompt.',
    });
    assert.equal(result.templateType, 'base');
    assert.equal(result.prompt, 'A cinematic image prompt.');
    assert.equal(result.structuredDraft, null);
});

test('extension startup has no default server-plugin gate or migration prerequisite', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../index.js', import.meta.url), 'utf8'));

    assert.doesNotMatch(source, /from '\.\/src\/server-connection-state\.js'/);
    assert.doesNotMatch(source, /from '\.\/src\/store-state\.js'/);
    assert.doesNotMatch(source, /from '\.\/src\/store-migration\.js'/);
    assert.doesNotMatch(source, /refreshServerConnectionState\(/);
    assert.doesNotMatch(source, /refreshStoreState\(/);
    assert.doesNotMatch(source, /migrateCollection\(/);
    assert.doesNotMatch(source, /resumePendingServerRequests\(/);
});

test('browser reference UI imports native upload support without the server store facade', async () => {
    const fs = await import('node:fs/promises');
    for (const path of ['../src/ui/gallery-actions.js', '../src/ui/tab-references.js']) {
        const source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /from '\.\.\/server-store-api\.js'/);
        assert.match(source, /from '\.\.\/references\.js'/);
    }
});
