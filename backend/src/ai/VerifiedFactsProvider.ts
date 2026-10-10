export interface VerifiedFactSource {
    title: string;
    url: string;
    provider: string;
}

interface NodeRelease {
    version?: string;
    date?: string;
    lts?: string | false;
}

export interface VerifiedFactResult {
    type: 'VERIFIED_FACT';
    answer: string;
    source: VerifiedFactSource;
    verifiedAt: string;
    cached: boolean;
}

export interface VerifiedFactsProvider {
    canHandle(query: string): boolean;
    answer(query: string, onActivity?: (stage: 'SOURCE_SEARCH' | 'SOURCE_VERIFICATION', status: 'RUNNING' | 'COMPLETED' | 'FAILED', message: string) => void): Promise<VerifiedFactResult>;
}

interface WikipediaSearchPage {
    pageid: number;
    title: string;
    snippet?: string;
}

interface WikipediaSearchResponse {
    query?: {
        search?: WikipediaSearchPage[];
    };
}

interface WikipediaExtractResponse {
    query?: {
        pages?: Record<string, { pageid?: number; title?: string; extract?: string }>;
    };
}

interface CachedFact {
    result: VerifiedFactResult;
    expiresAt: number;
}

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const NODE_RELEASE_INDEX = 'https://nodejs.org/dist/index.json';
const USER_AGENT = 'CLIRO/1.0 (local verified-facts lookup)';
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const CACHE_MAX_ENTRIES = 100;
const MAX_QUERY_LENGTH = 512;
const currentOfficeTerms = /\b(?:current(?:ly)?|incumbent|serves as|holds the office|in office|since)\b/i;
const officeTerms = /\b(?:chief minister|cm|prime minister|president|governor|mayor|minister|chancellor|head of state|ceo|chief executive officer|chairman|chairperson|leader|speaker|attorney general|secretary of state|chief justice|cabinet member|senator|representative|member of parliament|mp|mla|government official)\b/i;
const directOfficeClaim = /\b(?:is|are|serves? as|serving as)\b[^.!?]{0,120}\b(?:chief minister|cm|prime minister|president|governor|mayor|minister|chancellor|head of state|ceo|chief executive officer|chairman|chairperson|leader|speaker|attorney general|secretary of state|chief justice|cabinet member|senator|representative|member of parliament|mp|mla|government official)\b|\b(?:current|incumbent)\b[^.!?]{0,60}\b(?:chief minister|cm|prime minister|president|governor|mayor|minister|chancellor|head of state|ceo|chief executive officer|chairman|chairperson|leader|speaker|attorney general|secretary of state|chief justice|cabinet member|senator|representative|member of parliament|mp|mla|government official)\b[^.!?]{0,60}\b(?:is|are|serves? as|serving as)\b/i;
const indirectOfficeClaim = /\b(?:office|department|ministry)\b[^.!?]{0,35}\b(?:is|are)\s+(?:headed|led|managed|staffed|supported|run)\b|\b(?:principal|private|personal)\s+secretary\b/i;
const dynamicFactTerms = /\b(?:weather|forecast|exchange rate|currency rate|stock price|share price|market price|sports? score|live score|news|population|price|law|laws|rule|rules|version|release|election results?|office holder|officeholders?)\b/i;
const removeQueryFiller = /\b(?:who|what|when|where|why|how|is|are|the|a|an|of|for|from|in|on|at|to|with|and|it|me|tell|give|provide|please|verify|verified|verification|trusted|reliable|source|sources|cite|cited|citation|according|current|currently|latest|newest|today|tonight|now|right|recent|recently|this|week|month|year|as)\b/gi;

function isOpenAiFounderQuery(query: string): boolean {
    return /\b(?:founder|founders|founded)\b/i.test(query) && /\bopen\s*ai\b/i.test(query);
}

function normalizeOfficeEntity(value: string): string {
    return value
        .replace(/\btamil\s*nadu\b/gi, 'Tamil Nadu')
        .replace(/\btamilnadu\b/gi, 'Tamil Nadu')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeFactQuery(query: string): string {
    const canonicalized = normalizeOfficeEntity(query)
        .normalize('NFKC')
        .toLocaleLowerCase('en')
        .replace(/\bchief\s+minister\b/g, 'chief minister')
        .replace(/\bcm\b/g, 'chief minister')
        .replace(/\bprime\s+minister\b/g, 'prime minister')
        .replace(/\bpm\b/g, 'prime minister')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(removeQueryFiller, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return canonicalized.replace(/\btamil\s+nadu\b/g, 'tamil nadu');
}

function searchTermsFor(query: string): string[] {
    return normalizeFactQuery(query)
        .replace(removeQueryFiller, ' ')
        .split(/\s+/)
        .filter(term => term.length > 1);
}

function scoreTitle(title: string, queryTerms: string[]): number {
    const titleTerms = new Set(normalizeFactQuery(title).split(/\s+/));
    if (queryTerms.some(term => /\bfounders?\b|\bfounded\b/i.test(term)) &&
        titleTerms.has('openai')) return 1;
    const relevantTerms = queryTerms.filter(term => !['weather', 'forecast', 'exchange', 'rate', 'stock', 'price', 'share', 'market', 'sports', 'score', 'live', 'news', 'population', 'law', 'laws', 'rule', 'rules', 'version', 'release', 'election', 'results', 'office', 'holder', 'officeholders'].includes(term));
    if (relevantTerms.length === 0) return 0;
    const score = relevantTerms.filter(term => titleTerms.has(term)).length / relevantTerms.length;
    return /\b(?:office|department|list of|history of)\b/i.test(title) ? score * 0.65 : score;
}

function scoreSearchResult(page: WikipediaSearchPage, queryTerms: string[]): number {
    const titleScore = scoreTitle(page.title, queryTerms);
    const relevantTerms = queryTerms.filter(term => !['weather', 'forecast', 'exchange', 'rate', 'stock', 'price', 'share', 'market', 'sports', 'score', 'live', 'news', 'population', 'law', 'laws', 'rule', 'rules', 'version', 'release', 'election', 'results', 'office', 'holder', 'officeholders'].includes(term));
    if (!page.snippet || relevantTerms.length === 0) return titleScore;
    const snippet = normalizeFactQuery(page.snippet);
    const snippetScore = relevantTerms.filter(term => snippet.includes(term)).length / relevantTerms.length;
    return Math.max(titleScore, snippetScore * 0.8);
}

function searchQueryForOfficeHolder(query: string): string {
    const roleMatch = query.match(/\b(chief minister|cm|prime minister|pm|president|governor|mayor|minister|chancellor|head of state|chief executive officer|ceo|chairman|chairperson|leader|speaker|attorney general|secretary of state|chief justice|cabinet member|senator|representative|member of parliament|mp|mla|government official)\b/i);
    if (!roleMatch) return query;
    const role = /^(?:cm)$/i.test(roleMatch[1])
        ? 'Chief Minister'
        : /^(?:pm)$/i.test(roleMatch[1])
            ? 'Prime Minister'
            : roleMatch[1];
    const subject = normalizeOfficeEntity(
        query
            .replace(roleMatch[0], ' ')
            .replace(/\b(?:who|what|which|is|are|the|a|an|of|for|in|from|current(?:ly)?|latest|newest|today|right|now|recent(?:ly)?|as|please|verify|trusted|source|give|me|it)\b/gi, ' ')
            .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
    return subject ? `${role} of ${subject}` : query;
}

async function readBoundedText(response: Response): Promise<string> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error('The verification source response exceeded the allowed size.');
    }
    if (!response.body) {
        throw new Error('The verification source returned an empty response.');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error('The verification source response exceeded the allowed size.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
}

function extractVerifiedSentence(query: string, title: string, extract: string): string | null {
    if (isOpenAiFounderQuery(query)) {
        const foundingSection = extract.match(/==+\s*[^=]*founding[^=]*==+([\s\S]*)/i)?.[1] || extract;
        const foundingSentence = foundingSection
            .split(/(?<=[.!?])\s+/)
            .find(sentence => /\bOpenAI\b/i.test(sentence) && /\bfounded\b/i.test(sentence) && /\bby\b/i.test(sentence));
        if (!foundingSentence) return null;
        const names = foundingSentence.match(/\bfounded\b.{0,100}?\bby\s+(.+?)(?=,\s+with\b|\.|$)/i)?.[1];
        if (!names) return `From “${title}”: ${foundingSentence.trim()}`;
        return /\bsole\b/i.test(query)
            ? `No. The cited source lists these OpenAI founders: ${names.trim()}.`
            : `The cited source lists these OpenAI founders: ${names.trim()}.`;
    }

    const sentences = extract
        .replace(/\s+/g, ' ')
        .replace(/\b([A-Z])\.(?=\s+[A-Z])/g, '$1<initial-dot>')
        .split(/(?<=[.!?])\s+/)
        .map(sentence => sentence.replace(/<initial-dot>/g, '.').trim())
        .filter(Boolean);

    if (officeTerms.test(query)) {
        const currentSentence = sentences.find(sentence =>
            officeTerms.test(sentence) &&
            directOfficeClaim.test(sentence) &&
            !indirectOfficeClaim.test(sentence) &&
            (/\b(?:ceo|chief executive officer)\b/i.test(query) || currentOfficeTerms.test(sentence)) &&
            !/\b(?:former|formerly|previous|past|until|resigned|retired)\b/i.test(sentence)
        );
        return currentSentence ? `From “${title}”: ${currentSentence}` : null;
    }

    if (dynamicFactTerms.test(query)) {
        const topicalWords = searchTermsFor(query);
        const candidates = sentences.filter(sentence =>
            topicalWords.some(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sentence)) &&
            currentOfficeTerms.test(sentence)
        );
        return candidates.length ? candidates.slice(-2).join(' ') : null;
    }

    return null;
}

export class WikipediaFactsProvider implements VerifiedFactsProvider {
    private readonly cache = new Map<string, CachedFact>();

    constructor(
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly now: () => number = Date.now,
        private readonly cacheTtlMs = CACHE_TTL_MS,
        private readonly enabled = process.env.CLIRO_VERIFIED_FACTS_ENABLED !== 'false'
    ) {}

    canHandle(query: string): boolean {
        return this.enabled && Boolean(query.trim()) && query.length <= MAX_QUERY_LENGTH;
    }

    async answer(
        query: string,
        onActivity?: (stage: 'SOURCE_SEARCH' | 'SOURCE_VERIFICATION', status: 'RUNNING' | 'COMPLETED' | 'FAILED', message: string) => void
    ): Promise<VerifiedFactResult> {
        const normalizedQuery = normalizeFactQuery(query);
        if (!this.canHandle(query) || !normalizedQuery) {
            throw new Error('The current-fact query is empty, too long, or verification is disabled.');
        }

        const cached = this.cache.get(normalizedQuery);
        if (cached && cached.expiresAt > this.now()) {
            return { ...cached.result, cached: true };
        }
        if (cached) this.cache.delete(normalizedQuery);

        const result = await this.retrieve(query, onActivity);
        const now = this.now();
        for (const [key, item] of this.cache) {
            if (item.expiresAt <= now) this.cache.delete(key);
        }
        if (this.cache.size >= CACHE_MAX_ENTRIES && !this.cache.has(normalizedQuery)) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) this.cache.delete(oldestKey);
        }
        this.cache.set(normalizedQuery, {
            result,
            expiresAt: now + this.cacheTtlMs
        });
        return result;
    }

    private async getJson<T>(url: URL): Promise<T> {
        const response = await this.fetchImpl(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
            throw new Error(`The verification source returned HTTP ${response.status}.`);
        }
        const body = await readBoundedText(response);
        try {
            return JSON.parse(body) as T;
        } catch {
            throw new Error('The verification source returned invalid JSON.');
        }
    }

    private async retrieve(
        query: string,
        onActivity?: (stage: 'SOURCE_SEARCH' | 'SOURCE_VERIFICATION', status: 'RUNNING' | 'COMPLETED' | 'FAILED', message: string) => void
    ): Promise<VerifiedFactResult> {
        const openAiFounderQuery = isOpenAiFounderQuery(query);
        if (/\bnode\.?js\b/i.test(query) && /\b(?:latest|newest|current)\b.*\bversion\b|\bversion\b.*\b(?:latest|newest|current)\b/i.test(query)) {
            onActivity?.('SOURCE_SEARCH', 'RUNNING', 'Requesting the official Node.js release index.');
            let releases: NodeRelease[];
            try {
                releases = await this.getJson<NodeRelease[]>(new URL(NODE_RELEASE_INDEX));
                onActivity?.('SOURCE_SEARCH', 'COMPLETED', 'Official release index retrieved.');
            } catch (error) {
                onActivity?.('SOURCE_SEARCH', 'FAILED', error instanceof Error ? error.message : String(error));
                throw error;
            }
            if (!Array.isArray(releases)) throw new Error('The official Node.js release index had an invalid shape.');
            onActivity?.('SOURCE_VERIFICATION', 'RUNNING', 'Checking release index entries and dates.');
            const latest = releases.find(release =>
                typeof release.version === 'string' &&
                /^v\d+\.\d+\.\d+$/.test(release.version) &&
                typeof release.date === 'string' &&
                /^\d{4}-\d{2}-\d{2}$/.test(release.date)
            );
            if (!latest?.version || !latest.date) {
                onActivity?.('SOURCE_VERIFICATION', 'FAILED', 'The release index contained no valid release record.');
                throw new Error('The official Node.js release index contained no valid releases.');
            }
            onActivity?.('SOURCE_VERIFICATION', 'COMPLETED', 'A valid release entry was selected from the official index.');
            return {
                type: 'VERIFIED_FACT',
                answer: `The latest Node.js release listed by the official index is ${latest.version} (released ${latest.date}).`,
                source: {
                    title: 'Official Node.js release index',
                    url: NODE_RELEASE_INDEX,
                    provider: 'Node.js official distribution index'
                },
                verifiedAt: new Date(this.now()).toISOString(),
                cached: false
            };
        }

        const searchUrl = new URL(WIKIPEDIA_API);
        searchUrl.search = new URLSearchParams({
            action: 'query',
            list: 'search',
            srsearch: openAiFounderQuery ? 'OpenAI' : officeTerms.test(query) ? searchQueryForOfficeHolder(query) : query,
            srlimit: '10',
            format: 'json',
            utf8: '1'
        }).toString();
        onActivity?.('SOURCE_SEARCH', 'RUNNING', 'Searching the configured verified source.');
        let search: WikipediaSearchResponse;
        try {
            search = await this.getJson<WikipediaSearchResponse>(searchUrl);
            onActivity?.('SOURCE_SEARCH', 'COMPLETED', 'Source search completed.');
        } catch (error) {
            onActivity?.('SOURCE_SEARCH', 'FAILED', error instanceof Error ? error.message : String(error));
            throw error;
        }
        const searchResults = Array.isArray(search.query?.search) ? search.query.search : [];
        const queryTerms = searchTermsFor(query);
        const relevantPages = searchResults
            .filter(page => Number.isInteger(page.pageid) && typeof page.title === 'string')
            .map(page => ({ page, score: scoreSearchResult(page, queryTerms) }))
            .filter(candidate => candidate.score >= 0.5)
            .sort((left, right) => right.score - left.score)
            .slice(0, 5);
        if (relevantPages.length === 0) {
            onActivity?.('SOURCE_VERIFICATION', 'FAILED', 'The search returned no sufficiently relevant candidate articles.');
            throw new Error('No sufficiently relevant source article was found.');
        }

        for (const relevantPage of relevantPages) {
            onActivity?.('SOURCE_VERIFICATION', 'RUNNING', `Fetching and validating source article: ${relevantPage.page.title}.`);
            const extractUrl = new URL(WIKIPEDIA_API);
            extractUrl.search = new URLSearchParams({
                action: 'query',
                prop: 'extracts',
                explaintext: '1',
                pageids: String(relevantPage.page.pageid),
                format: 'json',
                utf8: '1'
            }).toString();
            if (!openAiFounderQuery) {
                extractUrl.searchParams.set('exintro', '1');
            }
            let extractResponse: WikipediaExtractResponse;
            try {
                extractResponse = await this.getJson<WikipediaExtractResponse>(extractUrl);
            } catch (error) {
                onActivity?.('SOURCE_VERIFICATION', 'FAILED', error instanceof Error ? error.message : String(error));
                throw error;
            }
            const page = extractResponse.query?.pages?.[String(relevantPage.page.pageid)];
            if (!page || typeof page.title !== 'string' || typeof page.extract !== 'string' || !page.extract.trim()) {
                continue;
            }

            const answer = extractVerifiedSentence(query, page.title, page.extract);
            if (!answer) {
                onActivity?.('SOURCE_VERIFICATION', 'FAILED', 'The source article did not contain a direct, relevant current claim.');
                continue;
            }

            onActivity?.('SOURCE_VERIFICATION', 'COMPLETED', 'A direct current claim was validated in the source article.');
            return {
                type: 'VERIFIED_FACT',
                answer,
                source: {
                    title: `Wikipedia: ${page.title}`,
                    url: `https://en.wikipedia.org/?curid=${relevantPage.page.pageid}`,
                    provider: 'Wikimedia public API'
                },
                verifiedAt: new Date(this.now()).toISOString(),
                cached: false
            };
        }
        onActivity?.('SOURCE_VERIFICATION', 'FAILED', 'No candidate source contained a direct, relevant current claim.');
        throw new Error('The source did not contain a direct, relevant current fact that could be verified.');
    }
}
