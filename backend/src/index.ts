import express from 'express';
import cors from 'cors';
import { OllamaProvider } from './ai/OllamaProvider';
import { OpenAIProvider } from './ai/OpenAIProvider';
import { selectLanguageProvider } from './ai/ProviderRouter';
import { getSystemStatus } from './system/systemTools';
import { ActionSource, DetectedGesture, ToolRegistry } from './tools/ToolRegistry';
import { PermissionEngine, PermissionLevel } from './permissions/PermissionEngine';
import { classifyQuery } from './ai/QueryRouter';
import { understandCommand } from './ai/MultilingualIntent';
import { verifyCurrentFact } from './ai/CurrentFactService';
import { WikipediaFactsProvider } from './ai/VerifiedFactsProvider';
import { ProjectWorkspace, ProjectWorkspaceError, ProjectCreationStage, ProjectTemplate, isProjectTemplate } from './projects/ProjectWorkspace';
import { ProjectCreationApprovalStore } from './projects/ProjectCreationApproval';
import { ProjectExecutionEngine, ExecutionEvent } from './projects/ProjectExecutionEngine';
import { WorkspaceTrustBridge } from './projects/WorkspaceTrustBridge';
import { parseProjectCreationCommand } from './projects/ProjectCommand';
import { planProjectIdea, ProjectBlueprint } from './projects/ProjectPlanner';
import { ChromeTabGestureAuthorization, chromeTabGestureActions } from './tools/ChromeTabGestureAuthorization';
import { planComputerAction } from './tools/ComputerActionPlanner';
import { createImageGenerationProvider, ImageGenerationError } from './ai/ImageGenerationProvider';
import { ImageGenerationService } from './ai/ImageGenerationService';
import { ProjectModificationEngine, ProjectModificationError } from './projects/ProjectModificationEngine';
import { ProjectModificationLanguageModel } from './projects/ProjectModificationLanguageModel';
import { loadBackendEnvironment } from './config/BackendEnvironment';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

loadBackendEnvironment(path.resolve(__dirname, '..'));

const app = express();
const port = 3001;

app.use(cors({
    origin(origin, callback) {
        if (!origin || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error('CORS origin is not allowed.'));
    }
}));
app.use(express.json());

const aiProvider = new OllamaProvider();
const openAIProvider = new OpenAIProvider();
const verifiedFactsProvider = new WikipediaFactsProvider();
const permissionEngine = new PermissionEngine();
const toolRegistry = new ToolRegistry();
const projectWorkspace = new ProjectWorkspace();
const workspaceTrustBridge = new WorkspaceTrustBridge(projectWorkspace);
const projectCreationApprovals = new ProjectCreationApprovalStore();
const projectExecutionEngine = new ProjectExecutionEngine(projectWorkspace, permissionEngine, toolRegistry, workspaceTrustBridge);
const imageGenerationProvider = createImageGenerationProvider();
const imageGenerationService = new ImageGenerationService(projectWorkspace, imageGenerationProvider);
const projectModificationEngine = new ProjectModificationEngine(
    projectWorkspace,
    new ProjectModificationLanguageModel(aiProvider, openAIProvider)
);
const chromeTabGestureAuthorizations = new ChromeTabGestureAuthorization();

type ActivityStage =
    | 'REQUEST_RECEIVED'
    | 'QUERY_CLASSIFICATION'
    | 'PROVIDER_SELECTION'
    | 'PERMISSION_CHECK'
    | 'SOURCE_SEARCH'
    | 'SOURCE_VERIFICATION'
    | ProjectCreationStage
    | 'APPLICATION_RESOLUTION'
    | 'APPLICATION_LAUNCH'
    | 'APPLICATION_VERIFICATION'
    | 'VS_CODE_OPENING'
    | 'VS_CODE_VERIFICATION'
    | 'PROJECT_PLANNING'
    | 'IMAGE_GENERATION_APPROVAL'
    | 'IMAGE_GENERATION'
    | 'IMAGE_VERIFICATION'
    | 'PROJECT_MODIFICATION_PLANNING'
    | 'PROJECT_MODIFICATION_APPROVAL'
    | 'PROJECT_MODIFICATION_APPLY'
    | 'PROJECT_MODIFICATION_VERIFICATION'
    | 'DEPENDENCIES_APPROVAL_REQUIRED'
    | 'REPAIR_APPROVAL_REQUIRED'
    | 'INSTALLING_DEPENDENCIES'
    | 'DEPENDENCIES_VERIFIED'
    | 'BUILDING'
    | 'BUILD_VERIFIED'
    | 'BUILD_FAILED'
    | 'TESTING'
    | 'TEST_VERIFIED'
    | 'STARTING'
    | 'RUNNING'
    | 'RUN_VERIFIED'
    | 'DIAGNOSING'
    | 'FIXING'
    | 'REBUILDING'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'VS_CODE_OPENING'
    | 'VS_CODE_VERIFICATION'
    | 'OPENAI_REQUEST'
    | 'OLLAMA_REQUEST'
    | 'RESPONSE_PROCESSING'
    | 'RESPONSE_READY'
    | 'FAILED';
type ActivityStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REQUIRES_APPROVAL';
interface ActivityEvent {
    stage: ActivityStage;
    status: ActivityStatus;
    message: string;
    at: string;
    requestId: string;
    projectId?: string;
    actionId: string;
    provider?: string;
    timestamp?: string;
    verification?: boolean | null;
}

function selectedLanguageProvider(requested?: unknown): 'OPENAI' | 'OLLAMA' {
    return selectLanguageProvider(requested, openAIProvider.configured, process.env.CLIRO_AI_PROVIDER || 'OLLAMA');
}

function projectTemplate(value: unknown): ProjectTemplate {
    return isProjectTemplate(value) ? value : 'basic';
}

app.get('/api/status', async (req, res) => {
    res.json({
        status: 'online',
        system: await getSystemStatus()
    });

    app.get('/api/projects/executions/:executionId', (req, res) => {
        if (!permissionEngine.checkPermission({
            name: 'readProjectExecutionStatus',
            level: PermissionLevel.SAFE_READ,
            description: 'Read the status of a CLIRO-owned project execution'
        })) return res.status(403).json({ error: 'Permission denied to read execution status.' });
        try {
            return res.json({ execution: projectExecutionEngine.get(req.params.executionId) });
        } catch (error) {
            return res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/projects/executions/:executionId/events', (req, res) => {
        if (!permissionEngine.checkPermission({
            name: 'readProjectExecutionEvents',
            level: PermissionLevel.SAFE_READ,
            description: 'Subscribe to real activity from a CLIRO-owned project execution'
        })) return res.status(403).json({ error: 'Permission denied to subscribe to execution events.' });
        try {
            const executionId = typeof req.params.executionId === 'string'
                ? req.params.executionId
                : req.params.executionId[0];
            projectExecutionEngine.get(executionId);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.write(': connected\n\n');
            const unsubscribe = projectExecutionEngine.subscribe(executionId, event => {
                if (res.writableEnded) return;
                res.write(`data: ${JSON.stringify({ activity: {
                    stage: event.stage,
                    status: event.status,
                    message: event.message,
                    at: event.timestamp,
                    timestamp: event.timestamp,
                    requestId: event.requestId,
                    projectId: event.projectId,
                    actionId: event.actionId,
                    verification: event.verification
                } })}\n\n`);
            });
            req.on('close', unsubscribe);
        } catch (error) {
            return res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.post('/api/projects/executions/:executionId/approval', async (req, res) => {
        const approve = req.body?.approve === true;
        const streaming = req.query.stream === 'true';
        const sendActivity = (event: ExecutionEvent) => {
            if (streaming) res.write(`data: ${JSON.stringify({ activity: {
                stage: event.stage,
                status: event.status,
                message: event.message,
                at: event.timestamp,
                timestamp: event.timestamp,
                requestId: event.requestId,
                projectId: event.projectId,
                actionId: event.actionId,
                verification: event.verification
            } })}\n\n`);
        };
        if (streaming) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
        }
        try {
            const execution = await projectExecutionEngine.decideApproval(
                req.params.executionId,
                req.body?.approvalRequestId,
                approve,
                sendActivity
            );
            if (streaming) {
                res.write(`data: ${JSON.stringify({ result: { executionResult: execution } })}\n\n`);
                res.write('data: [DONE]\n\n');
                return res.end();
            }
            return res.json({ executionResult: execution });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (streaming) {
                res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
                res.write('data: [DONE]\n\n');
                return res.end();
            }
            return res.status(409).json({ error: message });
        }
    });

    const stopProjectExecution = async (req: express.Request, res: express.Response) => {
        if (!permissionEngine.checkPermission({
            name: 'cancelOwnedProjectExecution',
            level: PermissionLevel.LOW_RISK,
            description: 'Stop only the CLIRO-owned child process for this execution'
        })) return res.status(403).json({ error: 'Permission denied to stop this project execution.' });
        try {
            const executionId = Array.isArray(req.params.executionId)
                ? req.params.executionId[0]
                : req.params.executionId;
            const execution = await projectExecutionEngine.cancel(executionId);
            return res.json({ executionResult: execution });
        } catch (error) {
            return res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
        }
    };
    app.post('/api/projects/executions/:executionId/cancel', stopProjectExecution);
    app.post('/api/projects/executions/:executionId/stop', stopProjectExecution);
    app.post('/api/projects/executions/:executionId/abort', stopProjectExecution);
});

app.post('/api/chrome/tab-gesture/authorize', (req, res) => {
    const action = req.body?.action;
    if (typeof action !== 'string' || !chromeTabGestureActions.includes(action as typeof chromeTabGestureActions[number])) {
        return res.status(400).json({ error: 'Unsupported Chrome tab action.' });
    }
    const gesture = action === 'closeCurrentChromeTab'
        ? 'CLOSED_FIST'
        : action === 'nextChromeTab' ? 'ROTATE_RIGHT' : 'ROTATE_LEFT';
    const authorization = toolRegistry.authorizeChromeTabGesture(action, {
        permissionEngine,
        source: 'gesture',
        gesture
    }, chromeTabGestureAuthorizations);
    if (!authorization.authorized) return res.status(403).json({ error: authorization.error });
    return res.json(authorization);
});

app.post('/api/chrome/tab-gesture/complete', (req, res) => {
    const action = req.body?.action;
    const completed = toolRegistry.completeChromeTabGesture(
        req.body?.authorizationId,
        action,
        req.body?.result,
        {
            permissionEngine,
            source: 'gesture',
            gesture: action === 'closeCurrentChromeTab'
                ? 'CLOSED_FIST'
                : action === 'nextChromeTab' ? 'ROTATE_RIGHT' : 'ROTATE_LEFT'
        },
        chromeTabGestureAuthorizations
    );
    if (!completed) return res.status(409).json({ error: 'Chrome tab action authorization is invalid, expired, or already used.' });
    return res.json({ result: completed });
});

app.get('/api/ai/connection', async (req, res) => {
    const isConnected = await aiProvider.checkConnection();
    res.json({ connected: isConnected, configuredModel: aiProvider.configuredModel });
});

app.get('/api/ai/providers', async (_req, res) => {
    res.json({
        preferredProvider: selectedLanguageProvider(),
        openaiConfigured: openAIProvider.configured,
        ollamaConnected: await aiProvider.checkConnection(),
        imageGenerationConfigured: imageGenerationService.providerStatus === 'CONFIGURED',
        imageGenerationProvider: imageGenerationProvider.name
    });
});

app.get('/api/ai/models', async (req, res) => {
    const models = await aiProvider.listModels();
    res.json({ models, configuredModel: aiProvider.configuredModel });
});

app.get('/api/projects', (_req, res, next) => {
    try {
        if (!permissionEngine.checkPermission({
            name: 'listUserProjects',
            level: PermissionLevel.SAFE_READ,
            description: 'List registered user project metadata'
        })) return res.status(403).json({ error: 'Permission denied to list projects.' });
        return res.json({ projects: projectWorkspace.listProjects() });
    } catch (error) {
        return next(error);
    }
});

const isLoopbackRequest = (req: express.Request): boolean => {
    const address = req.socket.remoteAddress || '';
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
};

app.get('/api/vscode/workspace-trust/poll', (req, res) => {
    if (!isLoopbackRequest(req)) return res.status(403).json({ error: 'Workspace trust bridge is available only to local VS Code.' });
    const workspacePath = req.query.workspacePath;
    if (typeof workspacePath !== 'string' || !workspacePath) {
        return res.status(400).json({ error: 'A VS Code workspace path is required.' });
    }
    return res.json(workspaceTrustBridge.poll(workspacePath));
});

app.post('/api/vscode/workspace-trust/report', (req, res) => {
    if (!isLoopbackRequest(req)) return res.status(403).json({ error: 'Workspace trust bridge is available only to local VS Code.' });
    if (typeof req.body?.workspacePath !== 'string' || typeof req.body?.isTrusted !== 'boolean') {
        return res.status(400).json({ error: 'A workspace path and VS Code trust state are required.' });
    }
    try {
        return res.json({
            report: workspaceTrustBridge.report(
                req.body.workspacePath,
                req.body.isTrusted,
                typeof req.body.requestId === 'string' ? req.body.requestId : undefined
            )
        });
    } catch (error) {
        return res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.get('/api/projects/:id/vscode/trust', (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'readRegisteredProjectWorkspaceTrust',
        level: PermissionLevel.SAFE_READ,
        description: 'Read the reported VS Code trust state for a registered CLIRO project'
    })) return res.status(403).json({ error: 'Permission denied to read project workspace trust.' });
    try {
        const project = projectWorkspace.getProject(req.params.id);
        return res.json({ projectId: project.id, projectPath: project.path, trustStatus: workspaceTrustBridge.getStatus(project) });
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.post('/api/projects/:id/vscode/trust', (req, res) => {
    if (req.body?.approve !== true) {
        return res.status(400).json({ error: 'Explicit user approval is required before opening VS Code workspace trust controls.' });
    }
    if (!permissionEngine.checkPermission({
        name: 'requestRegisteredProjectWorkspaceTrust',
        level: PermissionLevel.LOW_RISK,
        description: 'Open the native VS Code workspace trust UI for a registered CLIRO project after user approval'
    })) return res.status(403).json({ error: 'Permission denied to request VS Code workspace trust.' });
    try {
        const project = projectWorkspace.getProject(req.params.id);
        const request = workspaceTrustBridge.createTrustRequest(project);
        return res.status(202).json({ trustStatus: 'PENDING_USER_CONFIRMATION', request });
    } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.post('/api/projects/:id/vscode/trust/cancel', (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'cancelRegisteredProjectWorkspaceTrust',
        level: PermissionLevel.LOW_RISK,
        description: 'Cancel waiting for a user-approved VS Code workspace trust request'
    })) return res.status(403).json({ error: 'Permission denied to cancel the workspace trust request.' });
    try {
        const project = projectWorkspace.getProject(req.params.id);
        const requestId = req.body?.requestId;
        if (typeof requestId !== 'string' || !workspaceTrustBridge.cancelTrustRequest(project, requestId)) {
            return res.status(409).json({ error: 'The workspace trust request is no longer active.' });
        }
        return res.json({ trustStatus: 'CANCELLED', projectId: project.id, projectPath: project.path });
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 400;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.post('/api/projects/open', async (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'openUserProject',
        level: PermissionLevel.SAFE_READ,
        description: 'Safely inspect and register a user-selected project directory'
    })) return res.status(403).json({ error: 'Permission denied to open the project.' });
    try {
        return res.json(await projectWorkspace.openProject(req.body?.path));
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.post('/api/projects/create', async (req, res) => {
    const confirmed = req.body?.confirmed === true;
    if (!permissionEngine.checkPermission({
        name: 'createUserProject',
        level: PermissionLevel.APPROVAL_REQUIRED,
        description: 'Create the user-confirmed project directory',
        approvalGranted: confirmed
    })) return res.status(403).json({ error: 'Project creation requires an explicit confirmation.' });
    try {
        const requestId = randomUUID();
        const actionId = randomUUID();
        const activityEvents: ActivityEvent[] = [];
        const snapshot = await projectWorkspace.createProject(
            req.body?.name,
            projectWorkspace.projectPathForName(req.body?.name),
            projectTemplate(req.body?.template ?? 'blank'),
            stage => activityEvents.push({
                stage,
                status: 'COMPLETED',
                message: `${stage.replaceAll('_', ' ').toLowerCase()} completed.`,
                at: new Date().toISOString(),
                requestId,
                actionId
            })
        );
        activityEvents.unshift({
            stage: 'PERMISSION_CHECK',
            status: 'COMPLETED',
            message: 'Project creation approval confirmed.',
            at: new Date().toISOString(),
            requestId,
            actionId
        });
        for (const event of activityEvents) {
            event.projectId = snapshot.project.id;
        }
        return res.status(201).json({ ...snapshot, activityEvents });
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.get('/api/projects/:id', async (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'scanUserProject',
        level: PermissionLevel.SAFE_READ,
        description: 'Scan a registered user project without modifying files'
    })) return res.status(403).json({ error: 'Permission denied to scan the project.' });
    try {
        return res.json(await projectWorkspace.openRegisteredProject(req.params.id));
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.post('/api/projects/:id/analyze', async (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'analyzeUserProject',
        level: PermissionLevel.SAFE_READ,
        description: 'Run bounded static code analysis on a registered user project'
    })) return res.status(403).json({ error: 'Permission denied to analyze the project.' });
    try {
        return res.json({ analysis: await projectWorkspace.analyzeProject(req.params.id) });
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.post('/api/projects/:id/analyze-file', async (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'analyzeUserProjectFile',
        level: PermissionLevel.SAFE_READ,
        description: 'Run bounded static code analysis on one selected project file'
    })) return res.status(403).json({ error: 'Permission denied to analyze the file.' });
    try {
        return res.json({ analysis: await projectWorkspace.analyzeProjectFile(req.params.id, req.body?.path) });
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.get('/api/projects/:id/image', async (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'readGeneratedProjectImage',
        level: PermissionLevel.SAFE_READ,
        description: 'Read a verified generated image from a registered CLIRO project'
    })) return res.status(403).json({ error: 'Permission denied to read the generated image.' });
    if (typeof req.query.path !== 'string') {
        return res.status(400).json({ error: 'A generated image path is required.' });
    }
    try {
        const image = await imageGenerationService.readGeneratedImage(req.params.id, req.query.path);
        return res
            .type(image.mimeType)
            .set('X-Content-Type-Options', 'nosniff')
            .set('Cache-Control', 'no-store')
            .send(image.bytes);
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 404;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.get('/api/projects/:id/file', async (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'viewUserProjectFile',
        level: PermissionLevel.SAFE_READ,
        description: 'Read a bounded non-sensitive file from a registered user project'
    })) return res.status(403).json({ error: 'Permission denied to view the file.' });
    try {
        return res.json(await projectWorkspace.readProjectFile(req.params.id, req.query.path));
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.post('/api/projects/:id/ask', async (req, res) => {
    if (!permissionEngine.checkPermission({
        name: 'askAboutUserProject',
        level: PermissionLevel.SAFE_READ,
        description: 'Read bounded non-sensitive project source for local Ollama assistance'
    })) return res.status(403).json({ error: 'Permission denied to read project context.' });
    try {
        const { project, context } = await projectWorkspace.assistantContext(req.params.id, req.body?.question);
        const requestedModel = typeof req.body?.model === 'string' && req.body.model.trim()
            ? req.body.model.trim()
            : aiProvider.configuredModel;
        const answer = await aiProvider.chat(context, requestedModel);
        if (!answer.trim()) throw new Error('Ollama returned an empty answer for the project question.');
        return res.json({ project: { id: project.id, name: project.name }, answer });
    } catch (error) {
        const status = error instanceof ProjectWorkspaceError ? error.statusCode : 502;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

// VERY simple intent router to save LLM calls and respond instantly
async function routeIntent(prompt: string): Promise<{ intent: string, payload: any } | null> {
    const understood = understandCommand(prompt);
    if (understood.clarification) {
        return { intent: 'clarification', payload: { message: understood.clarification } };
    }
    switch (understood.intent) {
        case 'CANCEL':
            return { intent: 'cancelCommand', payload: {} };
        case 'PROJECT_CREATE':
            if (!understood.projectName) {
                return {
                    intent: 'clarification',
                    payload: {
                        message: /[\u0B80-\u0BFF]/.test(prompt)
                            ? 'எந்த project பெயரில் உருவாக்க வேண்டும்?'
                            : 'What name should I use for the project?'
                    }
                };
            }
            return {
                intent: 'createProject',
                payload: {
                    name: understood.projectName,
                    template: understood.template,
                    openInVSCode: understood.openInVSCode,
                    build: understood.build,
                    run: understood.run,
                    test: understood.test
                }
            };
        case 'PROJECT_BUILD':
        case 'PROJECT_TEST':
        case 'PROJECT_RUN':
        case 'DEPENDENCY_INSTALL':
            return {
                intent: 'executeProject',
                payload: {
                    build: understood.build,
                    test: understood.test,
                    run: understood.run
                }
            };
        case 'PROJECT_STOP':
            return { intent: 'stopProject', payload: {} };
        case 'PROJECT_MODIFY':
        case 'CODE_GENERATION':
        case 'CODE_FIX':
            return { intent: 'modifyProject', payload: { feature: understood.feature } };
        case 'PROJECT_ANALYZE':
            return { intent: 'analyzeSelectedProject', payload: {} };
        case 'PROJECT_OPEN':
        case 'PROJECT_SELECT':
            return {
                intent: understood.openInVSCode ? 'openSelectedProject' : 'selectProject',
                payload: { projectName: understood.projectName }
            };
        case 'IMAGE_GENERATE':
        case 'IMAGE_GENERATION':
        case 'IMAGE_EDIT':
        case 'IMAGE_VARIATIONS':
        case 'IMAGE_ADD_TO_PROJECT':
        case 'IMAGE_REGENERATE':
            return { intent: 'generateImage', payload: understood };
        case 'APPLICATION_CONTROL':
            return { intent: 'openApplication', payload: { app: understood.applicationName } };
        case 'SYSTEM_QUERY':
            return { intent: 'getSystemInfo', payload: { section: understood.section } };
        case 'CURRENT_FACT':
            return { intent: 'currentFactQuery', payload: {} };
    }

    const lower = prompt.toLowerCase().trim();
    const mentionedProject = lower.match(/\b(cliro|tms)\b/)?.[1] || 'cliro';

    if (/\b(?:what|which)\s+(?:apps?|applications?)\b.*\b(?:installed|available)\b|\b(?:list|show)\s+(?:the\s+)?(?:installed|available)\s+(?:apps?|applications?)\b|\bwhich\s+apps?\s+can\s+cliro\s+open\b/.test(lower)) {
        return { intent: 'listInstalledApplications', payload: {} };
    }

    if (/\bclose\b.*\bchrome\b.*\btabs?\b|\bclose\s+(?:all\s+)?tabs?\s+in\s+chrome\b/.test(lower)) {
        return { intent: 'closeChromeTabs', payload: {} };
    }
    if (/\b(?:next|switch to next)\s+(?:chrome\s+)?tab\b|\bnext chrome tab\b/.test(lower)) {
        return { intent: 'switchChromeTab', payload: { direction: 'next' } };
    }
    if (/\b(?:previous|prev|switch to previous)\s+(?:chrome\s+)?tab\b|\bprevious chrome tab\b/.test(lower)) {
        return { intent: 'switchChromeTab', payload: { direction: 'previous' } };
    }
    if (/\bclose\s+(?:(?:all|open)\s+)?(?:my\s+)?(?:open\s+)?applications?\b|\bclose\s+(?:all\s+)?open\s+apps?\b/.test(lower)) {
        return { intent: 'closeOpenApplications', payload: {} };
    }

    const codeAnalysisMatch = lower.match(/\b(?:check|analy[sz]e|inspect|review)\s+(?:(?:my|this|the)\s+)?(?:(cliro|tms)\s+)?(?:code|project)(?:\s+(?:for\s+)?(?:errors?|issues?))?\b|\bfind\s+(?:the\s+)?errors?\s+in\s+(?:(cliro|tms)\s+)?(?:(?:my|this|the)\s+)?(?:code|project)\b/);
    if (codeAnalysisMatch) {
        return { intent: 'analyzeCode', payload: { project: codeAnalysisMatch[1] || codeAnalysisMatch[2] || 'cliro' } };
    }

    const statusMatch = lower.match(/^(?:is|check\s+if|check\s+whether)\s+(?:the\s+)?(.+?)\s+(?:currently\s+)?(?:open|running)\s*[?.!]*$/);
    if (statusMatch) {
        const app = statusMatch[1].replace(/^my\s+/i, '').replace(/\s+app(?:lication)?$/i, '').trim();
        return { intent: 'checkApplicationStatus', payload: { app } };
    }

    if (/\b(?:is|does)\s+(?:my\s+)?(?:cliro|tms|this)\s+project\s+(?:present|exist|available)\b|\b(?:is\s+)?my\s+project\s+(?:present|available)\b/.test(lower)) {
        return { intent: 'checkProjectExists', payload: { project: mentionedProject } };
    }

    const projectCreation = parseProjectCreationCommand(prompt);
    if (projectCreation) {
        return {
            intent: 'createProject',
            payload: projectCreation
        };
    }

    const projectBuildIdea = planProjectIdea(prompt);
    if (projectBuildIdea) {
        return {
            intent: 'createProject',
            payload: {
                name: projectBuildIdea.name,
                template: projectBuildIdea.template,
                openInVSCode: projectBuildIdea.openInVSCode,
                projectBuild: true
            }
        };
    }

    const openProjectMatch = lower.match(/\b(?:open|launch)\s+(?:my\s+)?(?:(cliro|tms|[a-z0-9_-]+)\s+)?project\b/);
    if (openProjectMatch && !/\bfolder\b/.test(lower)) {
        return { intent: 'openProject', payload: { project: openProjectMatch[1] || 'cliro' } };
    }

    if (/\b(?:list|show|what)\b.*\bfiles?\b/.test(lower)) {
        const folderMatch = lower.match(/\b(?:in|inside|under)\s+(?:the\s+)?([a-z0-9._-]+)\s+folder\b/);
        return {
            intent: 'listProjectFiles',
            payload: {
                project: mentionedProject,
                relativePath: folderMatch?.[1] || ''
            }
        };
    }

    const filePresentMatch = lower.match(/\b(?:is|are)\s+(?:the\s+)?([a-z0-9._-]+)\s+present\b/);
    if (filePresentMatch) {
        return { intent: 'findProjectFile', payload: { project: mentionedProject, fileName: filePresentMatch[1], checkOnly: true } };
    }

    const findFileMatch = lower.match(/\bfind\s+(?:the\s+)?(.+?)\s*[?.!]*$/);
    if (findFileMatch) {
        const fileName = findFileMatch[1].replace(/^(?:file\s+named|file)\s+/i, '').trim().replace(/^["']|["']$/g, '');
        return { intent: 'findProjectFile', payload: { project: mentionedProject, fileName } };
    }

    if (/\b(?:what is|what's|how much|check|show|give me)\s+(?:my\s+)?(?:cpu|processor)(?:\s+usage)?\b|\b(?:cpu|processor)\s+(?:usage|status)\b/.test(lower)) {
        return { intent: 'getSystemInfo', payload: { section: 'cpu' } };
    }

    if (/\b(?:how much|what is|what's|check|show|give me)\s+(?:my\s+)?(?:ram|memory)\b|\b(?:ram|memory)\s+(?:usage|status)\b/.test(lower)) {
        return { intent: 'getSystemInfo', payload: { section: 'ram' } };
    }

    if (/\b(?:what is|what's|how much|check)\s+(?:my\s+)?battery(?:\s+(?:level|status|percentage))?\b|\bbattery\s+(?:level|status|percentage)\b/.test(lower)) {
        return { intent: 'getSystemInfo', payload: { section: 'battery' } };
    }

    if (/\b(?:what is|what's|how much|check|show|give me)\s+(?:my\s+)?(?:storage|disk space|drive space)\b|\b(?:storage|disk|drive)\s+(?:usage|space|status)\b/.test(lower)) {
        return { intent: 'getSystemInfo', payload: { section: 'storage' } };
    }

    if (/\b(?:show|display)\s+(?:(?:the|my)\s+)?(?:os|operating system|platform)\b|\b(?:what|which)\s+(?:is\s+)?my\s+(?:os|operating system|platform)\b|\b(?:what|which)\s+(?:operating system|os|platform)\s+am\s+i\s+using\b|\bwhich\s+(?:operating system|os|platform)\s+(?:is\s+)?(?:this|my|the)\s+(?:computer|pc|system)\s+(?:running|using)\b|\bwhat\s+(?:operating system|os|platform)\s+is\s+(?:this|my|the)\s+(?:computer|pc|system)\s+(?:running|using)\b|\btell me (?:my )?(?:computer|pc|system)['’]?s\s+(?:os|operating system|platform)\b/.test(lower)) {
        return { intent: 'getSystemInfo', payload: { section: 'os' } };
    }

    if (/\b(?:system status|system information|system info)\b/.test(lower) ||
        /\bhow is (?:my )?(?:pc|computer) performing\b/.test(lower) ||
        /\b(?:show|give me)\s+(?:my\s+)?(?:system|pc|computer)\b/.test(lower)) {
        return { intent: 'getSystemInfo', payload: { section: 'all' } };
    }

    const computerAction = planComputerAction(prompt);
    if (computerAction && 'unsupported' in computerAction) {
        return { intent: 'unsupportedComputerAction', payload: { message: computerAction.unsupported } };
    }
    if (computerAction) {
        return { intent: 'executeComputerActionPlan', payload: { actions: computerAction.actions } };
    }
    
    const openMatch = lower.match(/^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?(.+?)\s*[?.!]*$/);
    if (openMatch) {
        return { intent: 'openApplication', payload: { app: openMatch[1].trim() } };
    }
    
    if (lower.includes('check my code') || lower.includes('find the error')) {
        return { intent: 'analyzeCode', payload: {} };
    }

    if (lower.includes('fix this file') || lower.includes('fix the error')) {
        return { intent: 'proposeCodeChange', payload: { file: 'login.ts' } };
    }

    return null; // Route to LLM
}

app.post('/api/ai/chat', async (req, res) => {
    const { prompt, model } = req.body;
    const source: ActionSource = req.body.source === 'voice' || req.body.source === 'gesture' ? req.body.source : 'chat';
    const allowedGestures: DetectedGesture[] = [
        'FIST', 'ROTATE_LEFT', 'ROTATE_RIGHT', 'OPEN_PALM', 'CLOSED_FIST',
        'THUMBS_UP', 'THUMBS_DOWN', 'POINT', 'V_SIGN'
    ];
    const gesture = allowedGestures.includes(req.body.gesture) ? req.body.gesture as DetectedGesture : undefined;
    const approvalGranted = req.body.approvalGranted === true;
    const approvalRequestId = req.body.approvalRequestId;
    const requestId = randomUUID();
    let activeProjectId: string | undefined;
    if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    const streaming = req.query.stream === 'true';
    let streamStarted = false;
    const startStream = () => {
        if (!streaming || streamStarted) return;
        streamStarted = true;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
    };
    const writeEvent = (event: Record<string, unknown>) => {
        startStream();
        if (streaming) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const emitActivity = (
        stage: ActivityStage,
        status: ActivityStatus,
        message: string,
        details: Partial<ActivityEvent> = {}
    ) => {
        const event: ActivityEvent = {
            stage,
            status,
            message,
            at: details.timestamp || new Date().toISOString(),
            requestId,
            projectId: details.projectId || activeProjectId,
            actionId: details.actionId || (typeof approvalRequestId === 'string' ? approvalRequestId : requestId),
            timestamp: details.timestamp,
            verification: details.verification
        };
        writeEvent({ activity: event });
    };
    const sendResult = (result: unknown) => {
        if (!streaming) {
            res.json(result);
            return;
        }
        writeEvent({ result });
        res.write('data: [DONE]\n\n');
        res.end();
    };
    emitActivity('REQUEST_RECEIVED', 'COMPLETED', 'Request received by CLIRO.');

    const createChatProject = async (payload: {
        name?: unknown;
        template?: unknown;
        openInVSCode?: unknown;
        projectBuild?: unknown;
        build?: unknown;
        run?: unknown;
        test?: unknown;
    }): Promise<Record<string, unknown>> => {
        const plannedIdea = payload.projectBuild === true ? planProjectIdea(prompt) : null;
        const blueprint: ProjectBlueprint | undefined = plannedIdea?.blueprint;
        const template = plannedIdea?.template ?? (isProjectTemplate(payload.template) ? payload.template : 'basic');
        const openInVSCode = plannedIdea?.openInVSCode ?? (payload.openInVSCode === true);
        const name = plannedIdea?.name ?? (typeof payload.name === 'string' ? payload.name.trim() : '');
        if (blueprint) {
            emitActivity('PROJECT_PLANNING', 'RUNNING', 'Building a deterministic project blueprint.');
            emitActivity('PROJECT_PLANNING', 'COMPLETED', `PROJECT PLAN READY · ${blueprint.template.toUpperCase()} · ${blueprint.features.length} features · ${blueprint.roles.length} roles`);
        }
        let validated: { name: string; path: string; template: ProjectTemplate };
        try {
            const projectPath = projectWorkspace.projectPathForName(name);
            validated = await projectWorkspace.validateProjectCreation(name, projectPath, template);
            emitActivity('PROJECT_PATH_VALIDATION', 'COMPLETED', `Project location validated: ${validated.path}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emitActivity('PROJECT_PATH_VALIDATION', 'FAILED', message);
            emitActivity('FAILED', 'FAILED', message);
            return { projectResult: { type: 'PROJECT_CREATION_FAILED', verified: false, message: `Project request rejected: ${message}` } };
        }

        if (typeof approvalRequestId !== 'string') {
            const approval = projectCreationApprovals.create(prompt, validated.name, validated.template, openInVSCode);
            const message = `Creating ${validated.name} requires your approval. No files were created.`;
            emitActivity('PERMISSION_CHECK', 'REQUIRES_APPROVAL', 'Approval required before creating this project.');
            return {
                action: {
                    type: 'ACTION_APPROVAL_REQUIRED',
                    verified: false,
                    message,
                    approvalRequestId: approval.approvalRequestId,
                    projectName: approval.name,
                    projectTemplate: approval.template,
                    openInVSCode: approval.openInVSCode,
                    expiresAt: approval.expiresAt,
                    projectPlan: blueprint ? {
                        projectName: blueprint.projectName,
                        description: blueprint.description,
                        language: blueprint.language,
                        frontend: blueprint.frontend,
                        backend: blueprint.backend,
                        database: blueprint.database,
                        features: blueprint.features,
                        roles: blueprint.roles,
                        folders: blueprint.folders,
                        files: blueprint.files.map(file => file.path),
                        dependencies: blueprint.dependencies,
                        commands: blueprint.commands,
                        testPlan: blueprint.testPlan
                    } : undefined
                }
            };
        }

        const decision = projectCreationApprovals.decide(
            approvalRequestId,
            prompt,
            validated.name,
            validated.template,
            openInVSCode,
            approvalGranted
        );
        if (decision.status === 'cancelled') {
            const message = `Project creation cancelled for ${validated.name}. No files were created.`;
            emitActivity('PERMISSION_CHECK', 'FAILED', 'Project creation approval was cancelled.');
            emitActivity('FAILED', 'FAILED', message);
            return { projectResult: { type: 'PROJECT_CREATION_CANCELLED', verified: false, message } };
        }
        if (decision.status !== 'approved') {
            const message = decision.status === 'expired'
                ? 'Project approval expired. Submit the request again to review it.'
                : decision.status === 'mismatch'
                    ? 'This approval does not match the original project request.'
                    : 'This project approval is invalid or has already been used.';
            emitActivity('PERMISSION_CHECK', 'FAILED', message);
            emitActivity('FAILED', 'FAILED', message);
            return { projectResult: { type: 'PROJECT_CREATION_FAILED', verified: false, message } };
        }
        const allowed = permissionEngine.checkPermission({
            name: 'createUserProject',
            level: PermissionLevel.APPROVAL_REQUIRED,
            description: 'Create a user-confirmed project using a fixed safe template',
            approvalGranted: true
        });
        emitActivity('PERMISSION_CHECK', allowed ? 'COMPLETED' : 'FAILED',
            allowed ? 'Project creation approved.' : 'Project creation requires explicit approval.');
        if (!allowed) {
            const message = 'Project creation was not authorized. No files were created.';
            emitActivity('FAILED', 'FAILED', message);
            return { projectResult: { type: 'PROJECT_CREATION_FAILED', verified: false, message } };
        }

        const runningStages: ProjectCreationStage[] = [];
        try {
            const snapshot = await projectWorkspace.createProject(
                validated.name,
                validated.path,
                template,
                stage => {
                    runningStages.push(stage);
                    emitActivity(stage, 'RUNNING', `${stage.replaceAll('_', ' ').toLowerCase()} in progress.`);
                },
                blueprint ? Object.fromEntries(blueprint.files.map(file => [file.path, file.content])) : undefined
            );
            const registeredProject = projectWorkspace.listProjects().find(project => project.id === snapshot.project.id);
            if (!registeredProject) {
                throw new Error('The created project was not found in the ProjectWorkspace registry.');
            }
            activeProjectId = snapshot.project.id;
            for (const stage of runningStages) {
                emitActivity(stage, 'COMPLETED', `${stage.replaceAll('_', ' ').toLowerCase()} verified.`);
            }
            const projectResult = {
                type: 'PROJECT_CREATED',
                verified: true,
                message: `Created and verified ${snapshot.project.name} (${template} template) at ${snapshot.project.path}; ${snapshot.fileCount} files are registered in ProjectWorkspace.`,
                requestId,
                projectId: snapshot.project.id,
                projectPath: snapshot.project.path,
                fileCount: snapshot.fileCount
            };
            const requestedBuild = payload.build === true || /\bbuild\b/i.test(prompt);
            const requestedTest = payload.test === true || /\btest(?:s|ing)?\b/i.test(prompt);
            const requestedRun = payload.run === true || /\brun\b/i.test(prompt);
            if (!openInVSCode) {
                if (!requestedBuild && !requestedTest && !requestedRun) {
                    emitActivity('RESPONSE_READY', 'COMPLETED', 'Project creation verified and registered.');
                    return { projectResult };
                }
            }

            const executionRequested = requestedBuild || requestedTest || requestedRun;
            if (executionRequested) {
                let executionResult;
                try {
                    executionResult = await projectExecutionEngine.start(
                        snapshot.project.id,
                        {
                            build: requestedBuild,
                            test: requestedTest,
                            run: requestedRun,
                            openInVSCode
                        },
                        requestId,
                        event => emitActivity(event.stage, event.status, event.message, event)
                    );
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    emitActivity('FAILED', 'FAILED', `Project execution failed: ${detail}`, { projectId: snapshot.project.id });
                    return {
                        projectResult,
                        executionResult: {
                            executionId: requestId,
                            projectId: snapshot.project.id,
                            status: 'FAILED',
                            repairAttempts: 0,
                            events: [],
                            error: detail
                        }
                    };
                }
                if (executionResult.approvalRequired) {
                    const approval = executionResult.approvalRequired;
                    emitActivity('RESPONSE_READY', 'REQUIRES_APPROVAL', 'Project is verified; execution is waiting for the requested approval.');
                    return {
                        projectResult,
                        executionResult,
                        action: {
                            type: 'ACTION_APPROVAL_REQUIRED',
                            approvalType: approval.type,
                            approval: {
                                type: approval.type,
                                projectId: approval.projectId,
                                projectPath: approval.projectPath,
                                dependencies: approval.dependencies,
                                command: approval.command,
                                approvalRequestId: approval.approvalRequestId
                            },
                            executionId: approval.executionId,
                            approvalRequestId: approval.approvalRequestId,
                            projectId: approval.projectId,
                            projectPath: approval.projectPath,
                            dependencies: approval.dependencies,
                            command: approval.command,
                            repairProposal: approval.repairProposal,
                            expiresAt: approval.expiresAt,
                            message: approval.type === 'DEPENDENCY_INSTALL'
                                ? `Install ${approval.dependencies.length} declared project dependencies using the approved command?`
                                : `Apply the proposed safe project repair?`
                        }
                    };
                }
                return {
                    projectResult,
                    executionResult,
                    ...(executionResult.vsCodeResult ? { vsCodeResult: executionResult.vsCodeResult } : {})
                };
            }

            if (!openInVSCode) {
                emitActivity('RESPONSE_READY', 'COMPLETED', 'Project creation verified and registered.');
                return { projectResult };
            }
            emitActivity('VS_CODE_OPENING', 'RUNNING', 'Opening the verified project path as a VS Code workspace.');
            emitActivity('VS_CODE_VERIFICATION', 'RUNNING', 'Verifying the VS Code process, window, and exact workspace path.');
            const vsCodeResult = await toolRegistry.openVerifiedProjectInVSCode(snapshot.project.path, {
                permissionEngine,
                workspaceTrustBridge,
                source,
                gesture,
                onProgress: message => {
                    const stage: ActivityStage = /verif/i.test(message) || /wait/i.test(message)
                        ? 'VS_CODE_VERIFICATION'
                        : 'VS_CODE_OPENING';
                    emitActivity(stage, 'RUNNING', message);
                }
            });
            emitActivity(
                'VS_CODE_OPENING',
                vsCodeResult.verified ? 'COMPLETED' : 'FAILED',
                vsCodeResult.verified ? 'The created project workspace was verified in VS Code.' : 'Unable to verify the created project workspace in VS Code.'
            );
            emitActivity(
                'VS_CODE_VERIFICATION',
                vsCodeResult.verified ? 'COMPLETED' : 'FAILED',
                vsCodeResult.message
            );
            if (vsCodeResult.verified) emitActivity('RESPONSE_READY', 'COMPLETED', 'Project and VS Code results were verified.');
            else emitActivity('FAILED', 'FAILED', vsCodeResult.message);
            return {
                projectResult,
                vsCodeResult: {
                    ...vsCodeResult,
                    requestId,
                    projectId: snapshot.project.id
                }
            };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            emitActivity('FAILED', 'FAILED', detail);
            return { projectResult: { type: 'PROJECT_CREATION_FAILED', verified: false, message: `Project creation failed: ${detail}` } };
        }
    };

    try {
        const intentRoute = await routeIntent(prompt);
        const queryCategory = classifyQuery(prompt, intentRoute?.intent);
        if (intentRoute?.intent === 'clarification') {
            return sendResult({ type: 'CLARIFICATION', answer: intentRoute.payload.message });
        }
        if (intentRoute?.intent === 'cancelCommand') {
            return sendResult({
                type: 'CLIRO_RESPONSE',
                answer: 'Cancellation request received. If an approval is waiting, use its Cancel option so the existing approval flow records the decision.'
            });
        }
        if (intentRoute?.intent === 'createProject') {
            emitActivity('REQUEST_RECEIVED', 'COMPLETED', 'Project creation requested.');
        }
        emitActivity(
            'QUERY_CLASSIFICATION',
            'COMPLETED',
            intentRoute?.intent === 'createProject'
                ? `${queryCategory} · PROJECT_CREATE · ${String(intentRoute.payload.template).toUpperCase()}${intentRoute.payload.openInVSCode ? ' · OPEN IN VS CODE' : ''}`
                : `${queryCategory}${intentRoute ? ` · ${intentRoute.intent}` : ''}`
        );
        if (queryCategory === 'CURRENT_FACT' || queryCategory === 'VERIFIED_FACT') {
            emitActivity('PROVIDER_SELECTION', 'COMPLETED', 'WEB VERIFIED');
            writeEvent({ provider: 'WEB VERIFIED' });
            emitActivity('RESPONSE_PROCESSING', 'RUNNING', 'Validating verified-source result.');
            const result = await verifyCurrentFact(prompt, verifiedFactsProvider, Date.now, (stage, status, message) => {
                emitActivity(stage, status, message);
            });
            const sourceName = result.source?.provider || 'unavailable';
            fs.appendFileSync(
                'audit.log',
                `[${new Date().toISOString()}] VERIFIED_FACT_QUERY | Category: ${queryCategory} | Provider: ${sourceName} | Verified: ${result.type === 'VERIFIED_FACT'} | Cached: ${result.cached}\n`
            );
            if (result.type !== 'VERIFIED_FACT') emitActivity('FAILED', 'FAILED', result.message);
            emitActivity('RESPONSE_PROCESSING', 'COMPLETED', 'Verified response is ready for display.');
            emitActivity('RESPONSE_READY', result.type === 'VERIFIED_FACT' ? 'COMPLETED' : 'FAILED', result.type);
            return sendResult(result);
        }
        const selectedProjectId = typeof req.body.selectedProjectId === 'string'
            ? req.body.selectedProjectId
            : '';
        if (intentRoute?.intent === 'selectProject' || intentRoute?.intent === 'openSelectedProject') {
            if (!permissionEngine.checkPermission({
                name: 'openUserProject',
                level: PermissionLevel.SAFE_READ,
                description: 'Select and safely inspect a registered CLIRO project'
            })) return sendResult({ error: 'Permission denied to select the project.' });
            const requestedName = typeof intentRoute.payload.projectName === 'string'
                ? intentRoute.payload.projectName.trim()
                : '';
            const requestedProject = requestedName
                ? projectWorkspace.listProjects().find(project => project.name.toLocaleLowerCase() === requestedName.toLocaleLowerCase())
                : undefined;
            const projectId = requestedProject?.id || selectedProjectId;
            if (!projectId) {
                return sendResult({
                    type: 'CLARIFICATION',
                    answer: /[\u0B80-\u0BFF]/.test(prompt)
                        ? 'எந்த project-ஐ திறக்க வேண்டும்? Projects பட்டியலில் இருந்து தேர்ந்தெடுக்கவும்.'
                        : 'Which project should I open? Select a registered project first.'
                });
            }
            let snapshot;
            try {
                snapshot = await projectWorkspace.openRegisteredProject(projectId);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return sendResult({ type: 'CLARIFICATION', answer: message });
            }
            if (intentRoute.intent === 'openSelectedProject') {
                const vsCodeResult = await toolRegistry.openVerifiedProjectInVSCode(snapshot.project.path, {
                    permissionEngine,
                    workspaceTrustBridge,
                    source,
                    gesture
                });
                if (!vsCodeResult.verified) {
                    return sendResult({ vsCodeResult: { ...vsCodeResult, projectId: snapshot.project.id } });
                }
            }
            return sendResult({
                projectSelection: {
                    id: snapshot.project.id,
                    name: snapshot.project.name,
                    path: snapshot.project.path,
                    fileCount: snapshot.fileCount,
                    files: snapshot.files.filter(file => file.type === 'file').map(file => file.path)
                },
                answer: /[\u0B80-\u0BFF]/.test(prompt)
                    ? `${snapshot.project.name} project திறந்துவிட்டேன். இதில் என்ன feature அல்லது மாற்றம் செய்ய வேண்டும்?`
                    : `${snapshot.project.name} is open. What would you like me to build or change in this project?`
            });
        }
        if (intentRoute?.intent === 'generateImage') {
            const imageIntent = intentRoute.payload.intent;
            if (imageIntent !== 'IMAGE_GENERATION' && imageIntent !== 'IMAGE_GENERATE' && imageIntent !== 'IMAGE_ADD_TO_PROJECT') {
                return sendResult({
                    type: 'IMAGE_CAPABILITY_UNSUPPORTED',
                    provider: imageGenerationProvider.name,
                    verified: false,
                    reason: 'Only new image generation is currently supported.',
                    answer: 'This image provider currently supports new image generation only. Editing and reference-based variations are not available.'
                });
            }
            if (imageGenerationService.providerStatus !== 'CONFIGURED') {
                return sendResult({
                    type: 'IMAGE_GENERATION_NOT_CONFIGURED',
                    verified: false,
                    provider: imageGenerationProvider.name,
                    reason: 'No supported backend image provider is configured.',
                    requiredConfiguration: ['OPENAI_API_KEY', 'IMAGE_GENERATION_PROVIDER=openai'],
                    message: 'Image generation provider is not configured.',
                    answer: 'Image generation is not configured. Set OPENAI_API_KEY in the backend environment; optionally set IMAGE_GENERATION_PROVIDER=openai.'
                });
            }

            const projectHint = typeof intentRoute.payload.projectHint === 'string'
                ? intentRoute.payload.projectHint.trim()
                : '';
            const hintedProject = projectHint
                ? projectWorkspace.listProjects().find(project => project.name.toLocaleLowerCase() === projectHint.toLocaleLowerCase())
                : undefined;
            if (projectHint && !hintedProject) {
                return sendResult({
                    type: 'CLARIFICATION',
                    answer: `No registered project named "${projectHint}" was found. Select the intended project first.`
                });
            }
            const targetProjectId = hintedProject?.id || selectedProjectId || undefined;
            const saveToProject = true;
            if (!targetProjectId) {
                return sendResult({
                    type: 'CLARIFICATION',
                    answer: /[\u0B80-\u0BFF]/.test(prompt)
                        ? 'படத்தைச் சேமிக்க முதலில் Projects பகுதியில் ஒரு project-ஐத் தேர்ந்தெடுக்கவும்.'
                        : 'Select a registered project before saving the generated image into a project.'
                });
            }
            if (targetProjectId && !permissionEngine.checkPermission({
                name: 'readRegisteredProjectForImagePlan',
                level: PermissionLevel.SAFE_READ,
                description: 'Resolve a registered project before preparing an image asset plan'
            })) return sendResult({ error: 'Permission denied to inspect the selected project.' });

            const imageApprovalId = typeof approvalRequestId === 'string' ? approvalRequestId : undefined;
            if (!imageApprovalId) {
                try {
                    const approval = imageGenerationService.createApproval(
                        requestId,
                        saveToProject ? targetProjectId : undefined,
                        prompt,
                        typeof intentRoute.payload.imagePrompt === 'string' ? intentRoute.payload.imagePrompt : prompt,
                        typeof intentRoute.payload.imagePurpose === 'string' ? intentRoute.payload.imagePurpose : 'project visual asset',
                        typeof intentRoute.payload.imageCount === 'number' ? intentRoute.payload.imageCount : 1,
                        imageIntent === 'IMAGE_REGENERATE'
                    );
                    emitActivity('IMAGE_GENERATION_APPROVAL', 'REQUIRES_APPROVAL', 'Image generation requires explicit approval before contacting the provider or writing project files.', {
                        projectId: approval.plan.projectId,
                        actionId: approval.approvalRequestId
                    });
                    return sendResult({
                        action: {
                            type: 'ACTION_APPROVAL_REQUIRED',
                            approvalType: 'IMAGE_GENERATION',
                            approvalRequestId: approval.approvalRequestId,
                            expiresAt: approval.expiresAt,
                            message: `Generate ${approval.plan.count} image${approval.plan.count === 1 ? '' : 's'} with ${imageGenerationProvider.name}${approval.plan.projectName ? ` and save to ${approval.plan.projectName}` : ''}?`,
                            imagePlan: {
                                provider: imageGenerationProvider.name,
                                purpose: approval.plan.purpose,
                                prompt: approval.plan.prompt,
                                count: approval.plan.count,
                                projectName: approval.plan.projectName,
                                outputPaths: approval.plan.outputPaths,
                                expiresAt: approval.plan.expiresAt
                            }
                        }
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return sendResult({ type: 'IMAGE_GENERATION_FAILED', verified: false, answer: message });
                }
            }

            if (!approvalGranted) {
                try {
                    const cancelled = await imageGenerationService.generateApproved({
                        approvalRequestId: imageApprovalId,
                        projectId: saveToProject ? targetProjectId : undefined,
                        sourcePrompt: prompt,
                        approve: false
                    });
                    return sendResult(cancelled);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return sendResult({ type: 'IMAGE_GENERATION_FAILED', verified: false, answer: message });
                }
            }
            const allowed = permissionEngine.checkPermission({
                name: 'generateAndSaveImage',
                level: PermissionLevel.APPROVAL_REQUIRED,
                description: 'Generate an image only after explicit approval; save only to the selected registered project',
                approvalGranted: true
            });
            if (!allowed) return sendResult({ type: 'IMAGE_GENERATION_FAILED', verified: false, answer: 'Image generation was not authorized. No image files were created.' });
            emitActivity('IMAGE_GENERATION', 'RUNNING', 'Generating the approved image with the configured backend provider.', {
                projectId: saveToProject ? targetProjectId : undefined,
                actionId: imageApprovalId
            });
            try {
                const result = await imageGenerationService.generateApproved({
                    approvalRequestId: imageApprovalId,
                    projectId: saveToProject ? targetProjectId : undefined,
                    sourcePrompt: prompt,
                    approve: true
                });
                const verified = 'verified' in result && result.verified;
                emitActivity(verified ? 'IMAGE_VERIFICATION' : 'FAILED', verified ? 'COMPLETED' : 'FAILED',
                    verified ? 'Generated image bytes and any saved project files were verified.' : 'Image generation was cancelled or output verification failed.', {
                        projectId: saveToProject ? targetProjectId : undefined,
                        actionId: imageApprovalId,
                        verification: verified
                    });
                return sendResult({
                    ...result,
                    imageResult: result
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                emitActivity('FAILED', 'FAILED', message, { actionId: imageApprovalId });
                const code = error instanceof ImageGenerationError ? error.code : 'IMAGE_GENERATION_FAILED';
                return sendResult({ type: code, verified: false, answer: message });
            }
        }
        if (intentRoute?.intent === 'executeProject') {
            if (!selectedProjectId) {
                return sendResult({
                    type: 'CLARIFICATION',
                    answer: /[\u0B80-\u0BFF]/.test(prompt)
                        ? 'முதலில் Projects பகுதியில் ஒரு project-ஐத் தேர்ந்தெடுக்கவும்.'
                        : 'Select a project in the Projects view first.'
                });
            }
            try {
                const execution = await projectExecutionEngine.start(
                    selectedProjectId,
                    {
                        build: intentRoute.payload.build === true,
                        test: intentRoute.payload.test === true,
                        run: intentRoute.payload.run === true,
                        openInVSCode: false
                    },
                    requestId,
                    event => emitActivity(event.stage, event.status, event.message, event)
                );
                if (execution.approvalRequired) {
                    const approval = execution.approvalRequired;
                    return sendResult({
                        executionResult: execution,
                        action: {
                            type: 'ACTION_APPROVAL_REQUIRED',
                            approvalType: approval.type,
                            approvalRequestId: approval.approvalRequestId,
                            executionId: approval.executionId,
                            projectId: approval.projectId,
                            projectPath: approval.projectPath,
                            dependencies: approval.dependencies,
                            command: approval.command,
                            repairProposal: approval.repairProposal,
                            expiresAt: approval.expiresAt,
                            message: approval.type === 'DEPENDENCY_INSTALL'
                                ? `Install ${approval.dependencies.length} declared project dependencies using the approved command?`
                                : 'Apply the proposed safe project repair?'
                        }
                    });
                }
                return sendResult({ executionResult: execution });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return sendResult({
                    executionResult: {
                        executionId: requestId,
                        projectId: selectedProjectId,
                        status: 'FAILED',
                        error: message
                    }
                });
            }
        }
        if (intentRoute?.intent === 'stopProject') {
            if (!selectedProjectId) {
                return sendResult({
                    type: 'CLARIFICATION',
                    answer: /[\u0B80-\u0BFF]/.test(prompt)
                        ? 'எந்த project-ஐ நிறுத்த வேண்டும்? முதலில் Projects பகுதியில் அதைத் தேர்ந்தெடுக்கவும்.'
                        : 'Select the project to stop in the Projects view first.'
                });
            }
            if (!permissionEngine.checkPermission({
                name: 'cancelOwnedProjectExecution',
                level: PermissionLevel.LOW_RISK,
                description: 'Stop only the CLIRO-owned child process for the selected project'
            })) return sendResult({ action: { type: 'ACTION_FAILED', message: 'Permission denied to stop this project execution.' } });
            try {
                const project = projectWorkspace.getProject(selectedProjectId);
                if (!project.executionId) {
                    return sendResult({ action: { type: 'ACTION_FAILED', message: `No CLIRO-managed execution is recorded for ${project.name}.` } });
                }
                return sendResult({ executionResult: await projectExecutionEngine.cancel(project.executionId) });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return sendResult({ action: { type: 'ACTION_FAILED', message } });
            }
        }
        if (intentRoute?.intent === 'analyzeSelectedProject') {
            if (!selectedProjectId) {
                return sendResult({
                    type: 'CLARIFICATION',
                    answer: /[\u0B80-\u0BFF]/.test(prompt)
                        ? 'முதலில் Projects பகுதியில் ஒரு project-ஐத் தேர்ந்தெடுக்கவும்.'
                        : 'Select a project in the Projects view first.'
                });
            }
            if (!permissionEngine.checkPermission({
                name: 'analyzeUserProject',
                level: PermissionLevel.SAFE_READ,
                description: 'Analyze source files in the selected registered project'
            })) return sendResult({ error: 'Permission denied to analyze the project.' });
            return sendResult({ codeAnalysis: await projectWorkspace.analyzeProject(selectedProjectId) });
        }
        if (intentRoute?.intent === 'modifyProject') {
            if (!selectedProjectId) {
                return sendResult({
                    type: 'CLARIFICATION',
                    answer: /[\u0B80-\u0BFF]/.test(prompt)
                        ? 'முதலில் Projects பகுதியில் ஒரு project-ஐத் தேர்ந்தெடுக்கவும்.'
                        : 'Select a project in the Projects view first.'
                });
            }
            if (!permissionEngine.checkPermission({
                name: 'askAboutUserProject',
                level: PermissionLevel.SAFE_READ,
                description: 'Read bounded source files from the selected registered project to prepare a change plan'
            })) return sendResult({ error: 'Permission denied to read project context.' });
            const instruction = typeof intentRoute.payload.feature === 'string' && intentRoute.payload.feature.trim()
                ? intentRoute.payload.feature.trim()
                : prompt.trim();
            const modificationRequestId = typeof approvalRequestId === 'string' ? approvalRequestId : requestId;
            if (typeof approvalRequestId !== 'string') {
                emitActivity('PROJECT_MODIFICATION_PLANNING', 'RUNNING', 'Inspecting bounded project source and preparing a deterministic change plan.', {
                        projectId: selectedProjectId
                });
                try {
                        const proposal = await projectModificationEngine.propose({
                            requestId: modificationRequestId,
                            projectId: selectedProjectId,
                            instruction,
                            provider: selectedLanguageProvider(req.body.provider),
                            model: typeof model === 'string' && model.trim() ? model.trim() : undefined
                        });
                        if (proposal.status === 'unsupported') {
                            return sendResult({ type: 'PROJECT_MODIFICATION_UNAVAILABLE', verified: false, answer: proposal.reason });
                        }
                        emitActivity('PROJECT_MODIFICATION_PLANNING', 'COMPLETED', `Prepared ${proposal.proposal.changes.length} file change(s) for review. No files have been modified.`, {
                            projectId: selectedProjectId,
                            actionId: proposal.proposal.requestId
                        });
                        emitActivity('PROJECT_MODIFICATION_APPROVAL', 'REQUIRES_APPROVAL', 'Review the exact file changes before applying them.', {
                            projectId: selectedProjectId,
                            actionId: proposal.proposal.requestId
                        });
                        return sendResult({
                            action: {
                                type: 'ACTION_APPROVAL_REQUIRED',
                                approvalType: 'PROJECT_MODIFICATION',
                                approvalRequestId: proposal.proposal.requestId,
                                projectId: proposal.proposal.projectId,
                                expiresAt: new Date(proposal.proposal.expiresAt).toISOString(),
                                message: `Review ${proposal.proposal.changes.length} proposed project file change(s). No files have been modified.`,
                                modificationPlan: {
                                    projectId: proposal.proposal.projectId,
                                    instruction: proposal.proposal.instruction,
                                    planSha256: proposal.proposal.planSha256,
                                    expiresAt: proposal.proposal.expiresAt,
                                    changes: proposal.proposal.changes.map(change => ({
                                        operation: change.operation,
                                        path: change.path,
                                        diff: change.diff,
                                        content: change.content
                                    }))
                                }
                            }
                        });
                } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const code = error instanceof ProjectModificationError ? error.code : 'PROJECT_MODIFICATION_FAILED';
                        return sendResult({ type: code, verified: false, answer: message });
                }
            }

            try {
                if (!approvalGranted) {
                        const cancelled = projectModificationEngine.cancel(modificationRequestId, selectedProjectId);
                        emitActivity('CANCELLED', 'COMPLETED', 'Project modification approval was cancelled. No files were changed.', {
                            projectId: selectedProjectId,
                            actionId: modificationRequestId,
                            verification: false
                        });
                        return sendResult({ action: { type: 'ACTION_CANCELLED', message: `Modification cancelled (${cancelled.requestId}). No files were changed.` } });
                }
                const allowed = permissionEngine.checkPermission({
                        name: 'modifyUserProject',
                        level: PermissionLevel.APPROVAL_REQUIRED,
                        description: 'Apply only the exact reviewed project patch after explicit user approval',
                        approvalGranted: true
                });
                if (!allowed) return sendResult({ type: 'PROJECT_MODIFICATION_FAILED', verified: false, answer: 'The project modification was not authorized. No files were changed.' });
                projectModificationEngine.approve(modificationRequestId, selectedProjectId);
                emitActivity('PROJECT_MODIFICATION_APPLY', 'RUNNING', 'Applying the explicitly approved, validated file changes.', {
                        projectId: selectedProjectId,
                        actionId: modificationRequestId
                });
                const result = await projectModificationEngine.apply(modificationRequestId, selectedProjectId);
                emitActivity('PROJECT_MODIFICATION_VERIFICATION', 'COMPLETED', 'The changed files were read back and their exact contents were verified.', {
                        projectId: selectedProjectId,
                        actionId: modificationRequestId,
                        verification: true
                });
                return sendResult({ projectModificationResult: { ...result, verified: true } });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const code = error instanceof ProjectModificationError ? error.code : 'PROJECT_MODIFICATION_FAILED';
                emitActivity('FAILED', 'FAILED', message, { projectId: selectedProjectId, actionId: modificationRequestId });
                if (error instanceof ProjectModificationError && error.code === 'PARTIAL_APPLY') {
                    return sendResult({
                        projectModificationResult: {
                            verified: false,
                            partial: true,
                            changedPaths: error.partial?.changedPaths || [],
                            verifiedPaths: error.partial?.verifiedPaths || [],
                            message
                        }
                    });
                }
                return sendResult({ type: code, verified: false, answer: message });
            }
        }
        if (intentRoute?.intent === 'openSelectedProject') {
            if (!selectedProjectId) {
                return sendResult({
                    type: 'CLARIFICATION',
                    answer: /[\u0B80-\u0BFF]/.test(prompt)
                        ? 'முதலில் Projects பகுதியில் ஒரு project-ஐத் தேர்ந்தெடுக்கவும்.'
                        : 'Select a project in the Projects view first.'
                });
            }
            const project = projectWorkspace.getProject(selectedProjectId);
            const result = await toolRegistry.openVerifiedProjectInVSCode(project.path, {
                permissionEngine,
                workspaceTrustBridge,
                source,
                gesture
            });
            return sendResult({ vsCodeResult: { ...result, projectId: project.id } });
        }
        if (intentRoute?.intent === 'createProject' && !streaming) {
            return res.json(await createChatProject(intentRoute.payload));
        }

        if (intentRoute) {
            const actionIntents = new Set([
                'createProject',
                'openApplication',
                'openProject',
                'closeChromeTabs',
                'closeOpenApplications',
                'switchChromeTab',
                'executeComputerActionPlan',
                'unsupportedComputerAction'
            ]);
            if (actionIntents.has(intentRoute.intent)) {
                if (req.query.stream === 'true') {
                    if (intentRoute.intent === 'createProject') {
                        const result = await createChatProject(intentRoute.payload);
                        writeEvent({ result });
                        res.write('data: [DONE]\n\n');
                        res.end();
                        return;
                    }

                    const initialMessage = intentRoute.intent === 'openApplication'
                        ? 'FINDING APPLICATION...'
                        : intentRoute.intent === 'openProject'
                            ? `Opening ${intentRoute.payload.app || intentRoute.payload.project}...`
                            : intentRoute.intent === 'executeComputerActionPlan'
                                ? 'PLANNING SAFE COMPUTER ACTIONS...'
                                : `EXECUTING ${intentRoute.intent.replace(/([A-Z])/g, ' $1').toUpperCase()}...`;
                    res.write(`data: ${JSON.stringify({ action: { type: 'ACTION_EXECUTING', message: initialMessage } })}\n\n`);
                    emitActivity('PERMISSION_CHECK', 'RUNNING', 'Checking the existing action permission policy.');
                    const pendingApplicationStages = new Set<ActivityStage>();
                    
                    // Wait for the tool result
                    const toolResult = await toolRegistry.executeIntent(intentRoute.intent, intentRoute.payload, {
                        permissionEngine,
                        source,
                        gesture,
                        approvalGranted,
                        onProgress: intentRoute.intent === 'openApplication' || intentRoute.intent === 'executeComputerActionPlan'
                            ? message => {
                                const normalized = message.toLowerCase();
                                const stage: ActivityStage = normalized.includes('find') || normalized.includes('resolv')
                                    ? 'APPLICATION_RESOLUTION'
                                    : normalized.includes('open') || normalized.includes('launch')
                                        ? 'APPLICATION_LAUNCH'
                                        : 'APPLICATION_VERIFICATION';
                                if (pendingApplicationStages.size > 0 && !pendingApplicationStages.has(stage)) {
                                    for (const previousStage of pendingApplicationStages) {
                                        emitActivity(previousStage, 'COMPLETED',
                                            `${previousStage.replaceAll('_', ' ').toLowerCase()} completed.`);
                                    }
                                    pendingApplicationStages.clear();
                                }
                                pendingApplicationStages.add(stage);
                                emitActivity(stage, 'RUNNING', message);
                                res.write(`data: ${JSON.stringify({ action: { type: 'ACTION_EXECUTING', message } })}\n\n`);
                            }
                            : undefined
                    }, prompt);
                    let actionResult: unknown;
                    try {
                        actionResult = JSON.parse(toolResult);
                    } catch {
                        actionResult = null;
                    }
                    const parsedAction = actionResult && typeof actionResult === 'object'
                        ? actionResult as Record<string, unknown>
                        : null;
                    const verified = parsedAction?.verified === true;
                    for (const currentApplicationStage of pendingApplicationStages) {
                        emitActivity(
                            currentApplicationStage,
                            verified ? 'COMPLETED' : 'FAILED',
                            verified
                                ? `${currentApplicationStage.replaceAll('_', ' ').toLowerCase()} completed.`
                                : `The action did not complete ${currentApplicationStage.replaceAll('_', ' ').toLowerCase()}.`
                        );
                    }
                    emitActivity(
                        'PERMISSION_CHECK',
                        parsedAction?.type === 'ACTION_APPROVAL_REQUIRED' ? 'FAILED' : 'COMPLETED',
                        parsedAction?.type === 'ACTION_APPROVAL_REQUIRED'
                            ? 'Permission or approval denied the action.'
                            : 'Existing PermissionEngine policy allowed the attempted action.'
                    );
                    if (intentRoute.intent === 'openApplication' || intentRoute.intent === 'executeComputerActionPlan') {
                        emitActivity('APPLICATION_VERIFICATION', verified ? 'COMPLETED' : 'FAILED',
                            verified ? 'Application result was verified.' : 'The action did not return verified success.');
                    }
                    emitActivity(verified ? 'RESPONSE_READY' : 'FAILED', verified ? 'COMPLETED' : 'FAILED',
                        typeof parsedAction?.message === 'string' ? parsedAction.message : 'Action result received.');
                    if (actionResult && typeof actionResult === 'object' && 'type' in actionResult) {
                        res.write(`data: ${JSON.stringify({ action: actionResult })}\n\n`);
                    } else {
                        res.write(`data: ${JSON.stringify({ chunk: toolResult })}\n\n`);
                    }
                    res.write(`data: [DONE]\n\n`);
                    res.end();
                    return;
                }
            }
            
            emitActivity('RESPONSE_PROCESSING', 'RUNNING', `Processing ${intentRoute.intent} result.`);
            const toolResult = await toolRegistry.executeIntent(intentRoute.intent, intentRoute.payload, {
                permissionEngine,
                source,
                gesture,
                approvalGranted
            }, prompt);
            emitActivity('RESPONSE_PROCESSING', 'COMPLETED', `${intentRoute.intent} result processed.`);
            emitActivity('RESPONSE_READY', 'COMPLETED', `${intentRoute.intent} result is ready.`);
            if (intentRoute.intent === 'getSystemInfo') {
                return sendResult({ systemInfo: JSON.parse(toolResult) });
            }
            if (intentRoute.intent === 'analyzeCode') {
                return sendResult({ codeAnalysis: JSON.parse(toolResult) });
            }
            if (intentRoute.intent === 'listProjectFiles' || intentRoute.intent === 'findProjectFile' || intentRoute.intent === 'checkProjectExists') {
                return sendResult({ filesystemResult: JSON.parse(toolResult) });
            }
            if (intentRoute.intent === 'listInstalledApplications') {
                return sendResult({ installedApplications: JSON.parse(toolResult) });
            }
            if (intentRoute.intent === 'checkApplicationStatus') {
                return sendResult({ applicationResult: JSON.parse(toolResult) });
            }
            if (intentRoute.intent === 'closeChromeTabs' || intentRoute.intent === 'closeOpenApplications' || intentRoute.intent === 'switchChromeTab' ||
                intentRoute.intent === 'executeComputerActionPlan' || intentRoute.intent === 'unsupportedComputerAction') {
                return sendResult({ action: JSON.parse(toolResult) });
            }
            if (intentRoute.intent === 'openApplication' || intentRoute.intent === 'openProject') {
                try {
                    return sendResult({ action: JSON.parse(toolResult) });
                } catch {
                    return sendResult({ response: toolResult });
                }
            }
            return sendResult({ response: toolResult });
        }

        const selectedModel = model || process.env.OLLAMA_MODEL || 'qwen3:4b';
        const activeProvider = selectedLanguageProvider(req.body.provider);
        emitActivity('PROVIDER_SELECTION', 'COMPLETED', activeProvider);
        const providerStage = activeProvider === 'OPENAI' ? 'OPENAI_REQUEST' : 'OLLAMA_REQUEST';
        emitActivity(providerStage, 'RUNNING',
            activeProvider === 'OPENAI' ? `Requesting ${openAIProvider.configuredModel}.` : `Requesting ${selectedModel}.`);
        emitActivity('RESPONSE_PROCESSING', 'RUNNING', 'Waiting for the selected language provider response.');

        if (streaming) {
            if (activeProvider === 'OPENAI') {
                const response = await openAIProvider.chat(prompt);
                emitActivity('OPENAI_REQUEST', 'COMPLETED', 'OpenAI returned a response.');
                writeEvent({ provider: 'OPENAI' });
                emitActivity('RESPONSE_PROCESSING', 'COMPLETED', 'Response processing completed.');
                writeEvent({ chunk: response });
            } else {
                let providerReported = false;
                await aiProvider.chatStream(prompt, selectedModel, (chunk: string) => {
                    if (!providerReported) {
                        writeEvent({ provider: 'OLLAMA' });
                        providerReported = true;
                    }
                    writeEvent({ chunk });
                });
                emitActivity('OLLAMA_REQUEST', 'COMPLETED', 'Ollama returned a response.');
                emitActivity('RESPONSE_PROCESSING', 'COMPLETED', 'Response processing completed.');
            }
            emitActivity('RESPONSE_READY', 'COMPLETED', 'Response ready.');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        const response = activeProvider === 'OPENAI'
            ? await openAIProvider.chat(prompt)
            : await aiProvider.chat(prompt, selectedModel);
        emitActivity(providerStage, 'COMPLETED', `${activeProvider} returned a response.`);
        writeEvent({ provider: activeProvider });
        emitActivity('RESPONSE_PROCESSING', 'COMPLETED', 'Response processing completed.');
        emitActivity('RESPONSE_READY', 'COMPLETED', 'Response ready.');
        res.json({ type: 'AI_RESPONSE', answer: response, response, provider: activeProvider });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'The request could not be completed.';
        if (streaming && streamStarted) {
            emitActivity('FAILED', 'FAILED', message);
            res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        res.status(500).json({ error: message });
    }
});

const server = app.listen(port, '127.0.0.1', () => {
    console.log(`CLIRO Backend running on http://localhost:${port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`CLIRO backend cannot start: port ${port} is already in use.`);
    } else {
        console.error(`CLIRO backend failed to start: ${error.message}`);
    }
    process.exit(1);
});
