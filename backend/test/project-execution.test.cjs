const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ErrorDiagnosisEngine } = require('../dist/projects/ErrorDiagnosisEngine');
const { ProjectExecutionEngine } = require('../dist/projects/ProjectExecutionEngine');
const { ProjectRepairEngine } = require('../dist/projects/ProjectRepairEngine');
const { ProjectWorkspace } = require('../dist/projects/ProjectWorkspace');
const { PermissionEngine } = require('../dist/permissions/PermissionEngine');
const { ToolRegistry } = require('../dist/tools/ToolRegistry');

test('diagnoses real command output into structured categories', () => {
    const engine = new ErrorDiagnosisEngine();
    const typescript = engine.diagnose({
        command: 'npm run build',
        exitCode: 2,
        stdout: '',
        stderr: 'src/App.tsx(2,1): error TS2307: Cannot find module ./Missing',
        duration: 7,
        timestamp: '2026-10-06T00:00:00.000Z'
    }, 'D:\\CLIROProjects\\Demo');
    assert.equal(typescript.category, 'MODULE_NOT_FOUND');
    assert.ok(typescript.affectedFiles.includes('src/App.tsx'));
    assert.ok(typescript.confidence > 0.9);
    const typeError = engine.diagnose({
        command: 'npm run build',
        exitCode: 2,
        stdout: '',
        stderr: 'src/App.tsx(2,1): error TS2322: Type string is not assignable to number.',
        duration: 7,
        timestamp: '2026-10-06T00:00:00.000Z'
    }, 'D:\\CLIROProjects\\Demo');
    assert.equal(typeError.category, 'TYPESCRIPT_ERROR');

    const conflict = engine.diagnose({
        command: 'npm run dev',
        exitCode: 1,
        stdout: '',
        stderr: 'Error: listen EADDRINUSE: address already in use',
        duration: 2,
        timestamp: '2026-10-06T00:00:00.000Z'
    }, 'D:\\CLIROProjects\\Demo');
    assert.equal(conflict.category, 'PORT_CONFLICT');
});

test('repair proposals are path-bounded, approval-gated, and non-overwriting', async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cliro-repair-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const diagnosis = {
        category: 'MISSING_FILE',
        summary: 'A required file is missing.',
        affectedFiles: ['src/App.tsx'],
        suggestedFix: 'Restore the missing template file.',
        confidence: 0.9
    };
    const repair = new ProjectRepairEngine();
    const proposal = repair.proposeMissingTemplateFile(diagnosis, temporaryRoot, { 'src/App.tsx': 'export default 1;\n' });
    assert.ok(proposal);
    assert.equal(await repair.applyApprovedRepair(proposal, temporaryRoot, false), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, 'src', 'App.tsx')), false);
    assert.equal(await repair.applyApprovedRepair(proposal, temporaryRoot, true), true);
    assert.equal(fs.readFileSync(path.join(temporaryRoot, 'src', 'App.tsx'), 'utf8'), 'export default 1;\n');
    await assert.rejects(repair.applyApprovedRepair(proposal, temporaryRoot, true), /already exists/);
});

test('real execution engine pauses React dependency installation until its one-use approval', async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cliro-execution-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const workspace = new ProjectWorkspace(path.join(temporaryRoot, 'registry.json'), path.join(temporaryRoot, 'projects'));
    const projectPath = workspace.projectPathForName('ApprovalGateReact');
    const created = await workspace.createProject('ApprovalGateReact', projectPath, 'react');
    const engine = new ProjectExecutionEngine(workspace, new PermissionEngine(), new ToolRegistry());
    const initial = await engine.start(created.project.id, {
        build: true,
        test: true,
        run: true,
        openInVSCode: false
    }, 'request-execution-test');

    assert.equal(initial.status, 'AWAITING_APPROVAL');
    assert.equal(initial.approvalRequired.type, 'DEPENDENCY_INSTALL');
    assert.equal(initial.approvalRequired.projectId, created.project.id);
    assert.equal(initial.approvalRequired.projectPath, projectPath);
    assert.match(initial.approvalRequired.command, /^npm install /);
    assert.ok(initial.approvalRequired.dependencies.includes('react'));
    assert.equal(fs.existsSync(path.join(projectPath, 'node_modules')), false);
    assert.equal(initial.events.at(-1).stage, 'DEPENDENCIES_APPROVAL_REQUIRED');
    assert.equal(initial.events.at(-1).verification, false);

    await assert.rejects(
        engine.decideApproval(initial.executionId, 'not-the-issued-id', true),
        /invalid, expired, or already used/
    );
    const cancelled = await engine.decideApproval(
        initial.executionId,
        initial.approvalRequired.approvalRequestId,
        false
    );
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.events.at(-1).stage, 'CANCELLED');
    assert.equal(cancelled.events.at(-1).verification, false);
    assert.equal(fs.existsSync(path.join(projectPath, 'node_modules')), false);
    const persisted = workspace.getProject(created.project.id);
    assert.equal(persisted.executionId, initial.executionId);
    assert.equal(persisted.executionStatus, 'CANCELLED');
    assert.equal(persisted.runStatus, 'STOPPED');
});
