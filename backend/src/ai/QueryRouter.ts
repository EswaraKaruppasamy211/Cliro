export type QueryCategory =
    | 'SYSTEM_INFO'
    | 'APPLICATION_CONTROL'
    | 'FILESYSTEM'
    | 'CODE_ANALYSIS'
    | 'CURRENT_FACT'
    | 'VERIFIED_FACT'
    | 'IMAGE_GENERATION'
    | 'GENERAL_KNOWLEDGE'
    | 'CONVERSATION';

const temporalTerms = /\b(?:current(?:ly)?|latest|newest|today|tonight|now|right now|recent(?:ly)?|this week|this month|this year|as of|up[- ]to[- ]date)\b/i;
const officeHolderRoles = /\b(?:chief minister|cm|prime minister|president|governor|mayor|minister|chancellor|head of state|ceo|chief executive officer|chairman|chairperson|leader|executive|company leadership|speaker|attorney general|secretary of state|chief justice|cabinet member|senator|representative|member of parliament|mp|mla|government official)\b/i;
const officeHolderQuestion = /\bwho\s+(?:is|are|'s)\b/i;
const historicalOfficeQuestion = /\b(?:who\s+was|former|first|last|previous|historical|in\s+(?:19|20)\d{2})\b/i;
const generalKnowledgeQuestion = /^(?:who|what|why|how|explain|define|describe|tell me about|compare|when|where)\b/i;
const currentFactTopic = /\b(?:weather|forecast|exchange rate|currency rate|stock price|share price|market price|price|sports? score|live score|standings?|rankings?|score|news|population|law|laws|regulation|regulations|rule|rules|version|release|specifications?|product specs?|election results?|office holder|officeholders?|capital|status|event|events)\b/i;

export function isOpenAiFounderQuery(query: string): boolean {
    return /\b(?:founder|founders|founded)\b/i.test(query) &&
        /\bopen\s*ai\b/i.test(query);
}

export function isCurrentFactQuery(query: string): boolean {
    const normalized = query.trim();
    if (!normalized || (historicalOfficeQuestion.test(normalized) && officeHolderRoles.test(normalized))) {
        return false;
    }
    if (isOpenAiFounderQuery(normalized)) return false;

    const timeSensitive = temporalTerms.test(normalized);
    return (timeSensitive && (officeHolderRoles.test(normalized) || currentFactTopic.test(normalized))) ||
        (officeHolderQuestion.test(normalized) && officeHolderRoles.test(normalized));
}

export function classifyQuery(
    query: string,
    deterministicIntent?: string
): QueryCategory {
    if (deterministicIntent === 'currentFactQuery') {
        return 'CURRENT_FACT';
    }
    if (deterministicIntent === 'getSystemInfo' || deterministicIntent === 'checkApplicationStatus') {
        return 'SYSTEM_INFO';
    }
    if (deterministicIntent === 'generateImage') {
        return 'IMAGE_GENERATION';
    }
    if ([
        'openApplication',
        'openProject',
        'createProject',
        'listInstalledApplications',
        'closeChromeTabs',
        'closeOpenApplications',
        'switchChromeTab',
        'executeComputerActionPlan',
        'unsupportedComputerAction'
    ].includes(deterministicIntent || '')) {
        return 'APPLICATION_CONTROL';
    }
    if ([
        'listProjectFiles',
        'findProjectFile',
        'checkProjectExists'
    ].includes(deterministicIntent || '')) {
        return 'FILESYSTEM';
    }
    if ([
        'analyzeCode',
        'proposeCodeChange',
        'applyCodeChange'
    ].includes(deterministicIntent || '')) {
        return 'CODE_ANALYSIS';
    }
    if (isCurrentFactQuery(query)) {
        return 'CURRENT_FACT';
    }
    if (isOpenAiFounderQuery(query)) {
        return 'VERIFIED_FACT';
    }
    return generalKnowledgeQuestion.test(query.trim()) ? 'GENERAL_KNOWLEDGE' : 'CONVERSATION';
}
