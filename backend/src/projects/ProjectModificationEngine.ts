import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
    MAX_MODIFICATION_CONTEXT_BYTES,
    MAX_MODIFICATION_CONTEXT_FILES,
    MAX_MODIFICATION_FILE_BYTES,
    inspectProjectFile,
    ProjectPatchOperation,
    ProjectPatchValidationError,
    sha256,
    validateRegisteredProject,
    validateRelativeProjectFilePath
} from './ProjectPatchValidator';
import { ProjectSnapshot, ProjectWorkspace } from './ProjectWorkspace';

const MAX_PLAN_CHANGES = 20;
const MAX_APPROVAL_TTL_MS = 30 * 60 * 1000;

export interface ProjectModificationContextFile {
    path: string;
    content: string;
}

export interface ProjectModificationGeneratorInput {
    requestId: string;
    projectId: string;
    instruction: string;
    snapshot: ProjectSnapshot;
    eligibleFiles: readonly ProjectModificationContextFile[];
    inventoryComplete: boolean;
    provider?: 'OPENAI' | 'OLLAMA';
    model?: string;
}

export interface GeneratedProjectChange {
    path: string;
    content: string;
}

export interface ProjectModificationGenerator {
    generate(input: ProjectModificationGeneratorInput): Promise<readonly GeneratedProjectChange[]>;
}

export interface ProjectChangeDiffMetadata {
    beforeSha256: string | null;
    afterSha256: string;
    beforeBytes: number;
    afterBytes: number;
    beforeLines: number;
    afterLines: number;
    lineDelta: number;
}

export interface ProjectPlannedChange {
    operation: ProjectPatchOperation;
    path: string;
    content: string;
    diff: ProjectChangeDiffMetadata;
}

export interface ProjectModificationPlan {
    requestId: string;
    projectId: string;
    instruction: string;
    planSha256: string;
    expiresAt: number;
    changes: readonly ProjectPlannedChange[];
}

export type ProjectModificationProposalResult =
    | { status: 'unsupported'; reason: string }
    | { status: 'pending_approval'; proposal: ProjectModificationPlan };

export interface ProjectModificationApplyResult {
    status: 'applied';
    requestId: string;
    projectId: string;
    changedPaths: string[];
    changes: Array<{
        path: string;
        operation: ProjectPatchOperation;
        diff: ProjectChangeDiffMetadata;
    }>;
}

export type ProjectModificationApprovalResult =
    | { status: 'approved'; requestId: string; projectId: string; planSha256: string }
    | { status: 'cancelled'; requestId: string; projectId: string };

export class ProjectModificationError extends Error {
    constructor(
        message: string,
        readonly code: 'INVALID_REQUEST' | 'REQUEST_EXISTS' | 'UNKNOWN_REQUEST' |
            'PROJECT_MISMATCH' | 'REQUEST_MISMATCH' | 'EXPIRED' | 'INVALID_STATE' |
            'GENERATION_FAILED' | 'INVALID_PLAN' | 'STALE_FILE' | 'WRITE_FAILED' |
            'VERIFY_FAILED' | 'PROJECT_CHANGED' | 'PARTIAL_APPLY',
        readonly partial?: { changedPaths: string[]; verifiedPaths: string[] }
    ) {
        super(message);
        this.name = 'ProjectModificationError';
    }
}

interface InternalChange extends ProjectPlannedChange {
    expectedBeforeContent?: string;
}

interface ApprovalEntry {
    requestId: string;
    projectId: string;
    projectPath: string;
    plan: ProjectModificationPlan;
    internalChanges: readonly InternalChange[];
    state: 'pending' | 'approved' | 'applying' | 'consumed' | 'cancelled';
}

function stableJson(value: unknown): string {
    return JSON.stringify(value);
}

function countLines(content: string): number {
    return content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
}

function freezePlan(plan: ProjectModificationPlan): ProjectModificationPlan {
    for (const change of plan.changes) {
        Object.freeze(change.diff);
        Object.freeze(change);
    }
    Object.freeze(plan.changes);
    return Object.freeze(plan);
}

function validateRequestFields(requestId: unknown, projectId: unknown, instruction: unknown): asserts requestId is string {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200 ||
        typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200 ||
        typeof instruction !== 'string' || !instruction.trim() || instruction.length > 8_000) {
        throw new ProjectModificationError(
            'A request ID, registered project ID, and instruction of at most 8,000 characters are required.',
            'INVALID_REQUEST'
        );
    }
}

function resultChange(
    operation: ProjectPatchOperation,
    relativePath: string,
    content: string,
    beforeContent?: string
): InternalChange {
    const afterBuffer = Buffer.from(content, 'utf8');
    const beforeBuffer = beforeContent === undefined ? undefined : Buffer.from(beforeContent, 'utf8');
    return {
        operation,
        path: relativePath,
        content,
        diff: {
            beforeSha256: beforeBuffer ? sha256(beforeBuffer) : null,
            afterSha256: sha256(afterBuffer),
            beforeBytes: beforeBuffer?.length ?? 0,
            afterBytes: afterBuffer.length,
            beforeLines: beforeContent === undefined ? 0 : countLines(beforeContent),
            afterLines: countLines(content),
            lineDelta: countLines(content) - (beforeContent === undefined ? 0 : countLines(beforeContent))
        },
        expectedBeforeContent: beforeContent
    };
}

export class ProjectModificationEngine {
    private readonly approvals = new Map<string, ApprovalEntry>();
    private readonly approvalTtlMs: number;
    private readonly now: () => number;

    constructor(
        private readonly workspace: ProjectWorkspace,
        private readonly generator?: ProjectModificationGenerator,
        options: { approvalTtlMs?: number; now?: () => number } = {}
    ) {
        const requestedTtl = options.approvalTtlMs ?? 5 * 60 * 1000;
        this.approvalTtlMs = Math.min(
            MAX_APPROVAL_TTL_MS,
            Math.max(1, Math.trunc(Number.isFinite(requestedTtl) ? requestedTtl : 5 * 60 * 1000))
        );
        this.now = options.now ?? Date.now;
    }

    async propose(input: {
        requestId: string;
        projectId: string;
        instruction: string;
        provider?: 'OPENAI' | 'OLLAMA';
        model?: string;
    }): Promise<ProjectModificationProposalResult> {
        validateRequestFields(input?.requestId, input?.projectId, input?.instruction);
        this.expireEntries();
        if (this.approvals.has(input.requestId)) {
            throw new ProjectModificationError('This modification request ID has already been used.', 'REQUEST_EXISTS');
        }
        if (!this.generator) {
            return {
                status: 'unsupported',
                reason: 'No project modification content generator is configured; no files were changed.'
            };
        }

        const { project } = await validateRegisteredProject(this.workspace, input.projectId);
        let snapshot: ProjectSnapshot;
        try {
            snapshot = await this.workspace.scanProject(input.projectId);
        } catch (error) {
            throw new ProjectModificationError(
                `The registered project could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
                'PROJECT_CHANGED'
            );
        }

        const eligibleFiles: ProjectModificationContextFile[] = [];
        let usedContextBytes = 0;
        const files = snapshot.files
            .filter(entry => entry.type === 'file')
            .map(entry => entry.path)
            .sort((left, right) => left.localeCompare(right));
        for (const filePath of files) {
            if (eligibleFiles.length >= MAX_MODIFICATION_CONTEXT_FILES) break;
            try {
                const checked = await inspectProjectFile(this.workspace, input.projectId, filePath, project.path);
                if (!checked.exists || checked.content === undefined) continue;
                const size = Buffer.byteLength(checked.content, 'utf8');
                if (usedContextBytes + size > MAX_MODIFICATION_CONTEXT_BYTES) continue;
                eligibleFiles.push({ path: checked.relativePath, content: checked.content });
                usedContextBytes += size;
            } catch (error) {
                if (error instanceof ProjectPatchValidationError) continue;
                throw error;
            }
        }

        let generated: readonly GeneratedProjectChange[];
        try {
            generated = await this.generator.generate({
                requestId: input.requestId,
                projectId: input.projectId,
                instruction: input.instruction.trim(),
                snapshot,
                eligibleFiles: Object.freeze(eligibleFiles.map(file => Object.freeze(file))),
                inventoryComplete: !snapshot.bounded,
                provider: input.provider,
                model: input.model
            });
        } catch (error) {
            throw new ProjectModificationError(
                `The modification generator failed: ${error instanceof Error ? error.message : String(error)}`,
                'GENERATION_FAILED'
            );
        }

        if (!Array.isArray(generated) || generated.length === 0 || generated.length > MAX_PLAN_CHANGES) {
            throw new ProjectModificationError(
                `The generator must return between 1 and ${MAX_PLAN_CHANGES} file changes.`,
                'INVALID_PLAN'
            );
        }

        const seen = new Set<string>();
        const planned: InternalChange[] = [];
        for (const generatedChange of generated) {
            if (!generatedChange || typeof generatedChange.path !== 'string' || typeof generatedChange.content !== 'string') {
                throw new ProjectModificationError('The generator returned a malformed file change.', 'INVALID_PLAN');
            }
            let relativePath: string;
            try {
                relativePath = validateRelativeProjectFilePath(generatedChange.path);
            } catch (error) {
                throw new ProjectModificationError(
                    error instanceof Error ? error.message : 'The generator returned an ineligible path.',
                    'INVALID_PLAN'
                );
            }
            const key = process.platform === 'win32' ? relativePath.toLocaleLowerCase() : relativePath;
            if (seen.has(key)) throw new ProjectModificationError('The plan contains duplicate file paths.', 'INVALID_PLAN');
            seen.add(key);
            const outputBytes = Buffer.from(generatedChange.content, 'utf8');
            if (generatedChange.content.includes('\0') || outputBytes.length > MAX_MODIFICATION_FILE_BYTES ||
                outputBytes.toString('utf8') !== generatedChange.content) {
                throw new ProjectModificationError('The generator returned binary, oversized, or invalid UTF-8 content.', 'INVALID_PLAN');
            }

            let current;
            try {
                current = await inspectProjectFile(this.workspace, input.projectId, relativePath, project.path);
            } catch (error) {
                throw new ProjectModificationError(
                    error instanceof Error ? error.message : 'The file could not be validated.',
                    'INVALID_PLAN'
                );
            }
            planned.push(resultChange(
                current.exists ? 'REPLACE' : 'CREATE',
                relativePath,
                generatedChange.content,
                current.content
            ));
        }
        planned.sort((left, right) => left.path.localeCompare(right.path));

        const planCore = {
            requestId: input.requestId,
            projectId: input.projectId,
            instruction: input.instruction.trim(),
            changes: planned.map(({ expectedBeforeContent: _before, ...change }) => change)
        };
        const planSha256 = sha256(stableJson(planCore));
        const expiresAt = this.now() + this.approvalTtlMs;
        const plan = freezePlan({ ...planCore, planSha256, expiresAt });
        this.approvals.set(input.requestId, {
            requestId: input.requestId,
            projectId: input.projectId,
            projectPath: project.path,
            plan,
            internalChanges: planned,
            state: 'pending'
        });
        return { status: 'pending_approval', proposal: plan };
    }

    approve(requestId: string, projectId: string): ProjectModificationApprovalResult {
        const entry = this.getEntry(requestId, projectId);
        this.ensureNotExpired(entry);
        if (entry.state !== 'pending') {
            throw new ProjectModificationError('This modification request is not awaiting approval.', 'INVALID_STATE');
        }
        entry.state = 'approved';
        return {
            status: 'approved',
            requestId,
            projectId,
            planSha256: entry.plan.planSha256
        };
    }

    cancel(requestId: string, projectId: string): ProjectModificationApprovalResult {
        const entry = this.getEntry(requestId, projectId);
        this.ensureNotExpired(entry);
        if (entry.state !== 'pending' && entry.state !== 'approved') {
            throw new ProjectModificationError('This modification request can no longer be cancelled.', 'INVALID_STATE');
        }
        entry.state = 'cancelled';
        return { status: 'cancelled', requestId, projectId };
    }

    async apply(requestId: string, projectId: string): Promise<ProjectModificationApplyResult> {
        const entry = this.getEntry(requestId, projectId);
        this.ensureNotExpired(entry);
        if (entry.state !== 'approved') {
            throw new ProjectModificationError('Explicit approval is required before applying a project plan.', 'INVALID_STATE');
        }
        entry.state = 'applying';

        const applied: ProjectModificationApplyResult['changes'] = [];
        const writtenPaths: string[] = [];
        try {
            for (const change of entry.internalChanges) {
                const current = await inspectProjectFile(
                    this.workspace,
                    projectId,
                    change.path,
                    entry.projectPath
                );
                if (change.operation === 'CREATE') {
                    if (current.exists) throw new ProjectModificationError(`The planned new file now exists: ${change.path}`, 'STALE_FILE');
                } else if (!current.exists || current.content !== change.expectedBeforeContent) {
                    throw new ProjectModificationError(`The planned file changed after approval: ${change.path}`, 'STALE_FILE');
                }

                const bytes = Buffer.from(change.content, 'utf8');
                await this.atomicWrite(current.absolutePath, bytes, change.operation === 'CREATE');
                writtenPaths.push(change.path);
                const verified = await fs.promises.readFile(current.absolutePath);
                if (!verified.equals(bytes)) {
                    throw new ProjectModificationError(`The output did not exactly match the approved content: ${change.path}`, 'VERIFY_FAILED');
                }
                applied.push({
                    path: change.path,
                    operation: change.operation,
                    diff: change.diff
                });
            }
        } catch (error) {
            entry.state = 'consumed';
            if (writtenPaths.length > 0) {
                const verifiedPaths = applied.map(change => change.path);
                throw new ProjectModificationError(
                    `The approved plan stopped after writing ${writtenPaths.length} file(s). Read-back verified: ${verifiedPaths.join(', ') || 'none'}.`,
                    'PARTIAL_APPLY',
                    { changedPaths: writtenPaths, verifiedPaths }
                );
            }
            if (error instanceof ProjectModificationError) throw error;
            throw new ProjectModificationError(
                `Unable to apply the approved project plan: ${error instanceof Error ? error.message : String(error)}`,
                'WRITE_FAILED'
            );
        }
        entry.state = 'consumed';
        return {
            status: 'applied',
            requestId,
            projectId,
            changedPaths: applied.map(change => change.path),
            changes: applied
        };
    }

    private async atomicWrite(targetPath: string, content: Buffer, createOnly: boolean): Promise<void> {
        const directory = path.dirname(targetPath);
        const temporaryPath = path.join(directory, `.cliro-${randomUUID()}.tmp`);
        let handle: fs.promises.FileHandle | undefined;
        try {
            handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
            await handle.writeFile(content);
            await handle.sync();
            await handle.close();
            handle = undefined;
            if (createOnly) {
                await fs.promises.link(temporaryPath, targetPath);
                await fs.promises.unlink(temporaryPath);
            } else {
                await fs.promises.rename(temporaryPath, targetPath);
            }
        } catch (error) {
            if (handle) await handle.close().catch(() => undefined);
            await fs.promises.unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }

    private getEntry(requestId: string, projectId: string): ApprovalEntry {
        if (typeof requestId !== 'string' || !requestId || typeof projectId !== 'string' || !projectId) {
            throw new ProjectModificationError('A request ID and project ID are required.', 'INVALID_REQUEST');
        }
        const entry = this.approvals.get(requestId);
        if (!entry) throw new ProjectModificationError('The modification request is unknown or no longer available.', 'UNKNOWN_REQUEST');
        if (entry.projectId !== projectId) {
            throw new ProjectModificationError('The approval belongs to a different project.', 'PROJECT_MISMATCH');
        }
        if (entry.requestId !== requestId) {
            throw new ProjectModificationError('The approval does not match this request.', 'REQUEST_MISMATCH');
        }
        return entry;
    }

    private ensureNotExpired(entry: ApprovalEntry): void {
        if (this.now() >= entry.plan.expiresAt) {
            entry.state = 'consumed';
            throw new ProjectModificationError('The project modification approval has expired.', 'EXPIRED');
        }
    }

    private expireEntries(): void {
        const now = this.now();
        for (const [requestId, entry] of this.approvals) {
            if (now >= entry.plan.expiresAt) this.approvals.delete(requestId);
        }
    }
}
