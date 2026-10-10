import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export interface CodeFinding {
    file?: string;
    line?: number;
    severity: 'error' | 'warning' | 'info';
    type: string;
    message: string;
}

interface SkippedFile {
    file: string;
    reason: string;
}

export interface CodeAnalysisResult {
    type: 'CODE_ANALYSIS';
    project: string;
    success: boolean;
    message: string;
    analysisMethod: string;
    durationMs: number;
    filesScanned: string[];
    filesSkipped: SkippedFile[];
    skippedCount: number;
    excludedDirectories: string[];
    bounded: boolean;
    findingsTruncated: boolean;
    errors: CodeFinding[];
    warnings: CodeFinding[];
    informationalFindings: CodeFinding[];
}

interface CollectedFile {
    absolutePath: string;
    relativePath: string;
    content: string;
}

export interface ProjectSourceFile {
    relativePath: string;
    content: string;
}

interface CollectionResult {
    files: CollectedFile[];
    filesSkipped: SkippedFile[];
    skippedCount: number;
    excludedDirectories: string[];
    bounded: boolean;
}

const sourceExtensions = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.py', '.java', '.md'
]);
const compilerExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
export const ignoredProjectDirectories = new Set([
    '.git', '.vscode', 'node_modules', 'dist', 'build', 'coverage',
    '.next', '.nuxt', '.venv', 'venv', 'vendor', 'target'
]);
const maxFiles = 200;
const maxFileBytes = 256 * 1024;
const maxTotalBytes = 5 * 1024 * 1024;
const maxEntries = 10000;
const maxDepth = 12;
const maxReportedFindings = 200;
const maxReportedSkippedFiles = 50;

export function isSensitiveProjectName(name: string): boolean {
    const normalized = name.toLowerCase();
    return normalized === '.env' ||
        normalized.startsWith('.env.') ||
        ['.npmrc', '.pypirc', '.netrc'].includes(normalized) ||
        /(?:secret|credential|password|token|private[_-]?key|api[_-]?key|access[_-]?key)/.test(normalized) ||
        /^(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/i.test(normalized) ||
        /\.(?:pem|key|p12|pfx|ppk|jks|keystore)$/i.test(normalized);
}

function toRelativePath(root: string, filePath: string): string {
    return path.relative(root, filePath).split(path.sep).join('/');
}

function addSkipped(collection: CollectionResult, file: string, reason: string): void {
    collection.skippedCount += 1;
    if (collection.filesSkipped.length < maxReportedSkippedFiles) {
        collection.filesSkipped.push({ file, reason });
    }
}

export function supportsProjectFileAnalysis(relativePath: string): boolean {
    return sourceExtensions.has(path.extname(relativePath).toLowerCase());
}

async function collectProjectFiles(root: string, targetRelativePath?: string): Promise<CollectionResult> {
    const collection: CollectionResult = {
        files: [],
        filesSkipped: [],
        skippedCount: 0,
        excludedDirectories: [],
        bounded: false
    };
    const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    let inspectedEntries = 0;
    let totalBytes = 0;

    while (pending.length > 0) {
        if (collection.files.length >= maxFiles || inspectedEntries >= maxEntries) {
            collection.bounded = true;
            addSkipped(collection, '[remaining eligible files not scanned]', 'A project scan limit was reached.');
            break;
        }

        const current = pending.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
            const relativePath = toRelativePath(root, current.directory);
            addSkipped(collection, relativePath || '.', `Unable to read directory: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        for (const entry of entries) {
            inspectedEntries += 1;
            if (inspectedEntries > maxEntries) {
                collection.bounded = true;
                break;
            }

            const absolutePath = path.join(current.directory, entry.name);
            const relativePath = toRelativePath(root, absolutePath);

            if (isSensitiveProjectName(entry.name)) {
                if (entry.isFile()) addSkipped(collection, '[sensitive file omitted]', 'Sensitive file names are never inspected.');
                continue;
            }

            if (entry.isDirectory()) {
                if (ignoredProjectDirectories.has(entry.name.toLowerCase())) {
                    if (collection.excludedDirectories.length < 50) collection.excludedDirectories.push(relativePath);
                    continue;
                }
                if (current.depth >= maxDepth) {
                    collection.bounded = true;
                    addSkipped(collection, relativePath, `Maximum directory depth (${maxDepth}) reached.`);
                    continue;
                }
                pending.push({ directory: absolutePath, depth: current.depth + 1 });
                continue;
            }

            if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name).toLowerCase())) continue;
            if (targetRelativePath && relativePath.toLowerCase() !== targetRelativePath.toLowerCase()) continue;
            if (/\.(?:min|bundle)\.(?:js|css)$/i.test(entry.name)) {
                addSkipped(collection, relativePath, 'Generated or minified file.');
                continue;
            }

            try {
                const details = await fs.promises.stat(absolutePath);
                if (details.size > maxFileBytes) {
                    addSkipped(collection, relativePath, `File exceeds the ${maxFileBytes / 1024} KB limit.`);
                    continue;
                }
                if (totalBytes + details.size > maxTotalBytes) {
                    addSkipped(collection, relativePath, 'Total analysis size limit reached.');
                    collection.bounded = true;
                    pending.length = 0;
                    break;
                }

                const buffer = await fs.promises.readFile(absolutePath);
                totalBytes += buffer.length;
                if (buffer.includes(0)) {
                    addSkipped(collection, relativePath, 'Binary content is not inspected.');
                    continue;
                }
                collection.files.push({
                    absolutePath,
                    relativePath,
                    content: buffer.toString('utf8')
                });
                if (collection.files.length >= maxFiles) {
                    collection.bounded = pending.length > 0 || entries.indexOf(entry) < entries.length - 1;
                    if (collection.bounded) addSkipped(collection, '[remaining eligible files not scanned]', `Maximum file count (${maxFiles}) reached.`);
                    break;
                }
            } catch (error) {
                addSkipped(collection, relativePath, `Unable to read file: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    collection.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    collection.filesSkipped.sort((left, right) => left.file.localeCompare(right.file));
    collection.excludedDirectories.sort();
    return collection;
}

export async function readProjectSources(root: string): Promise<ProjectSourceFile[]> {
    const collection = await collectProjectFiles(root);
    return collection.files.map(file => ({
        relativePath: file.relativePath,
        content: file.content
    }));
}

function jsonSyntaxFindings(files: CollectedFile[]): CodeFinding[] {
    const findings: CodeFinding[] = [];
    for (const file of files) {
        if (path.extname(file.absolutePath).toLowerCase() !== '.json') continue;
        try {
            if (/^tsconfig(?:\..+)?\.json$/i.test(path.basename(file.absolutePath))) parseJsonc(file.content);
            else JSON.parse(file.content);
        } catch (error) {
            const details = error instanceof Error ? error.message : '';
            const position = details.match(/position\s+(\d+)/i);
            const offset = position ? Number(position[1]) : -1;
            const line = offset >= 0 ? file.content.slice(0, offset).split(/\r?\n/).length : undefined;
            findings.push({
                file: file.relativePath,
                line,
                severity: 'error',
                type: 'JSON syntax',
                message: 'Invalid JSON syntax.'
            });
        }
    }
    return findings;
}

function parseJsonc(content: string): Record<string, unknown> {
    let withoutComments = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        const next = content[index + 1];
        if (inString) {
            withoutComments += character;
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
        } else if (character === '"') {
            inString = true;
            withoutComments += character;
        } else if (character === '/' && next === '/') {
            while (index < content.length && content[index] !== '\n') index += 1;
            withoutComments += '\n';
        } else if (character === '/' && next === '*') {
            index += 2;
            while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
                if (content[index] === '\n') withoutComments += '\n';
                index += 1;
            }
            index += 1;
        } else {
            withoutComments += character;
        }
    }

    let withoutTrailingCommas = '';
    inString = false;
    escaped = false;
    for (let index = 0; index < withoutComments.length; index += 1) {
        const character = withoutComments[index];
        if (inString) {
            withoutTrailingCommas += character;
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
        } else if (character === '"') {
            inString = true;
            withoutTrailingCommas += character;
        } else if (character === ',') {
            let nextIndex = index + 1;
            while (/\s/.test(withoutComments[nextIndex] || '')) nextIndex += 1;
            if (withoutComments[nextIndex] !== '}' && withoutComments[nextIndex] !== ']') {
                withoutTrailingCommas += character;
            }
        } else {
            withoutTrailingCommas += character;
        }
    }
    return JSON.parse(withoutTrailingCommas) as Record<string, unknown>;
}

function configMatchesFile(configPath: string, config: Record<string, unknown>, filePath: string): boolean {
    const configDirectory = path.dirname(configPath);
    const files = Array.isArray(config.files) ? config.files.filter((item): item is string => typeof item === 'string') : undefined;
    if (files) {
        return files.some(file => path.resolve(configDirectory, file).toLowerCase() === filePath.toLowerCase());
    }

    const includes = Array.isArray(config.include) ? config.include.filter((item): item is string => typeof item === 'string') : ['**/*'];
    return includes.some(include => {
        const absolutePattern = path.resolve(configDirectory, include).split(path.sep).join('/');
        const absoluteFile = filePath.split(path.sep).join('/');
        if (!/[*?]/.test(include)) {
            return absoluteFile.toLowerCase().startsWith(`${absolutePattern.toLowerCase()}/`) ||
                absoluteFile.toLowerCase() === absolutePattern.toLowerCase();
        }

        let expression = '';
        for (let index = 0; index < absolutePattern.length; index += 1) {
            const character = absolutePattern[index];
            if (character === '*' && absolutePattern[index + 1] === '*') {
                index += 1;
                if (absolutePattern[index + 1] === '/') {
                    index += 1;
                    expression += '(?:.*/)?';
                } else {
                    expression += '.*';
                }
            } else if (character === '*') {
                expression += '[^/]*';
            } else if (character === '?') {
                expression += '[^/]';
            } else {
                expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            }
        }
        return new RegExp(`^${expression}$`, 'i').test(absoluteFile);
    });
}

function redactDiagnostic(message: string): string {
    return message
        .replace(/(['"])(?:(?!\1).)*(?:secret|token|password|credential|api[_-]?key|private[_-]?key)(?:(?!\1).)*\1/gi, '"[redacted literal]"')
        .replace(/\b(?:[A-F0-9]{32,}|[A-Za-z0-9+/=_-]{40,})\b/g, '[redacted value]')
        .replace(/\b[A-Za-z]:\\(?:[^\s:'"]+\\)*[^\s:'"]+/g, '[path]')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 1000);
}

function staticInspectionFindings(files: CollectedFile[]): CodeFinding[] {
    const findings: CodeFinding[] = [];
    for (const file of files) {
        const extension = path.extname(file.absolutePath).toLowerCase();
        if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.css', '.html'].includes(extension)) continue;
        const lines = file.content.split(/\r?\n/);
        lines.forEach((line, index) => {
            if (/^\s*(?:<<<<<<< |>>>>>>> )/.test(line)) {
                findings.push({
                    file: file.relativePath,
                    line: index + 1,
                    severity: 'error',
                    type: 'Static source analysis',
                    message: 'Possible unresolved merge-conflict marker.'
                });
            }
        });
    }
    return findings;
}

const compilerOptionAllowlist = new Set([
    'allowImportingTsExtensions', 'allowJs', 'allowSyntheticDefaultImports', 'alwaysStrict', 'baseUrl',
    'checkJs', 'downlevelIteration', 'esModuleInterop', 'exactOptionalPropertyTypes',
    'experimentalDecorators', 'forceConsistentCasingInFileNames', 'isolatedModules', 'jsx',
    'lib', 'module', 'moduleResolution', 'noFallthroughCasesInSwitch', 'noImplicitAny',
    'noImplicitReturns', 'noImplicitThis', 'noUnusedLocals', 'noUnusedParameters',
    'preserveSymlinks', 'resolveJsonModule', 'rootDirs', 'skipLibCheck', 'strict', 'strictBindCallApply',
    'strictFunctionTypes', 'strictNullChecks', 'strictPropertyInitialization', 'target',
    'types', 'useDefineForClassFields', 'verbatimModuleSyntax'
]);

function compilerArguments(config: Record<string, unknown> | undefined, configDirectory: string): string[] {
    const compilerOptions = config?.compilerOptions && typeof config.compilerOptions === 'object'
        ? config.compilerOptions as Record<string, unknown>
        : {};
    const args: string[] = [];
    for (const [name, value] of Object.entries(compilerOptions)) {
        if (!compilerOptionAllowlist.has(name) || value === undefined || value === null) continue;
        let normalizedValue: string;
        if (Array.isArray(value)) {
            normalizedValue = name === 'rootDirs'
                ? value.filter((item): item is string => typeof item === 'string').map(item => path.resolve(configDirectory, item)).join(',')
                : value.join(',');
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            normalizedValue = name === 'baseUrl' ? path.resolve(configDirectory, String(value)) : String(value);
        } else {
            continue;
        }
        if (typeof value === 'boolean') {
            args.push(`--${name}`);
            if (!value) args.push('false');
        } else {
            args.push(`--${name}`, normalizedValue);
        }
    }
    args.push('--ignoreConfig', '--noEmit', '--incremental', 'false', '--skipLibCheck');
    if (compilerOptions.allowJs !== true) args.push('--allowJs');
    return args;
}

function findCompilerScript(projectRoot: string, startDirectory: string): string {
    let currentDirectory = startDirectory;
    while (true) {
        const candidate = path.join(currentDirectory, 'node_modules', 'typescript', 'bin', 'tsc');
        if (fs.existsSync(candidate)) return candidate;
        if (path.resolve(currentDirectory).toLowerCase() === path.resolve(projectRoot).toLowerCase()) break;
        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) break;
        currentDirectory = parentDirectory;
    }

    const backendCompiler = path.resolve(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
    if (fs.existsSync(backendCompiler)) return backendCompiler;
    throw new Error('No installed TypeScript compiler was found for the configured project.');
}

function showCompilerOptions(compilerScript: string, configPath: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [compilerScript, '--showConfig', '--project', configPath, '--pretty', 'false'], {
            cwd: path.dirname(configPath),
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 60000
        }, (error, stdout) => {
            if (error) {
                reject(new Error(`Unable to read TypeScript project settings: ${error.message}`));
                return;
            }
            try {
                const configuration = JSON.parse(stdout) as { compilerOptions?: Record<string, unknown> };
                resolve(configuration.compilerOptions || {});
            } catch {
                reject(new Error('TypeScript compiler returned invalid project settings.'));
            }
        });
    });
}

function runCompiler(
    root: string,
    rootNames: string[],
    config: Record<string, unknown> | undefined,
    configDirectory: string,
    knownPaths: Set<string>,
    addFinding: (finding: CodeFinding) => void,
    compilerScript: string
): Promise<void> {
    const args = [...compilerArguments(config, configDirectory), ...rootNames];
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [compilerScript, ...args], {
            cwd: configDirectory,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 60000
        }, (error, stdout, stderr) => {
            const output = `${stdout}${stderr}`.trim();
            if (error && typeof error.code !== 'number') {
                reject(new Error(`TypeScript compiler could not complete: ${error.message}`));
                return;
            }
            if (output.length === 0) {
                resolve();
                return;
            }

            let currentFinding: CodeFinding | undefined;
            let parsedDiagnosticCount = 0;
            const flushFinding = () => {
                if (currentFinding) {
                    addFinding(currentFinding);
                    currentFinding = undefined;
                }
            };

            for (const line of output.split(/\r?\n/)) {
                const match = line.match(/^(.*)\((\d+),(\d+)\):\s+(error|warning|suggestion)\s+(TS\d+):\s*(.*)$/i);
                if (match) {
                    flushFinding();
                    parsedDiagnosticCount += 1;
                    const absoluteFile = path.resolve(configDirectory, match[1]);
                    if (!knownPaths.has(absoluteFile.toLowerCase())) continue;
                    currentFinding = {
                        file: toRelativePath(root, absoluteFile),
                        line: Number(match[2]),
                        severity: match[4].toLowerCase() === 'error' ? 'error' : match[4].toLowerCase() === 'warning' ? 'warning' : 'info',
                        type: match[5],
                        message: redactDiagnostic(match[6])
                    };
                } else {
                    const globalMatch = line.match(/^(error|warning|suggestion)\s+(TS\d+):\s*(.*)$/i);
                    if (globalMatch) {
                        flushFinding();
                        parsedDiagnosticCount += 1;
                        currentFinding = {
                            file: configDirectory === root ? undefined : toRelativePath(root, path.join(configDirectory, 'tsconfig.json')),
                            severity: globalMatch[1].toLowerCase() === 'error' ? 'error' : globalMatch[1].toLowerCase() === 'warning' ? 'warning' : 'info',
                            type: globalMatch[2],
                            message: redactDiagnostic(globalMatch[3])
                        };
                    } else if (currentFinding && /^\s+/.test(line)) {
                        currentFinding.message = redactDiagnostic(`${currentFinding.message} ${line.trim()}`);
                    } else if (line.trim()) {
                        flushFinding();
                    }
                }
            }
            flushFinding();

            if (parsedDiagnosticCount === 0) {
                reject(new Error('TypeScript compiler returned diagnostics in an unsupported format.'));
                return;
            }
            resolve();
        });
    });
}

async function compilerFindings(
    root: string,
    files: CollectedFile[],
    addFinding: (finding: CodeFinding) => void
): Promise<void> {
    const compilerFiles = files.filter(file => compilerExtensions.has(path.extname(file.absolutePath).toLowerCase()));
    if (compilerFiles.length === 0) return;

    const knownPaths = new Set(files.map(file => path.resolve(file.absolutePath).toLowerCase()));
    const coveredPaths = new Set<string>();
    const configs = files
        .filter(file => /^tsconfig(?:\..+)?\.json$/i.test(path.basename(file.absolutePath)))
        .map(file => {
            try {
                return { file, config: parseJsonc(file.content) };
            } catch {
                return null;
            }
        })
        .filter((entry): entry is { file: CollectedFile; config: Record<string, unknown> } => entry !== null)
        .filter(({ config }) => typeof config.compilerOptions === 'object' && config.compilerOptions !== null);

    const configurations = configs.map(({ file, config }) => {
        const rootNames = compilerFiles
            .filter(candidate => configMatchesFile(file.absolutePath, config, candidate.absolutePath))
            .map(candidate => candidate.absolutePath);
        rootNames.forEach(filePath => coveredPaths.add(path.resolve(filePath).toLowerCase()));
        return { file, config, rootNames };
    }).filter(configuration => configuration.rootNames.length > 0);

    const unconfiguredFiles = compilerFiles
        .filter(file => !coveredPaths.has(path.resolve(file.absolutePath).toLowerCase()))
        .map(file => file.absolutePath);

    for (const configuration of configurations) {
        const configDirectory = path.dirname(configuration.file.absolutePath);
        const compilerScript = findCompilerScript(root, configDirectory);
        const options = await showCompilerOptions(compilerScript, configuration.file.absolutePath);
        await runCompiler(
            root,
            configuration.rootNames,
            { compilerOptions: options },
            configDirectory,
            knownPaths,
            addFinding,
            compilerScript
        );
    }

    if (unconfiguredFiles.length > 0) {
        const compilerScript = findCompilerScript(root, root);
        await runCompiler(root, unconfiguredFiles, {
            compilerOptions: {
                target: 'ES2022',
                allowJs: true,
                checkJs: false,
                skipLibCheck: true
            }
        }, root, knownPaths, addFinding, compilerScript);
    }
}

export async function analyzeProjectCode(project: string, projectRoot: string, targetRelativePath?: string): Promise<CodeAnalysisResult> {
    const startedAt = Date.now();
    const collection = await collectProjectFiles(projectRoot, targetRelativePath);
    const errors: CodeFinding[] = [];
    const warnings: CodeFinding[] = [];
    const informationalFindings: CodeFinding[] = [];
    let findingsTruncated = false;
    let findingCount = 0;

    const addFinding = (finding: CodeFinding) => {
        findingCount += 1;
        if (findingCount > maxReportedFindings) {
            findingsTruncated = true;
            return;
        }
        if (finding.severity === 'error') errors.push(finding);
        else if (finding.severity === 'warning') warnings.push(finding);
        else informationalFindings.push(finding);
    };

    jsonSyntaxFindings(collection.files).forEach(addFinding);
    staticInspectionFindings(collection.files).forEach(addFinding);
    await compilerFindings(projectRoot, collection.files, addFinding);

    const uncompiledCount = collection.files.filter(file => {
        const extension = path.extname(file.absolutePath).toLowerCase();
        return !compilerExtensions.has(extension) && extension !== '.json';
    }).length;
    if (uncompiledCount > 0) {
        addFinding({
            severity: 'info',
            type: 'Static analysis coverage',
            message: `${uncompiledCount} scanned non-TypeScript file(s) received safe static text checks and inventory only; no configured language compiler was found for those formats.`
        });
    }
    if (collection.bounded) {
        addFinding({
            severity: 'info',
            type: 'Analysis bounds',
            message: 'Analysis was bounded by the configured file, size, depth, or directory-entry limits.'
        });
    }

    const hasErrors = errors.length > 0;
    return {
        type: 'CODE_ANALYSIS',
        project,
        success: true,
        message: hasErrors
            ? `Code analysis completed. ${errors.length} error${errors.length === 1 ? '' : 's'} were detected by the available static checks.`
            : 'Code analysis completed. No errors were detected by the available static checks.',
        analysisMethod: 'Configured TypeScript compiler checks on bounded source roots (no emit), JSON syntax validation, and conservative static source checks for merge-conflict markers.',
        durationMs: Date.now() - startedAt,
        filesScanned: collection.files.map(file => file.relativePath),
        filesSkipped: collection.filesSkipped,
        skippedCount: collection.skippedCount,
        excludedDirectories: collection.excludedDirectories,
        bounded: collection.bounded,
        findingsTruncated,
        errors,
        warnings,
        informationalFindings
    };
}
