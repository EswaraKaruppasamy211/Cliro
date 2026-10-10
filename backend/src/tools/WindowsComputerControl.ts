import { execFile, spawn } from 'child_process';
import type { SafeKeyAction } from './ComputerActionPlanner';

export interface ForegroundWindow {
    handle: string;
    processId: number;
    processName: string;
    title: string;
}

export interface WindowOperationResult {
    success: boolean;
    verified: boolean;
    message: string;
    processName?: string;
    processId?: number;
    windowFound?: boolean;
}

const foregroundScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CliroWindowApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$handle = [CliroWindowApi]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { 'null'; exit 0 }
$processId = [uint32]0
[void][CliroWindowApi]::GetWindowThreadProcessId($handle, [ref]$processId)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if (-not $process) { 'null'; exit 0 }
$title = New-Object System.Text.StringBuilder 1024
[void][CliroWindowApi]::GetWindowText($handle, $title, $title.Capacity)
[pscustomobject]@{
  handle = $handle.ToInt64().ToString()
  processId = [int]$processId
  processName = $process.ProcessName + '.exe'
  title = $title.ToString()
} | ConvertTo-Json -Compress
`;

const verifyExplorerFolderScript = `
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$expected = ([System.Uri]::new([string]$inputData.path)).AbsoluteUri.TrimEnd('/')
$shell = New-Object -ComObject Shell.Application
$found = $false
for ($attempt = 0; $attempt -lt 20 -and -not $found; $attempt++) {
  foreach ($window in @($shell.Windows())) {
    if (([string]$window.LocationURL).TrimEnd('/') -ieq $expected) { $found = $true; break }
  }
  if (-not $found) { Start-Sleep -Milliseconds 150 }
}
[pscustomobject]@{
  success = $found
  verified = $found
  message = if ($found) { 'The requested folder is open in File Explorer and its location was verified.' } else { 'Explorer accepted the folder request, but its window location could not be verified.' }
} | ConvertTo-Json -Compress
`;

const focusScript = `
param()
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CliroFocusApi {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$names = @($inputData.processNames | ForEach-Object { [string]$_ })
$targets = @()
for ($attempt = 0; $attempt -lt 20 -and $targets.Count -eq 0; $attempt++) {
  $targets = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    (($names -contains ($_.ProcessName + '.exe').ToLowerInvariant()) -or
     ($_.ProcessName -eq 'ApplicationFrameHost' -and $_.MainWindowTitle -ceq [string]$inputData.applicationName)) -and
    $_.MainWindowHandle -ne 0
  } | Select-Object -First 20)
  if ($targets.Count -eq 0) { Start-Sleep -Milliseconds 150 }
}
if ($targets.Count -eq 0) {
  [pscustomobject]@{ success = $false; verified = $false; windowFound = $false; message = 'No visible window was found for that application.' } | ConvertTo-Json -Compress
  exit 0
}
$target = $targets[0]
[void][CliroFocusApi]::SetForegroundWindow($target.MainWindowHandle)
Start-Sleep -Milliseconds 150
$activePid = [uint32]0
$activeHandle = [CliroFocusApi]::GetForegroundWindow()
[void][CliroFocusApi]::GetWindowThreadProcessId($activeHandle, [ref]$activePid)
$verified = $activePid -eq $target.Id
[pscustomobject]@{
  success = $verified
  verified = $verified
  windowFound = $true
  processName = $target.ProcessName + '.exe'
  processId = $target.Id
  message = if ($verified) { 'The application window is focused.' } else { 'Windows did not confirm that the application window received focus.' }
} | ConvertTo-Json -Compress
`;

const closeWindowScript = `
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CliroCloseApi {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$handle = [IntPtr]::new([Int64]$inputData.handle)
$targetPid = [int]$inputData.processId
$processName = ([string]$inputData.processName).ToLowerInvariant()
$actualPid = [uint32]0
[void][CliroCloseApi]::GetWindowThreadProcessId($handle, [ref]$actualPid)
$process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if (-not [CliroCloseApi]::IsWindow($handle) -or $actualPid -ne $targetPid -or
    -not $process -or $process.ProcessName.ToLowerInvariant() -ne [System.IO.Path]::GetFileNameWithoutExtension($processName)) {
  [pscustomobject]@{ success = $false; verified = $false; message = 'The foreground window identity changed; no close request was sent.' } | ConvertTo-Json -Compress
  exit 0
}
if ($processName -eq 'explorer.exe') {
  if ($inputData.title -eq 'Program Manager' -or $inputData.title -eq '') {
    [pscustomobject]@{ success = $false; verified = $false; message = 'The foreground Explorer window is the desktop shell, so it was not closed.' } | ConvertTo-Json -Compress
    exit 0
  }
  [void][CliroCloseApi]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  for ($i = 0; $i -lt 20 -and [CliroCloseApi]::IsWindow($handle); $i++) { Start-Sleep -Milliseconds 150 }
  $verified = -not [CliroCloseApi]::IsWindow($handle)
  [pscustomobject]@{
    success = $verified
    verified = $verified
    processName = 'explorer.exe'
    processId = $targetPid
    message = if ($verified) { 'The File Explorer window closed; the Windows Explorer process was left running.' } else { 'Windows did not confirm that the File Explorer window closed.' }
  } | ConvertTo-Json -Compress
  exit 0
}
$requested = [CliroCloseApi]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
if (-not $requested) {
  [pscustomobject]@{ success = $false; verified = $false; message = 'The application declined the graceful window-close request.' } | ConvertTo-Json -Compress
  exit 0
}
for ($i = 0; $i -lt 20 -and [CliroCloseApi]::IsWindow($handle); $i++) { Start-Sleep -Milliseconds 150 }
$verified = -not [CliroCloseApi]::IsWindow($handle)
[pscustomobject]@{
  success = $verified
  verified = $verified
  processName = $processName
  processId = $targetPid
  message = if ($verified) { 'The application window closed and its disappearance was verified.' } else { 'The close request was sent, but the application window remains open; it may have unsaved work.' }
} | ConvertTo-Json -Compress
`;

const closeApplicationScript = `
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CliroAppCloseApi {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
'@
$names = @($inputData.processNames | ForEach-Object { [System.IO.Path]::GetFileNameWithoutExtension([string]$_).ToLowerInvariant() })
if ($names -contains 'explorer') {
  [pscustomobject]@{ success = $false; verified = $false; message = 'File Explorer must be closed as a foreground window; the Explorer process is never terminated.' } | ConvertTo-Json -Compress
  exit 0
}
$targets = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  (($names -contains $_.ProcessName.ToLowerInvariant()) -or
   ($_.ProcessName -eq 'applicationframehost' -and $_.MainWindowTitle -ceq [string]$inputData.applicationName)) -and
  $_.MainWindowHandle -ne 0
} | Select-Object -First 20)
if ($targets.Count -eq 0) {
  [pscustomobject]@{ success = $false; verified = $false; message = 'No visible window was found for that application.' } | ConvertTo-Json -Compress
  exit 0
}
$handles = @($targets | ForEach-Object { [Int64]$_.MainWindowHandle })
$requested = @()
foreach ($target in $targets) {
  if ($target.CloseMainWindow()) { $requested += $target.Id }
}
for ($i = 0; $i -lt 20; $i++) {
  $openHandles = @($handles | Where-Object { [CliroAppCloseApi]::IsWindow([IntPtr]::new($_)) })
  if ($openHandles.Count -eq 0) { break }
  Start-Sleep -Milliseconds 150
}
$remaining = @($handles | Where-Object { [CliroAppCloseApi]::IsWindow([IntPtr]::new($_)) })
$verified = $requested.Count -gt 0 -and $remaining.Count -eq 0
[pscustomobject]@{
  success = $verified
  verified = $verified
  message = if ($verified) { 'The application windows closed and their disappearance was verified.' } else { 'Windows did not confirm that all application windows closed; unsaved work may be prompting.' }
} | ConvertTo-Json -Compress
`;

const sendInputScript = `
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CliroInputApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
}
'@
$handle = [CliroInputApi]::GetForegroundWindow()
$activePid = [uint32]0
[void][CliroInputApi]::GetWindowThreadProcessId($handle, [ref]$activePid)
$process = Get-Process -Id $activePid -ErrorAction SilentlyContinue
$names = @($inputData.processNames | ForEach-Object { [System.IO.Path]::GetFileNameWithoutExtension([string]$_).ToLowerInvariant() })
if (-not $process -or (
  $names.Count -gt 0 -and
  $names -notcontains $process.ProcessName.ToLowerInvariant() -and
  -not ($process.ProcessName -eq 'ApplicationFrameHost' -and $process.MainWindowTitle -ceq [string]$inputData.applicationName)
)) {
  [pscustomobject]@{ success = $false; verified = $false; message = 'The intended application is not the foreground window; no input was sent.' } | ConvertTo-Json -Compress
  exit 0
}
if ($inputData.operation -eq 'TEXT') {
  [System.Windows.Forms.SendKeys]::SendWait([string]$inputData.value)
} elseif ($inputData.key -eq 'WINDOWS') {
  [CliroInputApi]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
  [CliroInputApi]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
} else {
  [System.Windows.Forms.SendKeys]::SendWait([string]$inputData.value)
}
Start-Sleep -Milliseconds 100
$afterHandle = [CliroInputApi]::GetForegroundWindow()
$afterPid = [uint32]0
[void][CliroInputApi]::GetWindowThreadProcessId($afterHandle, [ref]$afterPid)
$verified = if ($inputData.key -eq 'ALT_TAB') {
  $afterHandle -ne $handle
} elseif ($inputData.key -eq 'WINDOWS') {
  $false
} else {
  $afterPid -eq $activePid -and $afterHandle -eq $handle
}
[pscustomobject]@{
  success = $true
  verified = $verified
  processName = $process.ProcessName + '.exe'
  processId = [int]$activePid
  message = if ($verified) { 'Input was sent to the confirmed foreground window.' } elseif ($inputData.key -eq 'WINDOWS') { 'The Windows key was sent, but its UI effect could not be verified.' } else { 'Input was sent, but the foreground result could not be verified.' }
} | ConvertTo-Json -Compress
`;

function encodePowerShell(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShellJson<T>(script: string, input?: unknown, timeoutMs = 10_000): Promise<T> {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error('Windows computer control is available only on Windows.'));
    }
    return new Promise((resolve, reject) => {
        const child = spawn(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Windows computer control timed out.'));
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', error => {
            clearTimeout(timer);
            reject(new Error(`Unable to start the Windows control helper: ${error.message}`));
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(stderr.trim() || `Windows control helper exited with code ${code}.`));
                return;
            }
            try {
                resolve(JSON.parse(stdout.trim()) as T);
            } catch {
                reject(new Error(stderr.trim() || 'Windows control helper returned invalid JSON.'));
            }
        });
        child.stdin.end(input === undefined ? '' : JSON.stringify(input), 'utf8');
    });
}

function checkedProcessNames(processNames: string[]): string[] {
    return [...new Set(processNames
        .filter(name => /^[a-z0-9][a-z0-9 ._-]*\.exe$/i.test(name))
        .map(name => name.toLowerCase()))];
}

export function getForegroundWindow(): Promise<ForegroundWindow | null> {
    return runPowerShellJson<ForegroundWindow | null>(foregroundScript);
}

export async function focusApplicationWindow(processNames: string[], applicationName: string): Promise<WindowOperationResult> {
    const names = checkedProcessNames(processNames);
    if (names.length === 0) return { success: false, verified: false, message: 'No safe application process identity is available.' };
    return runPowerShellJson<WindowOperationResult>(focusScript, { processNames: names, applicationName }, 5_000);
}

export async function closeForegroundWindow(window: ForegroundWindow): Promise<WindowOperationResult> {
    if (!/^\d+$/.test(window.handle) || !Number.isSafeInteger(window.processId) ||
        !/^[a-z0-9][a-z0-9 ._-]*\.exe$/i.test(window.processName)) {
        return { success: false, verified: false, message: 'The foreground window identity is invalid; no close request was sent.' };
    }
    return runPowerShellJson<WindowOperationResult>(closeWindowScript, window, 5_000);
}

export async function closeApplicationWindows(processNames: string[], applicationName: string): Promise<WindowOperationResult> {
    const names = checkedProcessNames(processNames);
    if (names.length === 0) return { success: false, verified: false, message: 'No safe application process identity is available.' };
    if (names.includes('explorer.exe')) {
        return { success: false, verified: false, message: 'File Explorer must be closed as a foreground window; the Explorer process is never terminated.' };
    }
    return runPowerShellJson<WindowOperationResult>(closeApplicationScript, { processNames: names, applicationName }, 7_000);
}

export function encodeSendKeysText(text: string): string {
    if (text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
        throw new Error('Text must be under 4,000 characters and cannot contain unsupported control characters.');
    }
    const escaped: Record<string, string> = {
        '+': '{+}', '^': '{^}', '%': '{%}', '~': '{~}', '(': '{(}', ')': '{)}',
        '[': '{[}', ']': '{]}', '{': '{{}', '}': '{}}'
    };
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[+^%~()[\]{}]/g, character => escaped[character])
        .replace(/\n/g, '{ENTER}')
        .replace(/\t/g, '{TAB}');
}

const keySequences: Record<Exclude<SafeKeyAction, 'WINDOWS'>, string> = {
    ENTER: '{ENTER}',
    ESCAPE: '{ESC}',
    TAB: '{TAB}',
    BACKSPACE: '{BACKSPACE}',
    CTRL_C: '^c',
    CTRL_V: '^v',
    CTRL_A: '^a',
    CTRL_L: '^l',
    ALT_TAB: '%{TAB}'
};

export async function sendTextToForeground(
    text: string,
    processNames: string[],
    applicationName?: string
): Promise<WindowOperationResult> {
    const encodedText = encodeSendKeysText(text);
    const names = checkedProcessNames(processNames);
    if (names.length === 0) return { success: false, verified: false, message: 'No allowlisted foreground application was identified; no text was sent.' };
    return runPowerShellJson<WindowOperationResult>(sendInputScript, {
        operation: 'TEXT',
        value: encodedText,
        processNames: names,
        applicationName
    }, 5_000);
}

export async function sendSafeKey(key: SafeKeyAction, expectedProcessNames: string[] = []): Promise<WindowOperationResult> {
    if (key !== 'WINDOWS' && !(key in keySequences)) {
        return { success: false, verified: false, message: 'This keyboard action is not allowed.' };
    }
    const value = key === 'WINDOWS' ? key : keySequences[key];
    return runPowerShellJson<WindowOperationResult>(sendInputScript, {
        operation: 'KEY',
        value,
        key,
        processNames: checkedProcessNames(expectedProcessNames)
    }, 5_000);
}

export async function openExplorerFolder(folderPath: string): Promise<WindowOperationResult> {
    let launchError: (Error & { code?: string | number }) | undefined;
    await new Promise<void>(resolve => {
        execFile('explorer.exe', [folderPath], { windowsHide: true, timeout: 10_000 }, error => {
            if (error) launchError = error;
            resolve();
        });
    });
    let verification: WindowOperationResult;
    try {
        verification = await runPowerShellJson<WindowOperationResult>(verifyExplorerFolderScript, { path: folderPath }, 5_000);
    } catch (error) {
        const verificationError = error instanceof Error ? error.message : String(error);
        if (launchError) {
            const launchDetail = typeof launchError.code === 'number'
                ? `Explorer exited with code ${launchError.code}.`
                : launchError.message;
            throw new Error(`${launchDetail} Folder verification also failed: ${verificationError}`);
        }
        throw error;
    }
    if (!verification.verified && launchError) {
        const launchDetail = typeof launchError.code === 'number'
            ? `Explorer exited with code ${launchError.code}.`
            : launchError.message;
        return {
            ...verification,
            message: `${launchDetail} ${verification.message}`
        };
    }
    return verification;
}
