import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/actionTrust.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { actionStateFor, isStructuredActionSuccess } = await import(moduleUrl);

test('verified action success is only reported when the backend confirms verification', () => {
  assert.equal(actionStateFor('APPLICATION_OPENED', true), 'success');
  assert.equal(actionStateFor('APPLICATION_OPENED', false), 'failed');
  assert.equal(actionStateFor('APPLICATION_OPENED'), 'failed');
  assert.equal(actionStateFor('ACTION_SUCCESS', true), 'success');
  assert.equal(actionStateFor('ACTION_FAILED', false), 'failed');
  assert.equal(actionStateFor('ACTION_FAILED', true), 'failed');
  assert.equal(actionStateFor('ACTION_EXECUTING'), 'executing');
  assert.equal(isStructuredActionSuccess({ type: 'APPLICATION_OPENED', verified: true, message: 'Opened' }), true);
  assert.equal(isStructuredActionSuccess({ type: 'APPLICATION_OPENED', verified: false, message: 'Failed' }), false);
  assert.equal(isStructuredActionSuccess({ type: 'APPLICATION_OPENED', message: 'Opened' }), false);
});
