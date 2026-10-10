"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSystemStatus = getSystemStatus;
const os_1 = __importDefault(require("os"));
function getSystemStatus() {
    const totalMem = os_1.default.totalmem();
    const freeMem = os_1.default.freemem();
    const usedMem = totalMem - freeMem;
    return {
        cpu: `${os_1.default.cpus().length} Cores`, // A simple approximation for now
        ram: `${(usedMem / 1024 / 1024 / 1024).toFixed(1)} / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
        storage: 'Unknown', // Need more specific OS commands to get exact storage easily without heavy libs
        os: `${os_1.default.type()} ${os_1.default.release()}`
    };
}
//# sourceMappingURL=systemStatus.js.map