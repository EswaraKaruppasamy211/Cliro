const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProjectWorkspace } = require('../dist/projects/ProjectWorkspace');
const {
    WorkspaceTrustBridge,
    classifyWorkspaceTrust,
    isCliroProjectPath
} = require('../dist/projects/WorkspaceTrustBridge');

const projectPath = 'D:\\CLIROProjects\\TrustCheck';
const now = Date.now();

test('trust is classified only for the exact verified workspace', () => {
    const report = {
        workspacePath: projectPath,
        isTrusted: true,
        observedAt: new Date(now).toISOString()
    };
    assert.equal(classifyWorkspaceTrust(projectPath, report, 'D:\\CLIROProjects', now), 'TRUSTED');
    assert.equal(classifyWorkspaceTrust(
        projectPath,
        { ...report, workspacePath: 'D:\\CLIROProjects\\OtherProject' },
        'D:\\CLIROProjects',
        now
    ), 'WRONG_WORKSPACE');
});

test('restricted and trusted states follow VS Code extension API reports', () => {
    const report = { workspacePath: projectPath, isTrusted: false, observedAt: new Date(now).toISOString() };
    assert.equal(classifyWorkspaceTrust(projectPath, report, 'D:\\CLIROProjects', now), 'RESTRICTED');
    assert.equal(classifyWorkspaceTrust(projectPath, { ...report, isTrusted: true }, 'D:\\CLIROProjects', now), 'TRUSTED');
});

test('trust handling rejects paths outside the CLIRO project root', () => {
    assert.equal(isCliroProjectPath('C:\\Users\\someone\\CLIROProjects\\Other'), false);
    assert.equal(isCliroProjectPath('D:\\CLIROProjects'), false);
    assert.equal(isCliroProjectPath(projectPath), true);
    assert.equal(classifyWorkspaceTrust(
        'C:\\Users\\someone\\CLIROProjects\\Other',
        { workspacePath: 'C:\\Users\\someone\\CLIROProjects\\Other', isTrusted: false, observedAt: new Date(now).toISOString() },
        'D:\\CLIROProjects',
        now
    ), 'OUTSIDE_CLIRO_ROOT');
});

test('user cancellation consumes the matching request without trusting the project', async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cliro-workspace-trust-'));
    const root = path.join(temporaryRoot, 'CLIROProjects');
    const workspace = new ProjectWorkspace(path.join(temporaryRoot, 'registry.json'), root);
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const registered = await workspace.createProject('TrustCheck', workspace.projectPathForName('TrustCheck'), 'basic');
    const bridge = new WorkspaceTrustBridge(workspace);

    const request = bridge.createTrustRequest(registered.project);
    assert.ok(request.requestId);
    assert.equal(bridge.cancelTrustRequest(registered.project, request.requestId), true);
    assert.equal(bridge.isCancelled(request.requestId), true);
    assert.equal(bridge.getStatus(registered.project), 'CANCELLED');
    assert.equal(bridge.poll(registered.project.path).request, null);
    assert.throws(() => bridge.report(registered.project.path, true, request.requestId), /active user-approved request/);
});

test('trust reports must match a registered CLIRO project and its exact workspace path', async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cliro-workspace-report-'));
    const root = path.join(temporaryRoot, 'CLIROProjects');
    const workspace = new ProjectWorkspace(path.join(temporaryRoot, 'registry.json'), root);
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const registered = await workspace.createProject('TrustReport', workspace.projectPathForName('TrustReport'), 'basic');
    const bridge = new WorkspaceTrustBridge(workspace);
    const request = bridge.createTrustRequest(registered.project);

    assert.throws(() => bridge.report(path.join(root, 'Other'), false), /registered CLIRO projects/);
    assert.throws(() => bridge.report(registered.project.path, true, 'wrong-request-id'), /active user-approved request/);
    bridge.report(registered.project.path, false, request.requestId);
    assert.equal(bridge.getStatus(registered.project), 'RESTRICTED');
    bridge.report(registered.project.path, true, request.requestId);
    assert.equal(bridge.getStatus(registered.project), 'TRUSTED');
});
