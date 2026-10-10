const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { planComputerAction } = require('../dist/tools/ComputerActionPlanner');
const { resolveSafeFolder } = require('../dist/tools/WindowsFolders');
const { ToolRegistry } = require('../dist/tools/ToolRegistry');
const { encodeSendKeysText } = require('../dist/tools/WindowsComputerControl');

test('known Windows folders and explicit existing paths become folder actions', () => {
    assert.deepEqual(planComputerAction('Open Downloads'), {
        actions: [{ type: 'OPEN_FOLDER', folder: 'Downloads' }]
    });
    assert.deepEqual(planComputerAction('Open the Documents folder'), {
        actions: [{ type: 'OPEN_FOLDER', folder: 'Documents' }]
    });
    assert.deepEqual(planComputerAction('Open E:\\Cliro'), {
        actions: [{ type: 'OPEN_FOLDER', folder: 'E:\\Cliro' }]
    });
    assert.deepEqual(planComputerAction('Open a folder named Projects'), {
        actions: [{ type: 'OPEN_FOLDER', folder: 'Projects' }]
    });
});

test('explicit folder paths must resolve to an existing directory', async () => {
    const existing = await resolveSafeFolder(os.tmpdir());
    assert.ok(existing);
    assert.equal(fs.statSync(existing.path).isDirectory(), true);
    assert.equal(await resolveSafeFolder(path.join(os.tmpdir(), 'cliro-no-such-folder-9a1d')), undefined);
    assert.equal(await resolveSafeFolder('C:\\Windows\\System32\\not-a-folder.exe'), undefined);
});

test('common application names and natural-language aliases are deterministic', () => {
    assert.deepEqual(planComputerAction('Could you open Windows Notepad?'), {
        actions: [{ type: 'OPEN_APPLICATION', application: 'Notepad' }]
    });
    assert.deepEqual(planComputerAction('Launch calc'), {
        actions: [{ type: 'OPEN_APPLICATION', application: 'Calculator' }]
    });
    assert.deepEqual(planComputerAction('Start Chrome'), {
        actions: [{ type: 'OPEN_APPLICATION', application: 'Google Chrome' }]
    });
    assert.deepEqual(planComputerAction('Bring Notepad to the front'), {
        actions: [{ type: 'FOCUS_APPLICATION', application: 'Notepad' }]
    });
});

test('explicit text and fixed keyboard commands are represented as bounded actions', () => {
    assert.deepEqual(planComputerAction('Open Notepad and write Hello CLIRO'), {
        actions: [
            { type: 'OPEN_APPLICATION', application: 'Notepad' },
            { type: 'FOCUS_APPLICATION', application: 'Notepad' },
            { type: 'TYPE_TEXT', text: 'Hello CLIRO' }
        ]
    });
    assert.deepEqual(planComputerAction('Open Notepad then type Good morning'), {
        actions: [
            { type: 'OPEN_APPLICATION', application: 'Notepad' },
            { type: 'FOCUS_APPLICATION', application: 'Notepad' },
            { type: 'TYPE_TEXT', text: 'Good morning' }
        ]
    });
    assert.deepEqual(planComputerAction('Press Ctrl+A'), {
        actions: [{ type: 'PRESS_KEY', key: 'CTRL_A' }]
    });
    assert.equal(planComputerAction('Type my name').unsupported.includes('exact text'), true);
});

test('SendKeys text escapes control syntax and preserves explicit line breaks', () => {
    assert.equal(encodeSendKeysText('Hello + (CLIRO)'), 'Hello {+} {(}CLIRO{)}');
    assert.equal(encodeSendKeysText('first line\nsecond line'), 'first line{ENTER}second line');
    assert.throws(() => encodeSendKeysText('bad\u0000text'), /unsupported control characters/);
    assert.throws(() => encodeSendKeysText('x'.repeat(4001)), /under 4,000 characters/);
});

test('close commands target one application or the foreground window, never a process command', () => {
    assert.deepEqual(planComputerAction('Close Notepad'), {
        actions: [{ type: 'CLOSE_APPLICATION', application: 'Notepad' }]
    });
    assert.deepEqual(planComputerAction('Close this folder'), {
        actions: [{ type: 'CLOSE_FOREGROUND_WINDOW' }]
    });
    assert.deepEqual(planComputerAction('Close it'), {
        actions: [{ type: 'CLOSE_FOREGROUND_WINDOW' }]
    });
    assert.equal(planComputerAction('Run taskkill /F /IM chrome.exe').unsupported.includes('force-kill'), true);
    assert.equal(planComputerAction('Delete all files').unsupported.includes('delete files'), true);
});

test('browser search and calculator chains are allowlisted and unsupported chains fail closed', () => {
    assert.deepEqual(planComputerAction('Open Chrome and search for weather'), {
        actions: [
            { type: 'OPEN_APPLICATION', application: 'Google Chrome' },
            { type: 'FOCUS_APPLICATION', application: 'Google Chrome' },
            { type: 'PRESS_KEY', key: 'CTRL_L' },
            { type: 'TYPE_TEXT', text: 'weather' },
            { type: 'PRESS_KEY', key: 'ENTER' }
        ]
    });
    assert.deepEqual(planComputerAction('Open Calculator and calculate 25 plus 30'), {
        actions: [
            { type: 'OPEN_APPLICATION', application: 'Calculator' },
            { type: 'FOCUS_APPLICATION', application: 'Calculator' },
            { type: 'TYPE_TEXT', text: '25+30' },
            { type: 'PRESS_KEY', key: 'ENTER' }
        ]
    });
    const unsupported = planComputerAction('Open Notepad and run PowerShell');
    assert.equal(unsupported.unsupported.includes('No partial action was run'), true);
});

test('general educational questions remain outside the computer-action planner', () => {
    assert.equal(planComputerAction('What is an operating system?'), null);
});

test('closing an application cannot pass the PermissionEngine gate without explicit approval', async t => {
    const previousDirectory = process.cwd();
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cliro-computer-action-'));
    process.chdir(temporaryDirectory);
    t.after(() => {
        process.chdir(previousDirectory);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });
    const registry = new ToolRegistry();
    let checked;
    const result = JSON.parse(await registry.executeIntent('executeComputerActionPlan', {
        actions: [{ type: 'CLOSE_APPLICATION', application: 'Notepad' }]
    }, {
        permissionEngine: {
            checkPermission(action) {
                checked = action;
                return false;
            }
        }
    }, 'Close Notepad'));
    assert.equal(checked.level, 2);
    assert.equal(result.type, 'ACTION_APPROVAL_REQUIRED');
    assert.equal(result.verified, false);
});
