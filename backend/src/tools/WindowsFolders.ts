import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ResolvedFolder {
    path: string;
    name: string;
}

const specialFolders: Record<string, string> = {
    desktop: 'Desktop',
    documents: 'Documents',
    downloads: 'Downloads',
    pictures: 'Pictures',
    music: 'Music',
    videos: 'Videos'
};

const configuredFolders: Record<string, string> = {
    cliro: 'E:\\Cliro',
    tms: 'C:\\Projects\\TMS'
};

function userRoots(): string[] {
    const home = os.homedir();
    return [...new Set([
        home,
        process.env.OneDrive,
        process.env.OneDriveConsumer,
        path.join(home, 'OneDrive'),
        path.join(home, 'OneDrive - Personal')
    ].filter((item): item is string => Boolean(item)))];
}

async function existingDirectory(candidate: string): Promise<string | undefined> {
    try {
        const canonical = await fs.promises.realpath(candidate);
        const details = await fs.promises.stat(canonical);
        return details.isDirectory() ? canonical : undefined;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
        throw error;
    }
}

export async function resolveSafeFolder(requested: string): Promise<ResolvedFolder | undefined> {
    const request = requested.trim().replace(/^["']|["']$/g, '');
    if (!request) return undefined;
    const folderKey = request.toLowerCase().replace(/\s+folder$/, '').trim();

    if (path.win32.isAbsolute(request)) {
        const canonical = await existingDirectory(request);
        return canonical ? { path: canonical, name: path.basename(canonical) || canonical } : undefined;
    }

    const configuredPath = configuredFolders[folderKey];
    if (configuredPath) {
        const canonical = await existingDirectory(configuredPath);
        return canonical ? { path: canonical, name: folderKey === 'cliro' ? 'CLIRO' : 'TMS' } : undefined;
    }

    const specialName = specialFolders[folderKey];
    if (specialName) {
        const candidates = userRoots().map(root => path.join(root, specialName));
        for (const candidate of candidates) {
            const canonical = await existingDirectory(candidate);
            if (canonical) return { path: canonical, name: specialName };
        }
        return undefined;
    }

    if (!/^[a-z0-9][a-z0-9 ._-]{0,79}$/i.test(request)) return undefined;
    const roots = userRoots().flatMap(root => [
        root,
        path.join(root, 'Desktop'),
        path.join(root, 'Documents')
    ]);
    for (const root of roots) {
        const canonical = await existingDirectory(path.join(root, request));
        if (canonical) return { path: canonical, name: path.basename(canonical) };
    }
    return undefined;
}
