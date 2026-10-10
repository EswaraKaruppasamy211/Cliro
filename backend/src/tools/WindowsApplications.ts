import { execFile } from 'child_process';
import path from 'path';

export interface WindowsApplication {
    name: string;
    appId: string;
    processNames: string[];
}

const discoveryScript = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$shortcutRoots = @(
    "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"
)
$shortcuts = @()
foreach ($root in $shortcutRoots) {
    if (Test-Path -LiteralPath $root) {
        foreach ($link in (Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
            try {
                $target = $shell.CreateShortcut($link.FullName).TargetPath
                if ($target) {
                    $shortcuts += [pscustomobject]@{
                        Name = ($link.BaseName -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
                        ProcessName = [System.IO.Path]::GetFileName($target)
                    }
                }
            } catch {}
        }
    }
}
$packages = @{}
foreach ($package in (Get-AppxPackage)) {
    $packages[$package.PackageFamilyName] = $package
}
$packageProcessNames = @{}
$applications = @(
    foreach ($entry in (Get-StartApps | Sort-Object Name -Unique)) {
        $processNames = @()
        if ($entry.AppID -match '(?i)([^\\\\!]+\\.exe)$') {
            $processNames += $Matches[1]
        }
        $normalizedName = ($entry.Name -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
        $shortcut = $shortcuts | Where-Object { $_.Name -eq $normalizedName } | Select-Object -First 1
        if ($shortcut) {
            $processNames += $shortcut.ProcessName
        }
        if ($entry.AppID -match '^([^!]+)!(.+)$') {
            $package = $packages[$Matches[1]]
            if ($package) {
                if (-not $packageProcessNames.ContainsKey($package.PackageFamilyName)) {
                    $packageProcessNames[$package.PackageFamilyName] = @{}
                    try {
                        $manifest = [xml](Get-AppxPackageManifest -Package $package)
                        foreach ($applicationNode in $manifest.SelectNodes("//*[local-name()='Application']")) {
                            $executable = $applicationNode.GetAttribute('Executable')
                            if ($executable) {
                                $packageProcessNames[$package.PackageFamilyName][$applicationNode.GetAttribute('Id')] =
                                    [System.IO.Path]::GetFileName($executable)
                            }
                        }
                    } catch {}
                }
                $applicationProcessName = $packageProcessNames[$package.PackageFamilyName][$Matches[2]]
                if ($applicationProcessName) {
                    $processNames += $applicationProcessName
                }
            }
        }
        [pscustomobject]@{
            Name = $entry.Name
            AppID = $entry.AppID
            ProcessNames = @($processNames | Where-Object { $_ } | Sort-Object -Unique)
        }
    }
)
ConvertTo-Json -InputObject @($applications) -Depth 4 -Compress
`;

const aliases: Record<string, string> = {
    'vscode': 'visual studio code',
    'visualstudio': 'visual studio code',
    'chrome': 'google chrome',
    'edge': 'microsoft edge',
    'windowsnotepad': 'notepad',
    'notepadexe': 'notepad',
    'windowscalculator': 'calculator',
    'calc': 'calculator',
    'explorer': 'file explorer',
    'windowsexplorer': 'file explorer',
    'mspaint': 'paint',
    'microsoftpaint': 'paint',
    'terminal': 'windows terminal',
    'cmd': 'command prompt',
    'powershell': 'windows powershell',
    'settings': 'windows settings',
    'taskmgr': 'task manager',
    'antigravity': 'antigravity ide'
};

const knownProcessNames: Record<string, string[]> = {
    'whatsapp': ['WhatsApp.exe', 'WhatsApp.Root.exe'],
    'antigravityide': ['Antigravity IDE.exe', 'Antigravity.exe'],
    'googlechrome': ['chrome.exe'],
    'microsoftedge': ['msedge.exe'],
    'fileexplorer': ['explorer.exe'],
    'notepad': ['notepad.exe'],
    'calculator': ['CalculatorApp.exe', 'Calculator.exe'],
    'visualstudiocode': ['Code.exe'],
    'paint': ['mspaint.exe'],
    'commandprompt': ['cmd.exe'],
    'windowspowershell': ['powershell.exe'],
    'windowsterminal': ['WindowsTerminal.exe'],
    'taskmanager': ['Taskmgr.exe']
};

let cachedApplications: WindowsApplication[] | undefined;
let cacheExpiresAt = 0;
let discoveryInProgress: Promise<WindowsApplication[]> | undefined;

export function normalizeApplicationName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function discoverInstalledApplications(): Promise<WindowsApplication[]> {
    if (cachedApplications && Date.now() < cacheExpiresAt) return cachedApplications;
    if (discoveryInProgress) return discoveryInProgress;

    discoveryInProgress = (async () => {
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', discoveryScript],
                { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30000 },
                (error, output, stderr) => {
                    if (error) {
                        reject(new Error(stderr.trim() || `Windows application discovery failed: ${error.message}`));
                        return;
                    }
                    resolve(output);
                }
            );
        });

        let rawApplications: Array<{ Name?: unknown; AppID?: unknown; ProcessNames?: unknown }>;
        try {
            const parsed: unknown = JSON.parse(stdout.trim());
            rawApplications = Array.isArray(parsed) ? parsed : [parsed as typeof rawApplications[number]];
        } catch {
            throw new Error('Windows application discovery returned invalid data.');
        }

        cachedApplications = rawApplications
            .filter((item): item is { Name: string; AppID: string; ProcessNames?: unknown } =>
                typeof item?.Name === 'string' && typeof item.AppID === 'string')
            .map(item => {
                const normalizedName = normalizeApplicationName(item.Name);
                const discoveredProcessNames = Array.isArray(item.ProcessNames)
                    ? item.ProcessNames.filter((name): name is string => typeof name === 'string')
                    : typeof item.ProcessNames === 'string' ? [item.ProcessNames] : [];
                const processNames = [
                    ...discoveredProcessNames,
                    ...(knownProcessNames[normalizedName] || [])
                ].map(name => path.basename(name)).filter(name => /\.exe$/i.test(name));
                return {
                    name: item.Name,
                    appId: item.AppID,
                    processNames: [...new Set(processNames.map(name => name.toLowerCase()))]
                };
            });
        cacheExpiresAt = Date.now() + 30_000;
        return cachedApplications;
    })();

    try {
        return await discoveryInProgress;
    } finally {
        discoveryInProgress = undefined;
    }
}

export async function resolveApplication(appName: string): Promise<WindowsApplication | undefined> {
    const applications = await discoverInstalledApplications();
    const requestedName = normalizeApplicationName(appName);

    const exactMatch = applications.find(application =>
        normalizeApplicationName(application.name) === requestedName);
    if (exactMatch) return exactMatch;

    const canonicalName = aliases[requestedName];
    if (!canonicalName) return undefined;
    return applications.find(application =>
        normalizeApplicationName(application.name) === normalizeApplicationName(canonicalName));
}

export async function isApplicationRunning(application: WindowsApplication): Promise<boolean> {
    if (application.processNames.length === 0) return false;

    const processNames = [...new Set(application.processNames
        .filter(name => /^[a-z0-9][a-z0-9 ._-]*\.exe$/i.test(name))
        .map(name => name.replace(/\.exe$/i, '')))];
    if (processNames.length === 0) return false;

    const namesLiteral = processNames.map(name => `'${name}'`).join(',');
    const script = `$ErrorActionPreference = 'Stop'; $names = @(${namesLiteral}); $running = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique); ConvertTo-Json -InputObject $running -Compress`;
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, maxBuffer: 256 * 1024, timeout: 15000 },
            (error, output, stderr) => {
                if (error) {
                    reject(new Error(stderr.trim() || `Unable to inspect running applications: ${error.message}`));
                    return;
                }
                resolve(output);
            }
        );
    });

    let runningNames: unknown;
    try {
        runningNames = JSON.parse(stdout.trim() || '[]');
    } catch {
        throw new Error('Windows returned invalid running-process information.');
    }
    const names = Array.isArray(runningNames) ? runningNames : [runningNames];
    return names.some(name =>
        typeof name === 'string' && processNames.some(processName => processName.toLowerCase() === name.toLowerCase()));
}

export function launchRegisteredApplication(application: WindowsApplication): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        execFile(
            'explorer.exe',
            [`shell:AppsFolder\\${application.appId}`],
            { windowsHide: true, timeout: 15000 },
            error => {
                if (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (typeof code === 'string') {
                        reject(new Error(`Windows could not launch ${application.name}: ${error.message}`));
                        return;
                    }
                    resolve(`The Windows launch handler returned an error: ${error.message}`);
                    return;
                }
                resolve(undefined);
            }
        );
    });
}

export async function waitForApplication(application: WindowsApplication): Promise<boolean> {
    if (application.processNames.length === 0) return false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (await isApplicationRunning(application)) return true;
    }
    return false;
}
