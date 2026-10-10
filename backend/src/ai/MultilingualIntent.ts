export type MultilingualIntent =
    | 'CHAT'
    | 'SYSTEM_QUERY'
    | 'CURRENT_FACT'
    | 'APPLICATION_CONTROL'
    | 'PROJECT_CREATE'
    | 'PROJECT_MODIFY'
    | 'PROJECT_ANALYZE'
    | 'PROJECT_BUILD'
    | 'PROJECT_TEST'
    | 'PROJECT_RUN'
    | 'PROJECT_STOP'
    | 'PROJECT_OPEN'
    | 'CODE_GENERATION'
    | 'CODE_FIX'
    | 'DEPENDENCY_INSTALL'
    | 'WEB_LOOKUP'
    | 'IMAGE_GENERATION'
    | 'IMAGE_GENERATE'
    | 'IMAGE_EDIT'
    | 'IMAGE_VARIATIONS'
    | 'IMAGE_ADD_TO_PROJECT'
    | 'IMAGE_REGENERATE'
    | 'PROJECT_SELECT'
    | 'CANCEL';

export interface UnderstoodCommand {
    intent?: MultilingualIntent;
    confidence: number;
    clarification?: string;
    projectName?: string;
    template?: 'react' | 'node' | 'typescript' | 'python' | 'html' | 'basic';
    openInVSCode?: boolean;
    build?: boolean;
    run?: boolean;
    test?: boolean;
    applicationName?: string;
    feature?: string;
    section?: 'cpu' | 'ram' | 'battery' | 'storage' | 'os' | 'all';
    imagePrompt?: string;
    imagePurpose?: string;
    imageCount?: number;
    projectHint?: string;
    includeImageInProject?: boolean;
}

const projectReference = /\bproject\b|ப்ராஜெக்ட்|ப்ராஜெக்ட்டை|ப்ராஜெக்ட்ல|இந்த\s+project|oru\s+project/i;
const tamilCreate = /உருவாக்கு|உருவாக்கி|உருவாக்கி\s+build|create\s*(?:பண்ணு|pannu|பண்ணி|panni)|\bcreate\b/i;
const tamilOpen = /\bopen\b|திறந்து\s*வை|திறந்து|திற|திறக்க|திறந்த|open\s*(?:பண்ணு|pannu|பண்ணி|panni)/i;
const tamilBuild = /\bbuild\b|build\s*(?:பண்ணு|pannu|பண்ணி|panni)|கட்டு/i;
const tamilRun = /\brun\b|run\s*(?:பண்ணு|pannu|பண்ணி|panni)|ஓட்டு|இயக்கு|இயக்கி/i;
const tamilTest = /\btest(?:s|ing)?\b|சோதனை/i;
const tamilStop = /\bstop\b|நிறுத்து|நிறுத்திவிடு/i;
const tamilCancel = /\bcancel\b|வேண்டாம்|நிறுத்து|நிறுத்திவிடு|cancel\s*(?:பண்ணு|pannu)/i;
const vsCodeMention = /vs\s*code|vscode|visual\s+studio\s+code|விஎஸ்\s*கோடு(?:ல|ல்)?/i;

function cleanName(value: string): string {
    return value
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .replace(/[.,!?;:]+$/g, '')
        .trim();
}

function projectNameFrom(input: string): string | undefined {
    const named = input.match(/(?:called|named|என்று)\s+["'“]?([A-Za-z][A-Za-z0-9_-]{0,63})/i);
    if (named) return cleanName(named[1]);
    const tanglish = input.match(/\b([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s*(?:ன்னு|னு)|\s+nu\b)/i);
    if (tanglish) {
        const candidate = cleanName(tanglish[1]);
        if (!/^(?:oru|oru|react|node|typescript|python|html|project)$/i.test(candidate)) return candidate;
    }
    return undefined;
}

function projectTemplateFrom(input: string): UnderstoodCommand['template'] {
    if (/\breact\b/i.test(input)) return 'react';
    if (/\bnode(?:\.js)?\b/i.test(input)) return 'node';
    if (/\btypescript\b/i.test(input)) return 'typescript';
    if (/\bpython\b/i.test(input)) return 'python';
    if (/\bhtml\b|\bweb\b/i.test(input)) return 'html';
    return 'basic';
}

function removeCommandWords(value: string): string {
    return value
        .replace(/^(?:இந்த|இது|oru|ஒரு|my|this|the)\s+/i, '')
        .replace(/(?:project|ப்ராஜெக்ட்|ப்ராஜெக்ட்டை|ப்ராஜெக்ட்ல)(?:ல|ல்|ஐ)?/gi, ' ')
        .replace(/(?:add|சேர்|சேர்த்து|உருவாக்கு|create|பண்ணு|பண்ணி|pannu|panni|please|வேண்டும்|வேணும்|செய்)/gi, ' ')
        .replace(/\b(?:implement|improve|connect|update|fix|make)\b/gi, ' ')
        .replace(/\b(?:to|in|this|that|the)\b/gi, ' ')
        .replace(/(?:இந்த|இது|இதுல|இப்போ)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:a|an|the)\s+/i, '')
        .replace(/[?.!,;:]+$/g, '')
        .trim();
}

export function understandCommand(input: string): UnderstoodCommand {
    const text = input.normalize('NFKC').trim();
    const lower = text.toLocaleLowerCase();
    if (!text) return { confidence: 0 };

    const refersToProject = projectReference.test(lower);
    const imageCue = /(?:\bimages?\b|\bpictures?\b|\bphotos?\b|\billustrations?\b|\blogos?\b|\bhero\b|\bbackground\b|\bvisual assets?\b|படம்|படத்தை|படங்கள்|ஓவியம்|லோகோ|பின்னணி)/i.test(lower);
    const imageAction = /(?:\b(?:generate|create|make|draw|render)\b|\b(?:edit|change|remove)\b.{0,40}\b(?:image|picture|photo|illustration)\b|\b(?:image|picture|photo|illustration)\b.{0,40}\b(?:edit|change|remove)\b|\bregenerate\b|\banother version\b|\bvariations?\b|உருவாக்கு|உருவாக்கி|உருவாக்க|செய்து\s*கொடு|பண்ணு|பண்ணி|pannu|panni|வரை)/i.test(lower);
    if (imageCue && imageAction) {
        const countMatch = lower.match(/\b(\d{1,2}|one|two|three|four)\s+(?:images?|pictures?|photos?|illustrations?|versions?)\b/i);
        const countWord: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
        const imageCount = countMatch
            ? Math.min(4, Math.max(1, Number(countMatch[1]) || countWord[countMatch[1].toLocaleLowerCase()] || 1))
            : 1;
        const imagePrompt = text
            .replace(/^\s*(?:cliro[, ]*)?/i, '')
            .replace(/^\s*(?:please\s+)?(?:generate|create|make|draw|render)\s+(?:(?:one|two|three|four|\d+)\s+)?(?:an?\s+)?/i, '')
            .replace(/\b(?:generate|create|make|draw|render|edit|change|remove|regenerate|another version|variations?)\b/gi, ' ')
            .replace(/(?:உருவாக்கு|உருவாக்கி|உருவாக்க|செய்து\s*கொடு|செய்|மாற்று|வேணும்|வேண்டும்|பண்ணு|பண்ணி|pannu|panni|வரை|க்கு|க்காக|இந்த|ஒரு|இன்னொரு)/gi, ' ')
            .replace(/\b(?:an?|this|my|for|in|on|website|homepage|home page|project|the|and|add|it|to|one|two|three|four)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const projectHint = projectNameFrom(text);
        const regenerates = /(?:regenerate|another version|one more version|இன்னொரு version|இன்னொரு படம்|இன்னொரு image|மீண்டும்)/i.test(lower);
        const edits = /(?:\bedit\b|\bchange\b|\bremove the background\b|மாற்று|திருத்து)/i.test(lower);
        const adds = /(?:\badd\b|\buse in\b|website.*(?:image|illustration)|project.*(?:image|illustration)|websiteல|projectல)/i.test(lower);
        return {
            intent: regenerates ? 'IMAGE_REGENERATE' : edits ? 'IMAGE_EDIT'
                : imageCount > 1 ? 'IMAGE_VARIATIONS'
                    : adds ? 'IMAGE_ADD_TO_PROJECT' : 'IMAGE_GENERATION',
            confidence: 0.9,
            imagePrompt: imagePrompt || text,
            imagePurpose: /\bhero\b/i.test(lower) ? 'hero image'
                : /\blogo\b/i.test(lower) ? 'logo'
                    : /\bbackground\b|பின்னணி/i.test(lower) ? 'background image'
                        : /\billustration\b|ஓவியம்/i.test(lower) ? 'illustration'
                            : 'project visual asset',
            imageCount,
            ...(projectHint ? { projectHint } : {}),
            includeImageInProject: adds || refersToProject
        };
    }
    if ((tamilCancel.test(lower) && !(refersToProject && tamilStop.test(lower))) ||
        /^(?:please\s+)?cancel(?:\s+that)?[.!?]*$/i.test(lower)) {
        return { intent: 'CANCEL', confidence: 0.99 };
    }

    const build = tamilBuild.test(lower);
    const run = tamilRun.test(lower);
    const test = tamilTest.test(lower);

    if (refersToProject && (build || run || test)) {
        return {
            intent: build ? 'PROJECT_BUILD' : test ? 'PROJECT_TEST' : 'PROJECT_RUN',
            confidence: 0.96,
            build,
            run,
            test
        };
    }

    if (refersToProject && tamilStop.test(lower)) {
        return { intent: 'PROJECT_STOP', confidence: 0.96 };
    }

    if (/(?:\bfix\b|\brepair\b|சரி\s*செய்|திருத்து).*(?:error|bug|code|பிழை|கோடு)|(?:error|bug|பிழை).*(?:fix|சரி|திருத்து)/i.test(lower)) {
        return { intent: 'CODE_FIX', confidence: 0.87, feature: text };
    }

    if ((refersToProject || /\badd\b.*\b(?:pannu|panni)\b/i.test(lower) ||
        /^(?:please\s+)?(?:add|implement|improve|connect|update|fix)\b/i.test(lower)) &&
        /(?:add|சேர்|சேர்த்து|implement|improve|connect|update|fix)/i.test(lower)) {
        const feature = removeCommandWords(text);
        if (feature) return { intent: 'PROJECT_MODIFY', confidence: 0.9, feature };
    }

    if (!refersToProject &&
        /(?:\bwrite\b|\bgenerate\b|\bcreate\b|எழுது|உருவாக்கு).*(?:code|function|component|கோடு|குறியீடு)/i.test(lower)) {
        return { intent: 'CODE_GENERATION', confidence: 0.86, feature: text };
    }

    if (/(?:எதாவது\s+பண்ணு|ஏதாவது\s+பண்ணு|something\s+to\s+this\s+project)/i.test(lower)) {
        return {
            confidence: 0.2,
            clarification: 'என்ன செய்ய வேண்டும்? Build செய்யவா, run செய்யவா, அல்லது code மாற்றவா?'
        };
    }

    const isCreate = tamilCreate.test(lower) && refersToProject;
    if (isCreate) {
        const name = projectNameFrom(text);
        return {
            intent: 'PROJECT_CREATE',
            confidence: name || /\b(?:react|node|typescript|python|html)\b/i.test(lower) ? 0.96 : 0.82,
            ...(name ? { projectName: name } : {}),
            template: projectTemplateFrom(text),
            openInVSCode: vsCodeMention.test(lower) && tamilOpen.test(lower),
            build,
            run,
            test
        };
    }

    if (/(?:ram|memory).*(?:evlo|எவ்வளவு)|(?:evlo|எவ்வளவு).*(?:ram|memory)|ram.*use\s*aaguthu/i.test(lower)) {
        return { intent: 'SYSTEM_QUERY', confidence: 0.95, section: 'ram' };
    }

    if (/(?:cpu|processor).*(?:evlo|எவ்வளவு|usage|use)|(?:evlo|எவ்வளவு).*(?:cpu|processor)/i.test(lower)) {
        return { intent: 'SYSTEM_QUERY', confidence: 0.93, section: 'cpu' };
    }
    if (/(?:battery|பேட்டரி).*(?:evlo|எவ்வளவு|level|status)|(?:evlo|எவ்வளவு).*(?:battery|பேட்டரி)/i.test(lower)) {
        return { intent: 'SYSTEM_QUERY', confidence: 0.92, section: 'battery' };
    }
    if (/(?:storage|disk|drive).*(?:evlo|எவ்வளவு|space|usage)|(?:evlo|எவ்வளவு).*(?:storage|disk|drive)/i.test(lower)) {
        return { intent: 'SYSTEM_QUERY', confidence: 0.9, section: 'storage' };
    }

    if (/(?:latest|current|today|now|இன்றைய|தற்போது|இப்போது).*(?:weather|news|price|version|வானிலை|செய்தி|விலை)|(?:weather|news|price|version|வானிலை|செய்தி|விலை).*(?:latest|current|today|now|இன்றைய|தற்போது|இப்போது)/i.test(lower)) {
        return { intent: 'CURRENT_FACT', confidence: 0.84 };
    }

    if (/build\s+error|error.*(?:enna|என்ன)|(?:enna|என்ன).*(?:error|பிழை)|(?:paaru|பார்).*(?:error|பிழை)/i.test(lower)) {
        return { intent: 'PROJECT_ANALYZE', confidence: 0.88 };
    }

    if (vsCodeMention.test(lower) && tamilOpen.test(lower)) {
        return { intent: 'APPLICATION_CONTROL', confidence: 0.96, applicationName: 'VS Code' };
    }

    const appOpen = lower.match(/(?:^|\s)(chrome|google chrome|notepad|calculator|file explorer|explorer|terminal)\s+(?:open|திற|திறந்து|pannu|பண்ணு)/i);
    if (appOpen) {
        return { intent: 'APPLICATION_CONTROL', confidence: 0.92, applicationName: appOpen[1] };
    }

    if (refersToProject && tamilOpen.test(lower)) {
        const namedProject = text.match(/(?:open|launch)\s+(?:my\s+)?([A-Za-z][A-Za-z0-9_-]{1,63})(?:\s+project)?\b/i)?.[1];
        return {
            intent: 'PROJECT_OPEN',
            confidence: 0.88,
            openInVSCode: vsCodeMention.test(lower),
            ...(namedProject ? { projectName: namedProject } : {})
        };
    }

    const namedProjectOnly = text.match(/^\s*(?:open|இந்த|my|the)?\s*([A-Za-z][A-Za-z0-9_-]{1,63})(?:\s+project)?\s*(?:ஐ|வை|project)?\s*[.!?]*$/i);
    if (namedProjectOnly && !/^(?:ram|memory|chrome|notepad|calculator|react|node|typescript|python|html|project|cancel|stop)$/i.test(namedProjectOnly[1])) {
        return { intent: 'PROJECT_SELECT', confidence: 0.88, projectName: namedProjectOnly[1] };
    }

    if (/(?:install|நிறுவு).*(?:dependency|dependencies|package|பேக்கேஜ்)|(?:dependency|dependencies|package|பேக்கேஜ்).*(?:install|நிறுவு|pannu)/i.test(lower)) {
        return { intent: 'DEPENDENCY_INSTALL', confidence: 0.86 };
    }

    if (/(?:search|look up|web|இணையத்தில்).*(?:search|தேடு|பார்)/i.test(lower)) {
        return { intent: 'WEB_LOOKUP', confidence: 0.82 };
    }

    return { intent: 'CHAT', confidence: 0.6 };
}
