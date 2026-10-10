import { randomUUID } from 'crypto';
import { ProjectTemplate } from './ProjectWorkspace';

export interface ProjectCreationApprovalRequest {
    approvalRequestId: string;
    prompt: string;
    name: string;
    template: ProjectTemplate;
    openInVSCode: boolean;
    expiresAt: string;
}

export type ProjectCreationDecision =
    | { status: 'approved' }
    | { status: 'cancelled' }
    | { status: 'invalid' }
    | { status: 'expired' }
    | { status: 'mismatch' };

interface StoredApproval extends ProjectCreationApprovalRequest {
    expiresAtMs: number;
}

export class ProjectCreationApprovalStore {
    private readonly approvals = new Map<string, StoredApproval>();

    constructor(private readonly ttlMs = 5 * 60 * 1000) {}

    create(
        prompt: string,
        name: string,
        template: ProjectTemplate,
        openInVSCode = false,
        now = Date.now()
    ): ProjectCreationApprovalRequest {
        this.removeExpired(now);
        const approvalRequestId = randomUUID();
        const expiresAtMs = now + this.ttlMs;
        const approval: StoredApproval = {
            approvalRequestId,
            prompt: prompt.trim(),
            name,
            template,
            openInVSCode,
            expiresAt: new Date(expiresAtMs).toISOString(),
            expiresAtMs
        };
        this.approvals.set(approvalRequestId, approval);
        return {
            approvalRequestId,
            prompt: approval.prompt,
            name,
            template,
            openInVSCode,
            expiresAt: approval.expiresAt
        };
    }

    decide(
        approvalRequestId: unknown,
        prompt: string,
        name: string,
        template: ProjectTemplate,
        openInVSCode: boolean,
        approve: boolean,
        now = Date.now()
    ): ProjectCreationDecision {
        if (typeof approvalRequestId !== 'string') return { status: 'invalid' };
        const approval = this.approvals.get(approvalRequestId);
        if (!approval) return { status: 'invalid' };
        if (approval.expiresAtMs <= now) {
            this.approvals.delete(approvalRequestId);
            return { status: 'expired' };
        }
        if (approval.prompt !== prompt.trim() || approval.name !== name || approval.template !== template ||
            approval.openInVSCode !== openInVSCode) {
            return { status: 'mismatch' };
        }
        this.approvals.delete(approvalRequestId);
        return { status: approve ? 'approved' : 'cancelled' };
    }

    private removeExpired(now: number): void {
        for (const [id, approval] of this.approvals) {
            if (approval.expiresAtMs <= now) this.approvals.delete(id);
        }
    }
}
