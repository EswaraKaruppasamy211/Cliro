export type ChromeTabAction = 'closeAllTabs' | 'nextTab' | 'previousTab';
export type ChromeActionType = 'ACTION_SUCCESS' | 'ACTION_PARTIAL' | 'ACTION_FAILED' | 'ACTION_UNAVAILABLE';

export interface ChromeActionResult {
    type: ChromeActionType;
    message: string;
    verified: boolean;
}

interface ChromeTarget {
    id: string;
    type: string;
    title?: string;
}

const debugEndpoint = 'http://127.0.0.1:9222';
let lastActivatedTarget: string | null = null;

async function getPageTargets(): Promise<ChromeTarget[] | null> {
    try {
        const response = await fetch(`${debugEndpoint}/json/list`, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) return null;
        const targets: unknown = await response.json();
        if (!Array.isArray(targets)) return null;
        return targets.filter((target): target is ChromeTarget =>
            Boolean(target) &&
            typeof target === 'object' &&
            'id' in target && typeof target.id === 'string' && /^[A-Za-z0-9_-]+$/.test(target.id) &&
            'type' in target && target.type === 'page');
    } catch {
        return null;
    }
}

function unavailable(): ChromeActionResult {
    return {
        type: 'ACTION_UNAVAILABLE',
        message: 'Safe Chrome tab control is unavailable. Chrome must already expose its local DevTools control endpoint; CLIRO did not launch or reconfigure Chrome.',
        verified: false
    };
}

export async function controlChromeTabs(action: ChromeTabAction): Promise<ChromeActionResult> {
    const targets = await getPageTargets();
    if (!targets) return unavailable();

    if (action === 'closeAllTabs') {
        if (targets.length === 0) {
            return { type: 'ACTION_SUCCESS', message: 'Chrome has no controllable tabs to close.', verified: true };
        }

        const closeRequestErrors = new Map<string, string>();
        for (const target of targets) {
            try {
                const response = await fetch(`${debugEndpoint}/json/close/${encodeURIComponent(target.id)}`, {
                    signal: AbortSignal.timeout(1500)
                });
                if (!response.ok) closeRequestErrors.set(target.id, `HTTP ${response.status}`);
            } catch (error) {
                closeRequestErrors.set(target.id, error instanceof Error ? error.message : String(error));
            }
        }

        const pending = new Set(targets.map(target => target.id));
        const deadline = Date.now() + 2500;
        while (pending.size > 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 150));
            const remaining = await getPageTargets();
            if (!remaining) break;
            for (const target of remaining) pending.delete(target.id);
        }

        const failed = targets.filter(target => pending.has(target.id)).map(target => target.title || target.id);
        if (failed.length > 0) {
            const failureDetails = targets
                .filter(target => pending.has(target.id) && closeRequestErrors.has(target.id))
                .map(target => `${target.title || target.id}: ${closeRequestErrors.get(target.id)}`);
            return {
                type: 'ACTION_PARTIAL',
                message: `Chrome closed some tabs, but could not verify closure of: ${failed.join(', ')}.${failureDetails.length ? ` ${failureDetails.join('; ')}` : ''}`,
                verified: false
            };
        }
        return { type: 'ACTION_SUCCESS', message: `Closed and verified ${targets.length} Chrome tab${targets.length === 1 ? '' : 's'}.`, verified: true };
    }

    if (targets.length < 2) {
        return {
            type: 'ACTION_UNAVAILABLE',
            message: 'Chrome tab switching requires at least two controllable tabs.',
            verified: false
        };
    }
    const currentIndex = lastActivatedTarget
        ? targets.findIndex(target => target.id === lastActivatedTarget)
        : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const offset = action === 'nextTab' ? 1 : -1;
    const targetIndex = (startIndex + offset + targets.length) % targets.length;
    const target = targets[targetIndex];

    try {
        const response = await fetch(`${debugEndpoint}/json/activate/${encodeURIComponent(target.id)}`, {
            signal: AbortSignal.timeout(1500)
        });
        if (!response.ok) {
            return { type: 'ACTION_FAILED', message: `Chrome did not activate the requested tab (HTTP ${response.status}).`, verified: false };
        }
        const remaining = await getPageTargets();
        if (!remaining?.some(item => item.id === target.id)) {
            return { type: 'ACTION_FAILED', message: 'Chrome tab activation could not be verified because the target disappeared.', verified: false };
        }
        lastActivatedTarget = target.id;
        return {
            type: 'ACTION_SUCCESS',
            message: `${action === 'nextTab' ? 'Activated the next' : 'Activated the previous'} Chrome tab${target.title ? `: ${target.title}` : ''}.`,
            verified: true
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { type: 'ACTION_FAILED', message: `Unable to activate the Chrome tab: ${detail}`, verified: false };
    }
}
