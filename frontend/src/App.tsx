import { useState, useEffect, useRef, useCallback } from 'react';
import VisionVoiceControls from './VisionVoiceControls';
import HolographicGlobe from './HolographicGlobe';
import type { HeadRotation } from './VisionVoiceControls';
import type { GestureAction } from './vision/GestureRecognizer';
import {
  DEFAULT_SPEECH_PREFERENCES,
  classifyVoiceCommand,
  isFemaleEnglishVoice,
  LocalSpeechQueue,
  selectSpeechVoice
} from './speech';
import type { SpeechPlaybackState, SpeechPreferences } from './speech';
import {
  configureChromeTabActions,
  getChromeBridgeStatus,
  runChromeTabGesture
} from './chromeTabActions';
import { actionLabelFor, actionStateFor, isStructuredActionSuccess } from './actionTrust';
import type { ChromeBridgeStatus, ChromeTabOperation, ChromeTabResult } from './chromeBridge';
import { activityMarkFor, mergeActivityEvent } from './activity';
import type { ActivityEvent } from './activity';
import './index.css';
import './command-center.css';

interface BatteryStatus { percent: number; isCharging: boolean; hasBattery: boolean; }
interface SystemStatus { cpu: string; ram: string; storage: string; os: string; battery: BatteryStatus; }
interface OllamaModelsResponse { models?: string[]; configuredModel?: string; }
interface ProviderStatusResponse {
  preferredProvider?: 'OLLAMA' | 'OPENAI';
  openaiConfigured?: boolean;
  imageGenerationConfigured?: boolean;
  imageGenerationProvider?: string;
}
interface CodeAnalysisFinding { file?: string; line?: number; severity: 'error' | 'warning' | 'info'; type: string; message: string; }
interface CodeAnalysisResult {
  type: 'CODE_ANALYSIS';
  project: string;
  success: boolean;
  message: string;
  analysisMethod: string;
  durationMs: number;
  filesScanned: string[];
  filesSkipped: Array<{ file: string; reason: string }>;
  skippedCount: number;
  excludedDirectories: string[];
  bounded: boolean;
  findingsTruncated: boolean;
  errors: CodeAnalysisFinding[];
  warnings: CodeAnalysisFinding[];
  informationalFindings: CodeAnalysisFinding[];
}
interface Message {
  role: 'user' | 'cliro';
  content: string;
  createdAt: string;
  speechId?: string;
  isAction?: boolean;
  actionState?: 'executing' | 'success' | 'failed';
  actionLabel?: string;
  preserveFormatting?: boolean;
  kind?: 'ai' | 'response' | 'system' | 'filesystem' | 'analysis' | 'error' | 'application' | 'verified' | 'verification-error';
  analysis?: CodeAnalysisResult;
  factSource?: { title: string; url: string; provider: string };
  imageDataUrl?: string;
  verifiedAt?: string;
  cached?: boolean;
  trustProjectId?: string;
  trustRequestId?: string;
  workspaceTrustStatus?: 'TRUSTED' | 'RESTRICTED' | 'UNAVAILABLE' | 'WRONG_WORKSPACE' | 'OUTSIDE_CLIRO_ROOT' | 'CANCELLED' | 'PENDING_USER_CONFIRMATION';
}
type ActionSource = 'chat' | 'voice' | 'gesture';
type DetectedGesture = 'FIST' | 'ROTATE_LEFT' | 'ROTATE_RIGHT' | 'OPEN_PALM' | 'CLOSED_FIST' | 'THUMBS_UP' | 'THUMBS_DOWN' | 'POINT' | 'V_SIGN';
type ActiveView = 'command-center' | 'agent' | 'system' | 'history' | 'projects' | 'code-analysis' | 'settings';
interface UserProject {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string;
  status: 'ready';
  template?: ProjectTemplate;
  language?: string;
  buildStatus?: 'NOT_RUN' | 'BUILDING' | 'PASSED' | 'FAILED';
  testStatus?: 'NOT_RUN' | 'TESTING' | 'PASSED' | 'FAILED' | 'NOT_CONFIGURED';
  runStatus?: 'STOPPED' | 'STARTING' | 'RUNNING' | 'FAILED';
}
type ProjectTemplate = 'blank' | 'basic' | 'react' | 'node' | 'typescript' | 'python' | 'html';
interface ProjectTreeEntry { path: string; type: 'file' | 'folder'; depth: number; }
interface ProjectSnapshot {
  project: UserProject;
  fileCount: number;
  folderCount: number;
  languages: string[];
  dependencyFiles: string[];
  dependencies: string[];
  dependencyDiagnostics: string[];
  entryPoints: string[];
  files: ProjectTreeEntry[];
  bounded: boolean;
  gitStatus: string;
  scannedAt: string;
}
interface ProjectExecutionResult {
  executionId: string;
  projectId: string;
  status: 'AWAITING_APPROVAL' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | string;
  buildResult?: { status: string; verified: boolean; command?: { exitCode: number | null; stdout: string; stderr: string } };
  testResult?: { status: string; verified: boolean; command?: { exitCode: number | null; stdout: string; stderr: string } };
  runResult?: { status: string; verified: boolean; pid?: number; port?: number; url?: string; error?: string };
  vsCodeResult?: {
    verified?: boolean;
    message?: string;
    workspacePath?: string;
    projectId?: string;
    workspaceTrustStatus?: Message['workspaceTrustStatus'];
    states?: string[];
  };
  diagnosis?: { category: string; summary: string; suggestedFix: string };
  error?: string;
}
interface ProjectSelectionResult {
  id: string;
  name: string;
  path: string;
  fileCount: number;
  files: string[];
}
interface VisionUiStatus {
  cameraState: string;
  handTrackingState: string;
  voiceEnabled: boolean;
}

const SPEECH_PREFERENCES_KEY = 'cliro.speech.preferences';

function isCancellationRequest(text: string): boolean {
  return /^(?:please\s+)?(?:cancel(?:\s+that)?|cancel\s*(?:pannu|பண்ணு)|வேண்டாம்|நிறுத்து|நிறுத்திவிடு)[.!?]*$/iu.test(text.trim());
}

function loadSpeechPreferences(): SpeechPreferences {
  try {
    const stored = localStorage.getItem(SPEECH_PREFERENCES_KEY);
    if (!stored) return DEFAULT_SPEECH_PREFERENCES;
    const parsed = JSON.parse(stored) as Partial<SpeechPreferences>;
    return {
      ...DEFAULT_SPEECH_PREFERENCES,
      ...parsed,
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SPEECH_PREFERENCES.enabled,
      voiceURI: typeof parsed.voiceURI === 'string' ? parsed.voiceURI : '',
      rate: typeof parsed.rate === 'number' ? Math.min(1.2, Math.max(0.7, parsed.rate)) : DEFAULT_SPEECH_PREFERENCES.rate,
      pitch: typeof parsed.pitch === 'number' ? Math.min(1.4, Math.max(0.8, parsed.pitch)) : DEFAULT_SPEECH_PREFERENCES.pitch,
      volume: typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : DEFAULT_SPEECH_PREFERENCES.volume
    };

  } catch {
    return DEFAULT_SPEECH_PREFERENCES;
  }
}

function historyMessage(message: Omit<Message, 'createdAt'>): Message {
  return { ...message, createdAt: new Date().toISOString() };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `Request failed with HTTP ${response.status}.`;
    throw new Error(detail);
  }
  return data as T;
}
interface PendingActionApproval {
  prompt: string;
  source: ActionSource;
  gesture?: DetectedGesture;
  approvalRequestId?: string;
  projectName?: string;
  projectTemplate?: ProjectTemplate;
  openInVSCode?: boolean;
  expiresAt?: string;
  approvalType?: 'DEPENDENCY_INSTALL' | 'REPAIR_FIX' | 'IMAGE_GENERATION' | 'PROJECT_MODIFICATION';
  executionId?: string;
  projectId?: string;
  projectPath?: string;
  dependencies?: string[];
  command?: string;
  repairProposal?: { filePath: string; summary: string };
  projectPlan?: {
    projectName: string;
    description: string;
    language: string;
    frontend: string;
    backend: string;
    database: string;
    features: string[];
    roles: string[];
    folders: string[];
    files: string[];
    dependencies: string[];
    commands: string[];
    testPlan: string[];
  };
  imagePlan?: {
    provider: string;
    purpose: string;
    prompt: string;
    count: number;
    projectName?: string;
    outputPaths: string[];
  };
  modificationPlan?: {
    instruction: string;
    changes: Array<{
      operation: 'CREATE' | 'REPLACE';
      path: string;
      content: string;
      diff: {
        beforeBytes: number;
        afterBytes: number;
        beforeLines: number;
        afterLines: number;
        lineDelta: number;
      };
    }>;
  };
}

const apiUrl = (path: string) => {
  const baseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
  if (baseUrl) return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  return path;
};


function responseLabelFor(kind: Message['kind']): string {
  switch (kind) {
    case 'ai': return 'AI RESPONSE';
    case 'system': return 'SYSTEM';
    case 'filesystem': return 'PROJECT RESULT';
    case 'application': return 'APPLICATION RESULT';
    case 'error': return 'REQUEST ERROR';
    case 'verified': return 'VERIFIED';
    case 'verification-error': return 'VERIFICATION FAILED';
    default: return 'CLIRO RESPONSE';
  }
}

function formatCodeAnalysis(result: CodeAnalysisResult): string {
  const lines = [
    result.message,
    `Project: ${result.project}`,
    `Analysis method: ${result.analysisMethod}`,
    `Duration: ${result.durationMs} ms`,
    `Files scanned: ${result.filesScanned.length}`
  ];
  if (result.filesScanned.length > 0) {
    lines.push(...result.filesScanned.slice(0, 20).map(file => `  ${file}`));
    if (result.filesScanned.length > 20) lines.push(`  …and ${result.filesScanned.length - 20} more`);
  }
  if (result.skippedCount > 0) {
    lines.push(`Files skipped: ${result.skippedCount}`);
    lines.push(...result.filesSkipped.slice(0, 10).map(file => `  ${file.file}: ${file.reason}`));
    if (result.skippedCount > result.filesSkipped.length) lines.push(`  …and ${result.skippedCount - result.filesSkipped.length} more`);
  }
  if (result.excludedDirectories.length > 0) {
    lines.push(`Excluded directories: ${result.excludedDirectories.join(', ')}`);
  }

  for (const [heading, findings] of [
    ['Errors', result.errors],
    ['Warnings', result.warnings],
    ['Informational findings', result.informationalFindings]
  ] as const) {
    if (findings.length === 0) continue;
    lines.push(`${heading} (${findings.length}):`);
    lines.push(...findings.slice(0, 50).map(finding =>
      `  ${finding.type}${finding.file ? ` — ${finding.file}` : ''}${finding.line ? `:${finding.line}` : ''}\n  ${finding.message}`
    ));
    if (findings.length > 50) lines.push(`  …and ${findings.length - 50} more`);
  }
  if (result.findingsTruncated) lines.push('Some findings were omitted because the reporting limit was reached.');
  if (result.bounded) lines.push('The analysis was bounded; not every eligible project file may have been scanned.');
  return lines.join('\n');
}

function CodeAnalysisCard({ result }: { result: CodeAnalysisResult }) {
  const groups: Array<{ label: string; items: CodeAnalysisFinding[]; tone: string }> = [
    { label: 'ERROR', items: result.errors, tone: 'error' },
    { label: 'WARNING', items: result.warnings, tone: 'warning' },
    { label: 'INFO', items: result.informationalFindings, tone: 'info' }
  ];

  return (
    <section className="analysis-card">
      <div className="analysis-card-header">
        <div>
          <span className="eyebrow">STATIC INSPECTION</span>
          <h3>Code analysis</h3>
        </div>
        <span className={`analysis-status ${!result.success ? 'failed' : result.errors.length ? 'issues' : 'clean'}`}>
          {!result.success ? 'FAILED' : result.errors.length ? 'ERRORS FOUND' : result.warnings.length ? 'WARNINGS' : 'NO ERRORS'}
        </span>
      </div>
      <div className="analysis-stats">
        <div><span>PROJECT</span><strong>{result.project.toUpperCase()}</strong></div>
        <div><span>FILES SCANNED</span><strong>{result.filesScanned.length}</strong></div>
        <div><span>ERRORS</span><strong className={result.errors.length ? 'tone-error' : ''}>{result.errors.length}</strong></div>
        <div><span>WARNINGS</span><strong className={result.warnings.length ? 'tone-warning' : ''}>{result.warnings.length}</strong></div>
      </div>
      <p className="analysis-summary">{result.message}</p>
      <div className="analysis-method"><span>METHOD</span>{result.analysisMethod}</div>
      <div className="analysis-method"><span>BUILD / TEST</span>Not run · this result is static analysis only</div>
      {result.filesSkipped.some(file => /sensitive/i.test(file.reason)) && (
        <div className="analysis-method">
          <span>SENSITIVE FILES</span>
          {result.filesSkipped.filter(file => /sensitive/i.test(file.reason)).length} omitted from inspection
        </div>
      )}
      {(result.skippedCount > 0 || result.excludedDirectories.length > 0 || result.bounded) && (
        <div className="analysis-coverage">
          <span>SCAN COVERAGE</span>
          <p>
            {result.skippedCount} file(s) skipped
            {result.excludedDirectories.length > 0 ? ` · excluded ${result.excludedDirectories.join(', ')}` : ''}
            {result.bounded ? ' · analysis reached a safety bound' : ''}
          </p>
        </div>
      )}
      {result.filesScanned.length > 0 && (
        <details className="analysis-file-list">
          <summary>SCANNED FILES <span>{result.filesScanned.length}</span></summary>
          <ul>{result.filesScanned.map(file => <li key={file}>{file}</li>)}</ul>
        </details>
      )}
      {groups.filter(group => group.items.length > 0).map(group => (
        <div className="finding-group" key={group.label}>
          <h4 className={`finding-heading ${group.tone}`}>{group.label}<span>{group.items.length}</span></h4>
          {group.items.map((finding, index) => (
            <article className={`finding-item ${group.tone}`} key={`${finding.file || finding.type}-${finding.line || index}-${index}`}>
              <div className="finding-location">
                <span>{finding.file || finding.type}</span>
                {finding.line ? <strong>LINE {finding.line}</strong> : null}
              </div>
              <p>{finding.message}</p>
            </article>
          ))}
        </div>
      ))}
      <div className="analysis-footer">
        <span>{result.filesScanned.length} FILES · {result.durationMs} MS</span>
        {result.findingsTruncated ? <span>FINDINGS LIMITED</span> : null}
      </div>
    </section>
  );
}

function App() {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [configuredModel, setConfiguredModel] = useState<string>('');
  const [selectedProvider, setSelectedProvider] = useState<'OLLAMA' | 'OPENAI'>('OLLAMA');
  const [activeProvider, setActiveProvider] = useState('—');
  const [openaiConfigured, setOpenaiConfigured] = useState(false);
  const [imageGenerationConfigured, setImageGenerationConfigured] = useState(false);
  const [imageGenerationProvider, setImageGenerationProvider] = useState('Unavailable');
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [activeExecutionId, setActiveExecutionId] = useState('');
  const [activeRunExecutionId, setActiveRunExecutionId] = useState('');
  const [connectionKnown, setConnectionKnown] = useState(false);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingActionApproval, setPendingActionApproval] = useState<PendingActionApproval | null>(null);
  const [agentState, setAgentState] = useState<'idle' | 'listening' | 'thinking' | 'vision' | 'executing' | 'success' | 'error'>('idle');
  const [speechPlaybackState, setSpeechPlaybackState] = useState<SpeechPlaybackState>('IDLE');
  const [activeView, setActiveView] = useState<ActiveView>('command-center');
  const [projects, setProjects] = useState<UserProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectSnapshot, setProjectSnapshot] = useState<ProjectSnapshot | null>(null);
  const [projectPanel, setProjectPanel] = useState<'create' | 'open' | null>(null);
  const [projectNameInput, setProjectNameInput] = useState('');
  const [projectPathInput, setProjectPathInput] = useState('');
  const [projectTemplateInput, setProjectTemplateInput] = useState<ProjectTemplate>('basic');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectNotice, setProjectNotice] = useState('');
  const [projectFilePath, setProjectFilePath] = useState('');
  const [projectFileContent, setProjectFileContent] = useState('');
  const [projectQuestion, setProjectQuestion] = useState('');
  const [projectAnswer, setProjectAnswer] = useState('');
  const [projectAnalysis, setProjectAnalysis] = useState<CodeAnalysisResult | null>(null);
  const [projectAnalysisAt, setProjectAnalysisAt] = useState('');
  const [visionUiStatus, setVisionUiStatus] = useState<VisionUiStatus>({
    cameraState: 'OFF',
    handTrackingState: 'OFF',
    voiceEnabled: false
  });
  const [avatarHeadRotation, setAvatarHeadRotation] = useState<HeadRotation | null>(null);
  const [speechPreferences, setSpeechPreferences] = useState<SpeechPreferences>(loadSpeechPreferences);
  const [speechVoices, setSpeechVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [chromeBridgeStatus, setChromeBridgeStatus] = useState<ChromeBridgeStatus>({
    connected: false,
    chromeWindowAvailable: false,
    eligibleTabCount: 0
  });
  const speechAvailable = typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined';
  const speechQueueRef = useRef<LocalSpeechQueue | null>(null);
  const speechVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const speechMessageSequenceRef = useRef(0);
  const lastRepeatableResponseRef = useRef<{ content: string; id: string } | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const cancelApprovalRef = useRef<HTMLButtonElement>(null);
  const cancelledExecutionIdsRef = useRef(new Set<string>());
  const chatInputRef = useRef<HTMLInputElement>(null);
  const workspaceContentRef = useRef<HTMLElement>(null);
  const selectedProjectIdRef = useRef('');
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const onVisionStatusChange = useCallback((status: VisionUiStatus) => {
    setVisionUiStatus(status);
  }, []);
  const refreshChromeBridgeStatus = useCallback(async () => {
    setChromeBridgeStatus(await getChromeBridgeStatus());
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(SPEECH_PREFERENCES_KEY, JSON.stringify(speechPreferences));
    } catch (error) {
      console.error('Could not save speech preferences:', error);
    }
  }, [speechPreferences]);

  useEffect(() => {
    if (!speechAvailable) return;
    const synthesis = window.speechSynthesis;
    const refreshVoices = () => {
      const voices = synthesis.getVoices();
      setSpeechVoices(voices);
      speechVoiceRef.current = selectSpeechVoice(voices);
    };
    speechQueueRef.current = new LocalSpeechQueue(
      synthesis,
      text => new SpeechSynthesisUtterance(text),
      () => speechVoiceRef.current,
      setSpeechPlaybackState
    );
    refreshVoices();
    synthesis.addEventListener('voiceschanged', refreshVoices);
    return () => {
      synthesis.removeEventListener('voiceschanged', refreshVoices);
      speechQueueRef.current?.stop();
      speechQueueRef.current = null;
    };
  }, [speechAvailable]);

  useEffect(() => {
    speechVoiceRef.current = selectSpeechVoice(speechVoices, speechPreferences.voiceURI);
  }, [speechVoices, speechPreferences.voiceURI]);

  useEffect(() => {
    configureChromeTabActions({
      async authorize(action: ChromeTabOperation) {
        const response = await requestJson<{ authorizationId: string }>(
          apiUrl('/api/chrome/tab-gesture/authorize'),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
          }
        );
        return response;
      },
      async complete(authorizationId: string, action: ChromeTabOperation, result: ChromeTabResult) {
        const response = await requestJson<{ result: ChromeTabResult }>(
          apiUrl('/api/chrome/tab-gesture/complete'),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authorizationId, action, result })
          }
        );
        return response.result;
      }
    });
    void refreshChromeBridgeStatus();
    const interval = window.setInterval(() => void refreshChromeBridgeStatus(), 5_000);
    return () => window.clearInterval(interval);
  }, [refreshChromeBridgeStatus]);

  const speakResponse = useCallback((
    text: string,
    source: ActionSource,
    id: string,
    force = false
  ) => {
    if (force || source === 'voice' || speechPreferences.enabled) {
      speechQueueRef.current?.speak(text, id, speechPreferences);
    }
  }, [speechPreferences]);

  const stopSpeech = useCallback(() => {
    speechQueueRef.current?.stop();
  }, []);

  const interruptSpeech = useCallback(() => {
    speechQueueRef.current?.interrupt();
  }, []);

  const nextSpeechMessageId = useCallback(
    () => `cliro-response-${++speechMessageSequenceRef.current}`,
    []
  );

  const appendAssistantMessage = useCallback((
    message: Omit<Message, 'createdAt' | 'role'>,
    source: ActionSource
  ) => {
    const id = nextSpeechMessageId();
    const response = historyMessage({ role: 'cliro', ...message, speechId: id });
    setMessages(previous => [...previous, response]);
    if (
      !response.isAction &&
      ['ai', 'response', 'verified', 'system', 'filesystem', 'application'].includes(response.kind || '')
    ) {
      lastRepeatableResponseRef.current = { content: response.content, id };
    }
    speakResponse(response.content, source, id);
    return response;
  }, [nextSpeechMessageId, speakResponse]);

  useEffect(() => {
    if (!activeRunExecutionId) return;
    const stream = new EventSource(apiUrl(`/api/projects/executions/${encodeURIComponent(activeRunExecutionId)}/events`));
    stream.onmessage = event => {
      try {
        const parsed = JSON.parse(event.data) as { activity?: ActivityEvent };
        if (!parsed.activity) return;
        const activity = parsed.activity;
        setActivityEvents(previous => mergeActivityEvent(previous, activity));
        if (activity.stage === 'RUNNING' && activity.status === 'FAILED') {
          appendAssistantMessage({
            content: activity.message,
            isAction: true,
            kind: 'response',
            actionState: 'failed',
            actionLabel: 'RUN PROCESS STOPPED'
          }, 'chat');
          setActiveRunExecutionId('');
          setAgentState('error');
          stream.close();
        } else if (activity.stage === 'CANCELLED') {
          setActiveRunExecutionId('');
          stream.close();
        }
      } catch (error) {
        console.error('Could not parse project execution activity:', error);
      }
    };
    stream.onerror = () => stream.close();
    return () => stream.close();
  }, [activeRunExecutionId, appendAssistantMessage]);

  useEffect(() => {
    checkConnection();
    fetchSystemStatus();
    const interval = setInterval(() => {
      checkConnection();
      fetchSystemStatus();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleScroll = () => {
    if (!chatContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    // If we are within 100px of the bottom, enable auto-scroll
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    setShouldAutoScroll(isNearBottom);
  };

  useEffect(() => { 
    if (shouldAutoScroll) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, shouldAutoScroll]);

  useEffect(() => {
    if (pendingActionApproval) cancelApprovalRef.current?.focus();
  }, [pendingActionApproval]);

  const checkConnection = async () => {
    try {
      const res = await fetch(apiUrl('/api/ai/connection'), { signal: AbortSignal.timeout(7000) });
      if (!res.ok) throw new Error(`Connection check failed with status ${res.status}.`);
      const data = await res.json();
      const connected = data.connected === true;
      setIsConnected(connected);
      setConnectionKnown(true);
      if (connected) fetchModels();
    } catch (e) { setIsConnected(false); setConnectionKnown(true); }
  };

  const fetchModels = async () => {
    try {
      const res = await fetch(apiUrl('/api/ai/models'), { signal: AbortSignal.timeout(7000) });
      if (!res.ok) throw new Error(`Model listing failed with status ${res.status}.`);
      const data = await res.json() as OllamaModelsResponse;
      const models = Array.isArray(data.models) ? data.models.filter(model => typeof model === 'string') : [];
      const configured = typeof data.configuredModel === 'string' ? data.configuredModel : '';
      setConfiguredModel(configured);
      setSelectedModel(current => current && models.includes(current)
        ? current
        : models.includes(configured) ? configured : models[0] || '');
    } catch (e) {}
  };

  const fetchSystemStatus = async () => {
    try {
      const res = await fetch(apiUrl('/api/status'), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`System status request failed with status ${res.status}.`);
      const data = await res.json();
      setBackendOnline(data.status === 'online');
      if (data.system) setSystemStatus(data.system);
    } catch (e) {
      setBackendOnline(false);
    }
  };

  async function fetchProviders() {
    try {
      const result = await requestJson<ProviderStatusResponse>(apiUrl('/api/ai/providers'), {
        signal: AbortSignal.timeout(7000)
      });
      setOpenaiConfigured(result.openaiConfigured === true);
      setImageGenerationConfigured(result.imageGenerationConfigured === true);
      setImageGenerationProvider(result.imageGenerationProvider || 'Unavailable');
      setSelectedProvider(result.preferredProvider === 'OPENAI' ? 'OPENAI' : 'OLLAMA');
    } catch {
      setOpenaiConfigured(false);
      setImageGenerationConfigured(false);
      setImageGenerationProvider('Unavailable');
      setSelectedProvider('OLLAMA');
    }
  }

  useEffect(() => {
    void fetchProviders();
  }, []);

  const handleSend = async (
    customMessage?: string,
    source: ActionSource = 'chat',
    gesture?: DetectedGesture,
    approvalDecision?: boolean,
    userMessageAlreadyShown = false,
    approvalRequestId?: string
  ): Promise<boolean> => {
    const submittedText = customMessage ?? input;
    if (!submittedText.trim()) return false;

    if (pendingActionApproval && approvalDecision === undefined) {
      if (!isCancellationRequest(submittedText)) return false;
      setMessages(prev => [...prev, historyMessage({ role: 'user', content: submittedText })]);
      if (pendingActionApproval.executionId) {
        void decideExecutionApproval(pendingActionApproval, false);
      } else {
        void handleSend(
          pendingActionApproval.prompt,
          pendingActionApproval.source,
          pendingActionApproval.gesture,
          false,
          true,
          pendingActionApproval.approvalRequestId
        );
      }
      return true;
    }

    if (!userMessageAlreadyShown) {
      setInput('');
      setMessages(prev => [...prev, historyMessage({ role: 'user', content: submittedText })]);
    }

    if (isCancellationRequest(submittedText) && (activeExecutionId || activeRunExecutionId)) {
      stopSpeech();
      void stopProjectExecution(activeRunExecutionId || activeExecutionId);
      return true;
    }

    const voiceCommand = classifyVoiceCommand(submittedText);
    if (voiceCommand?.type === 'repeat') {
      stopSpeech();
      const lastResponse = lastRepeatableResponseRef.current;
      if (lastResponse) {
        speakResponse(lastResponse.content, source, nextSpeechMessageId(), true);
      } else {
        const message = 'There is no assistant response available to repeat yet.';
        setMessages(prev => [...prev, historyMessage({ role: 'cliro', content: message, kind: 'system' })]);
        speakResponse(message, source, nextSpeechMessageId(), true);
      }
      setAgentState('idle');
      return true;
    }

    let textToSend = submittedText;
    if (voiceCommand?.type === 'stop') {
      stopSpeech();
      if (!voiceCommand.remainingCommand) {
        setAgentState(visionUiStatus.voiceEnabled ? 'listening' : 'idle');
        return true;
      }
      textToSend = voiceCommand.remainingCommand;
    } else if (source === 'voice') {
      interruptSpeech();
    }
    const normalizedPrompt = textToSend.toLowerCase();
    const requiresApproval =
      /\bclose\b.*\bchrome\b.*\btabs?\b|\bclose\s+(?:all\s+)?tabs?\s+in\s+chrome\b|\bclose\s+(?:(?:all|open)\s+)?(?:my\s+)?(?:open\s+)?applications?\b|\bclose\s+(?:all\s+)?open\s+apps?\b/.test(normalizedPrompt) ||
      /^(?:please\s+)?(?:close|exit)\s+(?:notepad|windows notepad|notepad\.exe|calculator|windows calculator|calc|chrome|google chrome|edge|microsoft edge|vs code|vscode|code|visual studio code|explorer|file explorer|windows explorer|paint|microsoft paint|mspaint|terminal|windows terminal|command prompt|cmd|powershell|settings|task manager|this|the current|current|it|the folder|this folder|the current folder|this application|this app|the current window|this window)\b/.test(normalizedPrompt) ||
      /^press\s+(?:ctrl|control)\+v\b/.test(normalizedPrompt);
    if (requiresApproval && approvalDecision === undefined) {
      setPendingActionApproval({ prompt: textToSend, source, gesture });
      setAgentState('idle');
      return false;
    }
    setPendingActionApproval(null);
    const approvalGranted = approvalDecision === true;
    setActivityEvents([{
      stage: 'REQUEST_RECEIVED',
      status: 'QUEUED',
      message: 'Request queued for CLIRO.',
      at: new Date().toISOString()
    }]);
    setAgentState('executing');

    try {
      const res = await fetch(apiUrl('/api/ai/chat?stream=true'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: textToSend,
          model: selectedModel || configuredModel || 'qwen3:4b',
          provider: selectedProvider,
          source,
          gesture,
          approvalGranted,
          approvalRequestId,
          selectedProjectId: selectedProjectIdRef.current
        })
      });

      const displayProjectApproval = (action: {
        approvalRequestId?: string;
        approvalType?: 'DEPENDENCY_INSTALL' | 'REPAIR_FIX' | 'IMAGE_GENERATION' | 'PROJECT_MODIFICATION';
        executionId?: string;
        projectId?: string;
        projectPath?: string;
        dependencies?: string[];
        command?: string;
        repairProposal?: { filePath: string; summary: string };
        projectName?: string;
        projectTemplate?: ProjectTemplate;
        openInVSCode?: boolean;
        expiresAt?: string;
        projectPlan?: PendingActionApproval['projectPlan'];
        imagePlan?: PendingActionApproval['imagePlan'];
        modificationPlan?: PendingActionApproval['modificationPlan'];
      }) => {
        if (!action.approvalRequestId) {
          appendAssistantMessage({
            content: 'The backend requested approval but did not provide a valid approval request ID.',
            kind: 'error'
          }, source);
          setAgentState('error');
          return false;
        }
        setPendingActionApproval({
          prompt: textToSend,
          source,
          gesture,
          approvalRequestId: action.approvalRequestId,
          projectName: action.projectName,
          projectTemplate: action.projectTemplate,
          openInVSCode: action.openInVSCode,
          expiresAt: action.expiresAt,
          approvalType: action.approvalType,
          executionId: action.executionId,
          projectId: action.projectId,
          projectPath: action.projectPath,
          dependencies: action.dependencies,
          command: action.command,
          repairProposal: action.repairProposal,
          projectPlan: action.projectPlan,
          imagePlan: action.imagePlan,
          modificationPlan: action.modificationPlan
        });
        setAgentState('idle');
        return true;
      };
      
      if (!res.ok) {
        let errorMessage = `Request failed with status ${res.status}.`;
        try {
          const data = await res.json();
          if (typeof data.error === 'string' && data.error.trim()) errorMessage = data.error;
        } catch {}
        appendAssistantMessage({ content: `[ERROR] ${errorMessage}`, kind: 'error' }, source);
        setAgentState('error');
        return false;
      }

      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
         const data = await res.json();
         if (data.type === 'VERIFIED_FACT') {
             appendAssistantMessage({
               content: data.answer,
               kind: 'verified',
               factSource: data.source,
               verifiedAt: data.verifiedAt,
               cached: data.cached
             }, source);
             setAgentState('success');
         } else if (
             data.type === 'VERIFICATION_FAILED' ||
             data.type === 'VERIFICATION_UNAVAILABLE' ||
             data.type === 'CURRENT_FACT_UNAVAILABLE'
         ) {
             appendAssistantMessage({
               content: data.message ?? data.answer ?? 'Current factual information could not be verified.',
               kind: 'verification-error',
               verifiedAt: data.verifiedAt,
               cached: false
             }, source);
             setAgentState('error');
         } else if (data.type === 'AI_RESPONSE') {
             appendAssistantMessage({ content: data.answer, kind: 'ai' }, source);
             setAgentState('idle');
         } else if (data.filesystemResult?.type === 'FILESYSTEM_RESULT') {
             const filesystemResult = data.filesystemResult;
             const entries = filesystemResult.entries?.map((entry: { name: string; type: string; path: string }) =>
               `[${entry.type}] ${entry.path}`
             ) ?? [];
             const matches = filesystemResult.matches?.map((match: { path: string }) => match.path) ?? [];
             const details = [...entries, ...matches].join('\n');
             appendAssistantMessage({
               content: details ? `${filesystemResult.message}\n${details}` : filesystemResult.message,
               kind: 'filesystem'
             }, source);
             setAgentState(filesystemResult.success ? 'idle' : 'error');
         } else if (data.codeAnalysis?.type === 'CODE_ANALYSIS') {
             const analysis = data.codeAnalysis as CodeAnalysisResult;
             appendAssistantMessage({
               content: formatCodeAnalysis(analysis),
               preserveFormatting: true,
               kind: 'analysis',
               analysis
             }, source);
             setAgentState(analysis.success ? 'success' : 'error');
         } else if (data.installedApplications?.type === 'APPLICATION_LIST') {
             const applications = data.installedApplications;
             const names = applications.applications.join('\n');
             const suffix = applications.truncated ? '\n…and more registered applications were omitted.' : '';
             appendAssistantMessage({
               content: `${applications.message}\n${names}${suffix}`,
               preserveFormatting: true,
               kind: 'application'
             }, source);
             setAgentState('idle');
         } else if (data.applicationResult?.type) {
             appendAssistantMessage({
               content: data.applicationResult.message,
               kind: 'application'
             }, source);
             setAgentState(data.applicationResult.type === 'APPLICATION_NOT_FOUND' ? 'error' : 'idle');
         } else if (data.systemInfo?.type === 'SYSTEM_INFO') {
             appendAssistantMessage({ content: data.systemInfo.message, kind: 'system' }, source);
             setAgentState('idle');
         } else if (data.action?.type === 'ACTION_APPROVAL_REQUIRED') {
             displayProjectApproval(data.action);
         } else if (data.action?.type === 'ACTION_CANCELLED') {
             appendAssistantMessage({ content: data.action.message || 'Project creation cancelled. No files were created.', kind: 'system' }, source);
             setAgentState('idle');
         } else if (data.projectResult?.type || data.vsCodeResult?.type || data.executionResult?.executionId) {
             const projectResult = data.projectResult;
             const vsCodeResult = data.vsCodeResult;
             if (projectResult) {
               appendAssistantMessage({
                 content: projectResult.message || 'Project creation returned no details.',
                 isAction: true,
                 kind: 'response',
                 actionState: projectResult.verified === true ? 'success' : 'failed',
                 actionLabel: projectResult.verified === true ? 'PROJECT VERIFIED' : 'PROJECT NOT VERIFIED'
               }, source);
             }
             if (vsCodeResult && !data.executionResult) {
               const trustRequired = vsCodeResult.workspaceTrustStatus === 'RESTRICTED';
               const trustUnavailable = vsCodeResult.workspaceTrustStatus === 'UNAVAILABLE';
               appendAssistantMessage({
                 content: [
                   vsCodeResult.message || 'VS Code returned no verification details.',
                   vsCodeResult.verified === true && vsCodeResult.workspacePath
                     ? `Workspace: ${vsCodeResult.workspacePath}`
                     : ''
                 ].filter(Boolean).join('\n'),
                 isAction: true,
                 kind: 'response',
                 actionState: vsCodeResult.verified === true ? 'success' : 'failed',
                 actionLabel: vsCodeResult.verified !== true ? 'VS CODE OPEN FAILED'
                   : trustRequired ? 'WORKSPACE TRUST REQUIRED'
                     : trustUnavailable ? 'WORKSPACE TRUST UNAVAILABLE' : 'VS CODE VERIFIED',
                 trustProjectId: trustRequired || trustUnavailable
                   ? vsCodeResult.projectId || projectResult?.projectId
                   : undefined,
                 workspaceTrustStatus: vsCodeResult.workspaceTrustStatus
               }, source);
             }
             if (data.executionResult) presentExecutionResult(data.executionResult as ProjectExecutionResult);
             else setAgentState(vsCodeResult && vsCodeResult.verified !== true ? 'error' : projectResult?.verified === true ? 'success' : 'error');
         } else if (data.action && isStructuredActionSuccess(data.action)) {
             appendAssistantMessage({
               content: data.action.message ?? 'Action completed.',
               isAction: true,
               kind: 'response',
               actionState: 'success',
               actionLabel: 'ACTION VERIFIED'
             }, source);
             setAgentState('success');
         } else if (data.action?.type) {
             const actionState = actionStateFor(data.action.type, data.action.verified);
             appendAssistantMessage({
               content: data.action.message,
               isAction: true,
               kind: 'response',
               actionState,
               actionLabel: data.action.verified === true ? 'ACTION VERIFIED' : actionLabelFor(data.action.type, data.action.message)
             }, source);
             setAgentState(actionState === 'success' ? 'success' : actionState === 'failed' ? 'error' : 'executing');
         } else {
             appendAssistantMessage({
               content: data.response ?? data.error ?? 'The backend returned an empty response.',
               kind: 'ai'
             }, source);
             setAgentState('idle');
         }
         return true;
      }

      if (!res.body) {
        appendAssistantMessage({ content: '[ERROR] The backend response stream was empty.', kind: 'error' }, source);
        setAgentState('error');
        return false;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      
      let currentResponse = '';
      let streamFailed = false;
      let actionEventReceived = false;
      let structuredResultReceived = false;
      let streamedActionResponse: string | null = null;
      let streamErrorResponse: string | null = null;
      const streamingSpeechId = nextSpeechMessageId();
      const streamingMessage = historyMessage({
        role: 'cliro',
        content: '',
        kind: 'ai',
        speechId: streamingSpeechId
      });
      setMessages(prev => [...prev, streamingMessage]);
      let eventBuffer = '';
      let streamDone = false;
      const consumeEvent = (frame: string) => {
        const dataStr = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!dataStr) return;
        if (dataStr === '[DONE]') {
          streamDone = true;
          return;
        }
        let parsed: {
          error?: string;
          action?: {
            type?: string;
            message?: string;
            verified?: boolean;
            approvalRequestId?: string;
            approvalType?: 'DEPENDENCY_INSTALL' | 'REPAIR_FIX' | 'IMAGE_GENERATION' | 'PROJECT_MODIFICATION';
            executionId?: string;
            projectId?: string;
            projectPath?: string;
            dependencies?: string[];
            command?: string;
            repairProposal?: { filePath: string; summary: string };
            projectName?: string;
            projectTemplate?: ProjectTemplate;
            openInVSCode?: boolean;
            expiresAt?: string;
            projectPlan?: PendingActionApproval['projectPlan'];
          };
          chunk?: string;
          provider?: string;
          activity?: ActivityEvent;
          result?: {
            type?: string;
            answer?: string;
            message?: string;
            provider?: string;
            reason?: string;
            requiredConfiguration?: string[];
            verified?: boolean;
            verifiedAt?: string;
            cached?: boolean;
            source?: Message['factSource'];
            response?: string;
            action?: {
              type?: string;
              message?: string;
              verified?: boolean;
              approvalRequestId?: string;
              approvalType?: 'DEPENDENCY_INSTALL' | 'REPAIR_FIX';
              executionId?: string;
              projectId?: string;
              projectPath?: string;
              dependencies?: string[];
              command?: string;
              repairProposal?: { filePath: string; summary: string };
              projectName?: string;
              projectTemplate?: ProjectTemplate;
              openInVSCode?: boolean;
              expiresAt?: string;
              projectPlan?: PendingActionApproval['projectPlan'];
              imagePlan?: PendingActionApproval['imagePlan'];
              modificationPlan?: PendingActionApproval['modificationPlan'];
            };
            projectResult?: { type?: string; verified?: boolean; message?: string; projectId?: string };
            imageResult?: {
              type?: string;
              verified?: boolean;
              provider?: string;
              projectId?: string;
              prompt?: string;
              imagePath?: string;
              imagePaths?: string[];
              message?: string;
              images?: Array<{ path?: string; absolutePath?: string; format?: string; mimeType?: string; size?: number; verified?: boolean; error?: string }>;
            };
            projectModificationResult?: {
              verified?: boolean;
              partial?: boolean;
              changedPaths?: string[];
              verifiedPaths?: string[];
              message?: string;
            };
            projectSelection?: ProjectSelectionResult;
            vsCodeResult?: {
              type?: string;
              verified?: boolean;
              message?: string;
              application?: string;
              projectId?: string;
              projectPath?: string;
              workspacePath?: string;
              workspaceTrustStatus?: Message['workspaceTrustStatus'];
              states?: string[];
            };
            executionResult?: {
              [key: string]: unknown;
              projectSelection?: ProjectSelectionResult;
            } & ProjectExecutionResult;
            systemInfo?: { type?: string; message?: string };
            codeAnalysis?: CodeAnalysisResult;
            filesystemResult?: { type?: string; message?: string; success?: boolean };
            applicationResult?: { type?: string; message?: string };
          };
        };
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          streamFailed = true;
          streamErrorResponse = 'The backend returned an invalid streaming response.';
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMessage = newMsgs[newMsgs.length - 1];
            if (lastMessage) newMsgs[newMsgs.length - 1] = { ...lastMessage, content: `[ERROR] ${streamErrorResponse}`, kind: 'error' };
            return newMsgs;
          });
          setAgentState('error');
          return;
        }
        if (parsed.activity) {
          const activity = parsed.activity;
          setActivityEvents(previous => mergeActivityEvent(previous, activity));
          if (activity.projectId && activity.actionId && [
            'DEPENDENCIES_APPROVAL_REQUIRED', 'INSTALLING_DEPENDENCIES', 'BUILDING', 'TESTING',
            'STARTING', 'DIAGNOSING', 'FIXING', 'REBUILDING'
          ].includes(activity.stage)) {
            setActiveExecutionId(activity.actionId);
          }
          if (activity.stage === 'RUN_VERIFIED' && activity.verification === true) {
            setActiveRunExecutionId(activity.actionId || '');
            setActiveExecutionId('');
          }
          if (activity.stage === 'CANCELLED') {
            setActiveRunExecutionId('');
            setActiveExecutionId('');
          }
        } else if (parsed.provider) {
          setActiveProvider(parsed.provider);
        } else if (parsed.result) {
          structuredResultReceived = true;
          const result = parsed.result;
          if (result.action?.type === 'ACTION_APPROVAL_REQUIRED') {
            structuredResultReceived = true;
            setMessages(previous => previous.filter(message => message.speechId !== streamingSpeechId));
            if (result.projectResult) {
              appendAssistantMessage({
                content: result.projectResult.message || 'Project creation returned no details.',
                isAction: true,
                kind: 'response',
                actionState: result.projectResult.verified === true ? 'success' : 'failed',
                actionLabel: result.projectResult.verified === true ? 'PROJECT VERIFIED' : 'PROJECT NOT VERIFIED'
              }, source);
            }
            displayProjectApproval(result.action);
          } else if (result.action?.type === 'ACTION_CANCELLED') {
            structuredResultReceived = true;
            setMessages(previous => previous.filter(message => message.speechId !== streamingSpeechId));
            appendAssistantMessage({
              content: result.action.message || 'Project creation cancelled. No files were created.',
              kind: 'system'
            }, source);
            setAgentState('idle');
          } else if (result.projectSelection) {
            selectedProjectIdRef.current = result.projectSelection.id;
            setSelectedProjectId(result.projectSelection.id);
            void refreshProjects();
            setMessages(previous => previous.filter(message => message.speechId !== streamingSpeechId));
            appendAssistantMessage({
              content: `${result.answer || `${result.projectSelection.name} is open.`}\n${result.projectSelection.fileCount} project files inspected.`,
              kind: 'filesystem'
            }, source);
            setAgentState('idle');
          } else if (result.type === 'IMAGE_GENERATION_NOT_CONFIGURED') {
            appendAssistantMessage({
              content: [
                result.message || result.answer || 'Image generation provider is not configured.',
                result.provider ? `Provider: ${result.provider}` : '',
                result.reason ? `Reason: ${result.reason}` : '',
                Array.isArray(result.requiredConfiguration) && result.requiredConfiguration.length > 0
                  ? `Required configuration: ${result.requiredConfiguration.join(', ')}`
                  : ''
              ].filter(Boolean).join('\n'),
              kind: 'system'
            }, source);
            setAgentState('idle');
          } else if (result.imageResult) {
            setMessages(previous => previous.filter(message => message.speechId !== streamingSpeechId));
            const images = Array.isArray(result.imageResult.images) ? result.imageResult.images : [];
            const verified = result.imageResult.verified === true;
            const summary = images.map((image: { path?: string; absolutePath?: string; size?: number; verified?: boolean; error?: string }) =>
              image.path
                ? `${image.verified ? 'Verified' : 'Not verified'}: ${image.absolutePath || image.path}${image.size ? ` (${image.size} bytes)` : ''}${image.error ? ` — ${image.error}` : ''}`
                : `${image.verified ? 'Generated' : 'Not verified'} image${image.size ? ` (${image.size} bytes)` : ''}${image.error ? ` — ${image.error}` : ''}`
            ).join('\n');
            const generatedProjectId = result.imageResult.projectId;
            const preview = typeof generatedProjectId === 'string'
              ? images.find((image: { path?: string; verified?: boolean }) =>
                image.verified === true && typeof image.path === 'string'
              )
              : undefined;
            appendAssistantMessage({
              content: `${verified ? (result.imageResult.message || 'Image generated successfully.') : 'Image generation completed with verification failures.'}${summary ? `\n${summary}` : ''}`,
              kind: verified ? 'filesystem' : 'error',
              ...(preview?.path && generatedProjectId ? {
                imageDataUrl: apiUrl(
                  `/api/projects/${encodeURIComponent(generatedProjectId)}/image?path=${encodeURIComponent(preview.path)}`
                )
              } : {})
            }, source);
            if (images.some((image: { path?: string }) => image.path)) void refreshProjects();
            setAgentState(verified ? 'success' : 'error');
          } else if (result.projectModificationResult) {
            setMessages(previous => previous.filter(message => message.speechId !== streamingSpeechId));
            const modification = result.projectModificationResult;
            const changedPaths = Array.isArray(modification.changedPaths) ? modification.changedPaths : [];
            appendAssistantMessage({
              content: modification.verified === true
                ? `Project files changed and verified. Build and test were not run.\n${changedPaths.join('\n')}`
                : `${modification.partial ? 'Project modification stopped partway through; changed files may remain.' : 'Project modification was not verified.'}${modification.message ? `\n${modification.message}` : ''}${changedPaths.length ? `\nChanged paths:\n${changedPaths.join('\n')}` : ''}${modification.verifiedPaths?.length ? `\nRead-back verified:\n${modification.verifiedPaths.join('\n')}` : ''}`,
              isAction: true,
              kind: modification.verified === true ? 'response' : 'error',
              actionState: modification.verified === true ? 'success' : 'failed',
              actionLabel: modification.verified === true ? 'FILES VERIFIED' : 'MODIFICATION NOT VERIFIED'
            }, source);
            void refreshProjects();
            setAgentState(modification.verified === true ? 'success' : 'error');
          } else if (
            result.type === 'IMAGE_GENERATION_CANCELLED' ||
            result.type === 'IMAGE_CAPABILITY_UNSUPPORTED' ||
            result.type === 'IMAGE_GENERATION_FAILED' ||
            result.type === 'IMAGE_GENERATION_PROVIDER_ERROR' ||
            result.type === 'IMAGE_GENERATION_INVALID_REQUEST' ||
            result.type === 'IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE' ||
            result.type === 'PROJECT_MODIFICATION_UNAVAILABLE' ||
            result.type === 'PROJECT_MODIFICATION_FAILED' ||
            result.type === 'GENERATION_FAILED' ||
            result.type === 'INVALID_PLAN'
          ) {
            appendAssistantMessage({
              content: result.answer || result.message || 'The requested operation could not be completed.',
              kind: result.type === 'IMAGE_GENERATION_CANCELLED' ? 'system' : 'error'
            }, source);
            setAgentState(result.type === 'IMAGE_GENERATION_CANCELLED' ? 'idle' : 'error');
          } else if (result.projectResult || result.vsCodeResult || result.executionResult) {
            structuredResultReceived = true;
            setMessages(previous => previous.filter(message => message.speechId !== streamingSpeechId));
            const projectResult = result.projectResult;
            const vsCodeResult = result.vsCodeResult;
            if (projectResult) {
              appendAssistantMessage({
                content: projectResult.message || 'Project creation returned no details.',
                isAction: true,
                kind: 'response',
                actionState: projectResult.verified === true ? 'success' : 'failed',
                actionLabel: projectResult.verified === true ? 'PROJECT VERIFIED' : 'PROJECT NOT VERIFIED'
              }, source);
            }
            if (vsCodeResult && !result.executionResult) {
              appendAssistantMessage({
                content: [
                  vsCodeResult.message || 'VS Code returned no verification details.',
                  vsCodeResult.verified === true && vsCodeResult.workspacePath
                    ? `Workspace: ${vsCodeResult.workspacePath}`
                    : ''
                ].filter(Boolean).join('\n'),
                isAction: true,
                kind: 'response',
                actionState: vsCodeResult.verified === true ? 'success' : 'failed',
                actionLabel: vsCodeResult.verified === true ? 'VS CODE VERIFIED' : 'VS CODE OPEN FAILED'
              }, source);
            }
            if (result.executionResult) presentExecutionResult(result.executionResult);
            else setAgentState(vsCodeResult && vsCodeResult.verified !== true ? 'error' : projectResult?.verified === true ? 'success' : 'error');
          } else if (result.type === 'VERIFIED_FACT') {
            setActiveProvider('WEB VERIFIED');
            appendAssistantMessage({
              content: result.answer || '',
              kind: 'verified',
              factSource: result.source,
              verifiedAt: result.verifiedAt,
              cached: result.cached
            }, source);
            setAgentState('success');
          } else if (
            result.type === 'CURRENT_FACT_UNAVAILABLE' ||
            result.type === 'VERIFICATION_FAILED' ||
            result.type === 'VERIFICATION_UNAVAILABLE'
          ) {
            streamFailed = true;
            setActiveProvider('WEB VERIFIED');
            appendAssistantMessage({
              content: result.message ?? result.answer ?? 'Current factual information could not be verified.',
              kind: 'verification-error',
              verifiedAt: result.verifiedAt,
              cached: false
            }, source);
            setAgentState('error');
          } else if (result.action?.type) {
            const action = result.action;
            const actionState = actionStateFor(action.type || '', action.verified);
            actionEventReceived = true;
            streamedActionResponse = action.message || '';
            setMessages(prev => [...prev, historyMessage({
              role: 'cliro',
              content: action.message || '',
              isAction: true,
              kind: 'response',
              actionState,
              actionLabel: action.verified === true ? 'ACTION VERIFIED' : actionLabelFor(action.type || '', action.message || '')
            })]);
            setAgentState(actionState === 'success' ? 'success' : actionState === 'failed' ? 'error' : 'executing');
          } else if (result.systemInfo?.type === 'SYSTEM_INFO') {
            appendAssistantMessage({ content: result.systemInfo.message || '', kind: 'system' }, source);
            setAgentState('idle');
          } else if (result.codeAnalysis?.type === 'CODE_ANALYSIS') {
            appendAssistantMessage({
              content: formatCodeAnalysis(result.codeAnalysis),
              preserveFormatting: true,
              kind: 'analysis',
              analysis: result.codeAnalysis
            }, source);
            setAgentState(result.codeAnalysis.success ? 'success' : 'error');
          } else if (result.filesystemResult?.type === 'FILESYSTEM_RESULT') {
            appendAssistantMessage({ content: result.filesystemResult.message || '', kind: 'filesystem' }, source);
            setAgentState(result.filesystemResult.success ? 'idle' : 'error');
          } else if (result.applicationResult?.type) {
            appendAssistantMessage({ content: result.applicationResult.message || '', kind: 'application' }, source);
            setAgentState(result.applicationResult.type === 'APPLICATION_NOT_FOUND' ? 'error' : 'idle');
          } else {
            appendAssistantMessage({
              content: result.answer ?? result.response ?? result.message ?? 'The backend returned an empty response.',
              kind: result.type === 'CLARIFICATION' ? 'system' : 'ai'
            }, source);
            setAgentState('idle');
          }
        } else if (parsed.error) {
          streamFailed = true;
          const streamError = parsed.error;
          streamErrorResponse = streamError;
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMessage = newMsgs[newMsgs.length - 1];
            if (lastMessage) newMsgs[newMsgs.length - 1] = { ...lastMessage, role: 'cliro', content: `[ERROR] ${streamError}`, kind: 'error' };
            return newMsgs;
          });
          setAgentState('error');
        } else if (parsed.action?.type) {
          const action = parsed.action;
          const actionType = action.type;
          if (!actionType) return;
          if (actionType === 'ACTION_APPROVAL_REQUIRED') {
            actionEventReceived = true;
            streamedActionResponse = '';
            setMessages(previous => previous.filter(message => message.speechId !== streamingSpeechId));
            displayProjectApproval(action);
            return;
          }
          if (actionType === 'ACTION_CANCELLED') {
            actionEventReceived = true;
            streamedActionResponse = action.message || 'Project creation cancelled. No files were created.';
            setMessages(previous => previous.filter(message => message.speechId !== streamingSpeechId));
            appendAssistantMessage({ content: streamedActionResponse, kind: 'system' }, source);
            setAgentState('idle');
            return;
          }
          const actionState = actionStateFor(actionType, action.verified);
          actionEventReceived = true;
          if (actionState === 'failed') streamFailed = true;
          streamedActionResponse = action.message || '';
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMessage = newMsgs[newMsgs.length - 1];
            if (lastMessage) {
              newMsgs[newMsgs.length - 1] = {
                ...lastMessage,
                role: 'cliro',
                content: action.message || '',
                isAction: true,
                kind: 'response',
                actionState,
                actionLabel: action.verified === true ? 'ACTION VERIFIED' : actionLabelFor(actionType, action.message || '')
              };
            }
            return newMsgs;
          });
          setAgentState(actionState === 'failed' ? 'error' : actionState);
        } else if (typeof parsed.chunk === 'string') {
          setAgentState('thinking');
          currentResponse += parsed.chunk;
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMessage = newMsgs[newMsgs.length - 1];
            if (lastMessage) {
              newMsgs[newMsgs.length - 1] = {
                ...lastMessage,
                content: currentResponse,
                isAction: false
              };
            }
            return newMsgs;
          });
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (value) eventBuffer += decoder.decode(value, { stream: true });
        const frames = eventBuffer.split(/\r?\n\r?\n/);
        eventBuffer = frames.pop() || '';
        for (const frame of frames) {
          consumeEvent(frame);
          if (streamDone) break;
        }
        if (streamDone || done) break;
      }
      eventBuffer += decoder.decode();
      if (eventBuffer.trim() && !streamDone) consumeEvent(eventBuffer);
      const finalStreamErrorResponse = streamErrorResponse;
      if (finalStreamErrorResponse) {
        speakResponse(finalStreamErrorResponse, source, streamingSpeechId);
      } else if (streamedActionResponse) {
        speakResponse(streamedActionResponse, source, streamingSpeechId);
      } else if (!streamFailed && !actionEventReceived && currentResponse.trim()) {
        lastRepeatableResponseRef.current = { content: currentResponse, id: streamingSpeechId };
        speakResponse(currentResponse, source, streamingSpeechId);
      }
      if (!streamFailed && !actionEventReceived && !structuredResultReceived) setAgentState('idle');
      return actionEventReceived || !streamFailed;
    } catch (e: any) {
      appendAssistantMessage({ content: `[ERROR] Connection failed: ${e.message}`, kind: 'error' }, source);
      setAgentState('error');
      return false;
    }
  };

  const refreshProjects = useCallback(async () => {
    try {
      const result = await requestJson<{ projects: UserProject[] }>(apiUrl('/api/projects'), {
        signal: AbortSignal.timeout(10_000)
      });
      const projectList = Array.isArray(result.projects) ? result.projects : [];
      setProjects(projectList);
      setProjectsLoaded(true);
      const targetId = projectList.some(project => project.id === selectedProjectIdRef.current)
        ? selectedProjectIdRef.current
        : projectList[0]?.id || '';
      selectedProjectIdRef.current = targetId;
      setSelectedProjectId(targetId);
      if (targetId) {
        const snapshot = await requestJson<ProjectSnapshot>(apiUrl(`/api/projects/${encodeURIComponent(targetId)}`), {
          signal: AbortSignal.timeout(20_000)
        });
        setProjectSnapshot(snapshot);
      } else {
        setProjectSnapshot(null);
      }
      setProjectNotice('');
      return projectList;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProjectsLoaded(false);
      setProjectNotice(`Unable to load registered projects: ${message}`);
      return null;
    }
  }, []);

  const presentExecutionResult = (execution: ProjectExecutionResult) => {
    let allVerified = execution.status === 'COMPLETED';
    const addOutcome = (
      label: string,
      details: string,
      verified: boolean,
      trustProjectId?: string,
      workspaceTrustStatus?: Message['workspaceTrustStatus']
    ) => {
      allVerified = allVerified && verified;
      appendAssistantMessage({
        content: details,
        isAction: true,
        kind: 'response',
        actionState: verified ? 'success' : 'failed',
        actionLabel: label,
        trustProjectId,
        workspaceTrustStatus
      }, 'chat');
    };
    if (execution.buildResult) {
      const buildOutput = execution.buildResult.command?.stderr || execution.buildResult.command?.stdout;
      addOutcome(
        execution.buildResult.verified ? 'BUILD PASSED' : 'BUILD FAILED',
        `Build status: ${execution.buildResult.status}${execution.buildResult.command?.exitCode !== undefined
          ? ` · exit code ${execution.buildResult.command.exitCode}` : ''}${buildOutput ? `\n${buildOutput}` : ''}`,
        execution.buildResult.verified === true
      );
    }
    if (execution.testResult) {
      const configured = execution.testResult.status !== 'NOT_CONFIGURED';
      const testOutput = execution.testResult.command?.stderr || execution.testResult.command?.stdout;
      addOutcome(
        execution.testResult.status === 'NOT_CONFIGURED' ? 'TEST NOT CONFIGURED'
          : execution.testResult.verified ? 'TEST PASSED' : 'TEST FAILED',
        `Test status: ${execution.testResult.status}${testOutput ? `\n${testOutput}` : ''}`,
        execution.testResult.verified === true && (configured || execution.testResult.status === 'NOT_CONFIGURED')
      );
    }
    if (execution.runResult) {
      addOutcome(
        execution.runResult.verified ? 'RUNNING VERIFIED' : 'RUN FAILED',
        execution.runResult.verified && execution.runResult.url
          ? `Process ${execution.runResult.pid} returned HTTP at ${execution.runResult.url}.`
          : execution.runResult.error || `Run status: ${execution.runResult.status}`,
        execution.runResult.verified === true
      );
      if (execution.runResult.verified && execution.runResult.status === 'RUNNING') {
        setActiveRunExecutionId(execution.executionId);
      }
    }
    if (execution.vsCodeResult) {
      const trustStatus = execution.vsCodeResult.workspaceTrustStatus;
      const trustRequired = trustStatus === 'RESTRICTED';
      addOutcome(
        !execution.vsCodeResult.verified ? 'VS CODE OPEN FAILED'
          : trustRequired ? 'WORKSPACE TRUST REQUIRED'
            : trustStatus === 'UNAVAILABLE' ? 'WORKSPACE TRUST UNAVAILABLE'
              : 'VS CODE VERIFIED',
        execution.vsCodeResult.workspacePath
          ? `${execution.vsCodeResult.message || ''}\nWorkspace: ${execution.vsCodeResult.workspacePath}`.trim()
          : execution.vsCodeResult.message || 'VS Code workspace verification failed.',
        execution.vsCodeResult.verified === true,
        trustStatus === 'RESTRICTED' || trustStatus === 'UNAVAILABLE'
          ? execution.vsCodeResult.projectId || execution.projectId
          : undefined,
        trustStatus
      );
    }
    if (execution.diagnosis) {
      addOutcome(
        `DIAGNOSIS · ${execution.diagnosis.category}`,
        `${execution.diagnosis.summary}\nSuggested fix: ${execution.diagnosis.suggestedFix}`,
        false
      );
    }
    if (execution.error) addOutcome('EXECUTION FAILED', execution.error, false);
    setActiveExecutionId('');
    setAgentState(allVerified ? 'success' : 'error');
  };

  const requestProjectWorkspaceTrust = async (projectId: string, messageId: string, cancel = false) => {
    const updateTrustMessage = (updates: Partial<Message>) => {
      setMessages(previous => previous.map(message =>
        message.speechId === messageId ? { ...message, ...updates } : message
      ));
    };
    try {
      if (cancel) {
        const existing = messages.find(message => message.speechId === messageId);
        if (!existing?.trustRequestId) return;
        const response = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/vscode/trust/cancel`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: existing.trustRequestId })
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(typeof body.error === 'string' ? body.error : `Trust cancellation failed with HTTP ${response.status}.`);
        }
        updateTrustMessage({
          content: 'Trust request cancelled. CLIRO did not change VS Code workspace trust.',
          workspaceTrustStatus: 'CANCELLED',
          trustRequestId: undefined
        });
        return;
      }

      updateTrustMessage({
        content: 'Opening VS Code’s native Workspace Trust controls. Confirm the trust decision in VS Code; CLIRO will only report trusted after VS Code confirms it.',
        workspaceTrustStatus: 'PENDING_USER_CONFIRMATION'
      });
      const startResponse = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/vscode/trust`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: true })
      });
      const startBody = await startResponse.json();
      if (!startResponse.ok || typeof startBody.request?.requestId !== 'string') {
        throw new Error(typeof startBody.error === 'string' ? startBody.error : `Trust request failed with HTTP ${startResponse.status}.`);
      }
      const requestId: string = startBody.request.requestId;
      updateTrustMessage({ trustRequestId: requestId });

      for (let attempt = 0; attempt < 80; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 1500));
        const response = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/vscode/trust`));
        const body = await response.json();
        if (!response.ok) {
          throw new Error(typeof body.error === 'string' ? body.error : `Trust state check failed with HTTP ${response.status}.`);
        }
        if (body.trustStatus === 'TRUSTED') {
          updateTrustMessage({
            content: 'VS Code confirmed that this CLIRO project workspace is trusted.',
            workspaceTrustStatus: 'TRUSTED',
            trustRequestId: undefined,
            actionLabel: 'WORKSPACE TRUST VERIFIED'
          });
          return;
        }
        if (body.trustStatus === 'CANCELLED') {
          updateTrustMessage({
            content: 'The workspace trust request was cancelled. The project remains open in VS Code and was not trusted by CLIRO.',
            workspaceTrustStatus: 'CANCELLED',
            trustRequestId: undefined,
            actionLabel: 'TRUST REQUEST CANCELLED'
          });
          return;
        }
      }
      updateTrustMessage({
        content: 'VS Code has not confirmed trust. The project remains open; choose Trust Folder in VS Code, or cancel this request.',
        workspaceTrustStatus: 'RESTRICTED',
        actionLabel: 'WORKSPACE TRUST STILL REQUIRED'
      });
    } catch (error) {
      updateTrustMessage({
        content: error instanceof Error ? error.message : String(error),
        workspaceTrustStatus: 'UNAVAILABLE',
        trustRequestId: undefined,
        actionLabel: 'WORKSPACE TRUST UNAVAILABLE'
      });
    }
  };

  const decideExecutionApproval = async (approval: PendingActionApproval, approve: boolean) => {
    if (!approval.executionId || !approval.approvalRequestId) {
      appendAssistantMessage({ content: 'The execution approval is missing its backend-issued identifiers.', kind: 'error' }, approval.source);
      setAgentState('error');
      setPendingActionApproval(null);
      return;
    }
    setPendingActionApproval(null);
    setAgentState(approve ? 'executing' : 'idle');
    try {
      const response = await fetch(apiUrl(`/api/projects/executions/${encodeURIComponent(approval.executionId)}/approval?stream=true`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalRequestId: approval.approvalRequestId, approve })
      });
      if (!response.ok || !response.body) {
        let message = `Execution approval failed with HTTP ${response.status}.`;
        try {
          const body = await response.json();
          if (typeof body.error === 'string') message = body.error;
        } catch {}
        throw new Error(message);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let execution: ProjectExecutionResult | undefined;
      let streamError = '';
      const consume = (frame: string) => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return;
        const parsed = JSON.parse(data) as {
          activity?: ActivityEvent;
          error?: string;
          result?: { executionResult?: ProjectExecutionResult };
        };
        if (parsed.activity) {
          setActivityEvents(previous => mergeActivityEvent(previous, parsed.activity!));
          if (parsed.activity.projectId && parsed.activity.actionId && [
            'INSTALLING_DEPENDENCIES', 'BUILDING', 'TESTING', 'STARTING',
            'DIAGNOSING', 'FIXING', 'REBUILDING'
          ].includes(parsed.activity.stage)) {
            setActiveExecutionId(parsed.activity.actionId);
          }
          if (parsed.activity.stage === 'RUN_VERIFIED' && parsed.activity.verification === true) {
            setActiveRunExecutionId(approval.executionId!);
            setActiveExecutionId('');
          }
          if (parsed.activity.stage === 'CANCELLED') {
            setActiveExecutionId('');
            setActiveRunExecutionId('');
          }
          if (parsed.activity.stage === 'COMPLETED') setActiveExecutionId('');
        }
        if (parsed.error) streamError = parsed.error;
        if (parsed.result?.executionResult) execution = parsed.result.executionResult;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) consume(frame);
        if (done) break;
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (streamError) throw new Error(streamError);
      if (!execution) throw new Error('The backend completed approval without returning execution state.');
      if (!approve) {
        setActiveExecutionId('');
        appendAssistantMessage({
          content: approval.approvalType === 'DEPENDENCY_INSTALL'
            ? 'Dependency installation was cancelled. No build, test, or run stages were started.'
            : 'The proposed repair was cancelled. No repair was applied.',
          kind: 'system'
        }, approval.source);
        setAgentState('idle');
      } else {
        presentExecutionResult(execution);
      }
      await refreshProjects();
    } catch (error) {
      setActiveExecutionId('');
      if (cancelledExecutionIdsRef.current.delete(approval.executionId)) {
        setAgentState('idle');
        return;
      }
      appendAssistantMessage({
        content: `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
        kind: 'error'
      }, approval.source);
      setAgentState('error');
    }
  };

  const stopProjectExecution = async (executionId: string) => {
    cancelledExecutionIdsRef.current.add(executionId);
    if (cancelledExecutionIdsRef.current.size > 20) {
      const oldest = cancelledExecutionIdsRef.current.values().next().value;
      if (oldest) cancelledExecutionIdsRef.current.delete(oldest);
    }
    try {
      const result = await requestJson<{ executionResult: ProjectExecutionResult & { events?: ActivityEvent[] } }>(
        apiUrl(`/api/projects/executions/${encodeURIComponent(executionId)}/cancel`),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
      );
      for (const event of result.executionResult.events || []) {
        if (event.stage === 'CANCELLED') setActivityEvents(previous => mergeActivityEvent(previous, event));
      }
      setActiveExecutionId('');
      setActiveRunExecutionId('');
      appendAssistantMessage({ content: 'CLIRO-owned project execution was stopped.', kind: 'system' }, 'chat');
      setAgentState('idle');
    } catch (error) {
      cancelledExecutionIdsRef.current.delete(executionId);
      appendAssistantMessage({
        content: `Unable to stop project execution: ${error instanceof Error ? error.message : String(error)}`,
        kind: 'error'
      }, 'chat');
      setAgentState('error');
    }
  };

  const navigateToView = (view: ActiveView) => {
    setActiveView(view);
    if (view === 'projects' || view === 'code-analysis') void refreshProjects();
  };

  const selectProject = async (projectId: string) => {
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setProjectAnalysis(null);
    setProjectAnalysisAt('');
    setProjectBusy(true);
    setProjectNotice('');
    setProjectAnswer('');
    setProjectFilePath('');
    setProjectFileContent('');
    try {
      const snapshot = await requestJson<ProjectSnapshot>(apiUrl(`/api/projects/${encodeURIComponent(projectId)}`), {
        signal: AbortSignal.timeout(20_000)
      });
      setProjectSnapshot(snapshot);
      setProjectFilePath('');
      setProjectFileContent('');
    } catch (error) {
      setProjectSnapshot(null);
      setProjectNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectBusy(false);
    }
  };

  const openExistingProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProjectBusy(true);
    setProjectNotice('');
    try {
      const snapshot = await requestJson<ProjectSnapshot>(apiUrl('/api/projects/open'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPathInput })
      });
      setProjectSnapshot(snapshot);
      selectedProjectIdRef.current = snapshot.project.id;
      setSelectedProjectId(snapshot.project.id);
      setProjectPanel(null);
      setProjectPathInput('');
      setProjectFilePath('');
      setProjectFileContent('');
      setProjectAnalysis(null);
      setProjectAnalysisAt('');
      await refreshProjects();
      setSelectedProjectId(snapshot.project.id);
      setMessages(prev => [...prev,
        historyMessage({ role: 'user', content: `Open existing project: ${snapshot.project.path}` }),
        historyMessage({
          role: 'cliro',
          content: `Opened ${snapshot.project.name}. Scanned ${snapshot.fileCount} visible files and ${snapshot.folderCount} folders.`,
          kind: 'filesystem'
        })
      ]);
      setProjectNotice(`Opened and scanned ${snapshot.project.name}.`);
    } catch (error) {
      setProjectNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectBusy(false);
    }
  };

  const createProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProjectBusy(true);
    setProjectNotice('');
    try {
      const snapshot = await requestJson<ProjectSnapshot & { activityEvents?: ActivityEvent[] }>(apiUrl('/api/projects/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectNameInput,
          template: projectTemplateInput,
          confirmed: true
        })
      });
      if (snapshot.activityEvents) setActivityEvents(snapshot.activityEvents);
      setProjectSnapshot(snapshot);
      selectedProjectIdRef.current = snapshot.project.id;
      setSelectedProjectId(snapshot.project.id);
      setProjectPanel(null);
      setProjectNameInput('');
      setProjectPathInput('');
      setProjectTemplateInput('basic');
      setProjectFilePath('');
      setProjectFileContent('');
      setProjectAnalysis(null);
      setProjectAnalysisAt('');
      await refreshProjects();
      setSelectedProjectId(snapshot.project.id);
      setMessages(prev => [...prev,
        historyMessage({ role: 'user', content: `Create project ${snapshot.project.name}` }),
        historyMessage({
          role: 'cliro',
          content: `Created ${snapshot.project.name} at ${snapshot.project.path}. The directory exists and its initial scan found ${snapshot.fileCount} visible files.`,
          kind: 'filesystem'
        })
      ]);
      setProjectNotice(`Created and scanned ${snapshot.project.name}.`);
    } catch (error) {
      setProjectNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectBusy(false);
    }
  };

  const refreshProjectSnapshot = async () => {
    if (!selectedProjectId) return;
    setProjectBusy(true);
    setProjectNotice('');
    try {
      const snapshot = await requestJson<ProjectSnapshot>(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}`), {
        signal: AbortSignal.timeout(20_000)
      });
      setProjectSnapshot(snapshot);
      setMessages(prev => [...prev,
        historyMessage({ role: 'user', content: `Refresh project scan: ${snapshot.project.name}` }),
        historyMessage({
          role: 'cliro',
          content: `Scan completed at ${new Date(snapshot.scannedAt).toLocaleString()}: ${snapshot.fileCount} visible files, ${snapshot.folderCount} folders.`,
          kind: 'filesystem'
        })
      ]);
      setProjectNotice(`Project scan refreshed at ${new Date(snapshot.scannedAt).toLocaleTimeString()}.`);
    } catch (error) {
      setProjectNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectBusy(false);
    }
  };

  const runProjectAnalysis = async (filePath?: string) => {
    if (!selectedProjectId) return;
    setProjectBusy(true);
    setProjectNotice('');
    try {
      const endpoint = filePath ? 'analyze-file' : 'analyze';
      const result = await requestJson<{ analysis: CodeAnalysisResult }>(
        apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}/${endpoint}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(filePath ? { path: filePath } : {})
        }
      );
      setProjectAnalysis(result.analysis);
      setProjectAnalysisAt(new Date().toISOString());
      const prompt = filePath ? `Analyze file ${filePath} in ${result.analysis.project}` : `Analyze project ${result.analysis.project}`;
      setMessages(prev => [...prev,
        historyMessage({ role: 'user', content: prompt }),
        historyMessage({
          role: 'cliro',
          content: formatCodeAnalysis(result.analysis),
          preserveFormatting: true,
          kind: 'analysis',
          analysis: result.analysis
        })
      ]);
      setProjectNotice(result.analysis.message);
      setAgentState(result.analysis.success ? 'success' : 'error');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProjectNotice(`Analysis failed: ${message}`);
      setAgentState('error');
    } finally {
      setProjectBusy(false);
    }
  };

  const viewProjectFile = async (filePath: string) => {
    if (!selectedProjectId) return;
    setProjectBusy(true);
    setProjectNotice('');
    try {
      const result = await requestJson<{ path: string; content: string }>(
        apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}/file?path=${encodeURIComponent(filePath)}`),
        { signal: AbortSignal.timeout(10_000) }
      );
      setProjectFilePath(result.path);
      setProjectFileContent(result.content);
      setMessages(prev => [...prev,
        historyMessage({ role: 'user', content: `View project file: ${result.path}` }),
        historyMessage({ role: 'cliro', content: `Displayed ${result.path} in the read-only project viewer.`, kind: 'filesystem' })
      ]);
    } catch (error) {
      setProjectNotice(error instanceof Error ? error.message : String(error));
      setProjectFilePath('');
      setProjectFileContent('');
    } finally {
      setProjectBusy(false);
    }
  };

  const askAboutProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProjectId || !projectQuestion.trim()) return;
    const question = projectQuestion.trim();
    setProjectBusy(true);
    setProjectNotice('');
    setProjectAnswer('');
    setMessages(prev => [...prev, historyMessage({ role: 'user', content: question })]);
    try {
      const result = await requestJson<{ project: { name: string }; answer: string }>(
        apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}/ask`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, model: selectedModel || configuredModel })
        }
      );
      setProjectAnswer(result.answer);
      appendAssistantMessage({ content: result.answer, kind: 'ai' }, 'chat');
      setProjectQuestion('');
      setAgentState('idle');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProjectNotice(`Project question failed: ${message}`);
      setMessages(prev => [...prev, historyMessage({ role: 'cliro', content: `[ERROR] ${message}`, kind: 'error' })]);
      setAgentState('error');
    } finally {
      setProjectBusy(false);
    }
  };

  const onGestureAction = async (action: GestureAction): Promise<string> => {
    const chromeOperation = runChromeTabGesture(action);
    if (chromeOperation) {
      const result = await chromeOperation;
      const updatedStatus = await getChromeBridgeStatus();
      setChromeBridgeStatus(updatedStatus);
      const isVerifiedSuccess = result.type === 'ACTION_SUCCESS' && result.verified;
      const actionTitle = action === 'CLOSE_CHROME_TAB'
        ? 'Tab closed'
        : action === 'NEXT_CHROME_TAB' ? 'Next tab' : 'Previous tab';
      const content = isVerifiedSuccess
        ? `Chrome: ${actionTitle}`
        : result.type === 'ACTION_UNAVAILABLE' && !updatedStatus.connected
          ? `Chrome: Bridge unavailable — ${result.message}`
          : result.type === 'ACTION_UNAVAILABLE'
            ? `Chrome: Action unavailable — ${result.message}`
            : `Chrome: Verification failed — ${result.message}`;
      appendAssistantMessage({
        content,
        kind: 'system',
        isAction: true,
        actionState: isVerifiedSuccess ? 'success' : 'failed',
        actionLabel: isVerifiedSuccess ? `CHROME · ${actionTitle.toUpperCase()}` : 'CHROME ACTION NOT VERIFIED'
      }, 'gesture');
      return content.toUpperCase();
    }
    if (action === 'TOGGLE_VOICE_OUTPUT') {
      setSpeechPreferences(current => ({ ...current, enabled: !current.enabled }));
      return `VOICE OUTPUT ${speechPreferences.enabled ? 'DISABLED FOR TYPED RESPONSES' : 'ENABLED FOR TYPED RESPONSES'}`;
    }
    if (action === 'SELECT') {
      if (activeView === 'agent' || activeView === 'command-center') chatInputRef.current?.focus();
      else workspaceContentRef.current?.focus();
      return 'ACTIVE CLIRO VIEW FOCUSED';
    }
    if (action === 'CANCEL' || action === 'APPROVE') {
      if (!pendingActionApproval) return 'NONE';
      if (action === 'CANCEL') {
        setPendingActionApproval(null);
        setMessages(prev => [...prev, historyMessage({
          role: 'cliro',
          content: 'Permission request cancelled by gesture. No system action was run.',
          kind: 'system'
        })]);
        setAgentState('idle');
        return 'PERMISSION REQUEST CANCELLED';
      }
      const approval = pendingActionApproval;
      const completed = await handleSend(approval.prompt, approval.source, 'THUMBS_UP', true, true);
      return completed ? 'APPROVAL SENT' : 'APPROVAL NOT COMPLETED';
    }
    return 'NONE';
  };

  const getRamPercentage = (ramString: string) => {
    if (!ramString) return 0;
    const parts = ramString.match(/([0-9.]+)\s*\/\s*([0-9.]+)/);
    if (parts && parts.length === 3) {
      const used = parseFloat(parts[1]);
      const total = parseFloat(parts[2]);
      if (total > 0) return Math.round((used / total) * 100);
    }
    return 0;
  };

  const getStatusPercentage = (value: string | undefined) => {
    const match = value?.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
    return match ? Math.min(100, Math.max(0, Number(match[1]))) : null;
  };
  const ramPercentage = systemStatus ? getRamPercentage(systemStatus.ram) : null;
  const cpuPercentage = getStatusPercentage(systemStatus?.cpu);
  const storagePercentage = getStatusPercentage(systemStatus?.storage);
  const batteryPercentage = systemStatus?.battery?.hasBattery ? systemStatus.battery.percent : null;
  const stateLabel = agentState === 'error' || speechPlaybackState === 'ERROR'
    ? 'ERROR'
    : speechPlaybackState === 'SPEAKING'
      ? 'SPEAKING'
      : agentState === 'executing' || agentState === 'thinking'
        ? 'PROCESSING'
        : speechPlaybackState === 'INTERRUPTED'
          ? 'INTERRUPTED'
          : agentState === 'listening' || visionUiStatus.voiceEnabled
            ? 'LISTENING'
            : agentState === 'vision'
              ? 'VISION'
              : 'IDLE';
  const activeViewTitle: Record<ActiveView, string> = {
    'command-center': 'Command center',
    agent: 'AI Agent',
    system: 'System',
    history: 'History',
    projects: 'Projects',
    'code-analysis': 'Code Analysis',
    settings: 'Settings'
  };
  const activeViewSubtitle: Record<ActiveView, string> = {
    'command-center': 'Your local command interface.',
    agent: 'Your intelligent local assistant. Ask anything, get real answers.',
    system: 'Monitor your computer in real time.',
    history: 'Review your recent CLIRO activity.',
    projects: 'Work with your local projects safely.',
    'code-analysis': 'Understand and analyze your code.',
    settings: 'Configure your local AI environment.'
  };
  const isAgentView = activeView === 'agent' || activeView === 'command-center';
  const agentStatusLabel = stateLabel;
  return (
    <div className="app-container app-shell" data-state={speechPlaybackState === 'SPEAKING' ? 'speaking' : agentState}>
      {/* LEFT SIDEBAR */}
      <aside className="glass-panel left-sidebar">
        <div className="brand-header">
          <div className="brand-logo"><span>C</span><i /></div>
          <div className="brand-text">
            <h1>CLIRO</h1>
            <p>LOCAL AI AGENT</p>
          </div>
        </div>
        
        <div className="nav-menu">
          <button className="btn-new-chat" onClick={() => { setPendingActionApproval(null); setMessages([]); setAgentState('idle'); setActiveView('agent'); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            New session <span>⌘ K</span>
          </button>
          <p className="nav-caption">WORKSPACE</p>
          <button type="button" className={`nav-item ${activeView === 'command-center' ? 'active' : ''}`} aria-current={activeView === 'command-center' ? 'page' : undefined} onClick={() => setActiveView('command-center')}>
            <span className="nav-icon">◈</span> COMMAND CENTER
          </button>
          <button type="button" className={`nav-item ${activeView === 'agent' ? 'active' : ''}`} aria-current={activeView === 'agent' ? 'page' : undefined} onClick={() => setActiveView('agent')}>
            <span className="nav-icon">✳</span> AI AGENT
          </button>
          <button type="button" className={`nav-item ${activeView === 'system' ? 'active' : ''}`} aria-current={activeView === 'system' ? 'page' : undefined} onClick={() => setActiveView('system')}>
            <span className="nav-icon">⌁</span> SYSTEM
          </button>
          <button type="button" className={`nav-item ${activeView === 'history' ? 'active' : ''}`} aria-current={activeView === 'history' ? 'page' : undefined} onClick={() => setActiveView('history')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> History
          </button>
          <button type="button" className={`nav-item ${activeView === 'projects' ? 'active' : ''}`} aria-current={activeView === 'projects' ? 'page' : undefined} onClick={() => navigateToView('projects')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> Projects
          </button>
          <button type="button" className={`nav-item ${activeView === 'code-analysis' ? 'active' : ''}`} aria-current={activeView === 'code-analysis' ? 'page' : undefined} onClick={() => navigateToView('code-analysis')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z"/><path d="m8 9 3 3-3 3m5 0h3"/></svg> Code Analysis
          </button>
          <button type="button" className={`nav-item ${activeView === 'settings' ? 'active' : ''}`} aria-current={activeView === 'settings' ? 'page' : undefined} onClick={() => setActiveView('settings')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> Settings
          </button>
        </div>
        
        <div className="sidebar-bottom">
          <div className="voice-agent-status">
            <div className={`voice-icon ${backendOnline ? 'connected' : ''}`}>
              <div className="voice-icon-inner"><span></span><span></span><span></span><span></span><span></span></div>
            </div>
            <div>
              <h4>CLIRO CORE</h4>
              <p>{backendOnline === null ? 'Checking system' : backendOnline ? 'System online' : 'System offline'}</p>
            </div>
            <span className={`status-dot ${backendOnline ? 'online' : backendOnline === null ? 'checking' : 'offline'}`} />
          </div>
          <div className="tagline">LOCAL INTELLIGENCE<br />PRIVATE BY DESIGN</div>
        </div>
      </aside>

      {/* CENTER STAGE */}
      <main className="center-stage">
        <div className="top-bar">
          <div className="page-heading">
            <span className="eyebrow">CLIRO / {activeViewTitle[activeView].toUpperCase()}</span>
            <h1>{activeViewTitle[activeView]}</h1>
            <p>{activeViewSubtitle[activeView]}</p>
          </div>
          <div className="top-statuses">
            <span className={`status-chip ${backendOnline === null ? 'checking' : backendOnline ? 'online' : 'offline'}`}>
              <i /> CLIRO {backendOnline === null ? 'CHECKING' : backendOnline ? 'ONLINE' : 'OFFLINE'}
            </span>
            <span className={`status-chip ${connectionKnown ? isConnected ? 'online' : 'offline' : 'checking'}`}>
              <i /> OLLAMA {connectionKnown ? isConnected ? 'CONNECTED' : 'OFFLINE' : 'CHECKING'}
            </span>
            <span
              className={`status-chip ${chromeBridgeStatus.connected ? 'online' : 'offline'}`}
              title={chromeBridgeStatus.connected
                ? `${chromeBridgeStatus.eligibleTabCount} eligible tabs in the last-focused Chrome window`
                : 'Install or reload the local CLIRO Chrome extension bridge.'}
              aria-label={chromeBridgeStatus.connected ? 'Chrome bridge connected' : 'Chrome bridge unavailable'}
            >
              <i /> CHROME {chromeBridgeStatus.connected ? 'CONNECTED' : 'BRIDGE UNAVAILABLE'}
            </span>
            <span className={`status-chip agent-chip ${agentState}`}>
              <i /> AGENT {agentStatusLabel}
            </span>
          </div>
        </div>

        <VisionVoiceControls
          onVoiceActivity={interruptSpeech}
          onVoiceCommand={transcript => {
            return handleSend(transcript, 'voice');
          }}
          onGestureAction={onGestureAction}
          onHeadRotation={setAvatarHeadRotation}
          onStatusChange={onVisionStatusChange}
          onAgentMode={mode => setAgentState(current => current === 'executing' ? current : mode)}
        />

        <div className={`workspace-viewport ${isAgentView ? 'chat-workspace' : 'page-workspace'}`}>
          <HolographicGlobe headRotation={avatarHeadRotation} />
        {isAgentView ? (
          <>
        {activeView === 'agent' && (
          <section className="agent-overview" aria-label="CLIRO AI Agent capabilities">
            <header>
              <span className="eyebrow">LOCAL AI COMPUTER AGENT</span>
              <h2>What CLIRO can do</h2>
              <p>Local AI, verified information, and permission-gated computer actions in one workspace.</p>
            </header>
            <div className="agent-capabilities">
              <section>
                <ul>
                  <li>Understand natural-language commands.</li>
                  <li>Chat using your configured local Ollama model.</li>
                  <li>Answer general questions and explain concepts.</li>
                  <li>Verify current facts using cited sources.</li>
                  <li>Read live system information.</li>
                  <li>Open and inspect user-selected local projects.</li>
                </ul>
              </section>
              <section>
                <div className="agent-example-list">
                  <ul>
                    <li>Run bounded static code analysis.</li>
                    <li>Discover supported installed applications.</li>
                    <li>Open supported apps through the permission flow.</li>
                    <li>Use camera-based hand gestures for CLIRO UI controls.</li>
                    <li>Use browser speech recognition when enabled.</li>
                    <li>Keep interaction history for this session.</li>
                  </ul>
                </div>
              </section>
            </div>
            <section className="agent-quick-prompts" aria-label="Quick examples">
              <span>QUICK EXAMPLES</span>
              <div className="agent-example-list">
                {['Show my CPU usage', 'Open Notepad', 'Check my code', 'Explain polymorphism'].map(example => (
                  <button type="button" key={example} className="action-pill" onClick={() => void handleSend(example)}>
                    {example}
                  </button>
                ))}
              </div>
            </section>
            <details className="agent-recent-activity">
              <summary>RECENT ACTIVITY · THIS SESSION</summary>
              {messages.length === 0
                ? <p>No activity recorded in this session.</p>
                : messages.slice(-4).map((message, index) => (
                  <div key={`${message.createdAt}-${index}`}>
                    <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString()}</time>
                    <span>{message.role === 'user' ? 'YOU' : responseLabelFor(message.kind)}</span>
                    <p>{message.content || 'In progress'}</p>
                  </div>
                ))}
            </details>
          </section>
        )}

        <div className="chat-container" ref={chatContainerRef} onScroll={handleScroll} aria-label="Conversation">
          {messages.length === 0 ? (
            <>
              <div className="welcome-msg">
                <span className="eyebrow">SESSION INITIALIZED</span>
                <h3>Command interface ready</h3>
                <p>Ask a question or issue a system command.</p>
              </div>
              <div className="quick-actions">
                <button type="button" className="action-pill" onClick={() => void handleSend('Open VS Code')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Open VS Code</button>
                <button type="button" className="action-pill" onClick={() => void handleSend('Check my battery')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/></svg> Check my battery</button>
                <button type="button" className="action-pill" onClick={() => void handleSend('System status')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> System status</button>
                <button type="button" className="action-pill" onClick={() => void handleSend('Open File Explorer')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> Open File Explorer</button>
              </div>
            </>
          ) : (
            messages.map((msg, i) => (
              <div key={i} className={`msg-row ${msg.role} ${msg.kind || ''} ${msg.actionState || ''}`}>
                <div className="msg-bubble-wrapper">
                  {msg.role === 'cliro' && <div className="cliro-avatar">C</div>}
                  <div className={msg.role === 'user' ? 'user-bubble' : `cliro-bubble ${msg.kind || 'response'}-bubble ${msg.isAction ? 'action-bubble' : ''}`}>
                    {msg.role === 'cliro' && msg.isAction && (
                      <>
                        <div className="cliro-header">
                          <div className="cliro-title">SYSTEM ACTION</div>
                          <span className={`action-state-mark ${msg.actionState || ''}`}>{msg.actionState === 'success' ? '✓' : msg.actionState === 'failed' ? '!' : '◌'}</span>
                        </div>
                        <div className={`action-status-text ${msg.actionState === 'executing' ? 'status-executing' : msg.actionState === 'success' ? 'status-success' : 'status-failed'}`}>
                          {msg.actionLabel || (msg.actionState === 'executing' ? 'EXECUTING' : msg.actionState === 'success' ? 'ACTION COMPLETED' : 'ACTION FAILED')}
                        </div>
                        <div>{msg.content}</div>
                        {msg.trustProjectId && msg.speechId && (
                          <div className="trust-action-controls">
                            {msg.workspaceTrustStatus === 'PENDING_USER_CONFIRMATION' ? (
                              msg.trustRequestId && (
                                <button
                                  type="button"
                                  className="action-pill"
                                  onClick={() => void requestProjectWorkspaceTrust(msg.trustProjectId!, msg.speechId!, true)}
                                >
                                  Cancel trust request
                                </button>
                              )
                            ) : msg.workspaceTrustStatus === 'RESTRICTED' ? (
                              <button
                                type="button"
                                className="action-pill"
                                onClick={() => void requestProjectWorkspaceTrust(msg.trustProjectId!, msg.speechId!)}
                              >
                                Trust this CLIRO project
                              </button>
                            ) : null}
                          </div>
                        )}
                        {msg.actionState === 'executing' && (
                          <div className="action-progress-bg"><div className="action-progress-fill"></div></div>
                        )}
                      </>
                    )}
                    {msg.role === 'cliro' && !msg.isAction && msg.analysis && <CodeAnalysisCard result={msg.analysis} />}
                    {msg.role === 'cliro' && !msg.isAction && !msg.analysis && (
                      <>
                        <div className="response-kind">{responseLabelFor(msg.kind)}</div>
                        {msg.kind === 'verified' && <strong className="verified-answer-label">Answer:</strong>}
                        {msg.preserveFormatting
                          ? <pre className="response-content">{msg.content}</pre>
                          : <div className="response-content">{msg.content}</div>}
                        {msg.imageDataUrl && (
                          <img className="generated-image-preview" src={msg.imageDataUrl} alt="Verified generated image preview" />
                        )}
                        {msg.kind === 'verified' && msg.factSource && (
                          <div className="verified-fact-meta">
                            <span>Source: <a href={msg.factSource.url} target="_blank" rel="noreferrer">{msg.factSource.title}</a></span>
                            <span>Provider: {msg.factSource.provider}</span>
                            {msg.verifiedAt && <span>Verified: {new Date(msg.verifiedAt).toLocaleString()}</span>}
                            {msg.cached && <span>Cached result</span>}
                          </div>
                        )}
                        {msg.kind === 'verification-error' && msg.verifiedAt && (
                          <div className="verified-fact-meta">Not verified · {new Date(msg.verifiedAt).toLocaleString()}</div>
                        )}
                      </>
                    )}
                    {msg.role === 'user' && (
                      <>
                        {msg.content}
                        <div className="user-meta">{new Date(msg.createdAt).toLocaleTimeString()} ✓✓</div>
                      </>
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="user-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="input-wrapper">
          <div className="input-glass">
            <span className="input-prefix" aria-hidden="true">⌘</span>
            <input
              ref={chatInputRef}
              type="text"
              aria-label="Ask CLIRO anything"
              placeholder="Ask CLIRO anything..."
              value={input} onChange={event => setInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void handleSend(); }}
              disabled={agentState === 'executing' || pendingActionApproval !== null}
            />
            <div className="input-tools">
              <span className="input-mode">LOCAL</span>
              <button className="btn-send" aria-label="Send message" onClick={() => void handleSend()} disabled={agentState === 'executing' || pendingActionApproval !== null || !input.trim()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            </div>
          </div>
          <div className="input-hint">
            ENTER TO TRANSMIT <span>•</span> LOCAL AI INTERFACE
          </div>
        </div>
          </>
        ) : (
          <section className="workspace-view" aria-labelledby="workspace-view-title" ref={workspaceContentRef} tabIndex={-1}>
            <header className="workspace-view-heading">
              <span className="eyebrow">CLIRO / WORKSPACE</span>
              <h2 id="workspace-view-title">{activeViewTitle[activeView]}</h2>
            </header>
            {activeView === 'system' && (
              <div className="workspace-metric-grid">
                <article className="workspace-info-card"><span>CPU</span><strong>{systemStatus?.cpu || 'Unavailable'}</strong></article>
                <article className="workspace-info-card"><span>RAM</span><strong>{systemStatus?.ram || 'Unavailable'}</strong></article>
                <article className="workspace-info-card"><span>STORAGE</span><strong>{systemStatus?.storage || 'Unavailable'}</strong></article>
                <article className="workspace-info-card"><span>BATTERY</span><strong>{systemStatus?.battery?.hasBattery ? `${systemStatus.battery.percent}% · ${systemStatus.battery.isCharging ? 'Charging' : 'On battery'}` : 'No battery data'}</strong></article>
                <article className="workspace-info-card"><span>OPERATING SYSTEM</span><strong>{systemStatus?.os || 'Unavailable'}</strong></article>
                <article className="workspace-info-card"><span>OLLAMA</span><strong>{connectionKnown ? isConnected ? 'Connected' : 'Offline' : 'Checking'}</strong><small>Model: {selectedModel || configuredModel || 'Not detected'}</small></article>
                <article className="workspace-info-card"><span>IMAGE GENERATION</span><strong>{imageGenerationConfigured ? `${imageGenerationProvider} configured` : 'Not configured'}</strong></article>
              </div>
            )}
            {activeView === 'history' && (
              <div className="workspace-history">
                {messages.length === 0
                  ? <p className="workspace-empty">No interactions in this session yet.</p>
                  : messages.map((message, index) => (
                    <article className={`workspace-history-entry ${message.role}`} key={`history-${index}`}>
                      <div>
                        <span>{message.role === 'user' ? 'YOU' : responseLabelFor(message.kind)}</span>
                        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
                      </div>
                      <p>{message.content || (message.actionState === 'executing' ? 'Action in progress…' : '')}</p>
                      {message.factSource && <a href={message.factSource.url} target="_blank" rel="noreferrer">{message.factSource.title}</a>}
                    </article>
                  ))}
              </div>
            )}
            {activeView === 'projects' && (
              <div className="project-workspace">
                <div className="project-workspace-actions">
                  <button type="button" className="workspace-action" onClick={() => { setProjectPanel('create'); setProjectNotice(''); }}>CREATE NEW PROJECT</button>
                  <button type="button" className="workspace-action" onClick={() => { setProjectPanel('open'); setProjectNotice(''); }}>OPEN EXISTING PROJECT</button>
                  <button type="button" className="workspace-action" onClick={() => void refreshProjects()} disabled={projectBusy}>REFRESH PROJECTS</button>
                </div>
                {projectNotice && <p className="project-notice" role="status">{projectNotice}</p>}
                {projectPanel && (
                  <form className="project-form" onSubmit={projectPanel === 'create' ? createProject : openExistingProject}>
                    <h3>{projectPanel === 'create' ? 'CREATE PROJECT' : 'OPEN EXISTING PROJECT'}</h3>
                    {projectPanel === 'create' && (
                      <label>
                        PROJECT NAME
                        <input value={projectNameInput} onChange={event => setProjectNameInput(event.target.value)} maxLength={80} required />
                      </label>
                    )}
                    {projectPanel === 'create' && (
                      <label>
                        INITIAL PROJECT TYPE
                        <select value={projectTemplateInput} onChange={event => setProjectTemplateInput(event.target.value as ProjectTemplate)}>
                          <option value="basic">Basic starter</option>
                          <option value="node">Node.js</option>
                          <option value="typescript">TypeScript</option>
                          <option value="python">Python</option>
                          <option value="html">HTML / CSS / JavaScript</option>
                          <option value="react">React + TypeScript + Vite</option>
                          <option value="blank">Empty folder</option>
                        </select>
                      </label>
                    )}
                    {projectPanel === 'create'
                      ? <p>New projects are stored under D:\CLIROProjects. CLIRO will never overwrite an existing project.</p>
                      : <>
                          <label>
                            EXISTING PROJECT DIRECTORY
                            <input
                              value={projectPathInput}
                              onChange={event => setProjectPathInput(event.target.value)}
                              placeholder="E:\\MyProjects\\MyApplication"
                              maxLength={1024}
                              required
                            />
                          </label>
                          <p>Use an absolute local path. CLIRO will not scan protected Windows directories. Opening a project registers only its name and path; source files are not stored in the registry.</p>
                        </>}
                    <div className="project-workspace-actions">
                      <button type="submit" className="workspace-action" disabled={projectBusy}>
                        {projectBusy ? 'WORKING…' : projectPanel === 'create' ? 'CREATE PROJECT' : 'SCAN AND OPEN'}
                      </button>
                      <button type="button" className="workspace-action secondary" onClick={() => setProjectPanel(null)} disabled={projectBusy}>CANCEL</button>
                    </div>
                  </form>
                )}
                {projectsLoaded && projects.length === 0 && !projectBusy && (
                  <div className="project-empty-state">
                    <h3>NO PROJECTS YET</h3>
                    <p>Open an existing project directory or create a new one to start a workspace.</p>
                  </div>
                )}
                {projects.length > 0 && (
                  <div className="project-list" aria-label="Registered user projects">
                    {projects.map(project => (
                      <button
                        type="button"
                        key={project.id}
                        className={`project-list-item ${selectedProjectId === project.id ? 'selected' : ''}`}
                        onClick={() => void selectProject(project.id)}
                      >
                        <strong>{project.name}</strong>
                        <span>{project.path}</span>
                        <small>{project.status === 'ready' ? 'READY' : 'DIRECTORY UNAVAILABLE'}{project.template ? ` · ${project.template.toUpperCase()}` : ''}{project.language ? ` · ${project.language}` : ''}{project.buildStatus ? ` · BUILD ${project.buildStatus}` : ''}{project.testStatus ? ` · TEST ${project.testStatus}` : ''}{project.runStatus ? ` · RUN ${project.runStatus}` : ''} · Last opened {new Date(project.lastOpenedAt).toLocaleString()}</small>
                      </button>
                    ))}
                  </div>
                )}
                {projectBusy && <p className="workspace-empty" role="status">Scanning or loading the selected project…</p>}
                {projectSnapshot && (
                  <section className="project-snapshot" aria-label={`${projectSnapshot.project.name} project details`}>
                    <header>
                      <span className="eyebrow">PROJECT OVERVIEW</span>
                      <h3>{projectSnapshot.project.name}</h3>
                      <p>{projectSnapshot.project.path}</p>
                    </header>
                    <div className="workspace-metric-grid">
                      <article className="workspace-info-card"><span>FILES</span><strong>{projectSnapshot.fileCount}{projectSnapshot.bounded ? '+' : ''}</strong></article>
                      <article className="workspace-info-card"><span>FOLDERS</span><strong>{projectSnapshot.folderCount}</strong></article>
                      <article className="workspace-info-card"><span>LANGUAGES</span><strong>{projectSnapshot.languages.join(', ') || 'None detected'}</strong></article>
                      <article className="workspace-info-card"><span>DEPENDENCY MANIFESTS</span><strong>{projectSnapshot.dependencyFiles.join(', ') || 'None detected'}</strong></article>
                      <article className="workspace-info-card"><span>DECLARED DEPENDENCIES</span><strong>{projectSnapshot.dependencies.join(', ') || 'None detected'}</strong></article>
                      <article className="workspace-info-card"><span>ENTRY POINTS</span><strong>{projectSnapshot.entryPoints.join(', ') || 'No candidates detected'}</strong></article>
                      <article className="workspace-info-card"><span>GIT STATUS</span><strong>{projectSnapshot.gitStatus}</strong></article>
                    </div>
                    {projectSnapshot.dependencyDiagnostics.length > 0 && (
                      <p className="project-notice">{projectSnapshot.dependencyDiagnostics.join(' ')}</p>
                    )}
                    <div className="project-snapshot-actions">
                      <button type="button" className="workspace-action" onClick={() => void refreshProjectSnapshot()} disabled={projectBusy}>REFRESH SCAN</button>
                      <button type="button" className="workspace-action" onClick={() => void runProjectAnalysis()} disabled={projectBusy}>ANALYZE PROJECT</button>
                      <span>Scanned {new Date(projectSnapshot.scannedAt).toLocaleString()}{projectSnapshot.bounded ? ' · limits reached' : ''}</span>
                    </div>
                    <div className="project-tree-panel">
                      <h3>FILE TREE</h3>
                      {projectSnapshot.files.length === 0
                        ? <p className="workspace-empty">No visible files or folders were found.</p>
                        : projectSnapshot.files.map(entry => entry.type === 'folder'
                          ? <div className="project-tree-entry folder" key={entry.path} style={{ paddingLeft: `${12 + entry.depth * 14}px` }}>▸ {entry.path.split('/').at(-1)}/</div>
                          : <button
                              type="button"
                              className={`project-tree-entry file ${projectFilePath === entry.path ? 'selected' : ''}`}
                              key={entry.path}
                              style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
                              onClick={() => void viewProjectFile(entry.path)}
                            >{entry.path.split('/').at(-1)}</button>)}
                    </div>
                    {projectFilePath && (
                      <div className="project-file-view">
                        <h3>VIEW FILE · {projectFilePath}</h3>
                        <pre>{projectFileContent}</pre>
                        <button type="button" className="workspace-action" onClick={() => void runProjectAnalysis(projectFilePath)} disabled={projectBusy}>ANALYZE FILE</button>
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}
            {activeView === 'code-analysis' && (
              <div className="project-workspace">
                <p>Select a registered user project. Analysis uses CLIRO’s bounded static analyzer; it does not run a project build or test suite.</p>
                <label className="project-select-label">
                  SELECT PROJECT
                  <select value={selectedProjectId} onChange={event => void selectProject(event.target.value)} disabled={projects.length === 0 || projectBusy}>
                    <option value="">No project selected</option>
                    {projects.map(project => <option value={project.id} key={project.id}>{project.name} — {project.path}</option>)}
                  </select>
                </label>
                {projectsLoaded && projects.length === 0 && !projectBusy && (
                  <div className="project-empty-state">
                    <h3>NO PROJECTS YET</h3>
                    <button type="button" className="workspace-action" onClick={() => navigateToView('projects')}>OPEN PROJECTS WORKSPACE</button>
                  </div>
                )}
                {projectNotice && <p className="project-notice" role="status">{projectNotice}</p>}
                {projectSnapshot && (
                  <>
                    <div className="project-analysis-actions">
                      <button type="button" className="workspace-action" onClick={() => void runProjectAnalysis()} disabled={projectBusy}>ANALYZE PROJECT</button>
                      <button type="button" className="workspace-action" onClick={() => void runProjectAnalysis()} disabled={projectBusy}>REFRESH ANALYSIS</button>
                      <button type="button" className="workspace-action" onClick={() => projectFilePath && void runProjectAnalysis(projectFilePath)} disabled={projectBusy || !projectFilePath}>ANALYZE FILE</button>
                      <button type="button" className="workspace-action" onClick={() => projectFilePath && void viewProjectFile(projectFilePath)} disabled={projectBusy || !projectFilePath}>VIEW FILE</button>
                    </div>
                    <div className="project-tree-panel compact">
                      <h3>SELECT A FILE TO VIEW OR ANALYZE</h3>
                      {projectSnapshot.files.filter(entry => entry.type === 'file').map(entry => (
                        <button
                          type="button"
                          className={`project-tree-entry file ${projectFilePath === entry.path ? 'selected' : ''}`}
                          key={entry.path}
                          style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
                          onClick={() => { setProjectFilePath(entry.path); void viewProjectFile(entry.path); }}
                        >{entry.path}</button>
                      ))}
                    </div>
                    {projectAnalysis && (
                      <section className="project-analysis-results">
                        <div className="analysis-method"><span>ANALYSIS TIME</span>{projectAnalysisAt ? new Date(projectAnalysisAt).toLocaleString() : 'Unavailable'}</div>
                        <div className="analysis-method"><span>LANGUAGES</span>{projectSnapshot.languages.join(', ') || 'None detected'}</div>
                        <CodeAnalysisCard result={projectAnalysis} />
                        {projectAnalysis.filesSkipped.length > 0 && (
                          <details className="analysis-file-list">
                            <summary>SKIPPED FILE DETAILS <span>{projectAnalysis.skippedCount}</span></summary>
                            <ul>{projectAnalysis.filesSkipped.map((file, index) => <li key={`${file.file}-${index}`}>{file.file}: {file.reason}</li>)}</ul>
                          </details>
                        )}
                      </section>
                    )}
                    <form className="project-question-form" onSubmit={askAboutProject}>
                      <label>
                        ASK CLIRO ABOUT THIS CODE
                        <input value={projectQuestion} onChange={event => setProjectQuestion(event.target.value)} maxLength={2000} placeholder="Where is the backend entry point?" disabled={projectBusy} />
                      </label>
                      <button type="submit" className="workspace-action" disabled={projectBusy || !projectQuestion.trim()}>ASK ABOUT PROJECT</button>
                      {projectAnswer && <p className="project-answer">{projectAnswer}</p>}
                    </form>
                  </>
                )}
              </div>
            )}
            {activeView === 'settings' && (
              <div className="workspace-settings">
                <section className="provider-settings" aria-labelledby="provider-settings-title">
                  <div>
                    <span className="eyebrow">LANGUAGE PROVIDER</span>
                    <h3 id="provider-settings-title">Conversation provider</h3>
                    <p>Verified current facts always use their cited-source provider. This selection applies only to general conversation, never computer actions.</p>
                  </div>
                  <label>
                    Preferred provider
                    <select value={selectedProvider} onChange={event => setSelectedProvider(event.target.value === 'OPENAI' ? 'OPENAI' : 'OLLAMA')}>
                      <option value="OLLAMA">Ollama · local</option>
                      <option value="OPENAI" disabled={!openaiConfigured}>OpenAI · {openaiConfigured ? 'configured' : 'not configured'}</option>
                    </select>
                  </label>
                  {!openaiConfigured && <p role="status">OpenAI is optional. Configure OPENAI_API_KEY in the backend environment to enable it; the key is never sent to this frontend.</p>}
                  <p role="status">
                    Image generation: {imageGenerationConfigured
                      ? `${imageGenerationProvider} configured; generated assets still require approval.`
                      : 'not configured. Configure OPENAI_API_KEY and IMAGE_GENERATION_PROVIDER=openai in the backend environment.'}
                  </p>
                </section>
                <section className="speech-settings" aria-labelledby="speech-settings-title">
                  <div>
                    <span className="eyebrow">LOCAL TEXT TO SPEECH</span>
                    <h3 id="speech-settings-title">Response voice</h3>
                    <p>Voice commands are spoken automatically. Typed responses use speech only when enabled here.</p>
                  </div>
                  <label className="speech-setting-toggle">
                    <input
                      type="checkbox"
                      checked={speechPreferences.enabled}
                      disabled={!speechAvailable}
                      onChange={event => setSpeechPreferences(current => ({ ...current, enabled: event.target.checked }))}
                    />
                    Speak typed responses
                  </label>
                  <label>
                    Preferred voice
                    <select
                      value={speechPreferences.voiceURI}
                      disabled={!speechAvailable || speechVoices.length === 0}
                      onChange={event => setSpeechPreferences(current => ({ ...current, voiceURI: event.target.value }))}
                    >
                      <option value="">Prefer an available female English voice</option>
                      {speechVoices.map(voice => (
                        <option key={voice.voiceURI} value={voice.voiceURI}>
                          {voice.name} ({voice.lang}){voice.default ? ' · system default' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Speech rate · {speechPreferences.rate.toFixed(2)}
                    <input type="range" min="0.7" max="1.2" step="0.05" value={speechPreferences.rate}
                      onChange={event => setSpeechPreferences(current => ({ ...current, rate: Number(event.target.value) }))} />
                  </label>
                  <label>
                    Pitch · {speechPreferences.pitch.toFixed(2)}
                    <input type="range" min="0.8" max="1.4" step="0.05" value={speechPreferences.pitch}
                      onChange={event => setSpeechPreferences(current => ({ ...current, pitch: Number(event.target.value) }))} />
                  </label>
                  <label>
                    Volume · {Math.round(speechPreferences.volume * 100)}%
                    <input type="range" min="0" max="1" step="0.05" value={speechPreferences.volume}
                      onChange={event => setSpeechPreferences(current => ({ ...current, volume: Number(event.target.value) }))} />
                  </label>
                  {!speechAvailable && <p role="status">Local browser speech synthesis is not available.</p>}
                  {speechAvailable && speechVoices.length === 0 && <p role="status">Loading voices from the browser…</p>}
                  {speechAvailable && speechVoices.length > 0 && !speechPreferences.voiceURI &&
                    !isFemaleEnglishVoice(selectSpeechVoice(speechVoices))
                    && <p role="status">No voice is identified as female; an English system voice is selected as a fallback.</p>}
                  <button type="button" className="workspace-action" onClick={() => speechQueueRef.current?.stop()} disabled={!speechAvailable}>
                    STOP SPEECH
                  </button>
                </section>
                <article className="workspace-info-card"><span>OLLAMA MODEL</span><strong>{selectedModel || configuredModel || 'Not detected'}</strong></article>
                <article className="workspace-info-card"><span>BACKEND</span><strong>{import.meta.env.VITE_API_URL || 'http://localhost:3001 (Vite proxy)'}</strong></article>
                <article className="workspace-info-card"><span>FRONTEND</span><strong>{window.location.origin}</strong></article>
                <article className="workspace-info-card"><span>VISION</span><strong>{visionUiStatus.cameraState} · TRACKING {visionUiStatus.handTrackingState}</strong></article>
                <article className="workspace-info-card"><span>VOICE</span><strong>{visionUiStatus.voiceEnabled ? 'ENABLED' : 'OFF'}</strong></article>
                <article className="workspace-info-card"><span>SPEECH STATE</span><strong>{speechPlaybackState}</strong></article>
              </div>
            )}
          </section>
        )}
        </div>

        {pendingActionApproval && (
          <div className="action-approval-overlay">
            <section
              className="action-approval-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="action-approval-title"
              aria-describedby="action-approval-description"
            >
              <span className="eyebrow">PERMISSION CHECK</span>
              <h2 id="action-approval-title">
                {pendingActionApproval.executionId
                  ? pendingActionApproval.approvalType === 'DEPENDENCY_INSTALL'
                    ? 'DEPENDENCY INSTALL REQUIRES APPROVAL'
                    : 'PROJECT REPAIR REQUIRES APPROVAL'
                  : pendingActionApproval.approvalType === 'IMAGE_GENERATION'
                    ? 'IMAGE GENERATION REQUIRES APPROVAL'
                    : pendingActionApproval.approvalType === 'PROJECT_MODIFICATION'
                      ? 'PROJECT CHANGES REQUIRE APPROVAL'
                  : pendingActionApproval.approvalRequestId
                  ? 'PROJECT CREATION REQUIRES APPROVAL'
                  : 'Approve this system action?'}
              </h2>
              <p id="action-approval-description">
                {pendingActionApproval.executionId
                  ? pendingActionApproval.approvalType === 'DEPENDENCY_INSTALL'
                    ? `Project files are created and verified. CLIRO will execute only after approval: ${pendingActionApproval.command || 'npm install'}. Dependencies: ${(pendingActionApproval.dependencies || []).join(', ')}. Working directory: ${pendingActionApproval.projectPath}. No install has started.`
                    : `CLIRO diagnosed an execution error: ${pendingActionApproval.repairProposal?.summary || 'a safe repair is available'}. Approving will create only ${pendingActionApproval.repairProposal?.filePath || 'the verified missing project file'} using a non-overwriting write.`
                  : pendingActionApproval.approvalType === 'IMAGE_GENERATION'
                  ? `CLIRO will send this prompt to ${pendingActionApproval.imagePlan?.provider || 'the configured image provider'} and generate ${pendingActionApproval.imagePlan?.count || 1} image(s) for ${pendingActionApproval.imagePlan?.purpose || 'the requested asset'}.${pendingActionApproval.imagePlan?.projectName ? ` Approved output will be saved in ${pendingActionApproval.imagePlan.projectName}.` : ' The image will be returned as a preview and not saved to a project.'} No provider request or file write has started.`
                  : pendingActionApproval.approvalType === 'PROJECT_MODIFICATION'
                  ? `CLIRO prepared exact changes for ${pendingActionApproval.projectId || 'the selected project'}. Approving applies only the listed file contents. No build or test will run automatically.`
                  : pendingActionApproval.approvalRequestId
                  ? `CLIRO is ready to create ${pendingActionApproval.projectName || 'this project'} using the ${pendingActionApproval.projectTemplate || 'selected'} starter${pendingActionApproval.openInVSCode ? ' and open its folder in VS Code' : ''}. The backend validated the destination; approval expires ${pendingActionApproval.expiresAt ? new Date(pendingActionApproval.expiresAt).toLocaleTimeString() : 'soon'}. Existing directories are never overwritten.`
                  : pendingActionApproval.prompt.toLowerCase().includes('chrome')
                    ? 'CLIRO will close controllable Chrome tabs. Unsaved page data may be lost.'
                    : 'CLIRO will request graceful closure of visible user application windows. Browser and system components are excluded; unsaved-data prompts will not be bypassed.'}
              </p>
              {pendingActionApproval.projectPlan && (
                <div className="project-plan-summary" aria-label="Project plan">
                  <h3>PROJECT PLAN READY</h3>
                  <p>{pendingActionApproval.projectPlan.description}</p>
                  <p><strong>Stack:</strong> {pendingActionApproval.projectPlan.language} · {pendingActionApproval.projectPlan.frontend} frontend · {pendingActionApproval.projectPlan.backend} backend · {pendingActionApproval.projectPlan.database}</p>
                  <p><strong>Roles:</strong> {pendingActionApproval.projectPlan.roles.join(', ')}</p>
                  <p><strong>Features:</strong> {pendingActionApproval.projectPlan.features.join(' · ')}</p>
                  <p><strong>Files:</strong> {pendingActionApproval.projectPlan.files.join(', ')}</p>
                  {pendingActionApproval.projectPlan.dependencies.length > 0 && (
                    <p><strong>Dependencies (not installed):</strong> {pendingActionApproval.projectPlan.dependencies.join(', ')}</p>
                  )}
                  <p><strong>Verification plan:</strong> {pendingActionApproval.projectPlan.testPlan.join(' · ')}</p>
                </div>
              )}
              {pendingActionApproval.imagePlan && (
                <div className="project-plan-summary" aria-label="Image generation plan">
                  <h3>IMAGE PLAN · {pendingActionApproval.imagePlan.provider.toUpperCase()}</h3>
                  <p><strong>Purpose:</strong> {pendingActionApproval.imagePlan.purpose}</p>
                  <p><strong>Prompt:</strong> {pendingActionApproval.imagePlan.prompt}</p>
                  <p><strong>Count:</strong> {pendingActionApproval.imagePlan.count}</p>
                  {pendingActionApproval.imagePlan.outputPaths.length > 0 && (
                    <p><strong>Output:</strong> {pendingActionApproval.imagePlan.outputPaths.join(', ')}</p>
                  )}
                </div>
              )}
              {pendingActionApproval.modificationPlan && (
                <div className="project-plan-summary" aria-label="Project modification plan">
                  <h3>EXACT FILE CHANGES · {pendingActionApproval.modificationPlan.changes.length}</h3>
                  <p><strong>Request:</strong> {pendingActionApproval.modificationPlan.instruction}</p>
                  {pendingActionApproval.modificationPlan.changes.map(change => (
                    <details key={change.path}>
                      <summary>{change.operation} · {change.path} · {change.diff.beforeLines} → {change.diff.afterLines} lines</summary>
                      <pre>{change.content}</pre>
                    </details>
                  ))}
                </div>
              )}
              <div className="action-approval-buttons">
                <button
                  ref={cancelApprovalRef}
                  type="button"
                  className="action-approval-cancel"
                  onClick={() => {
                    const approval = pendingActionApproval;
                    if (approval.executionId) void decideExecutionApproval(approval, false);
                    else void handleSend(
                        approval.prompt,
                        approval.source,
                        approval.gesture,
                        false,
                        true,
                        approval.approvalRequestId
                      );
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="action-approval-approve"
                  onClick={() => {
                    const approval = pendingActionApproval;
                    if (approval.executionId) void decideExecutionApproval(approval, true);
                    else void handleSend(
                        approval.prompt,
                        approval.source,
                        approval.gesture,
                        true,
                        true,
                        approval.approvalRequestId
                      );
                  }}
                >
                  {pendingActionApproval.approvalType === 'IMAGE_GENERATION'
                    ? 'Generate image'
                    : pendingActionApproval.approvalType === 'PROJECT_MODIFICATION'
                      ? 'Apply changes'
                      : pendingActionApproval.executionId || pendingActionApproval.approvalRequestId ? 'Approve' : 'Approve once'}
                </button>
              </div>
            </section>
          </div>
        )}
      </main>

      {/* RIGHT SIDEBAR */}
      <aside className="glass-panel right-sidebar">
        <div className="right-header">
          <div className="right-header-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> SYSTEM STATUS</div>
          <div className={`dot ${backendOnline === null ? 'checking' : backendOnline ? 'online' : 'offline'}`} />
        </div>

        <div className="metrics-container">
          <div className="metric-row">
            <div className="metric-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg></div>
            <div className="metric-info">
              <div className="metric-label-row"><span className="metric-label">CPU</span><span className="metric-val">{cpuPercentage === null ? '—' : `${cpuPercentage}%`}</span></div>
              <div className="metric-bar-bg"><div className="metric-bar" style={{ width: `${cpuPercentage ?? 0}%` }}></div></div>
            </div>
          </div>

          <div className="metric-row">
            <div className="metric-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10v4"/><path d="M10 10v4"/><path d="M14 10v4"/><path d="M18 10v4"/></svg></div>
            <div className="metric-info">
              <div className="metric-label-row"><span className="metric-label">RAM</span><span className="metric-val">{ramPercentage === null ? '—' : `${ramPercentage}%`}</span></div>
              <div className="metric-bar-bg"><div className="metric-bar" style={{ width: `${ramPercentage ?? 0}%` }}></div></div>
            </div>
          </div>

          <div className="metric-row">
            <div className="metric-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
            <div className="metric-info">
              <div className="metric-label-row"><span className="metric-label">STORAGE</span><span className="metric-val">{storagePercentage === null ? '—' : `${storagePercentage}%`}</span></div>
              <div className="metric-bar-bg"><div className="metric-bar" style={{ width: `${storagePercentage ?? 0}%` }}></div></div>
            </div>
          </div>

          <div className="metric-row">
            <div className="metric-icon" style={{ borderColor: 'rgba(0,255,170,0.3)', color: 'var(--accent-green)', boxShadow: 'inset 0 0 10px rgba(0,255,170,0.1)' }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/></svg></div>
            <div className="metric-info">
              <div className="metric-label-row"><span className="metric-label">BATTERY</span><span className="metric-val">{batteryPercentage === null ? 'N/A' : `${batteryPercentage}%`}</span></div>
              <div className="metric-bar-bg"><div className="metric-bar green" style={{ width: `${batteryPercentage ?? 0}%` }}></div></div>
              <div className="charging-text">{systemStatus?.battery?.hasBattery ? systemStatus.battery.isCharging ? 'CHARGING' : 'ON BATTERY' : 'NO BATTERY DATA'}</div>
            </div>
          </div>
        </div>

        <div className="system-details">
          <div className="sys-block">
            <svg className="sys-block-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.951-1.801"/></svg>
            <div className="sys-block-text">
              <h4>OS</h4>
              <p>{systemStatus?.os || (backendOnline === false ? 'Unavailable' : 'Loading telemetry')}</p>
              <span>LIVE SYSTEM TELEMETRY</span>
            </div>
          </div>

          <div className="sys-block">
            <svg className="sys-block-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9a6 6 0 0 1 12 0v5a6 6 0 0 1-12 0z"/><circle cx="12" cy="19" r="2"/><line x1="12" y1="14" x2="12" y2="17"/><path d="M4 14l-2-2v-4a2 2 0 0 1 2-2h1m15 8l2-2v-4a2 2 0 0 0-2-2h-1"/></svg>
            <div className="sys-block-text">
              <h4>OLLAMA</h4>
              <div className="sys-status-label"><div className={`status-dot ${connectionKnown ? isConnected ? 'online' : 'offline' : 'checking'}`} /> {connectionKnown ? isConnected ? 'Connected' : 'Offline' : 'Checking'}</div>
              <h4>Model</h4>
              <p>{selectedModel || configuredModel || (connectionKnown ? 'No model detected' : 'Checking model')}</p>
            </div>
          </div>
        </div>

        <section className="runtime-activity" aria-label="Request activity" aria-live="polite">
          <div className="runtime-activity-heading">
            <span>ACTIVE PROVIDER</span>
            <strong>{activeProvider}</strong>
          </div>
          <h3>JARVIS ACTIVITY</h3>
          {(activeRunExecutionId || (activeExecutionId && agentState === 'executing')) && (
            <button
              type="button"
              className="execution-stop-button"
              onClick={() => void stopProjectExecution(activeRunExecutionId || activeExecutionId)}
            >
              {activeRunExecutionId ? 'Stop CLIRO project' : 'Cancel execution'}
            </button>
          )}
          {activityEvents.length === 0
            ? <p className="activity-empty">Waiting for a request.</p>
            :             activityEvents.slice(-10).reverse().map((event, index) => (
              <div className="runtime-activity-row" key={`${event.stage}-${index}`}>
                <span className={`activity-mark ${event.status.toLowerCase()}`} aria-label={event.status}>
                  {activityMarkFor(event.status)}
                </span>
                <div>
                  <strong>{event.stage.replaceAll('_', ' ')}</strong>
                  <p>{event.message}</p>
                </div>
              </div>
            ))}
        </section>

        <div className="sidebar-quote">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          <div>Small steps with AI<br/>create big changes.</div>
        </div>
      </aside>
    </div>
  );
}

export default App;
