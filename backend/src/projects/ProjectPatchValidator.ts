import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { ProjectWorkspace, UserProject } from './ProjectWorkspace';

const manifestNames = new Set([
    'package.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts',
    'webpack.config.js', 'pyproject.toml', 'requirements.txt', 'go.mod',
    'cargo.toml', 'pom.xml', 'composer.json'
]);
const sourceExtensions = new Set([
    '.c', '.cc', '.cpp', '.cs', '.go', '.html', '.java', '.js', '.jsx',
    '.kt', '.mjs', '.cjs', '.php', '.py', '.rb', '.rs', '.swift', '.ts',
    '.tsx', '.vue'
]);
const styleExtensions = new Set(['.css', '.scss', '.sass', '.less']);
const secretExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore']);

export const MAX_MODIFICATION_FILE_BYTES = 256 * 1024;
export const MAX_MODIFICATION_CONTEXT_FILES = 80;
export const MAX_MODIFICATION_CONTEXT_BYTES = 1024 * 1024;

export type ProjectPatchOperation = 'CREATE' | 'REPLACE';

export interface ValidatedProjectFile {
    project: UserProject;
    projectRoot: string;
    absolutePath: string;
    relativePath: string;
    exists: boolean;
    content?: string;
}

export class ProjectPatchValidationError extends Error {
    constructor(
        message: string,
        readonly code: 'INVALID_PATH' | 'OUTSIDE_TRUSTED_ROOT' | 'SENSITIVE_PATH' |
            'UNSUPPORTED_FILE' | 'SYMLINK' | 'NOT_FOUND' | 'EXISTS' | 'FILE_TOO_LARGE' |
            'NOT_TEXT' | 'PROJECT_CHANGED'
    ) {
        super(message);
        this.name = 'ProjectPatchValidationError';
    }
}

export function sha256(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

export function validateRelativeProjectFilePath(input: unknown): string {
    if (typeof input !== 'string' || !input || input.length > 1024 ||
        input.startsWith('/') || input.includes('\\') || path.posix.isAbsolute(input) ||
        /^[a-zA-Z]:/.test(input) || input.includes('\0')) {
        throw new ProjectPatchValidationError('A normalized relative project file path is required.', 'INVALID_PATH');
    }

    const segments = input.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new ProjectPatchValidationError('Path traversal and empty path segments are not allowed.', 'INVALID_PATH');
    }

    if (segments.some(segment => {
        const name = segment.toLowerCase();
        return name === 'node_modules' || name === '.git' ||
            name === '.env' || name.startsWith('.env.') ||
            name.includes('secret') || name.includes('credential') ||
            name === 'id_rsa' || name === 'id_ed25519' ||
            secretExtensions.has(path.posix.extname(name));
    })) {
        throw new ProjectPatchValidationError('Sensitive project paths cannot be modified.', 'SENSITIVE_PATH');
    }

    const basename = segments[segments.length - 1].toLowerCase();
    const extension = path.posix.extname(basename);
    const isManifest = manifestNames.has(basename);
    const isSourceOrStyle = sourceExtensions.has(extension) || styleExtensions.has(extension);
    if (!isManifest && !isSourceOrStyle) {
        throw new ProjectPatchValidationError('Only allowlisted source, style, test, and manifest files can be modified.', 'UNSUPPORTED_FILE');
    }
    return segments.join('/');
}

function pathIsInside(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32'
        ? a.toLocaleLowerCase() === b.toLocaleLowerCase()
        : a === b;
}

export async function validateRegisteredProject(
    workspace: ProjectWorkspace,
    projectId: string,
    expectedProjectPath?: string
): Promise<{ project: UserProject; projectRoot: string }> {
    const project = workspace.getProject(projectId);
    if (expectedProjectPath && !samePath(project.path, expectedProjectPath)) {
        throw new ProjectPatchValidationError('The registered project path changed after planning.', 'PROJECT_CHANGED');
    }

    const trustedRoot = path.resolve(workspace.projectsRoot);
    let realRoot: string;
    let realProject: string;
    try {
        const rootDetails = await fs.promises.lstat(trustedRoot);
        if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
            throw new ProjectPatchValidationError('The trusted projects root must be a real directory.', 'OUTSIDE_TRUSTED_ROOT');
        }
        realRoot = await fs.promises.realpath(trustedRoot);
        realProject = await fs.promises.realpath(project.path);
    } catch (error) {
        if (error instanceof ProjectPatchValidationError) throw error;
        throw new ProjectPatchValidationError('The registered project or trusted root is unavailable.', 'OUTSIDE_TRUSTED_ROOT');
    }
    if (!samePath(realRoot, trustedRoot) || !samePath(realProject, path.resolve(project.path)) ||
        !pathIsInside(realProject, realRoot)) {
        throw new ProjectPatchValidationError(
            'Only registered projects located beneath the trusted CLIRO projects root may be modified.',
            'OUTSIDE_TRUSTED_ROOT'
        );
    }

    const relativeProjectPath = path.relative(realRoot, realProject);
    let cursor = realRoot;
    for (const segment of relativeProjectPath.split(path.sep)) {
        if (!segment) continue;
        cursor = path.join(cursor, segment);
        let details: fs.Stats;
        try {
            details = await fs.promises.lstat(cursor);
        } catch {
            throw new ProjectPatchValidationError('A registered project path component is unavailable.', 'OUTSIDE_TRUSTED_ROOT');
        }
        if (details.isSymbolicLink()) {
            throw new ProjectPatchValidationError('Linked project directories cannot be modified.', 'SYMLINK');
        }
        if (!details.isDirectory()) {
            throw new ProjectPatchValidationError('The registered project path is not a directory.', 'OUTSIDE_TRUSTED_ROOT');
        }
    }
    return { project, projectRoot: realProject };
}

export async function inspectProjectFile(
    workspace: ProjectWorkspace,
    projectId: string,
    inputPath: unknown,
    expectedProjectPath?: string
): Promise<ValidatedProjectFile> {
    const relativePath = validateRelativeProjectFilePath(inputPath);
    const { project, projectRoot } = await validateRegisteredProject(workspace, projectId, expectedProjectPath);
    const segments = relativePath.split('/');
    let current = projectRoot;
    for (const segment of segments.slice(0, -1)) {
        current = path.join(current, segment);
        let details: fs.Stats;
        try {
            details = await fs.promises.lstat(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new ProjectPatchValidationError('Parent directories must already exist.', 'NOT_FOUND');
            }
            throw error;
        }
        if (details.isSymbolicLink()) {
            throw new ProjectPatchValidationError('Linked files and folders cannot be modified.', 'SYMLINK');
        }
        if (!details.isDirectory()) {
            throw new ProjectPatchValidationError('A parent path component is not a directory.', 'INVALID_PATH');
        }
    }

    const absolutePath = path.join(projectRoot, ...segments);
    try {
        const details = await fs.promises.lstat(absolutePath);
        if (details.isSymbolicLink()) {
            throw new ProjectPatchValidationError('Linked files and folders cannot be modified.', 'SYMLINK');
        }
        if (!details.isFile()) {
            throw new ProjectPatchValidationError('Only regular files may be modified.', 'INVALID_PATH');
        }
        if (details.size > MAX_MODIFICATION_FILE_BYTES) {
            throw new ProjectPatchValidationError('The selected file exceeds the modification size limit.', 'FILE_TOO_LARGE');
        }
        const buffer = await fs.promises.readFile(absolutePath);
        if (buffer.includes(0)) {
            throw new ProjectPatchValidationError('Binary files cannot be modified.', 'NOT_TEXT');
        }
        return { project, projectRoot, absolutePath, relativePath, exists: true, content: buffer.toString('utf8') };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { project, projectRoot, absolutePath, relativePath, exists: false };
        }
        throw error;
    }
}
