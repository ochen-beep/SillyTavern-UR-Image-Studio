// @ts-check
import { effectiveReferenceCap } from './reference-limits.js';

/**
 * Resolve reference delivery for a server-owned image route.
 *
 * @param {object} conn
 * @returns {{supported:boolean,status:string,protocol:null,maxRefs:number|null,reason:string,source:string}}
 */
export function resolveServerOwnedReferencePolicy(conn) {
    const capabilities = conn?.selectedRoute?.capabilities;
    if (capabilities?.references === 'unsupported' || capabilities?.maxReferences === 0) {
        return {
            supported: false,
            status: 'unsupported',
            protocol: null,
            maxRefs: 0,
            reason: 'Выбранный маршрут не принимает референсы.',
            source: 'server-route',
        };
    }
    return {
        supported: true,
        status: capabilities?.references || 'unknown',
        protocol: null,
        maxRefs: effectiveReferenceCap({ providerCap: capabilities?.maxReferences }),
        reason: '',
        source: 'server-route',
    };
}
