// @ts-check
/**
 * Storage panel: the read-only report the user checks the settings.json diet
 * against. Guards (a) that the panel exists in the Settings tab markup with the
 * documented store classes, (b) that the CSS keeps the mode/name/detail layout,
 * and (c) that the settings-footprint metric matches what it claims to measure.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

/** Strip comments so explanatory prose cannot match as a declaration. */
function readCss() {
    return readFileSync(join(projectRoot, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const settingsSource = readFileSync(join(projectRoot, 'src', 'ui', 'tab-settings.js'), 'utf8');

describe('storage panel markup', () => {
    it('renders a named storage section in the Settings tab', () => {
        assert.match(settingsSource, /<h3>Хранилище<\/h3>/);
        assert.match(settingsSource, /id="urisStoreList"/);
        assert.match(settingsSource, /class="uris-store-list"/);
    });

    it('explains both modes so a user can tell file storage from the fallback', () => {
        assert.match(settingsSource, /Режим «настройки» означает/);
        assert.match(settingsSource, /STORE_MODE_LABEL/);
    });

    it('maps every observable mode to a human label', () => {
        assert.match(settingsSource, /file:\s*'файл'/);
        assert.match(settingsSource, /legacy:\s*'настройки'/);
        assert.match(settingsSource, /unknown:\s*'проверка…'/);
        assert.match(settingsSource, /info:\s*'остаток'/);
    });

    it('flags the settings row only when data is still stuck there', () => {
        // The module blob has no storage "mode"; the only meaningful signal is a
        // leftover index, so the badge must not be a size heuristic.
        assert.match(settingsSource, /leftoverCards > 0 \? 'legacy' : 'info'/);
        assert.doesNotMatch(settingsSource, /settingsBytes > 4096/);
    });
});

describe('storage panel CSS', () => {
    const css = readCss();

    it('lays the row out as name / mode / detail', () => {
        assert.match(css, /\.uris-store-list\s*\{[^}]*display:\s*flex/);
        assert.match(css, /\.uris-store-row\s*\{[^}]*display:\s*flex/);
        assert.match(css, /\.uris-store-name\s*\{[^}]*text-overflow:\s*ellipsis/);
        assert.match(css, /\.uris-store-detail\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
    });

    it('styles each mode badge', () => {
        for (const mode of ['file', 'legacy', 'unknown', 'info']) {
            assert.match(css, new RegExp(`\\.uris-store-mode-${mode}\\s*\\{`), `missing badge style for ${mode}`);
        }
    });
});

describe('measureSettingsFootprint', () => {
    let originalSt;
    let fileStore;

    beforeEach(async () => {
        originalSt = globalThis.SillyTavern;
        fileStore = await import('../src/file-store.js');
    });

    afterEach(() => { globalThis.SillyTavern = originalSt; });

    function withSettings(settings) {
        globalThis.SillyTavern = { getContext: () => ({ extensionSettings: { ur_image_studio: settings } }) };
    }

    it('reports the serialized module size and per-array entry counts', () => {
        withSettings({
            enabled: true,
            imageConnections: { galleryIndex: [{ id: 'a' }, { id: 'b' }], refs: [{ id: 'r' }] },
        });
        const footprint = fileStore.measureSettingsFootprint('ur_image_studio');

        assert.equal(footprint.entries.galleryIndex, 2);
        assert.equal(footprint.entries.refs, 1);
        assert.equal(footprint.settingsBytes > 0, true);
        assert.equal(footprint.connectionsBytes <= footprint.settingsBytes, true);
    });

    it('reports an empty footprint when the module has no settings', () => {
        globalThis.SillyTavern = { getContext: () => ({ extensionSettings: {} }) };
        const footprint = fileStore.measureSettingsFootprint('ur_image_studio');

        assert.equal(footprint.settingsBytes, 0);
        assert.equal(footprint.connectionsBytes, 0);
        assert.deepEqual(footprint.entries, {});
    });
});
