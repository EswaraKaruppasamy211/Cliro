import type { ProjectTemplate } from './ProjectWorkspace';

export interface ProjectBlueprintFile {
    path: string;
    content: string;
}

export interface ProjectBlueprint {
    projectName: string;
    description: string;
    template: ProjectTemplate;
    language: string;
    frontend: string;
    backend: string;
    database: string;
    features: string[];
    roles: string[];
    folders: string[];
    files: ProjectBlueprintFile[];
    dependencies: string[];
    commands: string[];
    testPlan: string[];
    openInVSCode: boolean;
}

export interface ProjectBuildIdea {
    name: string;
    template: ProjectTemplate;
    openInVSCode: boolean;
    blueprint: ProjectBlueprint;
}

const featureSets: Array<{ pattern: RegExp; roles: string[]; features: string[] }> = [
    {
        pattern: /\b(?:attendance|classroom|school|college)\b/i,
        roles: ['Admin', 'Faculty', 'Student'],
        features: ['Class and course management', 'Attendance recording', 'Attendance history', 'Summary dashboard']
    },
    {
        pattern: /\b(?:placement|recruit|job portal)\b/i,
        roles: ['Admin', 'Student', 'Faculty', 'Company'],
        features: ['Authentication', 'Student profiles', 'Skill profiles', 'Job listings', 'Applications', 'Placement tracking', 'Company management', 'Analytics', 'Notifications']
    },
    {
        pattern: /\b(?:todo|to-do|task list|task management)\b/i,
        roles: ['User'],
        features: ['Add tasks', 'Mark tasks complete', 'Remove tasks', 'View remaining task count']
    },
    {
        pattern: /\b(?:resume|cv)\b/i,
        roles: ['User'],
        features: ['Resume input', 'Structured resume summary', 'Skills overview', 'Review checklist']
    },
    {
        pattern: /\b(?:expense|budget|finance)\b/i,
        roles: ['User'],
        features: ['Record transactions', 'Categorize expenses', 'View spending totals', 'Review recent activity']
    }
];

function safeSuggestedName(idea: string): string {
    const words = idea.match(/[\p{L}\p{N}]+/gu) ?? [];
    const name = words.slice(0, 4)
        .map(word => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
        .join('');
    return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(name) ? name : 'NewProject';
}

function parseIdeaPrompt(prompt: string): { idea: string; name?: string; openInVSCode: boolean } | null {
    let command = prompt.trim().replace(/[?.!]+$/, '').trim();
    const openInVSCode = /\band\s+open(?:\s+it)?(?:\s+in\s+(?:vs\s*code|visual\s+studio\s+code))?$/i.test(command);
    if (openInVSCode) command = command.replace(/\s+and\s+open(?:\s+it)?(?:\s+in\s+(?:vs\s*code|visual\s+studio\s+code))?$/i, '').trim();

    const name = command.match(/\s+called\s+["“]?([\p{L}\p{N}][\p{L}\p{N} ._-]{0,79})["”]?$/iu)?.[1]?.trim();
    if (name) command = command.replace(/\s+called\s+["“]?[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}["”]?$/iu, '').trim();

    const prefix = command.match(/^(?:please\s+)?(?:build|make|create|develop)(?:\s+me)?\s+(.+)$/iu)
        ?? command.match(/^i\s+want\s+(?:(?:to\s+)?(?:build|make|create|develop)\s+)?(.+)$/iu);
    if (!prefix) return null;
    const idea = prefix[1]
        .replace(/^(?:(?:a|an|the)\s+)?(?:simple|basic|small|full[- ]stack)\s+/i, '')
        .replace(/^(?:a|an|the)\s+/i, '')
        .trim();
    if (!/\b(?:app(?:lication)?|system|website|web\s+app|portal|tool|platform|tracker|manager|management|analyzer|automation|dashboard|landing\s+page|site|to-do|todo)\b/i.test(idea)) {
        return null;
    }
    return idea.length >= 3 ? { idea, name, openInVSCode } : null;
}

export function planProjectIdea(prompt: string): ProjectBuildIdea | null {
    const request = parseIdeaPrompt(prompt);
    if (!request) return null;
    const { idea, openInVSCode } = request;
    const name = request.name || safeSuggestedName(idea);
    const displayIdea = idea.replace(/[^\p{L}\p{N}\s.,'&()-]/gu, '').replace(/\s+/g, ' ').trim() || 'New application';
    const lower = idea.toLocaleLowerCase();
    const template: ProjectTemplate =
        /\b(?:python|automation tool|automation script)\b/i.test(lower) ? 'python'
            : /\b(?:api|server|backend)\b/i.test(lower) ? 'node'
                : /\b(?:static|landing page|html|css)\b/i.test(lower) && !/\b(?:portfolio|website|web app)\b/i.test(lower) ? 'html'
                    : 'react';
    const matchingFeatures = featureSets.find(item => item.pattern.test(idea));
    const roles = matchingFeatures?.roles ?? ['User', 'Admin'];
    const features = matchingFeatures?.features ?? ['Core workflow for the requested idea', 'Review current status', 'Manage records'];
    const language = template === 'python' ? 'Python'
        : template === 'html' ? 'HTML, CSS, JavaScript'
            : template === 'node' ? 'JavaScript'
                : 'TypeScript';
    const description = `A ${displayIdea}.`;
    const dependencies = template === 'react' ? ['react', 'react-dom', 'vite', 'typescript'] : [];
    const commands = template === 'react'
        ? ['npm install (requires separate approval)', 'npm run build (after dependencies are installed)', 'npm run dev (after a verified build)']
        : template === 'node' ? ['node --check index.js', 'npm start (requires separate approval to run)']
            : template === 'python' ? ['python -m py_compile main.py', 'python main.py (requires separate approval to run)']
                : ['Open index.html in a browser'];
    const testPlan = template === 'react'
        ? ['Verify generated files match the approved plan', 'Install declared dependencies only after approval', 'Run the TypeScript/Vite production build']
        : ['Verify generated files match the approved plan', 'Run static syntax checks where available'];

    const genericAppContent = template === 'react'
        ? `const features = ${JSON.stringify(features, null, 2)};\n\nexport default function App() {\n  return (\n    <main>\n      <p className=\"eyebrow\">${name}</p>\n              <h1>${displayIdea}</h1>\n      <p>${description}</p>\n      <section aria-label=\"Planned features\">\n        <h2>Project features</h2>\n        <ul>{features.map((feature) => <li key={feature}>{feature}</li>)}</ul>\n      </section>\n      <section aria-label=\"User roles\">\n        <h2>Roles</h2>\n        <p>${roles.join(' · ')}</p>\n      </section>\n    </main>\n  );\n}\n`
        : '';
    const isTodoApp = /\b(?:todo|to-do|task list|task management)\b/i.test(idea);
    const appContent = isTodoApp
        ? `import { useState, type FormEvent } from 'react';\n\ntype Task = { id: number; title: string; completed: boolean };\n\nexport default function App() {\n  const [tasks, setTasks] = useState<Task[]>([]);\n  const [title, setTitle] = useState('');\n  function addTask(event: FormEvent<HTMLFormElement>) {\n    event.preventDefault();\n    const trimmed = title.trim();\n    if (!trimmed) return;\n    setTasks(current => [...current, { id: Date.now(), title: trimmed, completed: false }]);\n    setTitle('');\n  }\n  return (\n    <main>\n      <p className=\"eyebrow\">${name}</p>\n      <h1>To-Do List</h1>\n      <p>Keep track of tasks and celebrate each completed step.</p>\n      <form onSubmit={addTask}><label htmlFor=\"new-task\">New task</label><div className=\"task-entry\"><input id=\"new-task\" value={title} onChange={event => setTitle(event.target.value)} maxLength={160} /><button type=\"submit\">Add task</button></div></form>\n      <p aria-live=\"polite\">{tasks.filter(task => !task.completed).length} tasks remaining</p>\n      <ul className=\"task-list\">{tasks.map(task => <li key={task.id} className={task.completed ? 'completed' : ''}><label><input type=\"checkbox\" checked={task.completed} onChange={() => setTasks(current => current.map(item => item.id === task.id ? { ...item, completed: !item.completed } : item))} />{task.title}</label><button type=\"button\" aria-label={\`Remove \${task.title}\`} onClick={() => setTasks(current => current.filter(item => item.id !== task.id))}>Remove</button></li>)}</ul>\n    </main>\n  );\n}\n`
        : genericAppContent;
    const files: ProjectBlueprintFile[] = template === 'react'
        ? [
            { path: 'src/App.tsx', content: appContent },
            { path: 'src/style.css', content: `body { margin: 0; font-family: system-ui, sans-serif; color: #162033; background: #f4f7fb; }\nmain { max-width: 760px; margin: 4rem auto; padding: 2rem; }\n.eyebrow { color: #4771c6; text-transform: uppercase; letter-spacing: .12em; }\nli { margin: .5rem 0; }\n` },
            { path: 'README.md', content: `# ${name}\n\n${description}\n\n## Roles\n\n${roles.map(role => `- ${role}`).join('\n')}\n\n## Features\n\n${features.map(feature => `- ${feature}`).join('\n')}\n\nDependencies are declared in package.json and are not installed automatically.\n` }
        ]
        : [{ path: 'README.md', content: `# ${name}\n\n${description}\n\n## Features\n\n${features.map(feature => `- ${feature}`).join('\n')}\n` }];
    const folders = template === 'react' ? ['src'] : [];
    return {
        name,
        template,
        openInVSCode,
        blueprint: {
            projectName: name,
            description,
            template,
            language,
            frontend: template === 'react' || template === 'html' ? template : 'none',
            backend: template === 'node' ? 'Node.js' : 'none',
            database: 'none (not requested)',
            features,
            roles,
            folders,
            files,
            dependencies,
            commands,
            testPlan,
            openInVSCode
        }
    };
}
