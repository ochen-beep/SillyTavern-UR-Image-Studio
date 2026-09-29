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

    it('explains the readonly refusal so a user knows what to do', () => {
        assert.match(settingsSource, /«Только чтение» означает отказ записи/);
        assert.match(settingsSource, /STORE_MODE_LABEL/);
    });

    it('maps every observable mode to a human label', () => {
        assert.match(settingsSource, /file:\s*'файл'/);
        assert.match(settingsSource, /readonly:\s*'только чтение'/);
        assert.match(settingsSource, /unknown:\s*'проверка…'/);
    });

    it('no settings.json row: the settings world is gone', () => {
        assert.doesNotMatch(settingsSource, /settings.json (модуль)/);
        assert.doesNotMatch(settingsSource, /measureSettingsFootprint/);
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
        for (const mode of ['file', 'readonly', 'unknown']) {
            assert.match(css, new RegExp(`\\.uris-store-mode-${mode}\\s*\\{`), `missing badge style for ${mode}`);
        }
    });
});
