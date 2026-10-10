const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { ProjectModificationEngine, ProjectModificationError } = require('../dist/projects/ProjectModificationEngine');
const { ProjectPatchValidationError, validateRelativeProjectFilePath } = require('../dist/projects/ProjectPatchValidator');
const { ProjectWorkspace } = require('../dist/projects/ProjectWorkspace');
const { parseProjectModificationChanges } = require('../dist/projects/ProjectModificationLanguageModel');

async function fixture(t) {
    const base = path.join(__dirname, '.project-modification-fixtures', randomUUID());
    const trustedRoot = path.join(base, 'CLIROProjects');
    const registry = path.join(base, 'registry.json');
    const projectPath = path.join(trustedRoot, 'FixtureProject');
    await fs.promises.mkdir(projectPath, { recursive: true });
    const workspace = new ProjectWorkspace(registry, trustedRoot);
    const snapshot = await workspace.openProject(projectPath);
    t.after(async () => {
        await fs.promises.rm(base, { recursive: true, force: true });
    });
    return { base, trustedRoot, projectPath, workspace, projectId: snapshot.project.id };
}

function generator(changes) {
    return { async generate() { return changes; } };
}

function expectCode(error, code) {
    assert.ok(error instanceof ProjectModificationError || error instanceof ProjectPatchValidationError);
    assert.equal(error.code, code);
}

test('language-model output must be a bounded JSON array of complete file changes', () => {
    assert.deepEqual(
        parseProjectModificationChanges('```json\n{"changes":[{"path":"src/app.ts","content":"export {}\\n"}]}\n```'),
        [{ path: 'src/app.ts', content: 'export {}\n' }]
    );
    for (const response of [
        'Here is the code: {"changes":[]}',
        '{"changes":[{"path":"src/app.ts","content":3}]}',
        '{"files":[{"path":"src/app.ts","content":"x"}]}',
        'x'.repeat(300_001)
    ]) {
        assert.throws(() => parseProjectModificationChanges(response));
    }
});

test('patch paths are normalized, allowlisted, and reject traversal, secrets, and forbidden areas', () => {
    for (const pathName of ['../src/app.ts', '/src/app.ts', 'C:/src/app.ts', 'src\\app.ts', 'src//app.ts']) {
        assert.throws(() => validateRelativeProjectFilePath(pathName), ProjectPatchValidationError);
    }
    for (const pathName of ['.env', '.env.production', 'src/secrets.ts', 'node_modules/x.js', '.git/config', 'id_rsa.key']) {
        assert.throws(() => validateRelativeProjectFilePath(pathName), ProjectPatchValidationError);
    }
    for (const pathName of ['src/app.ts', 'test/app.test.ts', 'src/style.css', 'package.json', 'pyproject.toml']) {
        assert.equal(validateRelativeProjectFilePath(pathName), pathName);
    }
    assert.throws(() => validateRelativeProjectFilePath('README.md'), error => error.code === 'UNSUPPORTED_FILE');
});

test('rejects registered projects outside trusted root and linked project files', async t => {
    const fx = await fixture(t);
    const outside = path.join(fx.base, 'UntrustedProject');
    await fs.promises.mkdir(outside, { recursive: true });
    const outsideProject = await fx.workspace.openProject(outside);
    const outsideEngine = new ProjectModificationEngine(fx.workspace, generator([{ path: 'src/new.ts', content: 'new\n' }]));
    await assert.rejects(
        outsideEngine.propose({ requestId: 'outside', projectId: outsideProject.project.id, instruction: 'add file' }),
        error => error instanceof ProjectPatchValidationError && error.code === 'OUTSIDE_TRUSTED_ROOT'
    );

    await fs.promises.mkdir(path.join(fx.projectPath, 'src'), { recursive: true });
    const linkedTarget = path.join(fx.base, 'linked-target');
    await fs.promises.mkdir(linkedTarget);
    await fs.promises.writeFile(path.join(linkedTarget, 'linked.ts'), 'do not read\n');
    await fs.promises.symlink(linkedTarget, path.join(fx.projectPath, 'src', 'linked-dir'), 'junction');
    await assert.rejects(
        require('../dist/projects/ProjectPatchValidator').inspectProjectFile(
            fx.workspace, fx.projectId, 'src/linked-dir/linked.ts'
        ),
        error => error instanceof ProjectPatchValidationError && error.code === 'SYMLINK'
    );
});

test('proposal is deterministic, pending approval performs no writes, and apply verifies exact output', async t => {
    const fx = await fixture(t);
    await fs.promises.mkdir(path.join(fx.projectPath, 'src'));
    await fs.promises.writeFile(path.join(fx.projectPath, 'src', 'existing.ts'), 'old();\n');
    const engine = new ProjectModificationEngine(fx.workspace, generator([
        { path: 'src/new.ts', content: 'export const created = true;\n' },
        { path: 'src/existing.ts', content: 'export const replaced = true;\n' }
    ]));

    const result = await engine.propose({
        requestId: 'request-1',
        projectId: fx.projectId,
        instruction: 'Add a source file and replace existing implementation'
    });
    assert.equal(result.status, 'pending_approval');
    const plan = result.proposal;
    assert.deepEqual(plan.changes.map(change => change.path), ['src/existing.ts', 'src/new.ts']);
    assert.equal(plan.changes[0].operation, 'REPLACE');
    assert.equal(plan.changes[1].operation, 'CREATE');
    assert.equal(plan.changes[0].diff.beforeSha256.length, 64);
    await assert.rejects(
        engine.apply('request-1', fx.projectId),
        error => error.code === 'INVALID_STATE'
    );
    await assert.rejects(fs.promises.access(path.join(fx.projectPath, 'src', 'new.ts')));
    assert.equal(await fs.promises.readFile(path.join(fx.projectPath, 'src', 'existing.ts'), 'utf8'), 'old();\n');

    assert.throws(() => engine.approve('wrong-request', fx.projectId), error => error.code === 'UNKNOWN_REQUEST');
    assert.throws(() => engine.approve('request-1', 'wrong-project'), error => error.code === 'PROJECT_MISMATCH');
    assert.equal(engine.approve('request-1', fx.projectId).status, 'approved');
    const applied = await engine.apply('request-1', fx.projectId);
    assert.deepEqual(applied.changedPaths, ['src/existing.ts', 'src/new.ts']);
    assert.equal(await fs.promises.readFile(path.join(fx.projectPath, 'src', 'existing.ts'), 'utf8'), 'export const replaced = true;\n');
    assert.equal(await fs.promises.readFile(path.join(fx.projectPath, 'src', 'new.ts'), 'utf8'), 'export const created = true;\n');
    await assert.rejects(engine.apply('request-1', fx.projectId), error => error.code === 'INVALID_STATE');
});

test('approval is single-use, cancellable, and expires according to the TTL', async t => {
    const fx = await fixture(t);
    await fs.promises.mkdir(path.join(fx.projectPath, 'src'));
    let now = 1000;
    const engine = new ProjectModificationEngine(fx.workspace, generator([{ path: 'src/new.ts', content: 'ok\n' }]), {
        approvalTtlMs: 100,
        now: () => now
    });

    await engine.propose({ requestId: 'cancel-me', projectId: fx.projectId, instruction: 'add source' });
    assert.equal(engine.cancel('cancel-me', fx.projectId).status, 'cancelled');
    assert.throws(() => engine.approve('cancel-me', fx.projectId), error => error.code === 'INVALID_STATE');
    await assert.rejects(fs.promises.access(path.join(fx.projectPath, 'src', 'new.ts')));

    await engine.propose({ requestId: 'expire-me', projectId: fx.projectId, instruction: 'add source' });
    now = 1100;
    assert.throws(() => engine.approve('expire-me', fx.projectId), error => error.code === 'EXPIRED');
    await assert.rejects(fs.promises.access(path.join(fx.projectPath, 'src', 'new.ts')));
});

test('a mid-plan failure reports already written files and which outputs were verified', async t => {
    const fx = await fixture(t);
    await fs.promises.mkdir(path.join(fx.projectPath, 'src'));
    await fs.promises.mkdir(path.join(fx.projectPath, 'styles'));
    const engine = new ProjectModificationEngine(fx.workspace, generator([
        { path: 'src/new.ts', content: 'export const first = true;\n' },
        { path: 'styles/new.css', content: '.second { color: blue; }\n' }
    ]));
    const proposal = await engine.propose({
        requestId: 'partial-plan',
        projectId: fx.projectId,
        instruction: 'add two files'
    });
    assert.equal(proposal.status, 'pending_approval');
    engine.approve('partial-plan', fx.projectId);
    await fs.promises.rm(path.join(fx.projectPath, 'styles'), { recursive: true });

    await assert.rejects(
        engine.apply('partial-plan', fx.projectId),
        error => error.code === 'PARTIAL_APPLY' &&
            error.partial.changedPaths.join(',') === 'src/new.ts' &&
            error.partial.verifiedPaths.join(',') === 'src/new.ts'
    );
    assert.equal(
        await fs.promises.readFile(path.join(fx.projectPath, 'src', 'new.ts'), 'utf8'),
        'export const first = true;\n'
    );
});

test('without an injected generator, returns unsupported without changing the project', async t => {
    const fx = await fixture(t);
    const engine = new ProjectModificationEngine(fx.workspace);
    const result = await engine.propose({ requestId: 'no-generator', projectId: fx.projectId, instruction: 'add feature' });
    assert.equal(result.status, 'unsupported');
    assert.match(result.reason, /no project modification content generator/i);
    assert.deepEqual(await fs.promises.readdir(fx.projectPath), []);
});
