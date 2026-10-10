const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isCliroProject, isExactWorkspace } = require('../vscode-extension/workspacePolicy');

test('VS Code extension accepts only an exact workspace under D:\\CLIROProjects', () => {
    const expected = 'D:\\CLIROProjects\\Demo App';
    assert.equal(isCliroProject(expected), true);
    assert.equal(isExactWorkspace(expected, 'd:\\cliroprojects\\demo app'), true);
    assert.equal(isExactWorkspace(expected, 'D:\\CLIROProjects\\Other'), false);
    assert.equal(isCliroProject('C:\\Users\\someone\\CLIROProjects\\Demo App'), false);
    assert.equal(isCliroProject('D:\\CLIROProjects\\..\\Windows'), false);
});

test('trust requests invoke VS Code native controls and never change settings or trust directly', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'extension.js'), 'utf8');
    assert.match(source, /vscode\.workspace\.isTrusted/);
    assert.match(source, /vscode\.workspace\.onDidGrantWorkspaceTrust/);
    assert.match(source, /executeCommand\('workbench\.trust\.manage'\)/);
    assert.doesNotMatch(source, /security\.workspace\.trust\.enabled/);
    assert.doesNotMatch(source, /workspace\.isTrusted\s*=/);
});
