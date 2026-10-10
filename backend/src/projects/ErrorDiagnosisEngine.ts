import path from 'path';

export type DiagnosisCategory =
    | 'MODULE_NOT_FOUND'
    | 'TYPESCRIPT_ERROR'
    | 'JAVASCRIPT_SYNTAX_ERROR'
    | 'NPM_ERROR'
    | 'MISSING_FILE'
    | 'PORT_CONFLICT'
    | 'PERMISSION_ERROR'
    | 'RUNTIME_ERROR'
    | 'UNKNOWN_BUILD_ERROR';

export interface CommandResult {
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    duration: number;
    timestamp: string;
}

export interface ErrorDiagnosis {
    category: DiagnosisCategory;
    summary: string;
    affectedFiles: string[];
    suggestedFix: string;
    confidence: number;
}

export class ErrorDiagnosisEngine {
    diagnose(result: CommandResult, projectPath: string): ErrorDiagnosis {
        const output = `${result.stderr}\n${result.stdout}`;
        const normalizedPath = projectPath.replace(/[\\/]+$/, '');
        const rawFiles = [
            ...[...output.matchAll(/(?:^|\s)((?:[A-Za-z]:[\\/])?[\w./\\-]+\.(?:tsx?|jsx?|json|css|html|py))(?=[(:\s])/gim)].map(match => match[1]),
            ...[...output.matchAll(/(?:File not found|Could not find file)\s*[:=]?\s*['"]([^'"]+)['"]/gi)].map(match => match[1])
        ];
        const affectedFiles = [...new Set(rawFiles
            .map(file => file.trim())
            .map(file => path.isAbsolute(file) ? path.relative(normalizedPath, file) : file)
            .filter(file => file && !file.startsWith('..') && !path.isAbsolute(file))
            .slice(0, 10))];
        const identify = (category: DiagnosisCategory, summary: string, suggestedFix: string, confidence: number): ErrorDiagnosis => ({
            category,
            summary,
            affectedFiles,
            suggestedFix,
            confidence
        });

        if (/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package/i.test(output)) {
            return identify('MODULE_NOT_FOUND', 'A required module or package could not be resolved.',
                'Confirm the dependency is declared and installed; reinstall only after reviewing the dependency approval.', 0.94);
        }
        if (/\berror TS\d+\b|TS\d+:|TypeScript.*error/i.test(output)) {
            return identify('TYPESCRIPT_ERROR', 'The TypeScript compiler reported a type or compilation error.',
                'Review the listed source locations and correct the reported TypeScript issue.', 0.96);
        }
        if (/SyntaxError|Unexpected token|Unterminated string|Invalid or unexpected token/i.test(output)) {
            return identify('JAVASCRIPT_SYNTAX_ERROR', 'JavaScript parsing failed because of a syntax error.',
                'Correct the syntax error in the affected source file and rerun the build.', 0.9);
        }
        if (/EADDRINUSE|address already in use|port .+ is already in use/i.test(output)) {
            return identify('PORT_CONFLICT', 'The requested development-server port is already in use.',
                'Use an available local port or stop the conflicting application yourself.', 0.98);
        }
        if (/EACCES|EPERM|permission denied|access is denied/i.test(output)) {
            return identify('PERMISSION_ERROR', 'The process does not have permission to access a required resource.',
                'Review the path permissions; CLIRO will not elevate privileges automatically.', 0.94);
        }
        if (/ENOENT|no such file or directory|cannot find the path specified/i.test(output)) {
            return identify('MISSING_FILE', 'A required file or executable was not found.',
                'Restore the missing file or correct the project configuration.', 0.88);
        }
        if (/npm ERR!|npm error|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(output)) {
            return identify('NPM_ERROR', 'npm reported an installation or package-resolution error.',
                'Review npm output and network/registry configuration; retry only with explicit approval.', 0.9);
        }
        if (result.command.includes('run') && result.exitCode !== 0) {
            return identify('RUNTIME_ERROR', 'The project process exited unsuccessfully.',
                'Review the captured output and correct the runtime error before retrying.', 0.72);
        }
        return identify('UNKNOWN_BUILD_ERROR', 'The command failed without a recognized diagnostic signature.',
            'Review the captured stdout and stderr, then make a targeted change before retrying.', 0.45);
    }
}
