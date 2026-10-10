"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionEngine = exports.PermissionLevel = void 0;
var PermissionLevel;
(function (PermissionLevel) {
    PermissionLevel[PermissionLevel["SAFE_READ"] = 0] = "SAFE_READ";
    PermissionLevel[PermissionLevel["LOW_RISK"] = 1] = "LOW_RISK";
    PermissionLevel[PermissionLevel["APPROVAL_REQUIRED"] = 2] = "APPROVAL_REQUIRED";
    PermissionLevel[PermissionLevel["HIGH_RISK"] = 3] = "HIGH_RISK";
    PermissionLevel[PermissionLevel["BLOCKED"] = 4] = "BLOCKED";
})(PermissionLevel || (exports.PermissionLevel = PermissionLevel = {}));
class PermissionEngine {
    checkPermission(action) {
        if (action.level === PermissionLevel.BLOCKED) {
            return false;
        }
        if (action.level === PermissionLevel.SAFE_READ || action.level === PermissionLevel.LOW_RISK) {
            return true;
        }
        // In a real implementation, Levels 2 and 3 would trigger an approval flow.
        // For Phase 1, we will just return false to enforce security until UI is built.
        return false;
    }
}
exports.PermissionEngine = PermissionEngine;
//# sourceMappingURL=PermissionEngine.js.map