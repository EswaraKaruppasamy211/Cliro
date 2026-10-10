import { randomUUID } from 'crypto';

export const chromeTabGestureActions = [
    'closeCurrentChromeTab',
    'nextChromeTab',
    'previousChromeTab'
] as const;

export type ChromeTabGestureAction = typeof chromeTabGestureActions[number];
export type ChromeTabGestureResultType = 'ACTION_SUCCESS' | 'ACTION_FAILED' | 'ACTION_UNAVAILABLE';

export interface ChromeTabGestureResult {
    type: ChromeTabGestureResultType;
    message: string;
    verified: boolean;
}

interface PendingAuthorization {
    action: ChromeTabGestureAction;
    expiresAt: number;
}

export class ChromeTabGestureAuthorization {
    private readonly pending = new Map<string, PendingAuthorization>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly createId: () => string = randomUUID
    ) {}

    issue(action: ChromeTabGestureAction): string {
        this.expireOldAuthorizations();
        if (this.pending.size >= 100) {
            const oldestId = this.pending.keys().next().value;
            if (oldestId) this.pending.delete(oldestId);
        }
        const authorizationId = this.createId();
        this.pending.set(authorizationId, { action, expiresAt: this.now() + 30_000 });
        return authorizationId;
    }

    consume(
        authorizationId: unknown,
        action: unknown,
        result: unknown
    ): ChromeTabGestureResult | null {
        if (typeof authorizationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(authorizationId)) return null;
        const authorization = this.pending.get(authorizationId);
        this.pending.delete(authorizationId);
        if (!authorization || authorization.expiresAt < this.now() || authorization.action !== action) return null;
        if (!result || typeof result !== 'object') return null;

        const candidate = result as Partial<ChromeTabGestureResult>;
        if (
            !['ACTION_SUCCESS', 'ACTION_FAILED', 'ACTION_UNAVAILABLE'].includes(candidate.type || '') ||
            typeof candidate.message !== 'string' ||
            typeof candidate.verified !== 'boolean'
        ) return null;

        const verifiedSuccess = candidate.type === 'ACTION_SUCCESS' && candidate.verified === true;
        return {
            type: verifiedSuccess
                ? 'ACTION_SUCCESS'
                : candidate.type === 'ACTION_UNAVAILABLE' ? 'ACTION_UNAVAILABLE' : 'ACTION_FAILED',
            message: candidate.message.slice(0, 400),
            verified: verifiedSuccess
        };
    }

    private expireOldAuthorizations(): void {
        const now = this.now();
        for (const [authorizationId, authorization] of this.pending) {
            if (authorization.expiresAt < now) this.pending.delete(authorizationId);
        }
    }
}
