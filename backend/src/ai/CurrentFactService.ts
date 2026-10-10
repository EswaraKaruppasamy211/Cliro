import { VerifiedFactsProvider, VerifiedFactResult } from './VerifiedFactsProvider';

export interface CurrentFactUnavailableResult {
    type: 'CURRENT_FACT_UNAVAILABLE';
    verified: false;
    message: string;
    answer: string;
    source: null;
    verifiedAt: string;
    cached: false;
}

export type CurrentFactResult = VerifiedFactResult | CurrentFactUnavailableResult;

export async function verifyCurrentFact(
    query: string,
    provider: VerifiedFactsProvider,
    now: () => number = Date.now,
    onActivity?: (stage: 'SOURCE_SEARCH' | 'SOURCE_VERIFICATION', status: 'RUNNING' | 'COMPLETED' | 'FAILED', message: string) => void
): Promise<CurrentFactResult> {
    try {
        if (!provider.canHandle(query)) {
            throw new Error('The configured verification provider cannot handle this query.');
        }
        return await provider.answer(query, onActivity);
    } catch {
        const failureMessage = 'Current factual information could not be verified.';
        return {
            type: 'CURRENT_FACT_UNAVAILABLE',
            verified: false,
            message: failureMessage,
            answer: failureMessage,
            source: null,
            verifiedAt: new Date(now()).toISOString(),
            cached: false
        };
    }
}
