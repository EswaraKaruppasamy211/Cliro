export enum PermissionLevel {
    SAFE_READ = 0,
    LOW_RISK = 1,
    APPROVAL_REQUIRED = 2,
    HIGH_RISK = 3,
    BLOCKED = 4
}

export interface ToolAction {
    name: string;
    level: PermissionLevel;
    description: string;
    approvalGranted?: boolean;
}

export class PermissionEngine {
    
    public checkPermission(action: ToolAction): boolean {
        if (action.level === PermissionLevel.BLOCKED) {
            return false;
        }
        
        if (action.level === PermissionLevel.SAFE_READ || action.level === PermissionLevel.LOW_RISK) {
            return true;
        }
        
        if (action.level === PermissionLevel.APPROVAL_REQUIRED && action.approvalGranted === true) {
            return true;
        }

        return false;
    }
}
