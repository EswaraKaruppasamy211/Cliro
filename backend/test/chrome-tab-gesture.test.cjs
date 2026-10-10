const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PermissionEngine, PermissionLevel } = require('../dist/permissions/PermissionEngine');
const {
    ChromeTabGestureAuthorization
} = require('../dist/tools/ChromeTabGestureAuthorization');
const { ToolRegistry } = require('../dist/tools/ToolRegistry');

const actions = [
    'closeCurrentChromeTab',
    'nextChromeTab',
    'previousChromeTab'
];

test('ToolRegistry authorizes only fixed tab actions through LOW_RISK PermissionEngine checks', async t => {
    const previousDirectory = process.cwd();
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cliro-chrome-gesture-'));
    process.chdir(temporaryDirectory);
    t.after(() => {
        process.chdir(previousDirectory);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    const permissionEngine = new PermissionEngine();
    const registry = new ToolRegistry();
    const authorizations = new ChromeTabGestureAuthorization();
    for (const action of actions) {
        const result = registry.authorizeChromeTabGesture(action, {
            permissionEngine,
            source: 'gesture',
            gesture: action === actions[0] ? 'CLOSED_FIST' : action === actions[1] ? 'ROTATE_RIGHT' : 'ROTATE_LEFT'
        }, authorizations);
        assert.equal(result.authorized, true);
        assert.match(result.authorizationId, /^[0-9a-f-]{36}$/i);
    }
    assert.equal(registry.authorizeChromeTabGesture('closeAllChromeTabs', {
        permissionEngine,
        source: 'gesture',
        gesture: 'CLOSED_FIST'
    }, authorizations).authorized, false);
});

test('PermissionEngine denial prevents issuing a Chrome gesture authorization', async t => {
    const previousDirectory = process.cwd();
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cliro-chrome-denied-'));
    process.chdir(temporaryDirectory);
    t.after(() => {
        process.chdir(previousDirectory);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });
    const registry = new ToolRegistry();
    const authorizations = new ChromeTabGestureAuthorization();
    let checkedLevel;
    const result = registry.authorizeChromeTabGesture('closeCurrentChromeTab', {
        permissionEngine: {
            checkPermission(action) {
                checkedLevel = action.level;
                return false;
            }
        },
        source: 'gesture',
        gesture: 'CLOSED_FIST'
    }, authorizations);
    assert.equal(checkedLevel, PermissionLevel.LOW_RISK);
    assert.deepEqual(result, { authorized: false, error: 'Permission denied for this Chrome tab action.' });
});

test('completion requires a matching, unexpired, one-use authorization and a verified success', () => {
    let now = 1_000;
    let id = 1;
    const authorizations = new ChromeTabGestureAuthorization(
        () => now,
        () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`
    );
    const first = authorizations.issue('closeCurrentChromeTab');
    assert.equal(authorizations.consume(first, 'nextChromeTab', {
        type: 'ACTION_SUCCESS', message: 'wrong operation', verified: true
    }), null);
    assert.equal(authorizations.consume(first, 'closeCurrentChromeTab', {
        type: 'ACTION_SUCCESS', message: 'replay', verified: true
    }), null);

    const second = authorizations.issue('nextChromeTab');
    assert.deepEqual(authorizations.consume(second, 'nextChromeTab', {
        type: 'ACTION_FAILED', message: 'not verified', verified: true
    }), {
        type: 'ACTION_FAILED', message: 'not verified', verified: false
    });

    const third = authorizations.issue('previousChromeTab');
    now += 30_001;
    assert.equal(authorizations.consume(third, 'previousChromeTab', {
        type: 'ACTION_SUCCESS', message: 'expired', verified: true
    }), null);
});

test('verified completion is normalized and bounded before it is returned', () => {
    const authorizations = new ChromeTabGestureAuthorization(() => 0, () => '00000000-0000-4000-8000-000000000001');
    const id = authorizations.issue('closeCurrentChromeTab');
    const completed = authorizations.consume(id, 'closeCurrentChromeTab', {
        type: 'ACTION_SUCCESS',
        message: 'C'.repeat(500),
        verified: true
    });
    assert.equal(completed.type, 'ACTION_SUCCESS');
    assert.equal(completed.verified, true);
    assert.equal(completed.message.length, 400);
});
