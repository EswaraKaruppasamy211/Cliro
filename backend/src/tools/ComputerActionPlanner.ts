export type ComputerAction =
    | { type: 'OPEN_APPLICATION'; application: string }
    | { type: 'OPEN_FOLDER'; folder: string }
    | { type: 'CLOSE_APPLICATION'; application: string }
    | { type: 'CLOSE_FOREGROUND_WINDOW' }
    | { type: 'FOCUS_APPLICATION'; application: string }
    | { type: 'TYPE_TEXT'; text: string }
    | { type: 'PRESS_KEY'; key: SafeKeyAction };

export type SafeKeyAction =
    | 'ENTER'
    | 'ESCAPE'
    | 'TAB'
    | 'BACKSPACE'
    | 'CTRL_C'
    | 'CTRL_V'
    | 'CTRL_A'
    | 'CTRL_L'
    | 'ALT_TAB'
    | 'WINDOWS';

export type ComputerActionPlan =
    | { actions: ComputerAction[] }
    | { unsupported: string };

const folderNames: Record<string, string> = {
    desktop: 'Desktop',
    documents: 'Documents',
    downloads: 'Downloads',
    pictures: 'Pictures',
    music: 'Music',
    videos: 'Videos',
    projects: 'Projects',
    cliro: 'CLIRO'
};

const folderAliases: Record<string, string> = {
    'project folder': 'CLIRO',
    'my project': 'CLIRO',
    'project': 'CLIRO',
    'my project folder': 'CLIRO',
    'cliro project': 'CLIRO',
    'tms project': 'TMS'
};

const applicationAliases: Record<string, string> = {
    notepad: 'Notepad',
    'windows notepad': 'Notepad',
    'notepad.exe': 'Notepad',
    calculator: 'Calculator',
    'windows calculator': 'Calculator',
    calc: 'Calculator',
    chrome: 'Google Chrome',
    'google chrome': 'Google Chrome',
    edge: 'Microsoft Edge',
    'microsoft edge': 'Microsoft Edge',
    'vs code': 'Visual Studio Code',
    vscode: 'Visual Studio Code',
    code: 'Visual Studio Code',
    'visual studio code': 'Visual Studio Code',
    explorer: 'File Explorer',
    'file explorer': 'File Explorer',
    'windows explorer': 'File Explorer',
    paint: 'Paint',
    'microsoft paint': 'Paint',
    mspaint: 'Paint',
    terminal: 'Windows Terminal',
    'windows terminal': 'Windows Terminal',
    'command prompt': 'Command Prompt',
    cmd: 'Command Prompt',
    powershell: 'PowerShell',
    settings: 'Settings',
    'task manager': 'Task Manager'
};

const keyAliases: Record<string, SafeKeyAction> = {
    enter: 'ENTER',
    return: 'ENTER',
    escape: 'ESCAPE',
    esc: 'ESCAPE',
    tab: 'TAB',
    backspace: 'BACKSPACE',
    'ctrl+c': 'CTRL_C',
    'control+c': 'CTRL_C',
    'ctrl+v': 'CTRL_V',
    'control+v': 'CTRL_V',
    'ctrl+a': 'CTRL_A',
    'control+a': 'CTRL_A',
    'ctrl+l': 'CTRL_L',
    'control+l': 'CTRL_L',
    'alt+tab': 'ALT_TAB',
    'windows key': 'WINDOWS',
    'the windows key': 'WINDOWS'
};

function cleanEntity(value: string): string {
    return value.trim().replace(/^["']|["']$/g, '').replace(/[?.!,;]+$/, '').trim();
}

function applicationName(value: string): string | undefined {
    const cleaned = cleanEntity(value).replace(/^(?:my|the)\s+/i, '').replace(/\s+application$/i, '').trim();
    return applicationAliases[cleaned.toLowerCase()] || cleaned || undefined;
}

function folderName(value: string): string | undefined {
    const cleaned = cleanEntity(value)
        .replace(/^(?:(?:my|the|a|an)\s+)+/i, '')
        .replace(/\s+folder$/i, '')
        .replace(/^folder\s+(?:named|called)\s+/i, '')
        .trim();
    return folderNames[cleaned.toLowerCase()] ||
        folderAliases[cleaned.toLowerCase()] ||
        (cleaned ? cleaned : undefined);
}

function splitWriteChain(prompt: string): { before: string; text: string } | undefined {
    const match = prompt.match(/^(.+?)\s+(?:and\s+then|then|and)\s+(?:write|type)\s+(.+)$/i);
    if (!match) return undefined;
    const text = cleanEntity(match[2]);
    return text ? { before: match[1].trim(), text } : undefined;
}

function openAction(value: string): ComputerAction | undefined {
    const requested = cleanEntity(value)
        .replace(/^(?:my|the)\s+/i, '')
        .trim();
    if (!requested) return undefined;

    const exactPath = requested.replace(/^["']|["']$/g, '');
    if (/^(?:[a-z]:\\|\\\\)/i.test(exactPath)) {
        return { type: 'OPEN_FOLDER', folder: exactPath };
    }

    const folderMention = requested.match(/^(?:the\s+)?(?:folder\s+(?:named|called)\s+)?(.+?)(?:\s+folder)?$/i);
    const folderCandidate = folderMention?.[1]?.trim() || requested;
    const normalizedFolder = folderNames[folderCandidate.toLowerCase()];
    if (normalizedFolder && (
        /\bfolder\b/i.test(requested) ||
        ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos', 'projects'].includes(normalizedFolder.toLowerCase())
    )) {
        return { type: 'OPEN_FOLDER', folder: normalizedFolder };
    }

    const isFolder = /\bfolder\b/i.test(requested);
    if (isFolder) {
        const name = folderName(requested);
        return name ? { type: 'OPEN_FOLDER', folder: name } : undefined;
    }
    const application = applicationName(requested);
    return application ? { type: 'OPEN_APPLICATION', application } : undefined;
}

export function planComputerAction(prompt: string): ComputerActionPlan | null {
    const normalized = prompt.trim().replace(/\s+/g, ' ');
    if (!normalized) return null;

    if (/^(?:(?:run|execute|launch)\s+)?(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|taskkill(?:\.exe)?|format|reg(?:\.exe)?|(?:del|erase|rmdir|rd)\b)/i.test(normalized) ||
        /\b(?:force[- ]?kill|taskkill\b|delete\s+(?:(?:all|the)\s+)?(?:files?|folders?|directories?|drives?)|remove\s+(?:files?|folders?|directories?)|format\s+(?:the\s+)?drive|modify\s+the\s+registry)\b/i.test(normalized)) {
        return { unsupported: 'I cannot execute shell commands, force-kill processes, delete files, format drives, or modify the registry.' };
    }

    if (/^(?:click|double[- ]click|right[- ]click|scroll(?:\s+(?:up|down))?)\b/i.test(normalized)) {
        return { unsupported: 'Mouse control is unavailable because CLIRO does not yet have a verified semantic UI target. No click or scroll was attempted.' };
    }

    const keyMatch = normalized.match(/^(?:please\s+)?press\s+(.+?)\s*[?.!]*$/i);
    if (keyMatch) {
        const key = keyAliases[cleanEntity(keyMatch[1]).toLowerCase()];
        return key
            ? { actions: [{ type: 'PRESS_KEY', key }] }
            : { unsupported: 'That keyboard action is not in CLIRO’s fixed safe-key allowlist. No key was sent.' };
    }

    const closeFolder = /^(?:please\s+)?(?:close|exit)\s+(?:(?:the|this|current)\s+)*(?:folder|file explorer|explorer|window)\s*[?.!]*$/i.test(normalized);
    const closeCurrent = /^(?:please\s+)?(?:close|exit)\s+(?:(?:this|the current|current)\s+)?(?:window|application|app|it)\s*[?.!]*$/i.test(normalized);
    if (closeFolder || closeCurrent) {
        return { actions: [{ type: 'CLOSE_FOREGROUND_WINDOW' }] };
    }

    const closeMatch = normalized.match(/^(?:please\s+)?(?:close|exit)\s+(.+?)\s*[?.!]*$/i);
    if (closeMatch) {
        const target = cleanEntity(closeMatch[1]).replace(/^(?:the|my)\s+/i, '');
        if (target.toLowerCase() === 'it' || target.toLowerCase() === 'this' || target.toLowerCase() === 'this application') {
            return { actions: [{ type: 'CLOSE_FOREGROUND_WINDOW' }] };
        }
        const app = applicationName(target);
        return app ? { actions: [{ type: 'CLOSE_APPLICATION', application: app }] } : null;
    }

    const focusMatch = normalized.match(/^(?:please\s+)?(?:focus|switch to|bring)\s+(?:(?:the|window for)\s+)?(.+?)(?:\s+to the front)?\s*[?.!]*$/i);
    if (focusMatch) {
        const app = applicationName(focusMatch[1]);
        return app ? { actions: [{ type: 'FOCUS_APPLICATION', application: app }] } : null;
    }

    const calculatorChain = normalized.match(/^(?:please\s+)?(?:(?:could|can)\s+you\s+)?(?:open|launch|start)\s+(calculator|calc|windows calculator)\s+(?:and\s+then|then|and)\s+(?:calculate|compute)\s+(.+?)\s*[?.!]*$/i);
    if (calculatorChain) {
        const expression = calculatorChain[2]
            .replace(/\bplus\b/gi, '+')
            .replace(/\bminus\b/gi, '-')
            .replace(/\btimes\b|\bmultiplied by\b/gi, '*')
            .replace(/\bdivided by\b|\bover\b/gi, '/')
            .replace(/\s+/g, '');
        if (!/^[\d.+*/()\-]{1,80}$/.test(expression) || !/\d/.test(expression)) {
            return { unsupported: 'The calculator expression contains unsupported characters. No application was opened and no input was sent.' };
        }
        return {
            actions: [
                { type: 'OPEN_APPLICATION', application: 'Calculator' },
                { type: 'FOCUS_APPLICATION', application: 'Calculator' },
                { type: 'TYPE_TEXT', text: expression },
                { type: 'PRESS_KEY', key: 'ENTER' }
            ]
        };
    }

    const browserSearchChain = normalized.match(/^(?:please\s+)?(?:(?:could|can)\s+you\s+)?(?:open|launch|start)\s+(chrome|google chrome)\s+(?:and\s+then|then|and)\s+search(?:\s+for)?\s+(.+?)\s*[?.!]*$/i);
    if (browserSearchChain) {
        const query = cleanEntity(browserSearchChain[2]);
        if (!query || query.length > 300) {
            return { unsupported: 'The browser search text is empty or too long. No application was opened.' };
        }
        return {
            actions: [
                { type: 'OPEN_APPLICATION', application: 'Google Chrome' },
                { type: 'FOCUS_APPLICATION', application: 'Google Chrome' },
                { type: 'PRESS_KEY', key: 'CTRL_L' },
                { type: 'TYPE_TEXT', text: query },
                { type: 'PRESS_KEY', key: 'ENTER' }
            ]
        };
    }

    const chained = splitWriteChain(normalized);
    if (chained) {
        const openMatch = chained.before.match(/^(?:please\s+)?(?:could you\s+|can you\s+)?(?:open|launch|start)\s+(.+)$/i);
        const open = openMatch ? openAction(openMatch[1]) : undefined;
        if (!open || open.type !== 'OPEN_APPLICATION') {
            return { unsupported: 'This action chain requires one known application followed by explicit text. No action was run.' };
        }
        return {
            actions: [
                open,
                { type: 'FOCUS_APPLICATION', application: open.application },
                { type: 'TYPE_TEXT', text: chained.text }
            ]
        };
    }

    if (/^(?:please\s+)?(?:(?:could|can)\s+you\s+)?(?:open|launch|start)\s+.+\s+(?:and\s+then|then|and)\s+/i.test(normalized)) {
        return { unsupported: 'That action chain is not in CLIRO’s fixed action allowlist. No partial action was run.' };
    }

    const openMatch = normalized.match(/^(?:please\s+)?(?:(?:could|can)\s+you\s+)?(?:open|launch|start|go to)\s+(.+?)\s*[?.!]*$/i);
    if (openMatch) {
        const action = openAction(openMatch[1]);
        return action ? { actions: [action] } : null;
    }

    const writeMatch = normalized.match(/^(?:please\s+)?(?:write|type)\s+(?:the following text\s*[:,-]?\s*|this\s*[:,-]?\s*)?(.+?)\s*[?.!]*$/i);
    if (writeMatch) {
        const text = cleanEntity(writeMatch[1]);
        if (!text || /^(?:my name|this|the following text)$/i.test(text)) {
            return { unsupported: 'Please include the exact text CLIRO should type; it will not invent or infer text.' };
        }
        return { actions: [{ type: 'TYPE_TEXT', text }] };
    }

    return null;
}
