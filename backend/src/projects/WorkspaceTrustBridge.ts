import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { UserProject, ProjectWorkspace, CLIRO_PROJECTS_ROOT } from './ProjectWorkspace';

export type WorkspaceTrustStatus =
    | 'TRUSTED'
    | 'RESTRICTED'
    | 'UNAVAILABLE'
    | 'WRONG_WORKSPACE'
    | 'OUTSIDE_CLIRO_ROOT'
    | 'CANCELLED';

export interface WorkspaceTrustReport {
    workspacePath: string;
    isTrusted: boolean;
    observedAt: string;
    requestId?: string;
}

export interface WorkspaceTrustRequest {
    requestId: string;
    projectId: string;
    projectPath: string;
    createdAt: string;
}

export function isCliroProjectPath(projectPath: string, projectsRoot = CLIRO_PROJECTS_ROOT): boolean {
    if (!path.isAbsolute(projectPath) || !path.isAbsolute(projectsRoot)) return false;
    const root = path.resolve(projectsRoot);
    const candidate = path.resolve(projectPath);
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function classifyWorkspaceTrust(
    expectedPath: string,
    report: WorkspaceTrustReport | undefined,
    projectsRoot = CLIRO_PROJECTS_ROOT,
    now = Date.now()
): WorkspaceTrustStatus {
    if (!isCliroProjectPath(expectedPath, projectsRoot)) return 'OUTSIDE_CLIRO_ROOT';
    if (!report) return 'UNAVAILABLE';
    if (path.resolve(report.workspacePath).toLocaleLowerCase() !== path.resolve(expectedPath).toLocaleLowerCase()) {
        return 'WRONG_WORKSPACE';
    }
    const observedAt = Date.parse(report.observedAt);
    if (!Number.isFinite(observedAt) || now - observedAt > 20_000 || observedAt > now + 5_000) {
        return 'UNAVAILABLE';
    }
    return report.isTrusted ? 'TRUSTED' : 'RESTRICTED';
}

export class WorkspaceTrustBridge {
    private readonly reports = new Map<string, WorkspaceTrustReport>();
    private readonly requests = new Map<string, WorkspaceTrustRequest>();
    private readonly cancelledRequests = new Set<string>();

    constructor(private readonly projectWorkspace: ProjectWorkspace) {}

    getStatus(project: UserProject): WorkspaceTrustStatus {
        if (!this.isRegisteredCliroProject(project)) return 'UNAVAILABLE';
        const report = this.reports.get(this.key(project.path));
        if (report?.requestId && this.cancelledRequests.has(report.requestId)) return 'CANCELLED';
        return classifyWorkspaceTrust(project.path, report, this.projectWorkspace.projectsRoot);
    }

    getStatusForPath(workspacePath: string): WorkspaceTrustStatus {
        if (!isCliroProjectPath(workspacePath, this.projectWorkspace.projectsRoot)) return 'OUTSIDE_CLIRO_ROOT';
        const project = this.findRegisteredProject(workspacePath);
        return project ? this.getStatus(project) : 'UNAVAILABLE';
    }

    async waitForStatus(project: UserProject, timeoutMs = 5_000): Promise<WorkspaceTrustStatus> {
        const deadline = Date.now() + timeoutMs;
        let status = this.getStatus(project);
        while (status === 'UNAVAILABLE' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 250));
            status = this.getStatus(project);
        }
        return status;
    }

    async waitForStatusForPath(workspacePath: string, timeoutMs = 5_000): Promise<WorkspaceTrustStatus> {
        const deadline = Date.now() + timeoutMs;
        let status = this.getStatusForPath(workspacePath);
        while (status === 'UNAVAILABLE' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 250));
            status = this.getStatusForPath(workspacePath);
        }
        return status;
    }

    createTrustRequest(project: UserProject): WorkspaceTrustRequest {
        this.assertRegisteredCliroProject(project);
        const request: WorkspaceTrustRequest = {
            requestId: randomUUID(),
            projectId: project.id,
            projectPath: path.resolve(project.path),
            createdAt: new Date().toISOString()
        };
        this.cancelledRequests.delete(request.requestId);
        this.requests.set(this.key(project.path), request);
        return request;
    }

    cancelTrustRequest(project: UserProject, requestId: string): boolean {
        const key = this.key(project.path);
        const request = this.requests.get(key);
        if (!request || request.requestId !== requestId) return false;
        this.requests.delete(key);
        this.cancelledRequests.add(requestId);
        this.reports.set(key, {
            workspacePath: project.path,
            isTrusted: false,
            observedAt: new Date().toISOString(),
            requestId
        });
        return true;
    }

    poll(workspacePath: string): { trustStatus: WorkspaceTrustStatus; request: WorkspaceTrustRequest | null } {
        const project = this.findRegisteredProject(workspacePath);
        if (!project || !this.isRegisteredCliroProject(project)) {
            return { trustStatus: 'UNAVAILABLE', request: null };
        }
        return {
            trustStatus: this.getStatus(project),
            request: this.requests.get(this.key(project.path)) ?? null
        };
    }

    report(workspacePath: string, isTrusted: boolean, requestId?: string): WorkspaceTrustReport {
        const project = this.findRegisteredProject(workspacePath);
        if (!project || !this.isRegisteredCliroProject(project)) {
            throw new Error('Workspace trust reports are accepted only for registered CLIRO projects under D:\\CLIROProjects.');
        }
        const canonicalPath = path.resolve(project.path);
        if (path.resolve(workspacePath).toLocaleLowerCase() !== canonicalPath.toLocaleLowerCase()) {
            throw new Error('The VS Code trust report does not match the registered project workspace.');
        }
        if (requestId) {
            const request = this.requests.get(this.key(project.path));
            if (!request || request.requestId !== requestId || request.projectId !== project.id) {
                throw new Error('The VS Code trust report does not match an active user-approved request.');
            }
        }
        const report: WorkspaceTrustReport = {
            workspacePath: canonicalPath,
            isTrusted,
            observedAt: new Date().toISOString(),
            ...(requestId ? { requestId } : {})
        };
        this.reports.set(this.key(project.path), report);
        if (isTrusted && requestId) this.requests.delete(this.key(project.path));
        return report;
    }

    isCancelled(requestId: string): boolean {
        return this.cancelledRequests.has(requestId);
    }

    private findRegisteredProject(workspacePath: string): UserProject | undefined {
        const candidate = path.resolve(workspacePath);
        return this.projectWorkspace.listProjects().find(project =>
            path.resolve(project.path).toLocaleLowerCase() === candidate.toLocaleLowerCase()
        );
    }

    private isRegisteredCliroProject(project: UserProject): boolean {
        return isCliroProjectPath(project.path, this.projectWorkspace.projectsRoot);
    }

    private assertRegisteredCliroProject(project: UserProject): void {
        if (!this.isRegisteredCliroProject(project)) {
            throw new Error('Workspace trust can be requested only for a registered CLIRO project under D:\\CLIROProjects.');
        }
        const canonicalPath = path.resolve(project.path);
        if (canonicalPath.toLocaleLowerCase() !== project.path.toLocaleLowerCase() ||
            !fs.existsSync(canonicalPath) || !fs.statSync(canonicalPath).isDirectory()) {
            throw new Error('The registered CLIRO project directory is not available for workspace trust.');
        }
    }

    private key(workspacePath: string): string {
        return path.resolve(workspacePath).toLocaleLowerCase();
    }
}
