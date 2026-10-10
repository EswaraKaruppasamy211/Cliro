import si from 'systeminformation';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

const BYTES_PER_GIGABYTE = 1024 ** 3;
let cachedWindowsDriveRoots: string[] | undefined;
let windowsDriveRootsExpireAt = 0;
let windowsDriveRootsRequest: Promise<string[]> | undefined;

export type SystemInfoSection = 'cpu' | 'ram' | 'battery' | 'storage' | 'os' | 'all';

export interface BatteryStatus {
    percent: number | null;
    isCharging: boolean | null;
    hasBattery: boolean;
}

export interface SystemInfo {
    cpu: {
        usagePercent: number;
    };
    ram: {
        totalBytes: number;
        usedBytes: number;
        availableBytes: number;
        usagePercent: number;
    };
    battery: BatteryStatus;
    storage: {
        totalBytes: number;
        usedBytes: number;
        freeBytes: number;
        usagePercent: number;
        volumes: Array<{
            mount: string;
            totalBytes: number;
            usedBytes: number;
            freeBytes: number;
            usagePercent: number;
        }>;
    };
    os: {
        distro: string;
        platform: string;
        release: string;
        architecture: string;
    };
}

export interface SystemStatus {
    cpu: string;
    ram: string;
    storage: string;
    os: string;
    battery: BatteryStatus;
}

function toPercentage(used: number, total: number): number {
    if (total <= 0) throw new Error('System information returned an invalid zero-sized resource.');
    return Number(((used / total) * 100).toFixed(1));
}

function safeErrorDetail(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[A-Za-z]:\\[^\s]+/g, '[system path]').trim() || 'Unknown system information error.';
}

async function getWindowsStorageVolumes(): Promise<SystemInfo['storage']['volumes']> {
    let driveRoots = cachedWindowsDriveRoots && Date.now() < windowsDriveRootsExpireAt
        ? cachedWindowsDriveRoots
        : undefined;
    if (!driveRoots) {
        if (!windowsDriveRootsRequest) {
            windowsDriveRootsRequest = new Promise<string[]>((resolve, reject) => {
                execFile(
                    'powershell.exe',
                    [
                        '-NoLogo',
                        '-NoProfile',
                        '-NonInteractive',
                        '-Command',
                        '[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed } | ForEach-Object { $_.Name }'
                    ],
                    { windowsHide: true, maxBuffer: 64 * 1024, timeout: 15000 },
                    (error, output, stderr) => {
                        if (error) {
                            reject(new Error(stderr.trim() || `Unable to enumerate Windows storage volumes: ${error.message}`));
                            return;
                        }
                        const roots = [...new Set(output.split(/\r?\n/)
                            .map(root => root.trim())
                            .filter(root => /^[A-Z]:\\$/i.test(root)))];
                        if (roots.length === 0) {
                            reject(new Error('Windows did not report any fixed storage volumes.'));
                            return;
                        }
                        cachedWindowsDriveRoots = roots;
                        windowsDriveRootsExpireAt = Date.now() + 30_000;
                        resolve(roots);
                    }
                );
            }).finally(() => {
                windowsDriveRootsRequest = undefined;
            });
        }
        driveRoots = await windowsDriveRootsRequest;
    }
    if (driveRoots.length === 0) {
        throw new Error('Windows did not report any fixed storage volumes.');
    }

    const volumes = await Promise.all(driveRoots.map(async mount => {
        try {
            const stats = await fs.statfs(mount);
            const totalBytes = stats.blocks * stats.bsize;
            const freeBytes = stats.bavail * stats.bsize;
            return {
                mount,
                totalBytes,
                freeBytes,
                usedBytes: totalBytes - freeBytes,
                usagePercent: toPercentage(totalBytes - freeBytes, totalBytes)
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENODEV' || code === 'ENXIO') return null;
            throw error;
        }
    }));
    const availableVolumes = volumes.filter((volume): volume is NonNullable<typeof volume> => volume !== null);
    if (availableVolumes.length === 0) {
        throw new Error('No accessible Windows storage volumes were reported by the operating system.');
    }
    return availableVolumes;
}

export async function getSystemInfo(): Promise<SystemInfo> {
    try {
        const [cpu, battery, platformData] = await Promise.all([
            si.currentLoad(),
            si.battery(),
            process.platform === 'win32'
                ? (async () => {
                    const totalBytes = os.totalmem();
                    const availableBytes = os.freemem();
                    const volumes = await getWindowsStorageVolumes();
                    return {
                        memory: {
                            totalBytes,
                            availableBytes,
                            usedBytes: totalBytes - availableBytes
                        },
                        volumes,
                        os: {
                            distro: os.version(),
                            platform: os.platform(),
                            release: os.release(),
                            architecture: os.arch()
                        }
                    };
                })()
                : (async () => {
                    const [memory, filesystems, osInfo] = await Promise.all([
                        si.mem(),
                        si.fsSize(),
                        si.osInfo()
                    ]);
                    return {
                        memory: {
                            totalBytes: memory.total,
                            availableBytes: memory.available,
                            usedBytes: memory.used
                        },
                        volumes: filesystems.map(volume => ({
                            mount: volume.mount,
                            totalBytes: volume.size,
                            usedBytes: volume.used,
                            freeBytes: volume.available,
                            usagePercent: Number(volume.use.toFixed(1))
                        })),
                        os: {
                            distro: osInfo.distro,
                            platform: osInfo.platform,
                            release: osInfo.release,
                            architecture: osInfo.arch
                        }
                    };
                })()
        ]);

        if (platformData.volumes.length === 0) {
            throw new Error('No mounted storage volumes were reported by the operating system.');
        }

        const volumes = platformData.volumes;
        const totalBytes = volumes.reduce((total, volume) => total + volume.totalBytes, 0);
        const usedBytes = volumes.reduce((total, volume) => total + volume.usedBytes, 0);
        const freeBytes = volumes.reduce((total, volume) => total + volume.freeBytes, 0);

        return {
            cpu: {
                usagePercent: Number(cpu.currentLoad.toFixed(1))
            },
            ram: {
                totalBytes: platformData.memory.totalBytes,
                usedBytes: platformData.memory.usedBytes,
                availableBytes: platformData.memory.availableBytes,
                usagePercent: toPercentage(platformData.memory.usedBytes, platformData.memory.totalBytes)
            },
            battery: {
                hasBattery: battery.hasBattery,
                percent: battery.hasBattery ? battery.percent : null,
                isCharging: battery.hasBattery ? battery.isCharging : null
            },
            storage: {
                totalBytes,
                usedBytes,
                freeBytes,
                usagePercent: toPercentage(usedBytes, totalBytes),
                volumes
            },
            os: {
                ...platformData.os
            }
        };
    } catch (error) {
        throw new Error(`Unable to retrieve system information: ${safeErrorDetail(error)}`);
    }
}

export async function getSystemStatus(): Promise<SystemStatus> {
    const info = await getSystemInfo();
    return {
        cpu: `${info.cpu.usagePercent}%`,
        ram: `${(info.ram.usedBytes / BYTES_PER_GIGABYTE).toFixed(1)} / ${(info.ram.totalBytes / BYTES_PER_GIGABYTE).toFixed(1)} GB`,
        storage: `${info.storage.usagePercent}% used`,
        os: info.os.distro,
        battery: {
            percent: info.battery.percent ?? 0,
            isCharging: info.battery.isCharging ?? false,
            hasBattery: info.battery.hasBattery
        }
    };
}
