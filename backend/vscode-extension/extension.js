const vscode = require('vscode');
const { canonical, isCliroProject, isExactWorkspace } = require('./workspacePolicy');

const apiRoot = 'http://127.0.0.1:3001/api/vscode/workspace-trust';
const pollIntervalMs = 2000;

function activeProjectPath() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length !== 1) return undefined;
    const workspacePath = folders[0].uri.fsPath;
    return isCliroProject(workspacePath) ? workspacePath : undefined;
}

function activate(context) {
    const output = vscode.window.createOutputChannel('CLIRO Workspace Trust');
    const handledRequests = new Set();
    let activeRequestId;
    let inFlight = false;

    async function postReport(workspacePath, isTrusted, requestId) {
        const response = await fetch(`${apiRoot}/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspacePath,
                isTrusted,
                ...(requestId ? { requestId } : {})
            })
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`CLIRO trust report was rejected (${response.status}): ${detail}`);
        }
    }

    async function poll() {
        if (inFlight) return;
        const workspacePath = activeProjectPath();
        if (!workspacePath) return;
        inFlight = true;
        try {
            const response = await fetch(
                `${apiRoot}/poll?workspacePath=${encodeURIComponent(workspacePath)}`
            );
            if (!response.ok) {
                throw new Error(`CLIRO trust bridge poll failed with HTTP ${response.status}.`);
            }
            const state = await response.json();
            if (!state.request) {
                activeRequestId = undefined;
                await postReport(workspacePath, vscode.workspace.isTrusted);
                return;
            }
            const request = state.request;
            if (
                request.projectPath &&
                isExactWorkspace(request.projectPath, workspacePath) &&
                !handledRequests.has(request.requestId)
            ) {
                handledRequests.add(request.requestId);
                activeRequestId = request.requestId;
                await postReport(workspacePath, vscode.workspace.isTrusted, activeRequestId);
                if (!vscode.workspace.isTrusted) {
                    await vscode.commands.executeCommand('workbench.trust.manage');
                }
            } else {
                await postReport(workspacePath, vscode.workspace.isTrusted, activeRequestId);
            }
        } catch (error) {
            output.appendLine(error instanceof Error ? error.message : String(error));
        } finally {
            inFlight = false;
        }
    }

    const timer = setInterval(() => void poll(), pollIntervalMs);
    context.subscriptions.push(
        output,
        { dispose: () => clearInterval(timer) },
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            const workspacePath = activeProjectPath();
            if (workspacePath) {
                void postReport(workspacePath, true, activeRequestId).catch(error =>
                    output.appendLine(error instanceof Error ? error.message : String(error))
                );
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => void poll())
    );
    void poll();
}

module.exports = { activate };
