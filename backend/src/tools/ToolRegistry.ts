import { exec, execFile } from 'child_process';
import { getSystemInfo, getSystemStatus, SystemInfoSection } from '../system/systemTools';
import { PermissionLevel, PermissionEngine } from '../permissions/PermissionEngine';
import { analyzeProjectCode, CodeAnalysisResult } from './CodeAnalyzer';
import {
    discoverInstalledApplications,
    isApplicationRunning,
    launchRegisteredApplication,
    resolveApplication,
    waitForApplication
} from './WindowsApplications';
import { ChromeTabAction, controlChromeTabs } from './ChromeTabControl';
import {
    ChromeTabGestureAction,
    ChromeTabGestureAuthorization,
    ChromeTabGestureResult,
    chromeTabGestureActions
} from './ChromeTabGestureAuthorization';
import { closeVisibleUserApplications } from './WindowsApplicationControl';
import { planComputerAction } from './ComputerActionPlanner';
import type { ComputerAction } from './ComputerActionPlanner';
import { resolveSafeFolder } from './WindowsFolders';
import {
    closeApplicationWindows,
    closeForegroundWindow,
    ForegroundWindow,
    focusApplicationWindow,
    getForegroundWindow,
    openExplorerFolder,
    sendSafeKey,
    sendTextToForeground,
    WindowOperationResult
} from './WindowsComputerControl';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceTrustBridge, WorkspaceTrustStatus } from '../projects/WorkspaceTrustBridge';

export type ActionSource = 'chat' | 'voice' | 'gesture';
export type DetectedGesture =
    | 'FIST'
    | 'ROTATE_LEFT'
    | 'ROTATE_RIGHT'
    | 'OPEN_PALM'
    | 'CLOSED_FIST'
    | 'THUMBS_UP'
    | 'THUMBS_DOWN'
    | 'POINT'
    | 'V_SIGN';

export interface ToolContext {
    permissionEngine: PermissionEngine;
    workspaceTrustBridge?: WorkspaceTrustBridge;
    onProgress?: (message: string) => void;
    source?: ActionSource;
    gesture?: DetectedGesture;
    approvalGranted?: boolean;
}

export function vscodeWorkspaceArguments(workspacePath: string): string[] {
    if (!path.isAbsolute(workspacePath)) {
        throw new Error('The VS Code workspace path must be absolute.');
    }
    return ['--reuse-window', workspacePath];
}

function isComputerAction(value: unknown): value is ComputerAction {
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return false;
    switch (value.type) {
        case 'OPEN_APPLICATION':
        case 'CLOSE_APPLICATION':
        case 'FOCUS_APPLICATION':
            return 'application' in value && typeof value.application === 'string' &&
                value.application.trim().length > 0 && value.application.length <= 120;
        case 'OPEN_FOLDER':
            return 'folder' in value && typeof value.folder === 'string' &&
                value.folder.trim().length > 0 && value.folder.length <= 2048;
        case 'CLOSE_FOREGROUND_WINDOW':
            return true;
        case 'TYPE_TEXT':
            return 'text' in value && typeof value.text === 'string' &&
                value.text.length > 0 && value.text.length <= 4000 &&
                !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text);
        case 'PRESS_KEY':
            return 'key' in value && typeof value.key === 'string' &&
                ['ENTER', 'ESCAPE', 'TAB', 'BACKSPACE', 'CTRL_C', 'CTRL_V', 'CTRL_A', 'CTRL_L', 'ALT_TAB', 'WINDOWS'].includes(value.key);
        default:
            return false;
    }
}

export class ToolRegistry {
    private lastApplication: string | undefined;
    private lastFolder: string | undefined;

    private allowedProjects: Record<string, string> = {
        'tms': 'C:\\Projects\\TMS',
        'cliro': 'E:\\Cliro'
    };

    private audit(request: string, tool: string, level: PermissionLevel, status: string, result: string, context?: ToolContext, verified?: boolean) {
        const source = context?.source || 'chat';
        const input = source === 'gesture' ? context?.gesture || request : request;
        const metadata = ` | Source: ${source} | Detected input: ${JSON.stringify(input)} | Intent: ${tool} | Action ID: ${tool} | Permission: ${PermissionLevel[level]} | Verification: ${verified === true ? 'verified' : verified === false ? 'not verified' : 'not applicable'}`;
        const logEntry = `[${new Date().toISOString()}] Request: "${request}" | Tool: ${tool} | Level: ${level} | Status: ${status} | Result: ${result}${metadata}\n`;
        fs.appendFileSync('audit.log', logEntry);
    }

    private async isProcessRunning(processName: string): Promise<boolean> {
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${processName}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, output, stderr) => {
                if (error) {
                    reject(new Error(stderr.trim() || error.message));
                    return;
                }
                resolve(output);
            });
        });

        return stdout.split(/\r?\n/).some(line => {
            const imageName = line.match(/^"([^"]+)"/)?.[1];
            return imageName?.toLowerCase() === processName.toLowerCase();
        });
    }

    private getActionFailure(message: string): string {
        return JSON.stringify({ type: 'ACTION_FAILED', message });
    }

    authorizeChromeTabGesture(
        action: unknown,
        context: ToolContext,
        authorizations: ChromeTabGestureAuthorization
    ): { authorized: true; authorizationId: string } | { authorized: false; error: string } {
        if (typeof action !== 'string' || !chromeTabGestureActions.includes(action as ChromeTabGestureAction)) {
            return { authorized: false, error: 'Unsupported Chrome tab action.' };
        }
        const level = PermissionLevel.LOW_RISK;
        if (!context.permissionEngine.checkPermission({
            name: action,
            level,
            description: `Perform the fixed ${action} operation through the local Chrome extension`
        })) {
            this.audit(action, 'chromeTabGesture', level, 'DENIED', 'NOT_EXECUTED', context, false);
            return { authorized: false, error: 'Permission denied for this Chrome tab action.' };
        }
        const authorizationId = authorizations.issue(action as ChromeTabGestureAction);
        this.audit(action, 'chromeTabGesture', level, 'APPROVED', 'AUTHORIZED', context, false);
        return { authorized: true, authorizationId };
    }

    completeChromeTabGesture(
        authorizationId: unknown,
        action: unknown,
        result: unknown,
        context: ToolContext,
        authorizations: ChromeTabGestureAuthorization
    ): ChromeTabGestureResult | null {
        const completed = authorizations.consume(authorizationId, action, result);
        if (!completed) return null;
        this.audit(
            action as string,
            'chromeTabGesture',
            PermissionLevel.LOW_RISK,
            completed.type,
            completed.message,
            context,
            completed.verified
        );
        return completed;
    }

    private codeAnalysisFailure(project: string, message: string): CodeAnalysisResult {
        return {
            type: 'CODE_ANALYSIS',
            project,
            success: false,
            message: `Code analysis could not be completed: ${message}`,
            analysisMethod: 'Not completed',
            durationMs: 0,
            filesScanned: [],
            filesSkipped: [],
            skippedCount: 0,
            excludedDirectories: [],
            bounded: false,
            findingsTruncated: false,
            errors: [],
            warnings: [],
            informationalFindings: []
        };
    }

    private actionResult(
        type: string,
        message: string,
        verified: boolean,
        additional: Record<string, unknown> = {}
    ): string {
        return JSON.stringify({ type, message, verified, ...additional });
    }

    private safeApplicationForWindow(window: ForegroundWindow, applications: Awaited<ReturnType<typeof discoverInstalledApplications>>) {
        if (window.processName.toLowerCase() === 'explorer.exe' && window.title !== 'Program Manager') {
            return { name: 'File Explorer', appId: '', processNames: ['explorer.exe'] };
        }
        if (window.processName.toLowerCase() === 'applicationframehost.exe') {
            return applications.find(application => application.name.toLowerCase() === window.title.toLowerCase());
        }
        const processName = window.processName.toLowerCase();
        if ([
            'cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe',
            'conhost.exe', 'openconsole.exe', 'applicationframehost.exe', 'lockapp.exe'
        ].includes(processName)) return undefined;
        return applications.find(application =>
            application.processNames.some(name => name.toLowerCase() === processName));
    }

    private async executeComputerActionPlan(
        actions: unknown,
        context: ToolContext,
        originalRequest: string
    ): Promise<string> {
        if (!Array.isArray(actions) || actions.length === 0 || actions.length > 8) {
            return this.actionResult('UNSUPPORTED_ACTION', 'The computer action plan is invalid or too large; nothing was executed.', false);
        }

        const candidates: unknown[] = actions;
        const validatedActions = candidates.filter(isComputerAction);
        if (validatedActions.length !== candidates.length) {
            return this.actionResult('UNSUPPORTED_ACTION', 'The computer action plan contains an invalid step; nothing was executed.', false);
        }
        const auditRequest = validatedActions.some(action => action.type === 'TYPE_TEXT')
            ? '[computer action; typed text omitted]'
            : originalRequest;
        const completedMessages: string[] = [];
        for (const action of validatedActions) {
            const closeAction = action.type === 'CLOSE_APPLICATION' || action.type === 'CLOSE_FOREGROUND_WINDOW';
            const keyNeedsApproval = action.type === 'PRESS_KEY' && action.key === 'CTRL_V';
            const permissionLevel = closeAction || keyNeedsApproval
                ? PermissionLevel.APPROVAL_REQUIRED
                : PermissionLevel.LOW_RISK;
            if (!context.permissionEngine.checkPermission({
                name: `computer.${action.type}`,
                level: permissionLevel,
                description: `Perform the explicit ${action.type} step in the local computer action plan`,
                approvalGranted: context.approvalGranted
            })) {
                const message = permissionLevel === PermissionLevel.APPROVAL_REQUIRED
                    ? 'This action requires your explicit approval. No action was taken.'
                    : 'Permission denied. No action was taken.';
                this.audit(auditRequest, action.type, permissionLevel, 'DENIED', message, context, false);
                return this.actionResult('ACTION_APPROVAL_REQUIRED', message, false);
            }

            let result: string;
            try {
                result = await this.runComputerAction(action, context, auditRequest);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                this.audit(auditRequest, action.type, permissionLevel, 'FAILED', detail, context, false);
                return this.actionResult('ACTION_FAILED', `Unable to execute ${action.type}: ${detail}`, false);
            }

            let parsed: { type?: string; message?: string; verified?: boolean };
            try {
                parsed = JSON.parse(result);
            } catch {
                return this.actionResult('ACTION_FAILED', 'A computer action returned an invalid result; the remaining steps were stopped.', false);
            }
            if (!['ACTION_SUCCESS', 'APPLICATION_OPENED', 'APPLICATION_ALREADY_RUNNING'].includes(parsed.type || '') ||
                parsed.verified === false) {
                this.audit(auditRequest, action.type, permissionLevel, parsed.type || 'FAILED', parsed.message || 'NOT_VERIFIED', context, parsed.verified);
                return result;
            }
            this.audit(auditRequest, action.type, permissionLevel, parsed.type || 'SUCCESS', parsed.message || 'SUCCESS', context, parsed.verified);
            if (parsed.message) completedMessages.push(parsed.message);
        }
        return this.actionResult(
            'ACTION_SUCCESS',
            completedMessages.join(' '),
            true,
            { completedSteps: completedMessages.length }
        );
    }

    private async runComputerAction(
        action: ComputerAction,
        context: ToolContext,
        originalRequest: string
    ): Promise<string> {
        switch (action.type) {
            case 'OPEN_APPLICATION': {
                const result = JSON.parse(await this.executeIntent('openApplication', { app: action.application }, context, originalRequest)) as {
                    type: string;
                    message: string;
                    application?: string;
                };
                if (result.type === 'APPLICATION_OPENED' || result.type === 'APPLICATION_ALREADY_RUNNING') {
                    this.lastApplication = result.application || action.application;
                }
                return JSON.stringify({ ...result, verified: result.type === 'APPLICATION_OPENED' || result.type === 'APPLICATION_ALREADY_RUNNING' });
            }
            case 'OPEN_FOLDER': {
                const folder = await resolveSafeFolder(action.folder);
                if (!folder) {
                    return this.actionResult(
                        'FOLDER_NOT_FOUND',
                        `I couldn't find an existing allowed folder matching “${action.folder}”. Use a known folder name or an exact existing folder path.`,
                        false,
                        { folder: action.folder }
                    );
                }
                context.onProgress?.(`OPENING ${folder.name.toUpperCase()}...`);
                const opened = await openExplorerFolder(folder.path);
                this.lastFolder = folder.path;
                this.lastApplication = 'File Explorer';
                const type = opened.verified ? 'ACTION_SUCCESS' : 'ACTION_UNVERIFIED';
                return this.actionResult(type, opened.message, opened.verified, { folder: folder.name, path: folder.path });
            }
            case 'FOCUS_APPLICATION': {
                const application = await resolveApplication(action.application);
                if (!application) {
                    return this.actionResult('APPLICATION_NOT_FOUND', `I couldn't find ${action.application} among the installed Windows applications.`, false);
                }
                context.onProgress?.(`WAITING FOR ${application.name.toUpperCase()}...`);
                if (!(await waitForApplication(application))) {
                    return this.actionResult('APPLICATION_NOT_READY', `${application.name} did not become ready within the bounded wait.`, false);
                }
                const focused = await focusApplicationWindow(application.processNames, application.name);
                if (focused.success && focused.verified) this.lastApplication = application.name;
                return this.actionResult(focused.verified ? 'ACTION_SUCCESS' : 'ACTION_FAILED', focused.message, focused.verified, { application: application.name });
            }
            case 'CLOSE_APPLICATION': {
                const application = await resolveApplication(action.application);
                if (!application) {
                    return this.actionResult('APPLICATION_NOT_FOUND', `I couldn't find ${action.application} among the installed Windows applications.`, false);
                }
                let closed: WindowOperationResult;
                if (application.processNames.includes('explorer.exe')) {
                    const foreground = await getForegroundWindow();
                    if (!foreground || foreground.processName.toLowerCase() !== 'explorer.exe') {
                        return this.actionResult('WINDOW_NOT_FOUND', 'File Explorer is not the foreground window, so no Explorer window was closed.', false);
                    }
                    closed = await closeForegroundWindow(foreground);
                } else {
                    closed = await closeApplicationWindows(application.processNames, application.name);
                }
                if (closed.success && closed.verified) {
                    if (this.lastApplication === application.name) this.lastApplication = undefined;
                    return this.actionResult('ACTION_SUCCESS', `Closed ${application.name}. ${closed.message}`, true, { application: application.name });
                }
                return this.actionResult(closed.success ? 'ACTION_UNVERIFIED' : 'ACTION_FAILED', closed.message, false, { application: application.name });
            }
            case 'CLOSE_FOREGROUND_WINDOW': {
                const refersToPrevious = /\b(?:it|this application|this app)\b/i.test(originalRequest) ||
                    (/\bfolder\b/i.test(originalRequest) && Boolean(this.lastFolder));
                if (refersToPrevious && this.lastApplication) {
                    const application = await resolveApplication(this.lastApplication);
                    if (application?.processNames.includes('explorer.exe')) {
                        const foreground = await getForegroundWindow();
                        if (foreground?.processName.toLowerCase() === 'explorer.exe') {
                            const closed = await closeForegroundWindow(foreground);
                            if (closed.verified) this.lastFolder = undefined;
                            return this.actionResult(closed.verified ? 'ACTION_SUCCESS' : 'ACTION_FAILED', closed.message, closed.verified);
                        }
                    } else if (application) {
                        const closed = await closeApplicationWindows(application.processNames, application.name);
                        if (closed.verified) this.lastApplication = undefined;
                        return this.actionResult(closed.verified ? 'ACTION_SUCCESS' : 'ACTION_FAILED', closed.message, closed.verified);
                    }
                    return this.actionResult('WINDOW_NOT_FOUND', `The previously targeted ${this.lastApplication} window is not available; no other window was closed.`, false);
                }
                const foreground = await getForegroundWindow();
                if (!foreground) return this.actionResult('WINDOW_NOT_FOUND', 'No foreground window is available to close.', false);
                const applications = await discoverInstalledApplications();
                const application = this.safeApplicationForWindow(foreground, applications);
                if (!application) {
                    return this.actionResult('ACTION_UNAVAILABLE', 'The foreground window is not an allowlisted user application. It was left open.', false);
                }
                const closed = await closeForegroundWindow(foreground);
                if (closed.verified && application.name === this.lastApplication) this.lastApplication = undefined;
                if (closed.verified && application.name === 'File Explorer') this.lastFolder = undefined;
                return this.actionResult(closed.verified ? 'ACTION_SUCCESS' : 'ACTION_FAILED', closed.message, closed.verified, { application: application.name });
            }
            case 'TYPE_TEXT': {
                const applications = await discoverInstalledApplications();
                let application = this.lastApplication
                    ? await resolveApplication(this.lastApplication)
                    : undefined;
                let foreground = await getForegroundWindow();
                if (!application && foreground) application = this.safeApplicationForWindow(foreground, applications);
                if (!application || !foreground) {
                    return this.actionResult('ACTION_UNAVAILABLE', 'No allowlisted foreground application is available for text input; no text was sent.', false);
                }
                if (application.processNames.some(name => [
                    'cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe',
                    'conhost.exe', 'openconsole.exe', 'explorer.exe'
                ].includes(name.toLowerCase()))) {
                    return this.actionResult('ACTION_UNAVAILABLE', 'Text input is blocked in command shells and File Explorer. No text was sent.', false);
                }
                if (this.lastApplication) {
                    const focus = await focusApplicationWindow(application.processNames, application.name);
                    if (!focus.verified) return this.actionResult('ACTION_FAILED', `Unable to focus ${application.name}: ${focus.message}`, false);
                } else if (!application.processNames.some(name => name.toLowerCase() === foreground?.processName.toLowerCase())) {
                    return this.actionResult('ACTION_UNAVAILABLE', 'The intended application is not the foreground window; no text was sent.', false);
                }
                foreground = await getForegroundWindow();
                if (!foreground || !application.processNames.some(name => name.toLowerCase() === foreground?.processName.toLowerCase())) {
                    return this.actionResult('ACTION_UNAVAILABLE', 'The target application is no longer the foreground window; no text was sent.', false);
                }
                const sent = await sendTextToForeground(action.text, application.processNames, application.name);
                return this.actionResult(
                    sent.verified ? 'ACTION_SUCCESS' : 'ACTION_UNVERIFIED',
                    sent.verified
                        ? `Text was sent to ${application.name}; its window remained in the foreground.`
                        : `Text was sent to ${application.name}, but the foreground state could not be verified.`,
                    sent.verified,
                    { application: application.name }
                );
            }
            case 'PRESS_KEY': {
                const foreground = await getForegroundWindow();
                if (!foreground) return this.actionResult('WINDOW_NOT_FOUND', 'No foreground window is available to receive the key.', false);
                if ([
                    'cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe',
                    'conhost.exe', 'openconsole.exe'
                ].includes(foreground.processName.toLowerCase())) {
                    return this.actionResult('ACTION_UNAVAILABLE', 'Keyboard input is blocked in command shells and terminals.', false);
                }
                const sent = await sendSafeKey(action.key, [foreground.processName]);
                return this.actionResult(
                    sent.verified ? 'ACTION_SUCCESS' : 'ACTION_UNVERIFIED',
                    sent.verified ? `Sent the allowlisted ${action.key.replaceAll('_', '+')} key to the foreground window.` : sent.message,
                    sent.verified
                );
            }
        }
    }

    private isSensitiveName(name: string): boolean {
        const normalized = name.toLowerCase();
        return normalized === '.env' ||
            normalized.startsWith('.env.') ||
            ['.npmrc', '.pypirc', '.netrc'].includes(normalized) ||
            /(?:secret|credential|password|token|private[_-]?key|api[_-]?key|access[_-]?key)/.test(normalized);
    }

    private async getProjectDirectory(project: string): Promise<{ projectPath?: string; error?: string }> {
        const projectName = project.trim().toLowerCase();
        const projectPath = this.allowedProjects[projectName];
        if (!projectPath) {
            return { error: `I don't have a configured path for the ${project || 'requested'} project.` };
        }

        try {
            const details = await fs.promises.stat(projectPath);
            if (!details.isDirectory()) {
                return { error: `Project directory is not a folder: ${projectPath}` };
            }
            return { projectPath };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                return { error: `${projectName.toUpperCase()} project directory was not found: ${projectPath}` };
            }
            const detail = error instanceof Error ? error.message : String(error);
            return { error: `Unable to access project directory ${projectPath}: ${detail}` };
        }
    }

    private resolveProjectPath(projectRoot: string, relativePath: string): string | null {
        if (path.isAbsolute(relativePath)) return null;
        const resolvedPath = path.resolve(projectRoot, relativePath);
        const relativeToRoot = path.relative(projectRoot, resolvedPath);
        if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
            return null;
        }
        return resolvedPath;
    }

    private filesystemResult(result: Record<string, unknown>): string {
        return JSON.stringify({ type: 'FILESYSTEM_RESULT', ...result });
    }

    private async listProjectFiles(project: string, relativePath: string): Promise<string> {
        const root = await this.getProjectDirectory(project);
        if (!root.projectPath) return this.filesystemResult({ success: false, message: root.error });

        const targetPath = this.resolveProjectPath(root.projectPath, relativePath);
        if (!targetPath) {
            return this.filesystemResult({ success: false, message: 'The requested folder must be inside the configured project directory.' });
        }

        try {
            const details = await fs.promises.stat(targetPath);
            if (!details.isDirectory()) {
                return this.filesystemResult({ success: false, message: `The requested project path is not a folder: ${relativePath}` });
            }
            const items = await fs.promises.readdir(targetPath, { withFileTypes: true });
            const entries = items
                .filter(item => !this.isSensitiveName(item.name) && (item.isDirectory() || item.isFile()))
                .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
                .slice(0, 50)
                .map(item => ({
                    name: item.name,
                    type: item.isDirectory() ? 'folder' : 'file',
                    path: path.posix.join(relativePath.split(path.sep).join('/'), item.name)
                }));
            return this.filesystemResult({
                success: true,
                project,
                relativePath: relativePath || '.',
                entries,
                truncated: items.filter(item => !this.isSensitiveName(item.name) && (item.isDirectory() || item.isFile())).length > entries.length,
                message: entries.length === 0
                    ? `No visible files or folders were found in ${relativePath || project}.`
                    : `Found ${entries.length} item${entries.length === 1 ? '' : 's'} in ${relativePath || project}.`
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return this.filesystemResult({ success: false, message: `Unable to list ${relativePath || project}: ${detail}` });
        }
    }

    private async findProjectFile(project: string, fileName: string): Promise<{ matches: Array<{ path: string }>; truncated: boolean; error?: string }> {
        const root = await this.getProjectDirectory(project);
        if (!root.projectPath) return { matches: [], truncated: false, error: root.error };
        if (!fileName || fileName !== path.basename(fileName) || this.isSensitiveName(fileName)) {
            return { matches: [], truncated: false, error: 'Search requires a non-sensitive file name, not a path.' };
        }

        const matches: Array<{ path: string }> = [];
        const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv']);
        const pending: Array<{ directory: string; depth: number }> = [{ directory: root.projectPath, depth: 0 }];
        const maxEntries = 10000;
        const maxDepth = 10;
        let inspected = 0;
        let truncated = false;

        try {
            while (pending.length > 0 && matches.length < 50) {
                const current = pending.pop()!;
                if (current.depth > maxDepth) {
                    truncated = true;
                    continue;
                }
                const entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
                for (const entry of entries) {
                    inspected += 1;
                    if (inspected > maxEntries) {
                        truncated = true;
                        pending.length = 0;
                        break;
                    }
                    if (this.isSensitiveName(entry.name)) continue;
                    if (entry.isDirectory()) {
                        if (!ignoredDirectories.has(entry.name.toLowerCase())) {
                            pending.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
                        }
                    } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
                        matches.push({ path: path.relative(root.projectPath, path.join(current.directory, entry.name)).split(path.sep).join('/') });
                        if (matches.length === 50) {
                            truncated = pending.length > 0 || entries.indexOf(entry) < entries.length - 1;
                            break;
                        }
                    }
                }
            }
            return { matches, truncated };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { matches, truncated, error: `Unable to search the ${project} project: ${detail}` };
        }
    }

    private formatSystemInfo(section: SystemInfoSection, info: Awaited<ReturnType<typeof getSystemInfo>>): string {
        const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
        switch (section) {
            case 'cpu':
                return `Current CPU usage is ${info.cpu.usagePercent}%.`;
            case 'ram':
                return `RAM: ${gigabytes(info.ram.usedBytes)} used of ${gigabytes(info.ram.totalBytes)} total; ${gigabytes(info.ram.availableBytes)} available (${info.ram.usagePercent}% used).`;
            case 'battery':
                return info.battery.hasBattery
                    ? `Battery level is ${info.battery.percent}%.${info.battery.isCharging ? ' The device is charging.' : ''}`
                    : 'No battery information is available on this device.';
            case 'storage':
                return `Storage: ${gigabytes(info.storage.usedBytes)} used of ${gigabytes(info.storage.totalBytes)} total; ${gigabytes(info.storage.freeBytes)} free (${info.storage.usagePercent}% used).`;
            case 'os':
                return `Operating system: ${info.os.distro} (${info.os.platform} ${info.os.release}, ${info.os.architecture}).`;
            case 'all':
                return [
                    `CPU: ${info.cpu.usagePercent}% used.`,
                    `RAM: ${gigabytes(info.ram.usedBytes)} used of ${gigabytes(info.ram.totalBytes)} total; ${gigabytes(info.ram.availableBytes)} available (${info.ram.usagePercent}% used).`,
                    info.battery.hasBattery
                        ? `Battery: ${info.battery.percent}%${info.battery.isCharging ? ', charging' : ''}.`
                        : 'Battery: no battery information is available on this device.',
                    `Storage: ${gigabytes(info.storage.usedBytes)} used of ${gigabytes(info.storage.totalBytes)} total; ${gigabytes(info.storage.freeBytes)} free (${info.storage.usagePercent}% used).`,
                    `OS: ${info.os.distro} (${info.os.platform} ${info.os.release}, ${info.os.architecture}).`
                ].join('\n');
        }
    }

    async openVerifiedProjectInVSCode(
        projectPath: string,
        context: ToolContext
    ): Promise<{
        type: 'VS_CODE_OPENED' | 'VS_CODE_OPEN_FAILED';
        verified: boolean;
        message: string;
        application?: string;
        projectPath?: string;
        workspacePath?: string;
        workspaceTrustStatus?: WorkspaceTrustStatus;
        states?: string[];
    }> {
        if (!context.permissionEngine.checkPermission({
            name: 'openProjectInVSCode',
            level: PermissionLevel.LOW_RISK,
            description: 'Open a newly created, registered project folder in registered Visual Studio Code'
        })) {
            return { type: 'VS_CODE_OPEN_FAILED', verified: false, message: 'Permission denied to open the project in VS Code.' };
        }
        context.onProgress?.('RESOLVING REGISTERED VISUAL STUDIO CODE...');
        let application;
        try {
            application = await resolveApplication('Visual Studio Code');
        } catch (error) {
            return {
                type: 'VS_CODE_OPEN_FAILED',
                verified: false,
                message: `Unable to resolve registered Visual Studio Code: ${error instanceof Error ? error.message : String(error)}`
            };
        }
        if (!application) {
            return {
                type: 'VS_CODE_OPEN_FAILED',
                verified: false,
                message: 'Visual Studio Code was not found among registered Windows applications.'
            };
        }

        let canonicalPath: string;
        try {
            const absolutePath = path.resolve(projectPath);
            canonicalPath = await fs.promises.realpath(absolutePath);
            const details = await fs.promises.stat(canonicalPath);
            if (!details.isDirectory() || canonicalPath.toLocaleLowerCase() !== absolutePath.toLocaleLowerCase()) {
                throw new Error('The registered project directory could not be verified as a local directory.');
            }
        } catch (error) {
            return {
                type: 'VS_CODE_OPEN_FAILED',
                verified: false,
                message: `Unable to verify the created project directory before opening VS Code: ${error instanceof Error ? error.message : String(error)}`
            };
        }

        try {
            context.onProgress?.('VERIFYING VISUAL STUDIO CODE PROCESS...');
            const running = application.processNames.length > 0 && await isApplicationRunning(application);
            if (!running) {
                context.onProgress?.('LAUNCHING REGISTERED VISUAL STUDIO CODE...');
                const launchDetail = await launchRegisteredApplication(application);
                context.onProgress?.('VERIFYING VISUAL STUDIO CODE PROCESS...');
                if (!(await waitForApplication(application))) {
                    throw new Error(launchDetail
                        ? `The registered application launch did not produce a verified Code.exe process: ${launchDetail}`
                        : 'The registered application launch did not produce a verified Code.exe process.');
                }
            }

            const codeProcessName = application.processNames
                .map(processName => path.basename(processName))
                .find(processName => processName.toLowerCase() === 'code.exe');
            if (!codeProcessName) {
                throw new Error('The registered Visual Studio Code application does not identify Code.exe for verification.');
            }
            const processName = path.basename(codeProcessName, '.exe');
            const script = `$ErrorActionPreference = 'Stop'; $process = Get-Process -Name '${processName}' -ErrorAction Stop | Where-Object { $_.Path -and [System.IO.Path]::GetFileName($_.Path) -ieq 'Code.exe' } | Select-Object -First 1 -ExpandProperty Path; if (-not $process) { throw 'The verified Code.exe executable path could not be resolved.' }; [Console]::Out.Write($process)`;
            const executablePath = await new Promise<string>((resolve, reject) => {
                execFile(
                    'powershell.exe',
                    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
                    { windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 },
                    (error, stdout, stderr) => {
                        if (error) {
                            reject(new Error(stderr.trim() || `Unable to resolve the running registered VS Code executable: ${error.message}`));
                            return;
                        }
                        resolve(stdout.trim());
                    }
                );
            });
            if (!path.isAbsolute(executablePath) || path.basename(executablePath).toLowerCase() !== 'code.exe') {
                throw new Error('Windows returned an invalid executable path for the registered VS Code process.');
            }

            context.onProgress?.('OPENING CREATED PROJECT FOLDER IN VISUAL STUDIO CODE...');
            await new Promise<void>((resolve, reject) => {
                execFile(executablePath, vscodeWorkspaceArguments(canonicalPath), { windowsHide: true, timeout: 15000 }, (error, _stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr.trim() || `Unable to open the project with the registered VS Code command: ${error.message}`));
                        return;
                    }
                    resolve();
                });
            });

            context.onProgress?.('VERIFYING VISUAL STUDIO CODE WINDOW...');
            if (!(await isApplicationRunning(application))) {
                throw new Error('Code.exe was not detected after requesting the created project folder.');
            }
            const focused = await focusApplicationWindow(application.processNames, application.name);
            if (!focused.verified) {
                throw new Error(`The VS Code project window could not be verified: ${focused.message}`);
            }
            context.onProgress?.('VERIFYING THE OPEN VISUAL STUDIO CODE WORKSPACE...');
            const storageRoot = process.env.APPDATA
                ? path.join(process.env.APPDATA, 'Code', 'User', 'workspaceStorage')
                : '';
            if (!storageRoot) {
                throw new Error('The Visual Studio Code user-data directory could not be resolved to verify the open workspace.');
            }
            const deadline = Date.now() + 10_000;
            let workspaceVerified = false;
            while (Date.now() < deadline && !workspaceVerified) {
                const storageEntries = await fs.promises.readdir(storageRoot, { withFileTypes: true });
                for (const entry of storageEntries) {
                    if (!entry.isDirectory()) continue;
                    const metadataPath = path.join(storageRoot, entry.name, 'workspace.json');
                    let metadata: { folder?: unknown };
                    try {
                        metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8')) as { folder?: unknown };
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) continue;
                        throw error;
                    }
                    if (typeof metadata.folder !== 'string') continue;
                    try {
                        const storedPath = fileURLToPath(new URL(metadata.folder));
                        if (path.resolve(storedPath).toLocaleLowerCase() === canonicalPath.toLocaleLowerCase()) {
                            workspaceVerified = true;
                            break;
                        }
                    } catch {
                        continue;
                    }
                }
                if (!workspaceVerified) await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (!workspaceVerified) {
                throw new Error(`VS Code did not register the exact requested workspace folder: ${canonicalPath}`);
            }
            const workspaceTrustStatus = context.workspaceTrustBridge
                ? await context.workspaceTrustBridge.waitForStatusForPath(canonicalPath, 5_000)
                : 'UNAVAILABLE';
            const trustRequired = workspaceTrustStatus === 'RESTRICTED';
            const trustMessage = trustRequired
                ? 'Project opened in VS Code, but VS Code requires workspace trust for full features.'
                : workspaceTrustStatus === 'TRUSTED'
                    ? `The exact project workspace is verified and trusted in ${application.name}.`
                    : `The exact project workspace is verified in ${application.name}, but its trust state is unavailable because the CLIRO trust companion did not report it.`;
            return {
                type: 'VS_CODE_OPENED',
                verified: true,
                message: trustMessage,
                application: application.name,
                projectPath: canonicalPath,
                workspacePath: canonicalPath,
                workspaceTrustStatus,
                states: [
                    'VS_CODE_OPENED',
                    'WORKSPACE_VERIFIED',
                    ...(trustRequired
                        ? ['WORKSPACE_TRUST_REQUIRED']
                        : workspaceTrustStatus === 'TRUSTED'
                            ? ['WORKSPACE_TRUSTED']
                            : ['WORKSPACE_TRUST_UNAVAILABLE'])
                ]
            };
        } catch (error) {
            return {
                type: 'VS_CODE_OPEN_FAILED',
                verified: false,
                message: `Project creation succeeded, but VS Code could not be verified for the created project: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    async executeIntent(intent: string, payload: any, context: ToolContext, originalRequest: string): Promise<string> {
        switch (intent) {
            case 'executeComputerActionPlan':
                return this.executeComputerActionPlan(payload.actions, context, originalRequest);
            case 'unsupportedComputerAction':
                return this.actionResult(
                    'UNSUPPORTED_ACTION',
                    typeof payload.message === 'string' ? payload.message : 'This computer action is not supported safely.',
                    false
                );

            case 'listInstalledApplications': {
                if (!context.permissionEngine.checkPermission({
                    name: 'listInstalledApplications',
                    level: PermissionLevel.SAFE_READ,
                    description: 'Discover applications registered in the Windows Start Menu'
                })) {
                    throw new Error('Permission denied to discover installed applications.');
                }

                const applications = await discoverInstalledApplications();
                this.audit(originalRequest, 'listInstalledApplications', PermissionLevel.SAFE_READ, 'APPROVED', `DISCOVERED:${applications.length}`, context, true);
                const visibleApplications = applications.slice(0, 100).map(application => application.name);
                return JSON.stringify({
                    type: 'APPLICATION_LIST',
                    count: applications.length,
                    applications: visibleApplications,
                    truncated: applications.length > visibleApplications.length,
                    message: `Found ${applications.length} applications registered in the Windows Start Menu.`
                });
            }

            case 'checkApplicationStatus': {
                if (!context.permissionEngine.checkPermission({
                    name: 'checkApplicationStatus',
                    level: PermissionLevel.SAFE_READ,
                    description: 'Check whether a registered Windows application is running'
                })) {
                    throw new Error('Permission denied to check application status.');
                }

                const requestedName = String(payload.app || '');
                const application = await resolveApplication(requestedName);
                if (!application) {
                    this.audit(originalRequest, 'checkApplicationStatus', PermissionLevel.SAFE_READ, 'APPROVED', 'APPLICATION_NOT_FOUND', context, true);
                    return JSON.stringify({
                        type: 'APPLICATION_NOT_FOUND',
                        application: requestedName,
                        message: `I couldn't find ${requestedName || 'that application'} among the installed Windows applications.`
                    });
                }

                const running = application.processNames.length > 0
                    ? await isApplicationRunning(application)
                    : null;
                const message = running === null
                    ? `Windows lists ${application.name}, but its running process could not be identified.`
                    : running
                        ? `${application.name} is currently running.`
                        : `${application.name} is not currently running.`;
                this.audit(originalRequest, 'checkApplicationStatus', PermissionLevel.SAFE_READ, 'APPROVED', running === null ? 'UNVERIFIABLE' : running ? 'RUNNING' : 'NOT_RUNNING', context, running !== null);
                return JSON.stringify({
                    type: 'APPLICATION_STATUS',
                    application: application.name,
                    running,
                    message
                });
            }

            case 'openApplication': {
                const requestedName = String(payload.app || '');
                if (!context.permissionEngine.checkPermission({
                    name: 'openApplication',
                    level: PermissionLevel.LOW_RISK,
                    description: `Open an installed Windows application by its registered Start Menu entry`
                })) {
                    return JSON.stringify({
                        type: 'APPLICATION_FAILED',
                        application: requestedName,
                        message: `Permission denied to open ${requestedName || 'the requested application'}.`
                    });
                }

                context.onProgress?.('RESOLVING APPLICATION...');
                let application;
                try {
                    application = await resolveApplication(requestedName);
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'FAILED', 'DISCOVERY_FAILED', context, false);
                    return JSON.stringify({
                        type: 'APPLICATION_FAILED',
                        application: requestedName,
                        message: `Unable to discover installed applications: ${detail}`
                    });
                }

                if (!application) {
                    this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'APPROVED', 'APPLICATION_NOT_FOUND', context, false);
                    return JSON.stringify({
                        type: 'APPLICATION_NOT_FOUND',
                        application: requestedName,
                        message: `I couldn't find ${requestedName || 'that application'} among the installed Windows applications.`
                    });
                }

                try {
                    if (application.processNames.length > 0 && await isApplicationRunning(application)) {
                        const focused = await focusApplicationWindow(application.processNames, application.name);
                        if (focused.verified) {
                            this.lastApplication = application.name;
                            this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'APPROVED', 'ALREADY_RUNNING_AND_FOCUSED', context, true);
                            return JSON.stringify({
                                type: 'APPLICATION_ALREADY_RUNNING',
                                application: application.name,
                                message: `${application.name} is already running and its window is focused.`
                            });
                        }
                        if (focused.windowFound) {
                            this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'FAILED', 'FOCUS_VERIFICATION_FAILED', context, false);
                            return JSON.stringify({
                                type: 'APPLICATION_FAILED',
                                application: application.name,
                                message: `${application.name} is running, but Windows did not verify its window focus: ${focused.message}`
                            });
                        }
                    }
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'FAILED', 'PROCESS_CHECK_FAILED', context, false);
                    return JSON.stringify({
                        type: 'APPLICATION_FAILED',
                        application: application.name,
                        message: `Unable to check whether ${application.name} is running: ${detail}`
                    });
                }

                try {
                    context.onProgress?.('OPENING APPLICATION...');
                    const launcherError = await launchRegisteredApplication(application);
                    context.onProgress?.('VERIFYING APPLICATION...');
                    if (await waitForApplication(application)) {
                        const focused = await focusApplicationWindow(application.processNames, application.name);
                        if (!focused.verified) {
                            const message = focused.windowFound
                                ? `${application.name} is running, but Windows did not verify its window focus: ${focused.message}`
                                : `${application.name} started, but no visible application window appeared: ${focused.message}`;
                            this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'FAILED', 'WINDOW_VERIFICATION_FAILED', context, false);
                            return JSON.stringify({
                                type: 'APPLICATION_FAILED',
                                application: application.name,
                                message
                            });
                        }
                        this.lastApplication = application.name;
                        this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'APPROVED', 'OPENED_AND_VERIFIED', context, true);
                        return JSON.stringify({
                            type: 'APPLICATION_OPENED',
                            application: application.name,
                            message: `${application.name} opened successfully and its window is focused.`
                        });
                    }

                    const verificationMessage = application.processNames.length === 0
                        ? `Windows accepted the launch request for ${application.name}, but its process could not be identified for verification.`
                        : `${application.name} was launched, but its process was not detected within 6 seconds.`;
                    const message = launcherError
                        ? `${verificationMessage} ${launcherError}`
                        : verificationMessage;
                    this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'FAILED', 'VERIFICATION_FAILED', context, false);
                    return JSON.stringify({
                        type: 'APPLICATION_FAILED',
                        application: application.name,
                        message
                    });
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    this.audit(originalRequest, 'openApplication', PermissionLevel.LOW_RISK, 'FAILED', 'LAUNCH_OR_VERIFICATION_FAILED', context, false);
                    return JSON.stringify({
                        type: 'APPLICATION_FAILED',
                        application: application.name,
                        message: `Unable to open ${application.name}: ${detail}`
                    });
                }
            }

            case 'closeChromeTabs': {
                const level = PermissionLevel.APPROVAL_REQUIRED;
                if (!context.permissionEngine.checkPermission({
                    name: 'closeChromeTabs',
                    level,
                    description: 'Close Chrome tabs through the existing local Chrome DevTools endpoint',
                    approvalGranted: context.approvalGranted
                })) {
                    const result = {
                        type: 'ACTION_APPROVAL_REQUIRED',
                        message: 'Closing all Chrome tabs requires explicit user approval. No tabs were closed.',
                        verified: false
                    };
                    this.audit(originalRequest, 'closeChromeTabs', level, 'APPROVAL_REQUIRED', result.type, context, false);
                    return JSON.stringify(result);
                }

                const result = await controlChromeTabs('closeAllTabs');
                this.audit(originalRequest, 'closeChromeTabs', level, result.type, result.message, context, result.verified);
                return JSON.stringify(result);
            }

            case 'switchChromeTab': {
                const action = payload.direction === 'previous' ? 'previousTab' : 'nextTab';
                const level = PermissionLevel.LOW_RISK;
                if (!context.permissionEngine.checkPermission({
                    name: 'switchChromeTab',
                    level,
                    description: 'Activate an adjacent Chrome tab using the local Chrome DevTools endpoint'
                })) {
                    const result = {
                        type: 'ACTION_FAILED',
                        message: 'Permission denied to switch Chrome tabs.',
                        verified: false
                    };
                    this.audit(originalRequest, 'switchChromeTab', level, result.type, result.message, context, false);
                    return JSON.stringify(result);
                }

                const result = await controlChromeTabs(action as ChromeTabAction);
                this.audit(originalRequest, 'switchChromeTab', level, result.type, result.message, context, result.verified);
                return JSON.stringify(result);
            }

            case 'closeOpenApplications': {
                const level = PermissionLevel.APPROVAL_REQUIRED;
                if (!context.permissionEngine.checkPermission({
                    name: 'closeOpenApplications',
                    level,
                    description: 'Gracefully close visible user application windows without force-killing processes',
                    approvalGranted: context.approvalGranted
                })) {
                    const result = {
                        type: 'ACTION_APPROVAL_REQUIRED',
                        message: 'Closing open applications requires explicit user approval. No applications were closed.',
                        verified: false
                    };
                    this.audit(originalRequest, 'closeOpenApplications', level, 'APPROVAL_REQUIRED', result.type, context, false);
                    return JSON.stringify(result);
                }

                try {
                    const result = await closeVisibleUserApplications();
                    this.audit(originalRequest, 'closeOpenApplications', level, result.type, result.message, context, result.verified);
                    return JSON.stringify(result);
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    const result = {
                        type: 'ACTION_FAILED',
                        message: `Unable to close user application windows safely: ${detail}`,
                        verified: false
                    };
                    this.audit(originalRequest, 'closeOpenApplications', level, result.type, result.message, context, false);
                    return JSON.stringify(result);
                }
            }

            case 'getSystemStatus':
                const sysStatus = await getSystemStatus();
                this.audit(originalRequest, 'getSystemStatus', PermissionLevel.SAFE_READ, 'APPROVED', 'SUCCESS', context, true);
                
                const lowerReq = originalRequest.toLowerCase();
                if (lowerReq.includes('battery')) {
                    return `Your current battery level is ${sysStatus.battery.percent}%${sysStatus.battery.isCharging ? ' and it is charging.' : '.'}`;
                } else if (lowerReq.includes('os') || lowerReq.includes('operating system') || lowerReq.includes('windows')) {
                    return `You're running ${sysStatus.os}.`;
                } else if (lowerReq.includes('cpu')) {
                    return `Your current CPU usage is ${sysStatus.cpu}.`;
                } else if (lowerReq.includes('ram') || lowerReq.includes('memory')) {
                    return `You are using ${sysStatus.ram} of memory.`;
                } else if (lowerReq.includes('storage') || lowerReq.includes('disk')) {
                    return `Your main storage is ${sysStatus.storage}.`;
                }
                
                return `System Status: CPU is at ${sysStatus.cpu}, RAM is ${sysStatus.ram}, Storage is ${sysStatus.storage}, OS is ${sysStatus.os}, and Battery is ${sysStatus.battery.percent}%.`;

            case 'getSystemInfo': {
                const section = (payload.section || 'all') as SystemInfoSection;
                if (!context.permissionEngine.checkPermission({ name: 'getSystemInfo', level: PermissionLevel.SAFE_READ, description: `Read system ${section} information` })) {
                    throw new Error('Permission denied to read system information.');
                }

                try {
                    const info = await getSystemInfo();
                    const message = this.formatSystemInfo(section, info);
                    this.audit(originalRequest, 'getSystemInfo', PermissionLevel.SAFE_READ, 'APPROVED', `SUCCESS:${section}`, context, true);
                    const data = section === 'all' ? info : { [section]: info[section] };
                    return JSON.stringify({ type: 'SYSTEM_INFO', section, message, data });
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    this.audit(originalRequest, 'getSystemInfo', PermissionLevel.SAFE_READ, 'APPROVED', `FAILED:${section}`, context, false);
                    throw new Error(detail);
                }
            }

            case 'checkProjectExists': {
                if (!context.permissionEngine.checkPermission({ name: 'checkProjectExists', level: PermissionLevel.SAFE_READ, description: 'Check whether a configured project directory exists' })) {
                    return this.filesystemResult({ success: false, message: 'Permission denied to check the project directory.' });
                }
                const root = await this.getProjectDirectory(payload.project || '');
                const exists = Boolean(root.projectPath);
                this.audit(originalRequest, 'checkProjectExists', PermissionLevel.SAFE_READ, 'APPROVED', exists ? 'EXISTS' : 'NOT_FOUND', context, true);
                return this.filesystemResult({
                    success: exists,
                    project: payload.project,
                    exists,
                    message: root.error || `${String(payload.project).toUpperCase()} project directory is present.`
                });
            }

            case 'listProjectFiles': {
                if (!context.permissionEngine.checkPermission({ name: 'listProjectFiles', level: PermissionLevel.SAFE_READ, description: 'List visible files in a configured project folder' })) {
                    return this.filesystemResult({ success: false, message: 'Permission denied to list project files.' });
                }
                const result = await this.listProjectFiles(payload.project || '', payload.relativePath || '');
                const parsed = JSON.parse(result);
                this.audit(originalRequest, 'listProjectFiles', PermissionLevel.SAFE_READ, 'APPROVED', parsed.success ? 'SUCCESS' : 'FAILED', context, parsed.success);
                return result;
            }

            case 'findProjectFile': {
                if (!context.permissionEngine.checkPermission({ name: 'findProjectFile', level: PermissionLevel.SAFE_READ, description: 'Search for a file by name within a configured project' })) {
                    return this.filesystemResult({ success: false, message: 'Permission denied to search project files.' });
                }
                const result = await this.findProjectFile(payload.project || '', payload.fileName || '');
                const message = result.error
                    ? result.error
                    : result.matches.length > 0
                        ? payload.checkOnly
                            ? `${payload.fileName} is present in the ${payload.project} project.`
                            : `Found ${payload.fileName}: ${result.matches.map(match => match.path).join(', ')}${result.truncated ? ' (results limited).' : ''}`
                        : `No matching file named ${payload.fileName} was found in the ${payload.project} project.`;
                this.audit(originalRequest, 'findProjectFile', PermissionLevel.SAFE_READ, 'APPROVED', result.error ? 'FAILED' : result.matches.length ? 'FOUND' : 'NOT_FOUND', context, !result.error);
                return this.filesystemResult({ success: !result.error, project: payload.project, fileName: payload.fileName, matches: result.matches, truncated: result.truncated, message });
            }
            
            case 'openProject': {
                const projName = String(payload.project || '').toLowerCase();
                if (!context.permissionEngine.checkPermission({ name: 'openProject', level: PermissionLevel.LOW_RISK, description: 'Open a registered project in VS Code' })) {
                    return this.getActionFailure(`Permission denied to open project ${projName || 'requested project'}.`);
                }
                const project = await this.getProjectDirectory(projName);
                if (!project.projectPath) {
                    this.audit(originalRequest, 'openProject', PermissionLevel.LOW_RISK, 'APPROVED', 'PROJECT_NOT_AVAILABLE', context, false);
                    return this.getActionFailure(project.error || `I don't have a configured path for the ${projName} project.`);
                }

                this.audit(originalRequest, 'openProject', PermissionLevel.LOW_RISK, 'APPROVED', 'EXECUTING', context, false);
                try {
                    await new Promise<void>((resolve, reject) => {
                        exec(`code "${project.projectPath}"`, { windowsHide: true }, (error, _stdout, stderr) => {
                            if (error) {
                                reject(new Error(stderr.trim() || error.message));
                                return;
                            }
                            resolve();
                        });
                    });
                    if (!(await this.isProcessRunning('Code.exe'))) {
                        throw new Error('VS Code was not detected after the project open command completed.');
                    }
                    this.audit(originalRequest, 'openProject', PermissionLevel.LOW_RISK, 'APPROVED', 'SUCCESS', context, true);
                    return JSON.stringify({ type: 'ACTION_SUCCESS', message: `Opened the ${projName.toUpperCase()} project in VS Code.` });
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    this.audit(originalRequest, 'openProject', PermissionLevel.LOW_RISK, 'APPROVED', 'FAILED', context, false);
                    return this.getActionFailure(`Unable to open the ${projName.toUpperCase()} project in VS Code: ${detail}`);
                }
            }
            
            case 'analyzeCode': {
                const project = String(payload.project || 'cliro');
                if (!context.permissionEngine.checkPermission({
                    name: 'analyzeCode',
                    level: PermissionLevel.SAFE_READ,
                    description: 'Read and statically analyze configured project source files'
                })) {
                    this.audit(originalRequest, 'analyzeCode', PermissionLevel.SAFE_READ, 'DENIED', 'NOT_EXECUTED', context, false);
                    return JSON.stringify(this.codeAnalysisFailure(project, 'permission was denied.'));
                }

                const root = await this.getProjectDirectory(project);
                if (!root.projectPath) {
                    this.audit(originalRequest, 'analyzeCode', PermissionLevel.SAFE_READ, 'FAILED', 'PROJECT_UNAVAILABLE', context, false);
                    return JSON.stringify(this.codeAnalysisFailure(project, root.error || 'the configured project directory is unavailable.'));
                }

                try {
                    const result = await analyzeProjectCode(project, root.projectPath);
                    this.audit(originalRequest, 'analyzeCode', PermissionLevel.SAFE_READ, 'APPROVED', `SCANNED:${result.filesScanned.length};ERRORS:${result.errors.length}`, context, true);
                    return JSON.stringify(result);
                } catch (error) {
                    const detail = error instanceof Error ? error.message : 'an unexpected analysis error occurred.';
                    const safeDetail = detail
                        .replace(new RegExp(root.projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), project)
                        .replace(/[\r\n]+/g, ' ')
                        .slice(0, 500);
                    this.audit(originalRequest, 'analyzeCode', PermissionLevel.SAFE_READ, 'FAILED', 'ANALYSIS_ERROR', context, false);
                    return JSON.stringify(this.codeAnalysisFailure(project, safeDetail));
                }
            }

            case 'proposeCodeChange':
                this.audit(originalRequest, 'proposeCodeChange', PermissionLevel.APPROVAL_REQUIRED, 'WAITING_APPROVAL', 'PENDING', context, false);
                return JSON.stringify({
                    type: 'APPROVAL_REQUEST',
                    action: `Modify ${payload.file}`,
                    reason: 'Missing validation detected.',
                    risk: 'MEDIUM',
                    diff: `--- a/src/login.ts\n+++ b/src/login.ts\n@@ -10,2 +10,4 @@\n-    login(user, pass);\n+    if(!user || !pass) throw new Error("Missing credentials");\n+    login(user, pass);`
                });

            case 'applyCodeChange':
                this.audit(originalRequest, 'applyCodeChange', PermissionLevel.APPROVAL_REQUIRED, 'NOT_IMPLEMENTED', 'NO_CHANGE_APPLIED', context, false);
                return `Applying code changes is not implemented yet. No files were modified.`;

            default:
                return `Unknown tool intent: ${intent}`;
        }
    }
}
