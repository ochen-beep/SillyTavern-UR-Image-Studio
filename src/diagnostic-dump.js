// @ts-check
/** Diagnostic export: metadata and network evidence have separate files. */

import { state, DISPLAY_NAME, dumpProblemLog, dumpDebugLog, clearDiagnosticLogs } from './core.js';
import { listUrisErrors, clearUrisErrors } from './error-pool.js';
import { listPendingBrowserRequests, prunePendingBrowserRequests, clearPendingBrowserRequests } from './browser-image-recovery.js';
import { listDiagnosticEvents, getDiagnosticSessionId, hashDiagnosticId, clearDiagnosticEvents, recordDiagnosticEvent } from './diagnostic-events.js';
import { getNetDumpsCount, clearNetDumps } from './netdump.js';

function runtimeSnapshot() {
    const settings = state.settings || {};
    return {
        app: DISPLAY_NAME,
        debugMode: settings.debugMode === true,
        activeTab: settings.activeTab || null,
        apiSource: settings.apiSource || null,
        profileId: settings.profileId || null,
        currentChatHash: hashDiagnosticId(state.currentChatId),
        currentMsgId: state.currentMsgId ?? null,
        activeImageProfileId: state.activeImageProfileId || null,
        activeTemplateId: state.activeTemplateId || null,
        runningQueueRequestId: state.runningQueueRequestId || null,
        activeGenerationCount: state.activeGenerations?.size || 0,
        generationEpoch: state.generationEpoch ?? null,
        sessionId: getDiagnosticSessionId(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    };
}

/**
 * Build a metadata-only bundle. Extra caller fields are intentionally ignored.
 */
export async function buildDiagnosticDump({ exportedAt = new Date().toISOString() } = {}) {
    const pending = await listPendingBrowserRequests();
    return {
        probe: 'UR Image Studio diagnostic',
        exportedAt,
        meta: {
            version: 1,
            app: DISPLAY_NAME,
            debugMode: state.settings?.debugMode === true,
        },
        runtime: runtimeSnapshot(),
        // WARN/ERROR only: INFO lines restate the structured eventLog below.
        log: dumpProblemLog(),
        eventLog: listDiagnosticEvents(),
        debugLog: state.settings?.debugMode === true ? dumpDebugLog() : '',
        errorPool: listUrisErrors(),
        pendingRecovery: pending.map(item => ({
            id: item.id,
            requestId: item.requestId,
            status: item.status,
            createdAt: item.createdAt,
            error: item.error || null,
            cardId: item.cardId || null,
        })),
    };
}

/**
 * Export the non-network diagnostic bundle. Network evidence has its own
 * settings-panel button because it can be much larger than metadata and is
 * useful independently when investigating provider responses.
 */
export async function exportDiagnosticDump() {
    const exportedAt = new Date().toISOString();
    const diagnostic = await buildDiagnosticDump({ exportedAt });
    const payload = {
        probe: 'UR Image Studio diagnostic',
        exportedAt,
        meta: {
            version: 2,
            app: DISPLAY_NAME,
            note: 'Diagnostic metadata only: WARN/ERROR log, structured events, current-session errors, and pending recovery summaries. Network evidence is exported separately and may contain bounded prompt/model text previews; known auth headers and binary image bytes are excluded.',
        },
        diagnostic,
    };
    const json = JSON.stringify(payload);
    // The export act belongs to the incident timeline: the next dump shows when
    // the previous evidence left the browser and how big the journal was.
    recordDiagnosticEvent({
        event: 'diagnostic-export', stage: 'diagnostics', outcome: 'ok',
        details: { bytes: json.length, events: diagnostic.eventLog.length },
    });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `uris-diagnostic-${exportedAt.replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toastr?.success(`Диагностика выгружена · ${Math.round(json.length / 1024)} КБ`, DISPLAY_NAME);
    return payload;
}

/**
 * Clear every diagnostic store: events, logs, session error pool, network
 * dumps, and local recovery records. Shared by the ST settings panel and the
 * Settings tab. Throws when a store does not confirm the clear so callers can
 * surface a partial-failure toast.
 * @returns {Promise<{netCount:number, pendingCount:number}>} pre-clear counts for user messaging
 */
export async function clearAllDiagnostics() {
    const netCount = await getNetDumpsCount().catch(() => 0);
    await prunePendingBrowserRequests();
    const pendingCount = await clearPendingBrowserRequests();
    const eventsCleared = await clearDiagnosticEvents();
    const netCleared = await clearNetDumps();
    clearDiagnosticLogs();
    clearUrisErrors();
    if (!eventsCleared || !netCleared) throw new Error('Одно из хранилищ диагностики не подтвердило очистку');
    return { netCount, pendingCount };
}
