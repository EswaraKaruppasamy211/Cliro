import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import {
  getChromeBridgeStatus,
  isEligibleChromeTab,
  runChromeTabAction
} from '../chrome-extension/tab-operations.mjs';

const compiledActions = ts.transpileModule(
  await readFile(new URL('../src/chromeTabActions.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
).outputText
  .replace("from './chromeBridge';", "from 'data:text/javascript,export%20const%20requestChromeBridgeStatus%3Dasync()%3D%3E(%7Bconnected%3Afalse%2CchromeWindowAvailable%3Afalse%2CeligibleTabCount%3A0%7D)%3B%20export%20const%20requestChromeTabOperation%3Dasync()%3D%3Enull%3B';")
  .replace("from './vision/GestureRecognizer';", '');
const actionModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledActions).toString('base64')}`;
const { createChromeTabActions, runChromeTabGesture } = await import(actionModuleUrl);

const activeWindow = { id: 4, type: 'normal' };
const tab = (id, index, active = false, url = `https://site${id}.example/`) => ({
  id, index, active, windowId: 4, url
});

function mockChrome(initialTabs, overrides = {}) {
  let tabs = initialTabs.map(item => ({ ...item }));
  const calls = [];
  let focusedWindow = activeWindow;
  const chromeApi = {
    windows: {
      async getLastFocused() {
        calls.push(['getLastFocused']);
        return focusedWindow;
      }
    },
    tabs: {
      async query(query) {
        calls.push(['query', query]);
        return tabs.filter(item =>
          (query.windowId === undefined || item.windowId === query.windowId) &&
          (query.active === undefined || item.active === query.active)
        ).map(item => ({ ...item }));
      },
      async get(id) {
        calls.push(['get', id]);
        const found = tabs.find(item => item.id === id);
        if (!found) throw new Error('No tab with given id');
        return { ...found };
      },
      async remove(id) {
        calls.push(['remove', id]);
        if (!overrides.failClose) tabs = tabs.filter(item => item.id !== id);
      },
      async update(id, properties) {
        calls.push(['update', id, properties]);
        if (overrides.failUpdate) throw new Error('Activation denied');
        tabs = tabs.map(item => ({ ...item, active: item.id === id }));
        return tabs.find(item => item.id === id);
      }
    },
    setTabs(value) { tabs = value.map(item => ({ ...item })); },
    setFocusedWindow(value) { focusedWindow = value; },
    calls
  };
  return chromeApi;
}

test('extension bridge status reports connected and available without exposing tab metadata', async () => {
  const chromeApi = mockChrome([tab(1, 0, true)]);
  assert.deepEqual(await getChromeBridgeStatus(chromeApi), {
    connected: true, chromeWindowAvailable: true, eligibleTabCount: 1
  });
});

test('bridge status reports unavailable when Chrome APIs cannot be reached', async () => {
  const chromeApi = mockChrome([]);
  chromeApi.windows.getLastFocused = async () => { throw new Error('extension unavailable'); };
  assert.deepEqual(await getChromeBridgeStatus(chromeApi), {
    connected: false, chromeWindowAvailable: false, eligibleTabCount: 0
  });
});

test('no normal Chrome window returns ACTION_UNAVAILABLE', async () => {
  const chromeApi = mockChrome([]);
  chromeApi.setFocusedWindow(null);
  assert.equal((await runChromeTabAction('nextChromeTab', chromeApi)).type, 'ACTION_UNAVAILABLE');
});

test('no eligible active tab and protected chrome pages are not operated on', async () => {
  const protectedTabs = [tab(1, 0, true, 'chrome://settings/'), tab(2, 1, false)];
  const chromeApi = mockChrome(protectedTabs);
  assert.equal((await runChromeTabAction('closeCurrentChromeTab', chromeApi)).type, 'ACTION_UNAVAILABLE');
  assert.equal(chromeApi.calls.some(call => call[0] === 'remove'), false);
  assert.equal(isEligibleChromeTab(tab(3, 0, true, 'chrome-extension://id/popup.html')), false);
  assert.equal(isEligibleChromeTab(tab(4, 0, true, 'devtools://devtools/')), false);
});

test('close current tab succeeds only after the active tab is confirmed absent', async () => {
  const chromeApi = mockChrome([tab(1, 0), tab(2, 1, true)]);
  const result = await runChromeTabAction('closeCurrentChromeTab', chromeApi);
  assert.deepEqual(result, {
    type: 'ACTION_SUCCESS',
    message: 'Chrome closed the active tab and confirmed it is no longer open.',
    verified: true
  });
  assert.ok(chromeApi.calls.some(call => call[0] === 'remove' && call[1] === 2));
  assert.equal(chromeApi.calls.some(call => call[0] === 'remove' && call[1] === 1), false);
});

test('close is not reported successful if Chrome still returns the active tab', async () => {
  const chromeApi = mockChrome([tab(1, 0), tab(2, 1, true)], { failClose: true });
  const result = await runChromeTabAction('closeCurrentChromeTab', chromeApi);
  assert.equal(result.type, 'ACTION_FAILED');
  assert.equal(result.verified, false);
});

test('next and previous activate an adjacent eligible tab and verify its active ID', async () => {
  const nextChrome = mockChrome([tab(1, 0), tab(2, 1, true), tab(3, 2)]);
  assert.equal((await runChromeTabAction('nextChromeTab', nextChrome)).verified, true);
  assert.ok(nextChrome.calls.some(call => call[0] === 'update' && call[1] === 3));

  const previousChrome = mockChrome([tab(1, 0), tab(2, 1, true), tab(3, 2)]);
  assert.equal((await runChromeTabAction('previousChromeTab', previousChrome)).verified, true);
  assert.ok(previousChrome.calls.some(call => call[0] === 'update' && call[1] === 1));
});

test('tab switch verification failure is not reported as success', async () => {
  const chromeApi = mockChrome([tab(1, 0), tab(2, 1, true)], { failUpdate: true });
  const result = await runChromeTabAction('nextChromeTab', chromeApi);
  assert.equal(result.type, 'ACTION_FAILED');
  assert.equal(result.verified, false);
});

test('protected and ineligible pages are excluded from the tab order', async () => {
  assert.equal(isEligibleChromeTab(tab(1, 0, false, 'chrome://newtab/')), false);
  assert.equal(isEligibleChromeTab(tab(2, 1, false, 'https://chromewebstore.google.com/')), false);
  const chromeApi = mockChrome([
    tab(1, 0),
    tab(2, 1, true),
    tab(3, 2, false, 'chrome://settings/')
  ]);
  const result = await runChromeTabAction('nextChromeTab', chromeApi);
  assert.equal(result.type, 'ACTION_SUCCESS');
  assert.equal(chromeApi.calls.some(call => call[0] === 'update' && call[1] === 3), false);
});

test('gesture close, next, and previous codes route to their corresponding action functions', async () => {
  const events = [];
  const actions = createChromeTabActions({
    async authorize(action) { events.push(`authorize:${action}`); return { authorizationId: 'auth' }; },
    async execute(action) {
      events.push(`execute:${action}`);
      return { type: 'ACTION_SUCCESS', message: action, verified: true };
    },
    async complete(_id, action, result) { events.push(`complete:${action}`); return result; }
  });
  for (const [gesture, expected] of [
    ['CLOSE_CHROME_TAB', 'closeCurrentChromeTab'],
    ['NEXT_CHROME_TAB', 'nextChromeTab'],
    ['PREVIOUS_CHROME_TAB', 'previousChromeTab']
  ]) {
    const actionPromise = runChromeTabGesture(gesture, actions);
    if (actionPromise) await actionPromise;
    assert.ok(events.includes(`execute:${expected}`));
  }
  assert.deepEqual(events.filter(event => event.startsWith('execute:')), [
    'execute:closeCurrentChromeTab', 'execute:nextChromeTab', 'execute:previousChromeTab'
  ]);
});

test('authorization failure does not call the extension bridge', async () => {
  let executions = 0;
  const actions = createChromeTabActions({
    async authorize() { throw new Error('permission denied'); },
    async execute() { executions += 1; return { type: 'ACTION_SUCCESS', message: 'fake', verified: true }; },
    async complete(_id, _action, result) { return result; }
  });
  const result = await actions.closeCurrentChromeTab();
  assert.equal(result.type, 'ACTION_UNAVAILABLE');
  assert.equal(executions, 0);
});

test('cooldown, stability, low confidence, and multiple hands remain non-triggering', async () => {
  const source = await readFile(new URL('../src/vision/GestureRecognizer.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const recognizerModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  const recognizer = new recognizerModule.GestureRecognizer();
  assert.equal(recognizer.update([], null, 0).triggerUiAction, false);
  assert.equal(recognizer.update([[], []], 0.99, 200).triggerUiAction, false);
  assert.equal(recognizerModule.classifyHandLandmarks([], 0.79).gesture, 'UNKNOWN');
});

test('bridge source uses no process execution, remote endpoint, or browsing-data transmission', async () => {
  const files = [
    '../chrome-extension/manifest.json',
    '../chrome-extension/content-script.js',
    '../chrome-extension/service-worker.js',
    '../chrome-extension/tab-operations.mjs'
  ];
  const contents = await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  const manifest = JSON.parse(contents[0]);
  assert.deepEqual(manifest.permissions, ['tabs']);
  assert.equal('host_permissions' in manifest, false);
  assert.doesNotMatch(contents.join('\n'), /child_process|execFile|taskkill|powershell|XMLHttpRequest|WebSocket|fetch\s*\(/i);
  assert.doesNotMatch(contents.join('\n'), /history|cookies|storage/i);
  assert.match(contents[1], /action:\s*message\.action/);
  assert.doesNotMatch(contents[1], /url:\s*message|title:\s*message|content:/i);
});
