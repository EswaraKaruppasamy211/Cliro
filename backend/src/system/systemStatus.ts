import os from 'os';

export interface SystemStatus {
    cpu: string;
    ram: string;
    storage: string;
    os: string;
}

export function getSystemStatus(): SystemStatus {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    return {
        cpu: `${os.cpus().length} Cores`, // A simple approximation for now
        ram: `${(usedMem / 1024 / 1024 / 1024).toFixed(1)} / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
        storage: 'Unknown', // Need more specific OS commands to get exact storage easily without heavy libs
        os: `${os.type()} ${os.release()}`
    };
}
