import { ProjectTemplate } from './ProjectWorkspace';

export interface ProjectCreationCommand {
    name: string;
    template: ProjectTemplate;
    openInVSCode: boolean;
}

export function parseProjectCreationCommand(prompt: string): ProjectCreationCommand | null {
    const openSuffix = /\s+and\s+open(?:\s+it)?(?:\s+in\s+(?:vs\s*code|visual\s+studio\s+code))?\s*[?.!]*$/i;
    const openInVSCode = openSuffix.test(prompt);
    const command = prompt.replace(openSuffix, '').trim().replace(
        /\s*(?:,|and)\s*\b(?:build|test|run)\b(?:\s+it)?(?:\s*(?:,|and)\s*\b(?:build|test|run)\b(?:\s+it)?)*[,.!?]*$/i,
        ''
    ).trim();
    const match = command.match(
        /\bcreate\s+(?:(?:a|an)\s+)?(?:(react|node(?:\.js)?|typescript|python|html(?:\s*\/\s*css(?:\s*\/\s*javascript)?)?|web)\s+)?project\s+(?:called|named)\s+["“]?(.+?)["”]?\s*[?.!]*$/i
    );
    if (!match) return null;
    const name = match[2].replace(/["'“”]+$/g, '').trim().replace(/\s+and\s+open(?:\s+it)?$/i, '').trim();
    if (!name) return null;
    const detectedType = match[1]?.toLowerCase().replace(/\s+/g, '') || '';
    const template: ProjectTemplate = detectedType === 'react' ? 'react'
        : detectedType === 'node' || detectedType === 'node.js' ? 'node'
            : detectedType === 'typescript' ? 'typescript'
                : detectedType === 'python' ? 'python'
                    : detectedType.startsWith('html') || detectedType === 'web' ? 'html'
                        : 'basic';
    return { name, template, openInVSCode };
}
