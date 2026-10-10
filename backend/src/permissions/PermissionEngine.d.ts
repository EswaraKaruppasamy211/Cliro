export declare enum PermissionLevel {
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
}
export declare class PermissionEngine {
    checkPermission(action: ToolAction): boolean;
}
//# sourceMappingURL=PermissionEngine.d.ts.map