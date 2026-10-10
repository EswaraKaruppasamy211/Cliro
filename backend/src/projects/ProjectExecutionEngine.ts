import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { randomUUID } from 'crypto';
import { PermissionEngine, PermissionLevel } from '../permissions/PermissionEngine';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ProjectWorkspace, UserProject } from './ProjectWorkspace';
import { CommandResult, ErrorDiagnosis } from './ErrorDiagnosisEngine';
import { ProjectRepairEngine, RepairProposal, MAX_REPAIR_ATTEMPTS } from './ProjectRepairEngine';
import { WorkspaceTrustBridge } from './WorkspaceTrustBridge';

export type BuildStatus = 'NOT_RUN' | 'BUILDING' | 'PASSED' | 'FAILED';
export type TestStatus = 'NOT_RUN' | 'TESTING' | 'PASSED' | 'FAILED' | 'NOT_CONFIGURED';
export type RunStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'FAILED';
export type ExecutionStage =
    | 'DEPENDENCIES_APPROVAL_REQUIRED'
    | 'REPAIR_APPROVAL_REQUIRED'
    | 'INSTALLING_DEPENDENCIES'
    | 'DEPENDENCIES_VERIFIED'
    | 'BUILDING'
    | 'BUILD_VERIFIED'
    | 'BUILD_FAILED'
    | 'TESTING'
    | 'TEST_VERIFIED'
    | 'STARTING'
    | 'RUNNING'
    | 'RUN_VERIFIED'
    | 'DIAGNOSING'
    | 'FIXING'
    | 'REBUILDING'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'FAILED'
    | 'VS_CODE_OPENING'
    | 'VS_CODE_VERIFICATION';
export type ExecutionActivityStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REQUIRES_APPROVAL';

export interface ExecutionEvent {
    requestId: string;
    projectId: string;
    actionId: string;
    stage: ExecutionStage;
    status: ExecutionActivityStatus;
    timestamp: string;
    verification: boolean | null;
    message: string;
}

export interface ProjectExecutionOptions {
    build: boolean;
    test: boolean;
    run: boolean;
    openInVSCode: boolean;
}

export interface ExecutionApproval {
    type: 'DEPENDENCY_INSTALL' | 'REPAIR_FIX';
    projectId: string;
    projectPath: string;
    dependencies: string[];
    command: string;
    approvalRequestId: string;
    executionId: string;
    expiresAt: string;
    repairProposal?: { filePath: string; summary: string };
}

export interface ExecutionCommandRecord extends CommandResult {}

export interface ProjectExecutionSnapshot {
    executionId: string;
    requestId: string;
    projectId: string;
    status: 'AWAITING_APPROVAL' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    approvalRequired?: ExecutionApproval;
    installResult?: { status: 'PASSED' | 'FAILED'; verified: boolean; command: ExecutionCommandRecord };
    buildResult?: { status: BuildStatus; verified: boolean; command?: ExecutionCommandRecord };
    testResult?: { status: TestStatus; verified: boolean; command?: ExecutionCommandRecord };
    runResult?: { status: RunStatus; verified: boolean; pid?: number; port?: number; url?: string; error?: string };
    vsCodeResult?: Record<string, unknown>;
    diagnosis?: ErrorDiagnosis;
    repairAttempts: number;
    events: ExecutionEvent[];
}

interface StoredExecution extends ProjectExecutionSnapshot {
    projectPath: string;
    options: ProjectExecutionOptions;
    controller: AbortController;
    child?: ChildProcess;
    repairProposal?: RepairProposal;
    approvalToken?: string;
    runChild?: ChildProcess;
    runPort?: number;
}

interface ApprovalToken {
    executionId: string;
    type: ExecutionApproval['type'];
    expiresAt: number;
    consumed: boolean;
}

const MAX_CAPTURE = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const safeBuildScripts = new Set(['tsc -b && vite build', 'vite build', 'tsc']);
const safeTestScripts = new Set(['node --test', 'vitest run', 'jest --runInBand']);
const safeRunScripts = new Set(['vite']);

function isTerminalExecution(status: ProjectExecutionSnapshot['status']): boolean {
    return status === 'FAILED' || status === 'CANCELLED';
}

function appendBounded(previous: string, next: string): string {
    const value = previous + next;
    return value.length <= MAX_CAPTURE ? value : value.slice(value.length - MAX_CAPTURE);
}

function capture(command: string, exitCode: number | null, stdout: string, stderr: string, start: number): CommandResult {
    return {
        command,
        exitCode,
        stdout,
        stderr,
        duration: Date.now() - start,
        timestamp: new Date().toISOString()
    };
}

function isPackageManifest(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function choosePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Could not reserve a local verification port.'));
                return;
            }
            const port = address.port;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function httpReady(url: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 30_000;
        const check = () => {
            if (signal.aborted) {
                reject(new Error('Run verification was cancelled.'));
                return;
            }
            const request = http.get(url, response => {
                response.resume();
                if (response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300) {
                    resolve();
                    return;
                }
                retry();
            });
            request.setTimeout(2_000, () => request.destroy());
            request.once('error', retry);
        };
        const retry = () => {
            if (Date.now() >= deadline) {
                reject(new Error(`The application did not return a successful localhost response at ${url}.`));
                return;
            }
            setTimeout(check, 300);
        };
        signal.addEventListener('abort', () => reject(new Error('Run verification was cancelled.')), { once: true });
        check();
    });
}

export class ProjectExecutionEngine {
    private readonly executions = new Map<string, StoredExecution>();
    private readonly approvals = new Map<string, ApprovalToken>();
    private readonly repairEngine = new ProjectRepairEngine();

    constructor(
        private readonly workspace: ProjectWorkspace,
        private readonly permissionEngine: PermissionEngine,
        private readonly toolRegistry: ToolRegistry,
        private readonly workspaceTrustBridge?: WorkspaceTrustBridge
    ) {}

    async start(
        projectId: string,
        options: ProjectExecutionOptions,
        requestId = randomUUID(),
        listener?: (event: ExecutionEvent) => void
    ): Promise<ProjectExecutionSnapshot> {
        const project = this.workspace.getProject(projectId);
        const canonicalPath = await fs.promises.realpath(project.path);
        if (canonicalPath.toLocaleLowerCase() !== path.resolve(project.path).toLocaleLowerCase()) {
            throw new Error('The registered project path resolves through a link; execution was refused.');
        }
        const executionId = randomUUID();
        const execution: StoredExecution = {
            executionId,
            requestId,
            projectId,
            projectPath: canonicalPath,
            options,
            status: 'RUNNING',
            repairAttempts: 0,
            events: [],
            controller: new AbortController()
        };
        this.executions.set(executionId, execution);
        if (!this.permissionEngine.checkPermission({
            name: 'executeRegisteredProject',
            level: PermissionLevel.APPROVAL_REQUIRED,
            description: 'Run the project operations explicitly requested and approved by the user',
            approvalGranted: true
        })) {
            execution.status = 'FAILED';
            await this.persist(execution, { executionStatus: 'FAILED', executionId });
            throw new Error('PermissionEngine denied project execution.');
        }
        await this.persist(execution, { executionStatus: 'RUNNING', executionId, repairAttempts: 0 });

        const manifest = await this.readPackageManifest(canonicalPath);
        const dependencies = this.dependencyNames(manifest);
        if (dependencies.length > 0) {
            if (!(await this.verifyDependencies(canonicalPath, dependencies))) {
                await this.requireApproval(execution, {
                    type: 'DEPENDENCY_INSTALL',
                    projectId,
                    projectPath: canonicalPath,
                    dependencies,
                    command: 'npm install --no-audit --no-fund --ignore-scripts',
                    executionId,
                    expiresAt: ''
                }, listener);
                return this.snapshot(execution);
            }
            this.emit(execution, 'DEPENDENCIES_VERIFIED', 'COMPLETED', true, 'Declared npm packages and node_modules were already verified on disk.', listener);
        }
        await this.runStages(execution, listener);
        return this.snapshot(execution);
    }

    subscribe(executionId: string, listener: (event: ExecutionEvent) => void): () => void {
        const execution = this.getExecution(executionId);
        const listeners = this.listeners.get(executionId) ?? new Set<(event: ExecutionEvent) => void>();
        listeners.add(listener);
        this.listeners.set(executionId, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.listeners.delete(executionId);
        };
    }

    private readonly listeners = new Map<string, Set<(event: ExecutionEvent) => void>>();

    async decideApproval(
        executionId: string,
        approvalRequestId: unknown,
        approve: boolean,
        listener?: (event: ExecutionEvent) => void
    ): Promise<ProjectExecutionSnapshot> {
        const execution = this.getExecution(executionId);
        const token = typeof approvalRequestId === 'string' ? this.approvals.get(approvalRequestId) : undefined;
        if (token && token.expiresAt <= Date.now()) {
            this.approvals.delete(approvalRequestId as string);
        }
        if (!token || token.executionId !== executionId || token.consumed || token.expiresAt <= Date.now()) {
            throw new Error('The execution approval is invalid, expired, or already used.');
        }
        token.consumed = true;
        this.approvals.delete(approvalRequestId as string);
        execution.approvalToken = undefined;
        execution.approvalRequired = undefined;
        if (!approve) {
            execution.status = 'CANCELLED';
            execution.controller.abort();
            await this.persist(execution, { executionStatus: 'CANCELLED', runStatus: 'STOPPED', lastError: 'Execution approval was cancelled.' });
            this.emit(execution, 'CANCELLED', 'FAILED', false, 'Project execution cancelled by the user.', listener);
            return this.snapshot(execution);
        }
        if (!this.permissionEngine.checkPermission({
            name: token.type === 'DEPENDENCY_INSTALL' ? 'installProjectDependencies' : 'applyProjectRepair',
            level: PermissionLevel.APPROVAL_REQUIRED,
            description: `Explicit approval for ${token.type.toLowerCase()}`,
            approvalGranted: true
        })) throw new Error('PermissionEngine denied the approved execution action.');
        execution.status = 'RUNNING';
        await this.persist(execution, { executionStatus: 'RUNNING' });

        if (token.type === 'DEPENDENCY_INSTALL') {
            await this.installDependencies(execution, listener);
            if (isTerminalExecution(execution.status)) return this.snapshot(execution);
            await this.runStages(execution, listener);
            return this.snapshot(execution);
        }
        const proposal = execution.repairProposal;
        if (!proposal) throw new Error('The repair approval no longer has a matching proposal.');
        this.emit(execution, 'FIXING', 'RUNNING', null, `Applying approved repair to ${path.relative(execution.projectPath, proposal.filePath)}.`, listener);
        const applied = await this.repairEngine.applyApprovedRepair(proposal, execution.projectPath, true);
        if (!applied) {
            execution.status = 'FAILED';
            await this.persist(execution, { executionStatus: 'FAILED', lastError: 'The approved repair did not verify.' });
            return this.snapshot(execution);
        }
        execution.repairProposal = undefined;
        this.emit(execution, 'REBUILDING', 'RUNNING', null, 'Rebuilding after the approved repair.', listener);
        await this.buildWithRepairs(execution, listener);
        if (execution.buildResult?.status === 'PASSED') {
            await this.runTestAndApplication(execution, listener);
                if (!isTerminalExecution(execution.status)) {
                await this.completeExecution(execution, listener);
            }
        }
        return this.snapshot(execution);
    }

    async cancel(executionId: string, reason = 'Execution cancelled by the user.'): Promise<ProjectExecutionSnapshot> {
        const execution = this.getExecution(executionId);
        const buildWasRunning = execution.buildResult?.status === 'BUILDING';
        const testWasRunning = execution.testResult?.status === 'TESTING';
        execution.status = 'CANCELLED';
        execution.controller.abort();
        if (buildWasRunning) execution.buildResult = { status: 'FAILED', verified: false };
        if (testWasRunning) execution.testResult = { status: 'FAILED', verified: false };
        if (execution.child) await this.terminateOwnedProcess(execution.child);
        if (execution.runChild) await this.terminateOwnedProcess(execution.runChild);
        execution.approvalRequired = undefined;
        if (execution.approvalToken) this.approvals.delete(execution.approvalToken);
        await this.persist(execution, {
            executionStatus: 'CANCELLED',
            executionId: execution.executionId,
            buildStatus: buildWasRunning ? 'FAILED' : undefined,
            testStatus: testWasRunning ? 'FAILED' : undefined,
            runStatus: 'STOPPED',
            runPid: undefined,
            runPort: undefined,
            lastError: reason
        });
        this.emit(execution, 'CANCELLED', 'FAILED', false, reason);
        return this.snapshot(execution);
    }

    get(executionId: string): ProjectExecutionSnapshot {
        return this.snapshot(this.getExecution(executionId));
    }

    private async installDependencies(execution: StoredExecution, listener?: (event: ExecutionEvent) => void): Promise<void> {
        const permissionGranted = this.permissionEngine.checkPermission({
            name: 'installProjectDependencies',
            level: PermissionLevel.APPROVAL_REQUIRED,
            description: 'Install the dependencies listed in the verified project package manifest',
            approvalGranted: true
        });
        if (!permissionGranted) throw new Error('PermissionEngine denied dependency installation.');
        this.emit(execution, 'INSTALLING_DEPENDENCIES', 'RUNNING', null, 'Running the approved npm install in the verified project directory.', listener);
        const result = await this.runNpm(execution, ['install', '--no-audit', '--no-fund', '--ignore-scripts'], 'npm install --no-audit --no-fund --ignore-scripts');
        execution.installResult = { status: result.exitCode === 0 ? 'PASSED' : 'FAILED', verified: false, command: result };
        if (result.exitCode !== 0) {
            execution.status = 'FAILED';
            await this.persist(execution, { lastError: result.stderr || result.stdout || 'npm install failed.' });
            this.emit(execution, 'FAILED', 'FAILED', false, result.stderr || 'Dependency installation failed.', listener);
            return;
        }
        const manifest = await this.readPackageManifest(execution.projectPath);
        const dependencies = this.dependencyNames(manifest);
        if (!(await this.verifyDependencies(execution.projectPath, dependencies))) {
            execution.status = 'FAILED';
            const message = 'npm install exited successfully, but the declared dependencies could not be verified on disk.';
            await this.persist(execution, { lastError: message });
            this.emit(execution, 'FAILED', 'FAILED', false, message, listener);
            return;
        }
        execution.installResult.verified = true;
        this.emit(execution, 'DEPENDENCIES_VERIFIED', 'COMPLETED', true, 'Declared npm packages and node_modules were verified on disk.', listener);
    }

    private async runStages(execution: StoredExecution, listener?: (event: ExecutionEvent) => void): Promise<void> {
        try {
            if (execution.options.build) {
                await this.buildWithRepairs(execution, listener);
                if (execution.buildResult?.status !== 'PASSED') return;
            }
            await this.runTestAndApplication(execution, listener);
            if (execution.status === 'FAILED' || execution.status === 'CANCELLED') return;
            await this.completeExecution(execution, listener);
        } catch (error) {
            if (execution.controller.signal.aborted) return;
            const message = error instanceof Error ? error.message : String(error);
            execution.status = 'FAILED';
            await this.persist(execution, { lastError: message });
            this.emit(execution, 'BUILD_FAILED', 'FAILED', false, message, listener);
        }
    }

    private async completeExecution(execution: StoredExecution, listener?: (event: ExecutionEvent) => void): Promise<void> {
        if (execution.options.openInVSCode) {
            this.emit(execution, 'VS_CODE_OPENING', 'RUNNING', null, 'Opening the verified project folder in Visual Studio Code.', listener);
            this.emit(execution, 'VS_CODE_VERIFICATION', 'RUNNING', null, 'Verifying the application and exact workspace path.', listener);
            const result = await this.toolRegistry.openVerifiedProjectInVSCode(execution.projectPath, {
                permissionEngine: this.permissionEngine,
                workspaceTrustBridge: this.workspaceTrustBridge,
                source: 'chat',
                onProgress: message => this.emit(
                    execution,
                    /verif|wait/i.test(message) ? 'VS_CODE_VERIFICATION' : 'VS_CODE_OPENING',
                    'RUNNING',
                    null,
                    message,
                    listener
                )
            });
            execution.vsCodeResult = {
                ...result,
                projectId: execution.projectId,
                workspacePath: execution.projectPath
            };
            if (!result.verified) await this.persist(execution, { lastError: result.message });
            this.emit(execution, 'VS_CODE_OPENING', result.verified ? 'COMPLETED' : 'FAILED', result.verified, result.message, listener);
            this.emit(execution, 'VS_CODE_VERIFICATION', result.verified ? 'COMPLETED' : 'FAILED', result.verified, result.message, listener);
        }
        execution.status = 'COMPLETED';
        await this.persist(execution, { lastVerifiedAt: new Date().toISOString() });
        const verified = !execution.options.openInVSCode || execution.vsCodeResult?.verified === true;
        this.emit(
            execution,
            'COMPLETED',
            verified ? 'COMPLETED' : 'FAILED',
            verified,
            verified
                ? 'Requested project execution stages completed with their recorded verification results.'
                : 'Project execution completed, but the separate VS Code workspace result was not verified.',
            listener
        );
    }

    private async buildWithRepairs(execution: StoredExecution, listener?: (event: ExecutionEvent) => void): Promise<void> {
        while (true) {
            if (execution.controller.signal.aborted) return;
            execution.buildResult = { status: 'BUILDING', verified: false };
            await this.persist(execution, { buildStatus: 'BUILDING', lastError: undefined });
            this.emit(execution, execution.repairAttempts > 0 ? 'REBUILDING' : 'BUILDING', 'RUNNING', null, 'Executing the verified project build script.', listener);
            const result = await this.runBuild(execution);
            if (result.exitCode === 0 && await this.verifyBuildOutput(execution.projectPath)) {
                execution.buildResult = { status: 'PASSED', verified: true, command: result };
                await this.persist(execution, {
                    buildStatus: 'PASSED',
                    buildExitCode: 0,
                    buildTimestamp: result.timestamp,
                    lastVerifiedAt: result.timestamp,
                    lastError: undefined
                });
                this.emit(execution, 'BUILD_VERIFIED', 'COMPLETED', true, 'Build exited with code 0 and the expected output directory was verified.', listener);
                return;
            }
            execution.buildResult = { status: 'FAILED', verified: false, command: result };
            const errorMessage = result.stderr || result.stdout || 'Build failed or expected build output was absent.';
            execution.diagnosis = this.repairEngine.diagnose(result, execution.projectPath);
            await this.persist(execution, {
                buildStatus: 'FAILED',
                buildExitCode: result.exitCode,
                buildTimestamp: result.timestamp,
                lastError: errorMessage,
                repairAttempts: execution.repairAttempts
            });
            this.emit(execution, 'BUILD_FAILED', 'FAILED', false, errorMessage, listener);
            this.emit(execution, 'DIAGNOSING', 'RUNNING', null, execution.diagnosis.summary, listener);
            const proposal = this.repairEngine.proposeMissingTemplateFile(
                execution.diagnosis,
                execution.projectPath,
                await this.workspace.safeTemplateFiles(execution.projectId)
            );
            this.emit(execution, 'DIAGNOSING', 'COMPLETED', true, `${execution.diagnosis.category}: ${execution.diagnosis.suggestedFix}`, listener);
            if (!proposal || execution.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
                execution.status = 'FAILED';
                await this.persist(execution, { executionStatus: 'FAILED' });
                return;
            }
            execution.repairProposal = proposal;
            execution.repairAttempts += 1;
            await this.persist(execution, { repairAttempts: execution.repairAttempts });
            this.requireApproval(execution, {
                type: 'REPAIR_FIX',
                projectId: execution.projectId,
                projectPath: execution.projectPath,
                dependencies: [],
                command: `Create missing project file: ${path.relative(execution.projectPath, proposal.filePath)}`,
                executionId: execution.executionId,
                expiresAt: '',
                repairProposal: {
                    filePath: path.relative(execution.projectPath, proposal.filePath),
                    summary: execution.diagnosis.summary
                }
            }, listener);
            return;
        }
    }

    private async runTestAndApplication(execution: StoredExecution, listener?: (event: ExecutionEvent) => void): Promise<void> {
        if (execution.options.test) {
            const manifest = await this.readPackageManifest(execution.projectPath);
            const scripts = isPackageManifest(manifest?.scripts) ? manifest.scripts : {};
            const testScript = typeof scripts.test === 'string' ? scripts.test.trim() : '';
            if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') {
                execution.testResult = { status: 'NOT_CONFIGURED', verified: true };
                await this.persist(execution, { testStatus: 'NOT_CONFIGURED', testTimestamp: new Date().toISOString() });
                this.emit(execution, 'TEST_VERIFIED', 'COMPLETED', true, 'No valid project test script is configured; recorded as NOT_CONFIGURED.', listener);
            } else {
                if (!safeTestScripts.has(testScript)) {
                    execution.testResult = { status: 'FAILED', verified: false };
                    execution.status = 'FAILED';
                    const message = `The test script "${testScript}" is not in CLIRO's safe command allowlist.`;
                    await this.persist(execution, { testStatus: 'FAILED', testTimestamp: new Date().toISOString(), lastError: message });
                    this.emit(execution, 'TESTING', 'FAILED', false, message, listener);
                    return;
                }
                execution.testResult = { status: 'TESTING', verified: false };
                await this.persist(execution, { testStatus: 'TESTING' });
                this.emit(execution, 'TESTING', 'RUNNING', null, 'Running the allowlisted project test script.', listener);
                const result = await this.runNpm(execution, ['run', 'test', '--ignore-scripts'], 'npm run test');
                const passed = result.exitCode === 0;
                execution.testResult = { status: passed ? 'PASSED' : 'FAILED', verified: passed, command: result };
                await this.persist(execution, { testStatus: passed ? 'PASSED' : 'FAILED', testTimestamp: result.timestamp, lastError: passed ? undefined : result.stderr || result.stdout });
                this.emit(execution, 'TEST_VERIFIED', passed ? 'COMPLETED' : 'FAILED', passed, passed ? 'Project tests passed with exit code 0.' : result.stderr || 'Project tests failed.', listener);
                if (!passed) {
                    execution.status = 'FAILED';
                    return;
                }
            }
        }
        if (execution.options.run) await this.startAndVerifyRun(execution, listener);
    }

    private async startAndVerifyRun(execution: StoredExecution, listener?: (event: ExecutionEvent) => void): Promise<void> {
        const manifest = await this.readPackageManifest(execution.projectPath);
        if (manifest) {
            const scripts = isPackageManifest(manifest.scripts) ? manifest.scripts : {};
            const devScript = typeof scripts.dev === 'string' ? scripts.dev.trim() : '';
            if (devScript !== 'vite' || !safeRunScripts.has(devScript)) {
                const message = 'No allowlisted Vite run script is configured.';
                execution.runResult = { status: 'FAILED', verified: false, error: message };
                execution.status = 'FAILED';
                await this.persist(execution, { runStatus: 'FAILED', lastError: message });
                this.emit(execution, 'STARTING', 'FAILED', false, message, listener);
                return;
            }
        }
        if (!this.permissionEngine.checkPermission({
            name: 'runRegisteredProject',
            level: PermissionLevel.APPROVAL_REQUIRED,
            description: 'Run the explicitly requested project command',
            approvalGranted: true
        })) throw new Error('PermissionEngine denied project launch.');
        const port = await choosePort();
        execution.runPort = port;
        execution.runResult = { status: 'STARTING', verified: false, port };
        await this.persist(execution, { runStatus: 'STARTING', runPort: port });
        this.emit(execution, 'STARTING', 'RUNNING', null, 'Starting the allowlisted Vite development server on a local verification port.', listener);
        const result = await this.spawnCommand(execution, await this.npmInvocation(execution.projectPath, ['run', 'dev', '--ignore-scripts', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], 'npm run dev'), COMMAND_TIMEOUT_MS, true);
        if (execution.controller.signal.aborted || execution.status === 'CANCELLED') return;
        execution.runChild = result.child;
        let earlyExit: number | null | undefined;
        result.child.once('close', code => {
            earlyExit = code;
            if (execution.status === 'CANCELLED' || execution.runResult?.verified !== true) return;
            execution.runResult = {
                status: 'FAILED',
                verified: false,
                pid: result.child.pid,
                port,
                error: `The application process exited unexpectedly with code ${code ?? 'unknown'}.`
            };
            execution.status = 'FAILED';
            void this.persist(execution, { runStatus: 'FAILED', lastError: execution.runResult.error });
            this.emit(execution, 'RUNNING', 'FAILED', false, execution.runResult.error || 'The application process exited unexpectedly.');
        });
        try {
            await httpReady(`http://127.0.0.1:${port}/`, execution.controller.signal);
            if (!result.child.pid || result.child.exitCode !== null || result.child.killed || earlyExit !== undefined) {
                throw new Error('The development server exited before process and HTTP verification completed.');
            }
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            execution.runResult = { status: 'FAILED', verified: false, pid: result.child.pid, port, error: details };
            execution.status = 'FAILED';
            await this.persist(execution, { runStatus: 'FAILED', runPid: result.child.pid, runPort: port, lastError: details });
            this.emit(execution, 'RUNNING', 'FAILED', false, details, listener);
            return;
        }
        execution.runResult = { status: 'RUNNING', verified: true, pid: result.child.pid, port, url: `http://127.0.0.1:${port}/` };
        await this.persist(execution, { runStatus: 'RUNNING', runPid: result.child.pid, runPort: port, lastVerifiedAt: new Date().toISOString() });
        this.emit(execution, 'RUNNING', 'COMPLETED', true, `Application process ${result.child.pid} is alive and returned HTTP from ${execution.runResult.url}.`, listener);
        this.emit(execution, 'RUN_VERIFIED', 'COMPLETED', true, 'Process and localhost HTTP verification succeeded.', listener);
    }

    private async runBuild(execution: StoredExecution): Promise<CommandResult> {
        const manifest = await this.readPackageManifest(execution.projectPath);
        const scripts = isPackageManifest(manifest?.scripts) ? manifest.scripts : {};
        const script = typeof scripts.build === 'string' ? scripts.build.trim() : '';
        if (!safeBuildScripts.has(script)) {
            const result = capture('npm run build', 1, '', `The build script "${script || '(missing)'}" is not in CLIRO's safe command allowlist.`, Date.now());
            return result;
        }
        return this.runNpm(execution, ['run', 'build', '--ignore-scripts'], 'npm run build');
    }

    private async verifyBuildOutput(projectPath: string): Promise<boolean> {
        try {
            const dist = await fs.promises.stat(path.join(projectPath, 'dist'));
            if (!dist.isDirectory()) return false;
            const entries = await fs.promises.readdir(path.join(projectPath, 'dist'));
            return entries.length > 0;
        } catch {
            return false;
        }
    }

    private async runNpm(execution: StoredExecution, args: string[], command: string): Promise<CommandResult> {
        const start = Date.now();
        try {
            const invocation = await this.npmInvocation(execution.projectPath, args, command);
            return (await this.spawnCommand(execution, invocation, COMMAND_TIMEOUT_MS, false)).result;
        } catch (error) {
            if (execution.controller.signal.aborted) throw error;
            return capture(command, null, '', error instanceof Error ? error.message : String(error), start);
        }
    }

    private async npmInvocation(projectPath: string, args: string[], command: string): Promise<{ executable: string; args: string[]; command: string }> {
        const nodePath = process.execPath;
        const candidates = [
            path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
            path.join(path.dirname(nodePath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
        ];
        for (const candidate of candidates) {
            try {
                await fs.promises.access(candidate, fs.constants.R_OK);
                return { executable: nodePath, args: [candidate, ...args], command };
            } catch {}
        }
        throw new Error('The trusted npm CLI was not found beside the active Node.js runtime; CLIRO refused to run an unresolved npm command.');
    }

    private async spawnCommand(
        execution: StoredExecution,
        invocation: { executable: string; args: string[]; command: string },
        timeoutMs: number,
        keepAlive: boolean
    ): Promise<{ result: CommandResult; child: ChildProcess }> {
        if (execution.controller.signal.aborted) throw new Error('Project execution was cancelled.');
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        const child = spawn(invocation.executable, invocation.args, {
            cwd: execution.projectPath,
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CI: '1', npm_config_ignore_scripts: 'true' }
        });
        execution.child = child;
        if (keepAlive) {
            child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, String(chunk)); });
            child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, String(chunk)); });
            child.once('error', error => { stderr = appendBounded(stderr, error.message); });
            const timeout = setTimeout(() => { void this.terminateOwnedProcess(child); }, timeoutMs);
            child.once('close', () => clearTimeout(timeout));
            execution.controller.signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                void this.terminateOwnedProcess(child);
            }, { once: true });
            const result = capture(invocation.command, null, stdout, stderr, started);
            return { result, child };
        }
        const result = await new Promise<CommandResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                void this.terminateOwnedProcess(child);
                reject(new Error(`${invocation.command} exceeded its ${Math.round(timeoutMs / 60000)} minute timeout.`));
            }, timeoutMs);
            const abort = () => {
                clearTimeout(timeout);
                void this.terminateOwnedProcess(child);
                reject(new Error(`${invocation.command} was cancelled.`));
            };
            execution.controller.signal.addEventListener('abort', abort, { once: true });
            child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, String(chunk)); });
            child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, String(chunk)); });
            child.once('error', error => {
                clearTimeout(timeout);
                execution.controller.signal.removeEventListener('abort', abort);
                reject(new Error(`${invocation.command} could not start: ${error.message}`));
            });
            child.once('close', code => {
                clearTimeout(timeout);
                execution.controller.signal.removeEventListener('abort', abort);
                execution.child = undefined;
                resolve(capture(invocation.command, code, stdout, stderr, started));
            });
        });
        return { result, child };
    }

    private async terminateOwnedProcess(child: ChildProcess): Promise<void> {
        const pid = child.pid;
        if (!pid || child.exitCode !== null || child.killed) return;
        if (process.platform === 'win32') {
            await new Promise<void>(resolve => {
                const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
                    windowsHide: true,
                    shell: false,
                    stdio: 'ignore'
                });
                killer.once('error', () => resolve());
                killer.once('close', () => resolve());
            });
        } else {
            try { process.kill(-pid, 'SIGTERM'); } catch {
                try { process.kill(pid, 'SIGTERM'); } catch {}
            }
        }
    }

    private async readPackageManifest(projectPath: string): Promise<Record<string, unknown> | null> {
        try {
            const parsed: unknown = JSON.parse(await fs.promises.readFile(path.join(projectPath, 'package.json'), 'utf8'));
            return isPackageManifest(parsed) ? parsed : null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error(`The project package.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private dependencyNames(manifest: Record<string, unknown> | null): string[] {
        if (!manifest) return [];
        const dependencies = new Set<string>();
        for (const field of ['dependencies', 'devDependencies']) {
            const values = manifest[field];
            if (!isPackageManifest(values)) continue;
            for (const name of Object.keys(values)) {
                if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) dependencies.add(name);
            }
        }
        return [...dependencies].sort();
    }

    private async verifyDependencies(projectPath: string, dependencies: string[]): Promise<boolean> {
        try {
            const modules = await fs.promises.stat(path.join(projectPath, 'node_modules'));
            if (!modules.isDirectory()) return false;
            for (const dependency of dependencies) {
                const resolved = path.join(projectPath, 'node_modules', ...dependency.split('/'));
                const details = await fs.promises.stat(resolved);
                if (!details.isDirectory()) return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    private async requireApproval(
        execution: StoredExecution,
        request: Omit<ExecutionApproval, 'approvalRequestId' | 'expiresAt'> & { expiresAt: string },
        listener?: (event: ExecutionEvent) => void
    ): Promise<void> {
        const approvalRequestId = randomUUID();
        const expiresAt = Date.now() + APPROVAL_TTL_MS;
        this.approvals.set(approvalRequestId, {
            executionId: execution.executionId,
            type: request.type,
            expiresAt,
            consumed: false
        });
        execution.approvalToken = approvalRequestId;
        execution.approvalRequired = { ...request, approvalRequestId, expiresAt: new Date(expiresAt).toISOString() };
        execution.status = 'AWAITING_APPROVAL';
        await this.persist(execution, { executionStatus: 'AWAITING_APPROVAL', executionId: execution.executionId });
        this.emit(
            execution,
            request.type === 'DEPENDENCY_INSTALL' ? 'DEPENDENCIES_APPROVAL_REQUIRED' : 'REPAIR_APPROVAL_REQUIRED',
            'REQUIRES_APPROVAL',
            false,
            request.type === 'DEPENDENCY_INSTALL'
                ? 'Dependencies are declared but not installed. Waiting for explicit approval before running npm install.'
                : 'A deterministic repair was proposed. Waiting for explicit approval before changing any file.',
            listener);
    }

    private emit(
        execution: StoredExecution,
        stage: ExecutionStage,
        status: ExecutionActivityStatus,
        verification: boolean | null,
        message: string,
        listener?: (event: ExecutionEvent) => void
    ): void {
        const event: ExecutionEvent = {
            requestId: execution.requestId,
            projectId: execution.projectId,
            actionId: execution.approvalRequired?.approvalRequestId || execution.executionId,
            stage,
            status,
            timestamp: new Date().toISOString(),
            verification,
            message
        };
        execution.events.push(event);
        listener?.(event);
        for (const subscribed of this.listeners.get(execution.executionId) ?? []) subscribed(event);
    }

    private async persist(
        execution: StoredExecution,
        patch: Partial<Pick<UserProject,
            'buildStatus' | 'buildExitCode' | 'buildTimestamp' | 'testStatus' | 'testTimestamp' |
            'runStatus' | 'runPid' | 'runPort' | 'lastError' | 'repairAttempts' | 'lastVerifiedAt' |
            'executionId' | 'executionStatus'>>
    ): Promise<void> {
        await this.workspace.updateExecutionState(execution.projectId, {
            ...patch,
            executionId: execution.executionId,
            executionStatus: execution.status
        });
    }

    private getExecution(executionId: string): StoredExecution {
        const execution = this.executions.get(executionId);
        if (!execution) throw new Error('The requested project execution does not exist or has expired.');
        return execution;
    }

    private snapshot(execution: StoredExecution): ProjectExecutionSnapshot {
        return {
            executionId: execution.executionId,
            requestId: execution.requestId,
            projectId: execution.projectId,
            status: execution.status,
            ...(execution.approvalRequired ? { approvalRequired: execution.approvalRequired } : {}),
            ...(execution.installResult ? { installResult: execution.installResult } : {}),
            ...(execution.buildResult ? { buildResult: { ...execution.buildResult } } : {}),
            ...(execution.testResult ? { testResult: { ...execution.testResult } } : {}),
            ...(execution.runResult ? { runResult: { ...execution.runResult } } : {}),
            ...(execution.vsCodeResult ? { vsCodeResult: { ...execution.vsCodeResult } } : {}),
            ...(execution.diagnosis ? { diagnosis: execution.diagnosis } : {}),
            repairAttempts: execution.repairAttempts,
            events: [...execution.events]
        };
    }
}
