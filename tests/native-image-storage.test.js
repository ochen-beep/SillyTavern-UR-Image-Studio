// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

let originalFetch;
let originalSt;

beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalSt = globalThis.SillyTavern;
    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ Authorization: 'Bearer st-token' }),
        }),
    };
    // The gallery card store is a module-level singleton, and every test builds
    // its own SillyTavern context — drop the loaded mirror between tests or
    // cards from an earlier case leak into later assertions.
    const { resetGalleryStoreForTests } = await import('../src/gallery-index.js');
    resetGalleryStoreForTests();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalSt;
});

test('uploads generated data URL bytes to the dedicated native folder', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: 'user/images/UR%20Image%20Studio/uris_card.png' }) };
    };
    const { uploadGeneratedImage } = await import('../src/native-image-storage.js');

    const path = await uploadGeneratedImage('data:image/png;base64,aGVsbG8=', { filename: 'uris_card' });

    assert.equal(path, 'user/images/UR%20Image%20Studio/uris_card.png');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/images/upload');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(calls[0].options.headers, { Authorization: 'Bearer st-token', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        image: 'aGVsbG8=', format: 'png', ch_name: 'UR Image Studio', filename: 'uris_card',
    });
});

test('canonicalizes literal-space upload responses and leading-slash list entries', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/images/upload') return { ok: true, json: async () => ({ path: 'user/images/UR Image Studio/space name.png' }) };
        return { ok: true, json: async () => ['/user/images/UR%20Image%20Studio/space%20name.png', 'space name.png'] };
    };
    const { uploadGeneratedImage, listNativeImages } = await import('../src/native-image-storage.js');

    const uploaded = await uploadGeneratedImage('data:image/png;base64,aGVsbG8=', { filename: 'space name' });
    const listed = await listNativeImages();

    assert.equal(uploaded, 'user/images/UR%20Image%20Studio/space%20name.png');
    assert.deepEqual(listed, ['user/images/UR%20Image%20Studio/space%20name.png']);
    assert.equal(calls[0].url, '/api/images/upload');
});

test('rejects invalid upload response paths without accepting foreign files', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ path: 'https://evil.example/file.png' }) });
    const { uploadGeneratedImage } = await import('../src/native-image-storage.js');
    await assert.rejects(() => uploadGeneratedImage('data:image/png;base64,aGVsbG8='), /native image path/);
});


test('lists only safe native image paths from ST filenames', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ['uris_one.png', '../escape.png', 'manual.webp'] });
    const { listNativeImages } = await import('../src/native-image-storage.js');

    assert.deepEqual(await listNativeImages(), [
        'user/images/UR%20Image%20Studio/uris_one.png',
        'user/images/UR%20Image%20Studio/manual.webp',
    ]);
});

test('materializes a URL result through downloadResult before native upload', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === 'https://images.example/result.webp') {
            return { ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/webp' }) };
        }
        return { ok: true, json: async () => ({ path: 'user/images/UR%20Image%20Studio/uris_download.webp' }) };
    };
    const { materializeImageResult } = await import('../src/native-image-storage.js');

    const path = await materializeImageResult({ kind: 'url', value: 'https://images.example/result.webp' }, { filename: 'uris_download' });

    assert.equal(path, 'user/images/UR%20Image%20Studio/uris_download.webp');
    assert.equal(calls[0].url, 'https://images.example/result.webp');
    assert.equal(calls[1].url, '/api/images/upload');
    assert.deepEqual(JSON.parse(calls[1].options.body), {
        image: Buffer.from('image-bytes').toString('base64'), format: 'webp', ch_name: 'UR Image Studio', filename: 'uris_download',
    });
});

test('materializing an external URL applies timeoutMs to download and native upload', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timeouts = [];
    globalThis.setTimeout = (callback, delay, ...args) => {
        timeouts.push(delay);
        return originalSetTimeout(callback, delay, ...args);
    };
    globalThis.fetch = async (url) => {
        if (url === 'https://images.example/timed-result.png') {
            return { ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }) };
        }
        return { ok: true, json: async () => ({ path: 'user/images/UR%20Image%20Studio/uris_timed.png' }) };
    };
    try {
        const { materializeImageResult } = await import('../src/native-image-storage.js');
        await materializeImageResult(
            { kind: 'url', value: 'https://images.example/timed-result.png' },
            { filename: 'uris_timed', timeoutMs: 4321 },
        );
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }

    assert.deepEqual(timeouts, [4321, 4321]);
});

test('materializes a direct data URL result through the same native upload boundary', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: 'user/images/UR%20Image%20Studio/uris_data.png' }) };
    };
    const { materializeImageResult } = await import('../src/native-image-storage.js');

    const path = await materializeImageResult('data:image/png;base64,aGVsbG8=', { filename: 'uris_data' });

    assert.equal(path, 'user/images/UR%20Image%20Studio/uris_data.png');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/images/upload');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        image: 'aGVsbG8=', format: 'png', ch_name: 'UR Image Studio', filename: 'uris_data',
    });
});

test('gallery facade materializes legacy provider URLs before indexing a native path', async () => {
    const calls = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {},
            getRequestHeaders: () => ({ Authorization: 'Bearer st-token' }),
            saveSettingsDebounced: () => {},
        }),
    };
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === 'https://images.example/legacy.png') {
            return { ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }) };
        }
        return { ok: true, json: async () => ({ path: 'user/images/UR%20Image%20Studio/uris_legacy.png' }) };
    };
    const { addToGallery } = await import('../src/storage.js');

    const card = await addToGallery('chat-1', { id: 'legacy', src: 'https://images.example/legacy.png', prompt: 'portrait' });

    assert.equal(card.imagePath, 'user/images/UR%20Image%20Studio/uris_legacy.png');
    assert.equal(card.src, 'user/images/UR%20Image%20Studio/uris_legacy.png');
    // Cards live in a server file now, so the user-files traffic (probe, read,
    // index write) is expected noise here — this case is about materialization order.
    const materializationCalls = calls
        .map(call => call.url)
        .filter(url => !String(url).startsWith('/api/files/') && !String(url).startsWith('/user/files/'));
    assert.deepEqual(materializationCalls, ['https://images.example/legacy.png', '/api/images/upload']);
});

test('gallery authority is shared index only and clearGallery removes only the active chat cards', async () => {
    const writes = [];
    const context = {
        extensionSettings: {},
        getRequestHeaders: () => ({ Authorization: 'Bearer st-token' }),
        saveSettingsDebounced: () => {},
    };
    globalThis.SillyTavern = {
        getContext: () => context,
        libs: {
            localforage: {
                getItem: async () => [{ id: 'legacy', src: 'data:image/png;base64,legacy' }],
                setItem: async (...args) => writes.push(args),
                removeItem: async (...args) => writes.push(args),
            },
        },
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => ['one.png', 'two.png'] });
    const { addToGallery, clearGallery, getGallery } = await import('../src/storage.js');

    await addToGallery('chat-a', { id: 'a', imagePath: 'user/images/UR%20Image%20Studio/one.png', prompt: 'one' });
    await addToGallery('chat-b', { id: 'b', imagePath: 'user/images/UR%20Image%20Studio/two.png', prompt: 'two' });
    const freshBrowserCards = await getGallery('chat-a');
    await clearGallery('chat-a');

    assert.deepEqual(freshBrowserCards.map(card => card.id), ['a']);
    assert.deepEqual((await getGallery('chat-a')).map(card => card.id), []);
    assert.deepEqual((await getGallery('chat-b')).map(card => card.id), ['b']);
    assert.deepEqual(writes, []);
    assert.equal(JSON.stringify(context.extensionSettings).includes('data:image'), false);
});

test('gallery mutations cannot cross chat ownership boundaries', async () => {
    const context = {
        extensionSettings: {},
        getRequestHeaders: () => ({ Authorization: 'Bearer st-token' }),
        saveSettingsDebounced: () => {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async () => ({ ok: true, json: async () => ['one.png'] });
    const { addToGallery, getGallery, removeFromGallery, updateGalleryEntry } = await import('../src/storage.js');

    await addToGallery('chat-a', {
        id: 'owned-by-a', imagePath: 'user/images/UR%20Image%20Studio/one.png', prompt: 'original',
    });

    assert.equal(await removeFromGallery('chat-b', 'owned-by-a'), false);
    assert.equal(await updateGalleryEntry('chat-b', 'owned-by-a', { prompt: 'forged' }), null);
    assert.deepEqual((await getGallery('chat-a')).map(card => card.prompt), ['original']);
});

test('addToGallery keeps passed chat ownership over supplied provenance', async () => {
    const context = {
        extensionSettings: {},
        getRequestHeaders: () => ({ Authorization: 'Bearer st-token' }),
        saveSettingsDebounced: () => {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async () => ({ ok: true, json: async () => ['one.png'] });
    const { addToGallery, getGallery } = await import('../src/storage.js');

    const card = await addToGallery('chat-a', {
        id: 'authoritative-owner',
        imagePath: 'user/images/UR%20Image%20Studio/one.png',
        sourceMsgId: 42,
        provenance: { chatId: 'chat-b', sourceMsgId: 99, requestId: 'request-1' },
    });

    assert.deepEqual(card.provenance, { chatId: 'chat-a', sourceMsgId: 42, requestId: 'request-1' });
    assert.deepEqual((await getGallery('chat-a')).map(item => item.id), ['authoritative-owner']);
    assert.deepEqual(await getGallery('chat-b'), []);
});

test('addToGallery rejects a foreign chat ID collision before materializing an image', async () => {
    const context = {
        extensionSettings: {},
        getRequestHeaders: () => ({ Authorization: 'Bearer st-token' }),
        saveSettingsDebounced: () => {},
    };
    const calls = [];
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url) => {
        calls.push(url);
        return { ok: true, json: async () => ({ path: 'user/images/UR%20Image%20Studio/forbidden.png' }) };
    };
    const { addToGallery, getGallery } = await import('../src/storage.js');

    await addToGallery('chat-a', {
        id: 'shared-id',
        imagePath: 'user/images/UR%20Image%20Studio/original.png',
        prompt: 'original',
    });

    await assert.rejects(
        () => addToGallery('chat-b', { id: 'shared-id', src: 'data:image/png;base64,aGVsbG8=', prompt: 'forged' }),
        /belongs to another chat/,
    );

    // No materialization may happen before the collision is rejected. Card-file
    // traffic (probe, read) is storage plumbing, not materialization.
    const materializationCalls = calls
        .filter(url => !String(url).startsWith('/api/files/') && !String(url).startsWith('/user/files/'));
    assert.deepEqual(materializationCalls, []);
    assert.deepEqual((await getGallery('chat-a')).map(card => ({ id: card.id, prompt: card.prompt, imagePath: card.imagePath })), [
        { id: 'shared-id', prompt: 'original', imagePath: 'user/images/UR%20Image%20Studio/original.png' },
    ]);
    assert.deepEqual(await getGallery('chat-b'), []);
});

test('uploads to a character folder when ch_name is provided', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: 'user/images/Alice/uris_card.png' }) };
    };
    const { uploadGeneratedImage } = await import('../src/native-image-storage.js');

    const path = await uploadGeneratedImage('data:image/png;base64,aGVsbG8=', { filename: 'uris_card', ch_name: 'Alice' });

    assert.equal(path, 'user/images/Alice/uris_card.png');
    assert.deepEqual(JSON.parse(calls[0].options.body).ch_name, 'Alice');
});

test('defaults to the legacy folder when ch_name is omitted', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ path: 'user/images/UR%20Image%20Studio/x.png' }) });
    const { uploadGeneratedImage } = await import('../src/native-image-storage.js');
    const path = await uploadGeneratedImage('data:image/png;base64,aGVsbG8=', { filename: 'x' });
    assert.equal(path, 'user/images/UR%20Image%20Studio/x.png');
});

test('lists native images in a specified folder', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ['portrait.png'] };
    };
    const { listNativeImages } = await import('../src/native-image-storage.js');
    const paths = await listNativeImages({ folder: 'Alice' });
    assert.deepEqual(paths, ['user/images/Alice/portrait.png']);
    assert.equal(calls[0].body.folder, 'Alice');
});

test('getCharacterImageFolder resolves character name for solo chats', async () => {
    globalThis.SillyTavern = {
        getContext: () => ({
            chatId: 'test-chat',
            characterId: 0,
            characters: [{ name: 'Alice' }],
            groupId: null,
        }),
    };
    const { getCharacterImageFolder } = await import('../src/native-image-storage.js');
    assert.equal(getCharacterImageFolder(), 'Alice');
});

test('getCharacterImageFolder resolves group_ prefix for group chats', async () => {
    globalThis.SillyTavern = {
        getContext: () => ({
            chatId: 'test-chat',
            characterId: null,
            characters: [],
            groupId: 'group123',
        }),
    };
    const { getCharacterImageFolder } = await import('../src/native-image-storage.js');
    assert.equal(getCharacterImageFolder(), 'group_group123');
});

test('getCharacterImageFolder falls back to the legacy folder when no character or group', async () => {
    globalThis.SillyTavern = {
        getContext: () => ({ chatId: 'test-chat', characterId: null, characters: [], groupId: null }),
    };
    const { getCharacterImageFolder, NATIVE_GALLERY_FOLDER } = await import('../src/native-image-storage.js');
    assert.equal(getCharacterImageFolder(), NATIVE_GALLERY_FOLDER);
});

test('getCharacterImageFolder uses the studio folder when no chat is open', async () => {
    globalThis.SillyTavern = {
        getContext: () => ({ characterId: null, characters: [], groupId: null }),
    };
    const { getCharacterImageFolder } = await import('../src/native-image-storage.js');
    const { STUDIO_IMAGE_FOLDER } = await import('../src/studio-scope.js');
    assert.equal(getCharacterImageFolder(), STUDIO_IMAGE_FOLDER);
});

test('getGallery excludes hidden cards but keeps them in the shared index', async () => {
    const context = { extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { getItem: async () => '' } } };
    globalThis.fetch = async () => ({ ok: true, json: async () => [] });
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const { getGallery } = await import('../src/storage.js');

    await addCard({ id: 'vis', imagePath: 'user/images/Alice/vis.png', prompt: 'visible', provenance: { chatId: 'c1' } });
    await addCard({ id: 'hid', imagePath: 'user/images/Alice/hid.png', prompt: 'hidden', hidden: true, provenance: { chatId: 'c1' } });

    const visible = await getGallery('c1');
    assert.deepEqual(visible.map(c => c.id), ['vis']);
    const all = await listCards({ reconcile: false });
    assert.deepEqual(all.map(c => c.id).sort(), ['hid', 'vis']);
});

test('deleteGalleryCard hides the card when deleteFile is false', async () => {
    const context = { extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { getItem: async () => '' } } };
    globalThis.fetch = async () => ({ ok: true, json: async () => [] });
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const { deleteGalleryCard, getGallery } = await import('../src/storage.js');

    await addCard({ id: 'd1', imagePath: 'user/images/Alice/x.png', prompt: 'p', provenance: { chatId: 'c1' } });
    const result = await deleteGalleryCard('c1', 'd1', { deleteFile: false });

    assert.equal(result, true);
    assert.deepEqual((await getGallery('c1')).map(c => c.id), []);
    const all = await listCards({ reconcile: false });
    assert.equal(all.find(c => c.id === 'd1').hidden, true);
});

test('deleteGalleryCard removes the card and deletes the file when deleteFile is true', async () => {
    const calls = [];
    const context = { extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { getItem: async () => '' } } };
    globalThis.fetch = async (url, options) => {
        calls.push({ url, body: options ? JSON.parse(options.body) : null });
        return { ok: true, json: async () => [] };
    };
    const { addCard } = await import('../src/gallery-index.js');
    const { deleteGalleryCard, getGallery } = await import('../src/storage.js');

    await addCard({ id: 'd2', imagePath: 'user/images/Alice/y.png', prompt: 'p', provenance: { chatId: 'c1' } });
    const result = await deleteGalleryCard('c1', 'd2', { deleteFile: true });

    assert.equal(result, true);
    assert.deepEqual((await getGallery('c1')).map(c => c.id), []);
    const deleteCall = calls.find(c => c.url === '/api/images/delete');
    assert.ok(deleteCall, 'called /api/images/delete');
    assert.deepEqual(deleteCall.body, { path: 'user/images/Alice/y.png' });
});

test('deleteGalleryCard degrades to hide when the file path is shared by another card', async () => {
    const calls = [];
    const context = { extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { getItem: async () => '' } } };
    globalThis.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => [] }; };
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const { deleteGalleryCard } = await import('../src/storage.js');

    await addCard({ id: 's1', imagePath: 'user/images/Alice/shared.png', prompt: 'p1', provenance: { chatId: 'c1' } });
    await addCard({ id: 's2', imagePath: 'user/images/Alice/shared.png', prompt: 'p2', provenance: { chatId: 'c1' } });

    const result = await deleteGalleryCard('c1', 's1', { deleteFile: true });

    assert.equal(result, true);
    assert.equal(calls.includes('/api/images/delete'), false, 'did not delete the shared file');
    const all = await listCards({ reconcile: false });
    assert.equal(all.find(c => c.id === 's1').hidden, true, 's1 hidden instead');
    assert.equal(all.find(c => c.id === 's2').hidden, false, 's2 untouched');
});

test('makeThumbnailForPath uploads a small webp variant into the dedicated thumbs folder', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === 'user/images/UR%20Image%20Studio/big.png') {
            return { ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }) };
        }
        return { ok: true, json: async () => ({ path: 'user/images/URIS_Thumbs/uris_req_thumb.webp' }) };
    };
    const { makeThumbnailForPath } = await import('../src/native-image-storage.js');
    const optimizeCalls = [];

    const thumbPath = await makeThumbnailForPath('user/images/UR%20Image%20Studio/big.png', {
        filename: 'uris_req',
        _optimize: async (input, opts) => {
            optimizeCalls.push(opts);
            return { blob: new Blob(['thumb-bytes'], { type: 'image/webp' }) };
        },
    });

    assert.equal(thumbPath, 'user/images/URIS_Thumbs/uris_req_thumb.webp');
    assert.equal(optimizeCalls[0].maxEdge, 512);
    assert.match(optimizeCalls[0].version, /^thumb-v1-/);
    const upload = calls.find(call => call.url === '/api/images/upload');
    const body = JSON.parse(upload.options.body);
    assert.equal(body.ch_name, 'URIS_Thumbs', 'миниатюры живут в отдельной папке, которую reconcile никогда не сканирует');
    assert.equal(body.filename, 'uris_req_thumb');
    assert.equal(body.format, 'webp');
});

test('makeThumbnailForPath rejects a broken thumbnail source without uploading', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(url);
        return { ok: false, status: 404 };
    };
    const { makeThumbnailForPath } = await import('../src/native-image-storage.js');
    await assert.rejects(() => makeThumbnailForPath('user/images/UR%20Image%20Studio/gone.png', {}));
    assert.equal(calls.length, 1, 'после неудачного fetch загрузки быть не должно');
});

test('gallery actions land in the diagnostic journal', async () => {
    const { resetDiagnosticEventsForTests, listDiagnosticEvents } = await import('../src/diagnostic-events.js');
    resetDiagnosticEventsForTests();
    const context = {
        extensionSettings: {},
        getRequestHeaders: () => ({ Authorization: 'Bearer st-token' }),
        saveSettingsDebounced: () => {},
    };
    globalThis.SillyTavern = {
        getContext: () => context,
        libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
    };
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u === '/api/files/verify') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        if (u === '/api/files/upload') return { ok: true, status: 200, json: async () => ({}) };
        if (u === '/api/images/upload') return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/uris_manual.png' }) };
        if (u.startsWith('/user/files/')) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    const { addToGallery, deleteGalleryCard, clearGallery, saveImageToFile } = await import('../src/storage.js');

    await addToGallery('chat-a', { id: 'a', imagePath: 'user/images/UR%20Image%20Studio/one.png', prompt: 'one' });
    await saveImageToFile('data:image/png;base64,AAAA');
    await deleteGalleryCard('chat-a', 'a');
    await clearGallery('chat-b');

    const events = listDiagnosticEvents();
    const save = events.find(e => e.event === 'gallery-manual-save');
    assert.ok(save, 'manual save writes a journal event');
    assert.equal(save.outcome, 'ok');
    const remove = events.find(e => e.event === 'gallery-card-remove');
    assert.ok(remove, 'card removal writes a journal event');
    assert.equal(remove.outcome, 'hidden');
    assert.equal(remove.details.deleteFile, false);
    const clear = events.find(e => e.event === 'gallery-clear');
    assert.ok(clear, 'gallery clear writes a journal event');
    assert.equal(clear.details.count, 0);
});
