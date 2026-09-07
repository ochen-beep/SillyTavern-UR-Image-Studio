// @ts-check
// Tests for stage completion notifications: settings normalization, gate
// order (enabled → preset → background-only → force), the shared
// AudioContext lifecycle and the Settings tab controls.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFakeDocument } from './fake-dom.js';

class MockAudioContext {
    constructor() {
        this.state = 'suspended';
        this.destination = {};
        MockAudioContext.instances.push(this);
    }
    async resume() { this.state = 'running'; MockAudioContext.resumes++; }
    createGain() {
        const gain = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
        MockAudioContext.gains.push(gain);
        return { gain, connect() {} };
    }
    createOscillator() {
        const osc = {
            type: '', frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
            connect() {}, start() { MockAudioContext.started++; }, stop() {},
        };
        return osc;
    }
    createBuffer() { return {}; }
    createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
}
MockAudioContext.instances = [];
MockAudioContext.started = 0;
MockAudioContext.resumes = 0;
MockAudioContext.gains = [];

// Module-scope bootstrap: modules read globals at call time; per-test mocks
// are reinstalled in beforeEach.
globalThis.document = { hidden: false, hasFocus: () => false };
globalThis.window = { AudioContext: MockAudioContext, location: { origin: 'http://localhost:8000' } };
globalThis.toastr = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };
let extensionSettings = {};
globalThis.SillyTavern = { getContext: () => ({ extensionSettings, saveSettingsDebounced: () => {} }) };

const { state, loadSettings, NOTIFY_SOUNDS, MODULE_NAME } = await import('../src/core.js');
const { playStageSound, unlockAudio, initNotifyUnlock, resetNotifyForTests } = await import('../src/notify.js');
const { render } = await import('../src/ui/tab-settings.js');

beforeEach(() => {
    globalThis.document = { hidden: false, hasFocus: () => false };
    globalThis.window = { AudioContext: MockAudioContext, location: { origin: 'http://localhost:8000' } };
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings, saveSettingsDebounced: () => {} }) };
    extensionSettings = {};
    resetNotifyForTests();
    MockAudioContext.started = 0;
    MockAudioContext.resumes = 0;
    MockAudioContext.gains = [];
    state.settings = {
        notifyStage1: false,
        notifyStage2: true,
        notifyStage1Sound: 'soft',
        notifyStage2Sound: 'chime',
        notifyVolume: 80,
        notifyOnlyUnfocused: true,
    };
});

function focused() { globalThis.document = { hidden: false, hasFocus: () => true }; }
function unfocused() { globalThis.document = { hidden: true, hasFocus: () => true }; }

test('loadSettings applies notification defaults and normalizes persisted values', () => {
    const ctx = globalThis.SillyTavern.getContext();
    ctx.extensionSettings[MODULE_NAME] = {
        notifyVolume: 150,
        notifyStage1Sound: 'hacker',
        notifyStage2Sound: null,
        notifyStage1: 'yes',
    };
    loadSettings();
    assert.equal(state.settings.notifyVolume, 100);
    assert.equal(state.settings.notifyStage1Sound, 'soft');
    assert.equal(state.settings.notifyStage2Sound, 'chime');
    assert.equal(state.settings.notifyStage1, false); // strict boolean, 'yes' → false
    assert.equal(state.settings.notifyStage2, true); // missing → default enabled
    assert.equal(state.settings.notifyOnlyUnfocused, true);

    delete ctx.extensionSettings[MODULE_NAME];
    loadSettings();
    assert.equal(state.settings.notifyVolume, 80);
    assert.equal(state.settings.notifyStage2, true);
    assert.equal(state.settings.notifyStage1, false);
});

test('enabled stage plays when the tab is in the background', () => {
    unfocused();
    playStageSound('stage2');
    assert.ok(MockAudioContext.started > 0, 'oscillators started');
});

test('background-only gate stays silent while the tab is focused', () => {
    focused();
    playStageSound('stage2');
    assert.equal(MockAudioContext.started, 0);

    unfocused();
    playStageSound('stage2');
    assert.ok(MockAudioContext.started > 0);
});

test('force bypasses the background gate and the enabled flag', () => {
    focused();
    playStageSound('stage2', { force: true });
    assert.ok(MockAudioContext.started > 0, 'focused but forced');

    playStageSound('stage1', { force: true }); // stage1 is disabled by default
    assert.ok(MockAudioContext.started > 0, 'disabled stage but forced');
});

test('disabled stage stays silent without force', () => {
    unfocused();
    playStageSound('stage1');
    assert.equal(MockAudioContext.started, 0);
});

test('preset "none" never plays, even forced', () => {
    unfocused();
    state.settings.notifyStage2Sound = 'none';
    playStageSound('stage2', { force: true });
    assert.equal(MockAudioContext.started, 0);
});

test('volume maps to the master gain (80 → 0.8)', () => {
    unfocused();
    playStageSound('stage2');
    assert.ok(MockAudioContext.started > 0, 'tone played');
    const masterGain = MockAudioContext.gains[0];
    assert.ok(masterGain, 'master gain created');
    assert.equal(masterGain.value, 0.8);
});

test('missing AudioContext degrades to a silent no-op', () => {
    globalThis.window = { location: { origin: 'http://localhost:8000' } };
    resetNotifyForTests();
    unfocused();
    assert.doesNotThrow(() => playStageSound('stage2'));
});

test('unlockAudio resumes a suspended shared context', () => {
    unlockAudio();
    const ctx = MockAudioContext.instances.at(-1);
    assert.equal(ctx.state, 'running');
    assert.ok(MockAudioContext.resumes >= 1);
    // Repeated unlock is a no-op on a running context.
    const before = MockAudioContext.resumes;
    unlockAudio();
    assert.equal(MockAudioContext.resumes, before);
});

test('settings tab renders the notifications section', () => {
    globalThis.document = makeFakeDocument().document;
    const root = globalThis.document.createElement('div');
    root.id = 'root';
    render(root);
    assert.ok(root.querySelector('#uris_notify_stage1'), 'stage1 toggle');
    assert.ok(root.querySelector('#uris_notify_stage2'), 'stage2 toggle');
    const select = root.querySelector('#uris_notify_stage2_sound');
    assert.ok(select, 'stage2 sound select');
    assert.match(select.innerHTML, /Без звука/);
    assert.match(select.innerHTML, /Куранты/);
    assert.ok(root.querySelector('#uris_notify_stage1_test'), 'stage1 test button');
    assert.ok(root.querySelector('#uris_notify_stage2_test'), 'stage2 test button');
    assert.equal(root.querySelector('#urisNotifyVolume').value, '80');
    assert.ok(root.querySelector('#uris_notify_unfocused'), 'background-only toggle');
});

test('pipeline modules ring the bell at their success points', async () => {
    const stage1src = await readFile(new URL('../src/pipeline-stage1.js', import.meta.url), 'utf8');
    const stage2src = await readFile(new URL('../src/pipeline-stage2.js', import.meta.url), 'utf8');
    assert.match(stage1src, /playStageSound\('stage1'\)/);
    assert.match(stage2src, /playStageSound\('stage2'\)/);
    // Catalog is the single source of truth for labels.
    assert.equal(NOTIFY_SOUNDS.none.label, 'Без звука');
});

test('initNotifyUnlock binds gesture listeners once', () => {
    const listeners = [];
    globalThis.document = {
        hidden: false,
        addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); },
    };
    initNotifyUnlock();
    initNotifyUnlock(); // idempotent
    const types = listeners.map(l => l.type);
    assert.ok(types.includes('pointerdown'));
    assert.ok(types.includes('touchend'));
    assert.ok(types.includes('click'));
    assert.equal(listeners.length, 3);
});
