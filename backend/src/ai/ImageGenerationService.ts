import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
    GeneratedImage,
    ImageFormat,
    ImageGenerationError,
    ImageGenerationProvider,
    ImageSize,
    isValidImageBytes
} from './ImageGenerationProvider';
import { ProjectWorkspace, UserProject } from '../projects/ProjectWorkspace';

const APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_PROMPT_LENGTH = 4_000;

export interface ImageGenerationPlan {
    requestId: string;
    projectId: string;
    projectName: string;
    purpose: string;
    prompt: string;
    size: ImageSize;
    format: ImageFormat;
    count: number;
    outputPaths: string[];
    expiresAt: string;
}

export interface ImageApprovalRequest {
    approvalRequestId: string;
    expiresAt: string;
    plan: ImageGenerationPlan;
}

export interface ImageGenerationResult {
    type: 'IMAGE_GENERATED' | 'IMAGE_GENERATION_PARTIAL';
    verified: boolean;
    provider: string;
    projectId: string;
    prompt: string;
    message: string;
    imagePath?: string;
    imagePaths: string[];
    images: Array<{
        path?: string;
        absolutePath?: string;
        format: ImageFormat;
        mimeType: string;
        size: number;
        base64?: string;
        verified: boolean;
        error?: string;
    }>;
}

interface StoredApproval extends ImageApprovalRequest {
    projectId?: string;
    sourcePrompt: string;
    expiresAtMs: number;
    consumed: boolean;
}

export class ImageGenerationService {
    private readonly approvals = new Map<string, StoredApproval>();

    constructor(
        private readonly workspace: ProjectWorkspace,
        private readonly provider: ImageGenerationProvider,
        private readonly ttlMs = APPROVAL_TTL_MS,
        private readonly now = Date.now
    ) {}

    get providerStatus(): 'CONFIGURED' | 'NOT_CONFIGURED' {
        return this.provider.status;
    }

    createApproval(
        requestId: string,
        projectId: string,
        sourcePrompt: string,
        prompt: string,
        purpose: string,
        count: number,
        regenerate: boolean
    ): ImageApprovalRequest {
        const normalizedPrompt = prompt.trim();
        if (!requestId || requestId.length > 128) throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'A valid request ID is required.');
        if (!normalizedPrompt || normalizedPrompt.length > MAX_PROMPT_LENGTH) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', `Image prompt must contain 1 to ${MAX_PROMPT_LENGTH} characters.`);
        }
        if (!Number.isInteger(count) || count < 1 || count > 4) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'Image count must be between 1 and 4.');
        }

        if (!projectId) throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'Select a registered project before generating an image file.');
        const project = this.workspace.getProject(projectId);
        this.assertTrustedProjectPath(project.path);
        const outputPaths = this.availableOutputPaths(project.path, purpose, count, regenerate);

        const expiresAtMs = this.now() + this.ttlMs;
        const plan: ImageGenerationPlan = {
            requestId,
            projectId: project.id,
            projectName: project.name,
            purpose: purpose.slice(0, 100),
            prompt: normalizedPrompt,
            size: '1536x1024',
            format: 'png',
            count,
            outputPaths,
            expiresAt: new Date(expiresAtMs).toISOString()
        };
        const approvalRequestId = randomUUID();
        const approval: StoredApproval = {
            approvalRequestId,
            expiresAt: plan.expiresAt,
            plan,
            projectId: project.id,
            sourcePrompt: sourcePrompt.trim(),
            expiresAtMs,
            consumed: false
        };
        this.removeExpired();
        this.approvals.set(approvalRequestId, approval);
        return { approvalRequestId, expiresAt: plan.expiresAt, plan };
    }

    async generateApproved(input: {
        approvalRequestId: unknown;
        projectId?: string;
        sourcePrompt: string;
        approve: boolean;
    }): Promise<ImageGenerationResult | { type: 'IMAGE_GENERATION_CANCELLED'; verified: false; message: string }> {
        const approval = typeof input.approvalRequestId === 'string'
            ? this.approvals.get(input.approvalRequestId)
            : undefined;
        if (!approval || approval.consumed || approval.expiresAtMs <= this.now()) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'The image approval is invalid, expired, or already used.');
        }
        if (approval.projectId !== input.projectId ||
            approval.sourcePrompt !== input.sourcePrompt.trim()) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'The image approval does not match its original request.');
        }
        approval.consumed = true;
        this.approvals.delete(approval.approvalRequestId);
        if (!input.approve) {
            return {
                type: 'IMAGE_GENERATION_CANCELLED',
                verified: false,
                message: 'Image generation was cancelled. No image files were created.'
            };
        }

        const generated = await this.provider.generate({
            prompt: approval.plan.prompt,
            size: approval.plan.size,
            format: approval.plan.format,
            count: approval.plan.count
        });
        if (generated.length !== approval.plan.count) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE', 'The provider returned a different number of images than requested.');
        }

        const saved: ImageGenerationResult['images'] = [];
        for (let index = 0; index < generated.length; index += 1) {
            const image = generated[index];
            this.verifyGeneratedImage(image, approval.plan.format);
            const relativePath = approval.plan.outputPaths[index];
            if (relativePath) {
                try {
                    const project = this.workspace.getProject(approval.plan.projectId);
                    const target = await this.writeProjectImage(project, relativePath, image);
                    saved.push({
                        path: relativePath,
                        absolutePath: target.absolutePath,
                        format: image.format,
                        mimeType: image.mimeType,
                        size: target.size,
                        verified: true
                    });
                } catch (error) {
                    saved.push({
                        path: relativePath,
                        format: image.format,
                        mimeType: image.mimeType,
                        size: image.bytes.byteLength,
                        verified: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            } else {
                saved.push({
                    format: image.format,
                    mimeType: image.mimeType,
                    size: image.bytes.byteLength,
                    verified: true
                });
            }
        }
        const verified = saved.every(image => image.verified);
        return {
            type: verified ? 'IMAGE_GENERATED' : 'IMAGE_GENERATION_PARTIAL',
            verified,
            provider: this.provider.name,
            projectId: approval.plan.projectId,
            prompt: approval.plan.prompt,
            message: verified ? 'Image generated successfully.' : 'Image generation did not pass file verification.',
            ...(verified && saved[0]?.absolutePath ? { imagePath: saved[0].absolutePath } : {}),
            imagePaths: saved.flatMap(image => image.verified && image.absolutePath ? [image.absolutePath] : []),
            images: saved
        };
    }

    private removeExpired(): void {
        const now = this.now();
        for (const [id, approval] of this.approvals) {
            if (approval.expiresAtMs <= now) this.approvals.delete(id);
        }
    }

    private outputPathsForVersion(purpose: string, count: number, version: number): string[] {
        const slug = purpose.toLocaleLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 36) || 'generated-image';
        return Array.from({ length: count }, (_, index) => {
            const versionSuffix = version > 1 ? `-v${version}` : '';
            const suffix = index > 0 ? `-${index + 1}` : '';
            return `public/images/${slug}${versionSuffix}${suffix}.png`;
        });
    }

    private availableOutputPaths(projectPath: string, purpose: string, count: number, regenerate: boolean): string[] {
        for (let version = regenerate ? 2 : 1; version < 100; version += 1) {
            const outputPaths = this.outputPathsForVersion(purpose, count, version);
            if (outputPaths.every(relativePath => !fs.existsSync(path.join(projectPath, ...relativePath.split('/'))))) {
                return outputPaths;
            }
        }
        throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'No unused image output version is available.');
    }

    private assertTrustedProjectPath(projectPath: string): void {
        const absoluteRoot = path.resolve(this.workspace.projectsRoot);
        const absoluteProject = path.resolve(projectPath);
        if (path.dirname(absoluteProject).toLocaleLowerCase() !== absoluteRoot.toLocaleLowerCase()) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'Image assets may only be saved inside a direct child project of the trusted CLIRO projects root.');
        }
    }

    private async writeProjectImage(
        project: UserProject,
        relativePath: string,
        image: GeneratedImage
    ): Promise<{ size: number; absolutePath: string }> {
        this.assertTrustedProjectPath(project.path);
        const projectRoot = path.resolve(project.path);
        const canonicalRoot = await fs.promises.realpath(projectRoot);
        if (canonicalRoot.toLocaleLowerCase() !== projectRoot.toLocaleLowerCase()) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'The registered project path resolves through a link.');
        }
        const segments = relativePath.split('/');
        if (segments.length !== 3 || segments[0] !== 'public' || segments[1] !== 'images' ||
            !/^[a-z0-9-]{1,80}\.png$/i.test(segments[2])) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'The generated image output path is not allowed.');
        }
        const publicDirectory = path.join(projectRoot, 'public');
        const imageDirectory = path.join(publicDirectory, 'images');
        for (const directory of [publicDirectory, imageDirectory]) {
            try {
                await fs.promises.mkdir(directory);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            const details = await fs.promises.lstat(directory);
            if (!details.isDirectory() || details.isSymbolicLink()) {
                throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'Image output directories must be real project directories.');
            }
            const realDirectory = await fs.promises.realpath(directory);
            if (!realDirectory.toLocaleLowerCase().startsWith(`${canonicalRoot.toLocaleLowerCase()}${path.sep.toLocaleLowerCase()}`)) {
                throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'Image output directory escaped the registered project.');
            }
        }

        const targetPath = path.join(projectRoot, ...segments);
        const expectedDirectory = path.resolve(imageDirectory);
        if (path.dirname(path.resolve(targetPath)).toLocaleLowerCase() !== expectedDirectory.toLocaleLowerCase()) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'Image output escaped the project image directory.');
        }
        let handle: fs.promises.FileHandle | undefined;
        try {
            handle = await fs.promises.open(targetPath, 'wx');
            await handle.writeFile(image.bytes);
            await handle.sync();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', `Refusing to overwrite existing image ${relativePath}.`);
            }
            throw error;
        } finally {
            await handle?.close();
        }

        const stat = await fs.promises.lstat(targetPath);
        const realTarget = await fs.promises.realpath(targetPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== image.bytes.byteLength ||
            realTarget.toLocaleLowerCase() !== path.resolve(targetPath).toLocaleLowerCase()) {
            await fs.promises.unlink(targetPath);
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE', 'The generated image file did not pass post-write verification.');
        }
        const storedBytes = await fs.promises.readFile(targetPath);
        this.verifyGeneratedImage({ ...image, bytes: storedBytes }, image.format);
        return { size: stat.size, absolutePath: targetPath };
    }

    async readGeneratedImage(projectId: string, relativePath: string): Promise<{ bytes: Buffer; mimeType: string }> {
        const project = this.workspace.getProject(projectId);
        this.assertTrustedProjectPath(project.path);
        const projectRoot = path.resolve(project.path);
        const canonicalRoot = await fs.promises.realpath(projectRoot);
        if (canonicalRoot.toLocaleLowerCase() !== projectRoot.toLocaleLowerCase()) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'The registered project path resolves through a link.');
        }
        const segments = relativePath.split('/');
        if (segments.length !== 3 || segments[0] !== 'public' || segments[1] !== 'images' ||
            !/^[a-z0-9-]{1,80}\.png$/i.test(segments[2])) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'Only generated image assets may be previewed.');
        }
        for (let index = 0; index < segments.length - 1; index += 1) {
            const directory = path.join(projectRoot, ...segments.slice(0, index + 1));
            const directoryDetails = await fs.promises.lstat(directory);
            const realDirectory = await fs.promises.realpath(directory);
            if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink() ||
                !realDirectory.toLocaleLowerCase().startsWith(`${canonicalRoot.toLocaleLowerCase()}${path.sep.toLocaleLowerCase()}`)) {
                throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'The image preview path escaped the registered project.');
            }
        }
        const absolutePath = path.join(projectRoot, ...segments);
        const details = await fs.promises.lstat(absolutePath);
        const realPath = await fs.promises.realpath(absolutePath);
        if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > 20 * 1024 * 1024) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE', 'The generated image file is missing or has an invalid size.');
        }
        if (realPath.toLocaleLowerCase() !== absolutePath.toLocaleLowerCase()) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', 'The image preview path resolves outside its approved location.');
        }
        const bytes = await fs.promises.readFile(absolutePath);
        const image: GeneratedImage = { bytes, format: 'png', mimeType: 'image/png' };
        this.verifyGeneratedImage(image, 'png');
        return { bytes, mimeType: image.mimeType };
    }

    private verifyGeneratedImage(image: GeneratedImage, expectedFormat: ImageFormat): void {
        if (image.format !== expectedFormat || !image.mimeType.startsWith('image/') ||
            image.bytes.byteLength < 16 || image.bytes.byteLength > 20 * 1024 * 1024) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE', 'The generated image failed format or size verification.');
        }
        if (!isValidImageBytes(image.bytes, expectedFormat)) {
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE', 'The image file signature did not match the expected format.');
        }
    }
}
