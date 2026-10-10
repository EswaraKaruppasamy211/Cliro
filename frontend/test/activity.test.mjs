import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/activity.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { activityMarkFor, mergeActivityEvent } = await import(moduleUrl);

test('activity event states display queued, rotating, completed, and failed marks', () => {
  assert.equal(activityMarkFor('QUEUED'), '○');
  assert.equal(activityMarkFor('RUNNING'), '◌');
  assert.equal(activityMarkFor('COMPLETED'), '✓');
  assert.equal(activityMarkFor('FAILED'), '×');
  assert.equal(activityMarkFor('REQUIRES_APPROVAL'), '⚠');
});

test('activity panel state comes from stage updates and keeps bounded recent stages', async () => {
  const event = (stage, status) => ({ stage, status, message: stage, at: '2026-10-05T00:00:00.000Z' });
  const running = mergeActivityEvent([], event('OPENAI_REQUEST', 'RUNNING'));
  const complete = mergeActivityEvent(running, event('OPENAI_REQUEST', 'COMPLETED'));
  assert.equal(complete.length, 1);
  assert.equal(complete[0].status, 'COMPLETED');
  const otherRequest = mergeActivityEvent(complete, {
    ...event('OPENAI_REQUEST', 'RUNNING'),
    requestId: 'request-2',
    actionId: 'action-2',
    verification: null
  });
  assert.equal(otherRequest.length, 2);
  const bounded = Array.from({ length: 12 }, (_, index) =>
    event(`STAGE_${index}`, 'COMPLETED')
  ).reduce((events, item) => mergeActivityEvent(events, item), []);
  assert.equal(bounded.length, 10);
  assert.equal(bounded[0].stage, 'STAGE_2');

  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/command-center.css', import.meta.url), 'utf8');
  const trustExtension = await readFile(new URL('../../backend/vscode-extension/extension.js', import.meta.url), 'utf8');
  const toolRegistry = await readFile(new URL('../../backend/src/tools/ToolRegistry.ts', import.meta.url), 'utf8');
  assert.match(appSource, /aria-label="Request activity"/);
  assert.match(appSource, /PROJECT CREATION REQUIRES APPROVAL/);
  assert.match(appSource, /PROJECT PLAN READY/);
  assert.match(appSource, /projectPlan\.features\.join/);
  assert.match(appSource, /approvalRequestId/);
  assert.match(appSource, /PROJECT VERIFIED/);
  assert.match(appSource, /VS CODE VERIFIED/);
  assert.match(appSource, /VS CODE OPEN FAILED/);
  assert.match(appSource, /New projects are stored under D:\\CLIROProjects/);
  assert.match(appSource, /Workspace: \$\{vsCodeResult\.workspacePath\}/);
  assert.match(toolRegistry, /Project opened in VS Code, but VS Code requires workspace trust for full features\./);
  assert.match(appSource, /Trust this CLIRO project/);
  assert.match(appSource, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/vscode\/trust/);
  assert.match(appSource, /workspaceTrustStatus === 'RESTRICTED'/);
  assert.match(trustExtension, /vscode\.workspace\.isTrusted/);
  assert.match(trustExtension, /workbench\.trust\.manage/);
  assert.doesNotMatch(trustExtension, /security\.workspace\.trust\.enabled/);
  assert.doesNotMatch(appSource, /C:\\Users\\acer\\CLIROProjects/);
  assert.match(appSource, /activityEvents\.slice\(-10\)/);
  assert.match(appSource, /pendingActionApproval\.executionId \|\| pendingActionApproval\.approvalRequestId \? 'Approve' : 'Approve once'/);
  assert.match(appSource, />\s*Cancel\s*</);
  assert.match(appSource, /DEPENDENCY INSTALL REQUIRES APPROVAL/);
  assert.match(appSource, /approval\.executionId/);
  assert.match(appSource, /\/api\/projects\/executions\/\$\{encodeURIComponent\(approval\.executionId\)\}\/approval/);
  assert.match(appSource, /Cancel execution/);
  assert.match(appSource, /Stop CLIRO project/);
  assert.match(appSource, /verification === true/);
  assert.match(appSource, /BUILD PASSED/);
  assert.match(appSource, /TEST NOT CONFIGURED/);
  assert.match(appSource, /RUNNING VERIFIED/);
  assert.match(appSource, /setActivityEvents\(previous => mergeActivityEvent\(previous, parsed\.activity!?\)\)/);
  assert.match(css, /\.activity-mark\.running[\s\S]*animation:\s*activity-rotate/);
  assert.match(css, /\.activity-mark\.requires_approval/);
});
