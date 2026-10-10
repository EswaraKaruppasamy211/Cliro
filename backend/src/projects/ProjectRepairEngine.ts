import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ErrorDiagnosis, ErrorDiagnosisEngine } from './ErrorDiagnosisEngine';

export const MAX_REPAIR_ATTEMPTS = 3;

export interface RepairProposal {
    repairId: string;
    projectPath: string;
    filePath: string;
    content: string;
    diagnosis: ErrorDiagnosis;
}

export class ProjectRepairEngine {
    private readonly diagnoses = new ErrorDiagnosisEngine();

    diagnose(result: Parameters<ErrorDiagnosisEngine['diagnose']>[0], projectPath: string): ErrorDiagnosis {
        return this.diagnoses.diagnose(result, projectPath);
    }

    proposeMissingTemplateFile(
        diagnosis: ErrorDiagnosis,
        projectPath: string,
        templateFiles: Record<string, string>
    ): RepairProposal | null {
        if (diagnosis.category !== 'MISSING_FILE' && diagnosis.category !== 'MODULE_NOT_FOUND') return null;
        const missing = diagnosis.affectedFiles.find(file => Object.hasOwn(templateFiles, file.replace(/\\/g, '/')));
        if (!missing) return null;
        const relativePath = missing.replace(/\\/g, '/');
        const filePath = path.resolve(projectPath, relativePath);
        const relative = path.relative(projectPath, filePath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
        return {
            repairId: randomUUID(),
            projectPath,
            filePath,
            content: templateFiles[relativePath],
            diagnosis
        };
    }

    async applyApprovedRepair(proposal: RepairProposal, projectPath: string, approved: boolean): Promise<boolean> {
        if (!approved) return false;
        const root = await fs.promises.realpath(projectPath);
        const target = path.resolve(proposal.filePath);
        const relative = path.relative(root, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('The proposed repair path is outside the verified project directory.');
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, proposal.content, { encoding: 'utf8', flag: 'wx' });
        const written = await fs.promises.readFile(target, 'utf8');
        if (written !== proposal.content) throw new Error('The approved repair did not verify after writing.');
        return true;
    }
}
