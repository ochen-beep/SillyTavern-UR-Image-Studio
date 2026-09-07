// @ts-check
/**
 * Stage completion notifications: short synthesized tones via a shared Web
 * Audio AudioContext. No audio assets — envelopes are generated per preset
 * (the ST-Copilot approach), but the context follows the mobile-safe unlock
 * pattern from the Web Audio best practices: one singleton created/resumed on
 * the first user gesture and reused forever (a context created outside a
 * gesture — e.g. minutes after "Сгенерировать" — starts suspended on iOS and
 * would stay silent). resume() is retried before every play because iOS can
 * park the context in an "interrupted" state after calls/lock screen.
 *
 * Gate order mirrors SillyTavern core playMessageSound(): stage enabled →
 * preset != none → background-only gate → force overrides the first two.
 * Every failure is swallowed: a notification must never break a generation.
 */
import { state, NOTIFY_SOUNDS, NOTIFY_DEFAULTS } from './core.js';

const PRESET_FALLBACK = {
    stage1: NOTIFY_DEFAULTS.stage1Sound,
    stage2: NOTIFY_DEFAULTS.stage2Sound,
};

let _ctx = null;
let _unlockBound = false;

function getAudioContext() {
    if (typeof window === 'undefined') return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (typeof AC !== 'function') return null;
    if (!_ctx) {
        try { _ctx = new AC(); } catch { return null; }
    }
    return _ctx;
}

/** Create/resume the shared context; safe to call repeatedly. */
export function unlockAudio() {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
        if (typeof ctx.resume === 'function' && ctx.state !== 'running') ctx.resume().catch?.(() => {});
    } catch { /* ignore */ }
    // Silent 1-sample buffer: older Safari only fully unlocks after actual playback.
    try {
        if (typeof ctx.createBuffer === 'function') {
            const source = ctx.createBufferSource();
            source.buffer = ctx.createBuffer(1, 1, 22050);
            source.connect(ctx.destination);
            source.start(0);
        }
    } catch { /* ignore */ }
}

/** Bind one-time gesture listeners so the context is unlocked as early as possible. */
export function initNotifyUnlock() {
    if (_unlockBound || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    _unlockBound = true;
    const options = { once: true, capture: true };
    document.addEventListener('pointerdown', unlockAudio, options);
    document.addEventListener('touchend', unlockAudio, options);
    document.addEventListener('click', unlockAudio, options);
}

/** Test hook: drop the singleton context and unlock binding state. */
export function resetNotifyForTests() {
    _ctx = null;
    _unlockBound = false;
}

/**
 * True when the ST tab is currently visible and focused. Combines both mobile
 * signals: iOS apps often skip blur when backgrounded, but fire visibilitychange.
 */
export function isPageFocused() {
    if (typeof document === 'undefined') return true;
    try { if (document.hidden === true) return false; } catch { /* ignore */ }
    try {
        if (typeof document.hasFocus === 'function' && document.hasFocus() === false) return false;
    } catch { /* ignore */ }
    return true;
}

/**
 * Play the completion tone for a pipeline stage. Never throws.
 * @param {'stage1'|'stage2'} stage
 * @param {{ force?: boolean }} [opts] force bypasses the enabled and
 *   background-only gates (Settings tab ▶ test buttons)
 */
export function playStageSound(stage, { force = false } = {}) {
    try {
        const s = state.settings || {};
        const enabled = stage === 'stage1' ? s.notifyStage1 === true : s.notifyStage2 === true;
        if (!enabled && !force) return;
        const fallback = PRESET_FALLBACK[stage] || NOTIFY_DEFAULTS.stage1Sound;
        const preset = stage === 'stage1' ? (s.notifyStage1Sound || fallback) : (s.notifyStage2Sound || fallback);
        if (preset === 'none' || !Object.hasOwn(NOTIFY_SOUNDS, preset)) return;
        if (!force && s.notifyOnlyUnfocused !== false && isPageFocused()) return;

        const volume = typeof s.notifyVolume === 'number' && Number.isFinite(s.notifyVolume)
            ? Math.min(100, Math.max(0, s.notifyVolume))
            : NOTIFY_DEFAULTS.volume;
        synthSound(preset, volume);
    } catch { /* notifications must never break a generation */ }
}

/** Synthesize one preset tone. Ported from the ST-Copilot envelopes. */
function synthSound(type, volume = 80) {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
        if (typeof ctx.resume === 'function' && ctx.state !== 'running') {
            const resumed = ctx.resume();
            if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
        }
        if (ctx.state === 'closed') return;
    } catch { return; }

    let masterGain;
    let now;
    try {
        masterGain = ctx.createGain();
        masterGain.gain.value = Math.max(0, Math.min(1, volume / 100));
        masterGain.connect(ctx.destination);
        now = ctx.currentTime;
    } catch { return; }

    const tone = (freq, { type: wave = 'sine', from, to, start = 0, hold = 0, attack = 0.02, decay = 0.4, peak = 0.2 }) => {
        const osc = ctx.createOscillator();
        osc.type = wave;
        if (from !== undefined) {
            osc.frequency.setValueAtTime(from, now + start);
            osc.frequency.exponentialRampToValueAtTime(to, now + start + hold + attack);
        } else {
            osc.frequency.value = freq;
        }
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(masterGain);
        gain.gain.setValueAtTime(0.0001, now + start);
        gain.gain.linearRampToValueAtTime(peak, now + start + attack);
        gain.gain.exponentialRampToValueAtTime(0.001, now + start + attack + hold + decay);
        osc.start(now + start);
        osc.stop(now + start + attack + hold + decay);
    };

    try {
        if (type === 'chime') {
            [523.25, 659.25, 783.99].forEach((freq, i) => tone(freq, { start: i * 0.12, decay: 0.5, peak: 0.18 }));
        } else if (type === 'bell') {
            tone(880, { peak: 0.25, decay: 1.2 });
        } else if (type === 'soft') {
            tone(660, { peak: 0.15, attack: 0.05, decay: 0.4 });
        } else if (type === 'digital') {
            [440, 880].forEach((freq, i) => tone(freq, {
                type: 'square', start: i * 0.07, attack: 0.005, hold: 0.12, decay: 0.05, peak: 0.08,
            }));
        } else if (type === 'pop') {
            tone(null, { from: 600, to: 200, hold: 0.1, attack: 0.01, decay: 0.15, peak: 0.22 });
        }
    } catch { /* ignore */ }
    // NOTE: the context is a long-lived singleton (unlike ST-Copilot's
    // per-beep contexts) — it is never closed here, or the next play would
    // hit a closed context and stay silent.
}
