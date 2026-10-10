const assert = require('node:assert/strict');
const test = require('node:test');
const { ProjectCreationApprovalStore } = require('../dist/projects/ProjectCreationApproval');
const { parseProjectCreationCommand } = require('../dist/projects/ProjectCommand');
const { planProjectIdea } = require('../dist/projects/ProjectPlanner');

test('classifies project creation prompts and detects starter types', () => {
    const cases = [
        ['Create a project called ApprovalTest', 'ApprovalTest', 'basic', false],
        ['Create a Node project called TestNode', 'TestNode', 'node', false],
        ['Create a Node.js project called TestNode', 'TestNode', 'node', false],
        ['Create a TypeScript project called TestTS', 'TestTS', 'typescript', false],
        ['Create a Python project called TestPython', 'TestPython', 'python', false],
        ['Create an HTML project called TestWeb', 'TestWeb', 'html', false],
        ['Create an HTML/CSS/JavaScript project called TestWeb', 'TestWeb', 'html', false],
        ['Create a React project called TestReact', 'TestReact', 'react', false],
        ['Create a React project called JarvisTodo2, build it, test it, run it, and open it in VS Code.', 'JarvisTodo2', 'react', true],
        ['Create a React project called MyPortfolio and open it in VS Code', 'MyPortfolio', 'react', true],
        ['Create a project called TestApp and open it', 'TestApp', 'basic', true],
        ['Create a Python project called MLTest and open it', 'MLTest', 'python', true],
        ['Create a Node project called BackendTest and open it', 'BackendTest', 'node', true],
        ['Create a project called WebTest and open it', 'WebTest', 'basic', true]
    ];
    for (const [prompt, name, template, openInVSCode] of cases) {
        assert.deepEqual(parseProjectCreationCommand(prompt), { name, template, openInVSCode }, prompt);
    }
});

test('plans idea-based project requests into a structured blueprint without creating files', () => {
    const planned = planProjectIdea('Build a simple React To-Do application called JarvisTodo and open it in VS Code.');
    assert.ok(planned);
    assert.equal(planned.name, 'JarvisTodo');
    assert.equal(planned.template, 'react');
    assert.equal(planned.openInVSCode, true);
    assert.deepEqual(planned.blueprint.roles, ['User']);
    assert.ok(planned.blueprint.features.includes('Add tasks'));
    const app = planned.blueprint.files.find(file => file.path === 'src/App.tsx');
    assert.ok(app);
    assert.match(app.content, /function addTask/);
    assert.match(app.content, /completed: !item\.completed/);
    assert.ok(planned.blueprint.testPlan.length > 0);
    assert.match(planned.blueprint.commands.join(' '), /requires separate approval/i);
    assert.equal(planProjectIdea('Explain how React works.'), null);

    const placement = planProjectIdea('Create an online placement management system for colleges.');
    assert.deepEqual(placement.blueprint.roles, ['Admin', 'Student', 'Faculty', 'Company']);
    const resume = planProjectIdea('I want an AI resume analyzer.');
    assert.equal(resume.name, 'AIResumeAnalyzer');
    assert.equal(resume.template, 'react');
    assert.equal(planProjectIdea('Create a database.'), null);
});

test('approval requests are unique, bound to the original action, single-use, cancellable, and expiring', () => {
    const store = new ProjectCreationApprovalStore(1000);
    const first = store.create('Create a Node project called One and open it', 'One', 'node', true, 10_000);
    const second = store.create('Create a Node project called Two', 'Two', 'node', false, 10_000);
    assert.notEqual(first.approvalRequestId, second.approvalRequestId);
    assert.equal(
        store.decide(first.approvalRequestId, 'Create a Node project called Other and open it', 'Other', 'node', true, true, 10_100).status,
        'mismatch'
    );
    assert.equal(
        store.decide(first.approvalRequestId, first.prompt, first.name, first.template, false, true, 10_100).status,
        'mismatch'
    );
    assert.equal(
        store.decide(first.approvalRequestId, first.prompt, first.name, first.template, true, true, 10_100).status,
        'approved'
    );
    assert.equal(
        store.decide(first.approvalRequestId, first.prompt, first.name, first.template, true, true, 10_101).status,
        'invalid'
    );
    assert.equal(
        store.decide(second.approvalRequestId, second.prompt, second.name, second.template, false, false, 10_100).status,
        'cancelled'
    );
    assert.equal(
        store.decide(second.approvalRequestId, second.prompt, second.name, second.template, false, true, 10_101).status,
        'invalid'
    );
    const expired = store.create('Create a Python project called Late', 'Late', 'python', false, 20_000);
    assert.equal(
        store.decide(expired.approvalRequestId, expired.prompt, expired.name, expired.template, false, true, 21_000).status,
        'expired'
    );
});
