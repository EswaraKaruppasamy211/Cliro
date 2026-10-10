import { execFile } from 'child_process';

export interface ClosedApplication {
    processName: string;
    processId: number;
    status: 'CLOSED' | 'CLOSE_REQUESTED' | 'REFUSED' | 'FAILED';
}

export interface CloseApplicationsResult {
    type: 'ACTION_SUCCESS' | 'ACTION_PARTIAL' | 'ACTION_FAILED';
    message: string;
    closed: ClosedApplication[];
    verified: boolean;
}

const closeVisibleApplicationsScript = `
$ErrorActionPreference = 'Stop'
$sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$excluded = @(
  'explorer','taskmgr','dwm','winlogon','csrss','lsass','services','svchost','systemsettings',
  'system','registry','idle','fontdrvhost','securityhealthservice','msmpeng',
  'audiodg','ctfmon','sihost','searchhost','searchindexer','startmenuexperiencehost',
  'shellexperiencehost','runtimebroker','textinputhost','lockapp','applicationframehost','msedgewebview2',
  'ollama','ollama app','node','powershell','pwsh','cmd','conhost','windowsterminal',
  'chrome','msedge','firefox','brave','opera'
)
$targets = @(Get-Process | Where-Object {
  $_.SessionId -eq $sessionId -and
  $_.MainWindowHandle -ne 0 -and
  -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) -and
  $excluded -notcontains $_.ProcessName.ToLowerInvariant()
} | Select-Object -First 25)
$results = @()
foreach ($target in $targets) {
  $entry = [ordered]@{ processName = $target.ProcessName; processId = $target.Id; status = 'FAILED' }
  try {
    $requested = $target.CloseMainWindow()
    if (-not $requested) {
      $entry.status = 'REFUSED'
    } elseif ($target.WaitForExit(1500)) {
      $entry.status = 'CLOSED'
    } else {
      $entry.status = 'CLOSE_REQUESTED'
    }
  } catch {
    $entry.status = 'FAILED'
  }
  $results += [pscustomobject]$entry
}
ConvertTo-Json -InputObject @($results) -Compress
`;

export async function closeVisibleUserApplications(): Promise<CloseApplicationsResult> {
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', closeVisibleApplicationsScript],
            { windowsHide: true, timeout: 45_000, maxBuffer: 256 * 1024 },
            (error, output, stderr) => {
                if (error) {
                    reject(new Error(stderr.trim() || error.message));
                    return;
                }
                resolve(output.trim());
            }
        );
    });

    if (!stdout) {
        return {
            type: 'ACTION_SUCCESS',
            message: 'No eligible open application windows were found. Browser windows, CLIRO, Ollama, and Windows system applications were left open.',
            closed: [],
            verified: true
        };
    }

    let closed: ClosedApplication[];
    try {
        const parsed: unknown = JSON.parse(stdout);
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        closed = entries.map((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || !('processName' in entry) || !('processId' in entry) || !('status' in entry)) {
                throw new Error('The Windows close-operation response had an invalid shape.');
            }
            const status = entry.status;
            if (status !== 'CLOSED' && status !== 'CLOSE_REQUESTED' && status !== 'REFUSED' && status !== 'FAILED') {
                throw new Error('The Windows close-operation response contained an invalid status.');
            }
            return {
                processName: String(entry.processName),
                processId: Number(entry.processId),
                status
            };
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to verify application close results: ${detail}`);
    }

    const actuallyClosed = closed.filter(item => item.status === 'CLOSED');
    const notClosed = closed.filter(item => item.status !== 'CLOSED');
    if (notClosed.length > 0) {
        const closedNames = actuallyClosed.map(item => item.processName).join(', ');
        return {
            type: actuallyClosed.length > 0 ? 'ACTION_PARTIAL' : 'ACTION_FAILED',
            message: `${actuallyClosed.length} application window${actuallyClosed.length === 1 ? '' : 's'} closed and verified${closedNames ? ` (${closedNames})` : ''}. These did not close: ${notClosed.map(item => `${item.processName} (${item.status})`).join(', ')}. No process was force-killed.`,
            closed,
            verified: false
        };
    }

    return {
        type: 'ACTION_SUCCESS',
        message: `Closed and verified ${actuallyClosed.length} application window${actuallyClosed.length === 1 ? '' : 's'}${actuallyClosed.length ? ` (${actuallyClosed.map(item => item.processName).join(', ')})` : ''}. Browser windows, CLIRO, Ollama, and Windows system applications were left open.`,
        closed,
        verified: true
    };
}
