# Backend

The TypeScript source under `src/` is authoritative. Run `npm run build` to
compile it to `dist/`, then run `npm start` to execute `dist/index.js`.

The older JavaScript files alongside the TypeScript files in `src/` are not
used by these scripts and should not be edited as a second implementation.
Generated files in `dist/` are build output; regenerate them from the
TypeScript source rather than maintaining them manually.

The backend loads environment variables from `backend/.env`, resolved relative
to the compiled entry point (`backend/dist/index.js`), not relative to the
process working directory. Existing process environment variables take
precedence. The frontend is never given backend credentials.

## Current-fact routing

Deterministic local tools are routed before current-fact detection. Current or
time-sensitive questions use the replaceable `VerifiedFactsProvider` interface
and do not fall back to Ollama when retrieval fails. The current implementation
uses the Wikimedia public API, returns an attributed article source and
retrieval timestamp, and caches successful normalized queries in memory for
five minutes. Unsupported questions or unavailable retrieval return a clear
verification failure rather than an AI-generated guess. Current office-holder
lookups use Wikimedia and require a direct role claim in a relevant article
excerpt; political office claims must explicitly identify the current or
incumbent holder. Indirect office-staff statements and historical role-change
statements are rejected. Latest Node.js versions use the official Node.js index;
OpenAI founder queries use the attributed Wikipedia article. General chat
continues to use the configured local Ollama model.
The OpenAI article is historical secondary-source evidence, not an official
OpenAI record.

Set `CLIRO_VERIFIED_FACTS_ENABLED=false` in the backend process environment to
disable external verification; current-fact requests will then fail closed.

## User project workspace

`/api/projects` manages explicitly opened or created user project folders; the
CLIRO source tree is not pre-registered as a user project. The per-user
`LOCALAPPDATA/CLIRO/projects.json` file (or `~/.local/share/cliro/projects.json`
outside Windows) stores project metadata and execution status, but not source
code or credentials. Project creation requires an explicit confirmed request
and is restricted to the trusted D: project root.

New CLIRO-created projects are restricted to the trusted root
`D:\CLIROProjects`; project names cannot select another drive or escape that
root. The root is created when needed. Existing projects registered under
other locations, including legacy C: locations, are left untouched and can
still be opened explicitly.

Project inventories exclude sensitive filenames, symlinks, common generated
folders, and are bounded by entry, file, and depth limits. File viewing and
local Ollama project questions use the same bounded, sensitive-file-filtered
source collector as static analysis. Analysis is static only; execution is
handled separately by the bounded, approval-gated ProjectExecutionEngine.

## Local computer actions

Typed and recognized voice commands use the same deterministic action planner
before Ollama. The planner allows selected installed-app launch/focus, safe
user-folder opening, graceful single-application/window close requests,
explicit text input, and a fixed keyboard allowlist. Multi-step plans stop at
the first failed or unverified step. The existing Windows Start Menu resolver,
ToolRegistry, and PermissionEngine remain authoritative; app/window closing
and clipboard paste require the existing explicit approval UI.

Folder requests resolve only to known user folders, configured CLIRO project
directories, safe direct-child folder names, or an explicit existing directory
path. App launches use registered Windows Start Menu entries. Window close
uses graceful close messages only; it never force-kills a process and never
terminates `explorer.exe`. Text comes only from the user's literal request,
is bounded and escaped as input data, and is not written to the audit log.
Shell/terminal input is blocked. PowerShell helpers use fixed embedded scripts
and receive structured input over standard input; user text is never executed
as PowerShell or shell code.

Mouse clicks and scrolling are deliberately unavailable until CLIRO can
identify and verify a semantic UI target. Arbitrary screen coordinates,
executable paths, shell commands, process termination, and destructive
filesystem actions are not accepted by the planner.

## Language provider selection

Ollama remains the default general-conversation provider. Set
`OPENAI_API_KEY` in the backend environment and choose **OpenAI** in CLIRO
Settings to route general chat to OpenAI; `OPENAI_MODEL` optionally selects
the model (default `gpt-4o-mini`). `OPENAI_API_KEY` is read only by the
backend and is never returned by an API endpoint or sent to the frontend.
Without the key, an OpenAI preference safely resolves to Ollama. Deterministic
OS actions are handled before language-provider selection, and current facts
always use the verified-source provider.

The chat stream emits structured activity-stage events based on actual request,
permission, source, project, application, provider, and response execution.
It does not use simulated progress timers.

## Safe project templates

Project creation supports `blank`, `basic`, `node`, `typescript`, `python`,
`html`, and `react` templates. Files are created with exclusive creation, read
back for verification, scanned, and registered only after verification
succeeds. Dependencies are not installed automatically. Chat-created projects
are placed under `D:\CLIROProjects`; the backend issues a unique, single-use
approval request bound to the original prompt and project type.
Requests expire after five minutes. Existing paths are never overwritten.
Idea-style requests such as “Build a student attendance management system”
receive a deterministic structured plan before the existing approval step.
The generated files are backend-controlled starter content; no LLM output is
treated as a filesystem operation. React starters declare dependencies.
Before installation, CLIRO displays the exact command, package list, project ID, and verified project path and waits
for a one-use backend approval. Installation uses the active Node runtime's
resolved npm CLI with an argument array, a fixed project working directory,
and lifecycle scripts disabled. Dependencies are verified on disk before
build/test/run can proceed.
Build and test scripts are run only when they match CLIRO's explicit safe
allowlist. Build success requires exit code zero and a non-empty `dist`
directory. Test projects without a configured script are recorded as
`NOT_CONFIGURED`, not as failures. The React/Vite run stage uses a reserved
localhost port and requires both a live CLIRO-owned process and a successful
HTTP response before reporting `RUNNING`.
Build/test/run status and timestamps are persisted in the project registry.
Execution activity events include request/project/action IDs and real
verification state. Stop/cancel targets only the child process tree started
by that CLIRO execution. Error diagnosis reads captured command output and
does not modify files. Repairs are limited to restoring an absent deterministic
starter file, require a separate approval, use exclusive file creation, and
are capped at three attempts.
If the approved chat command explicitly requests VS Code, CLIRO opens the
verified registered project path with the running registered `Code.exe` and
verifies the exact workspace path from VS Code's workspace storage as well as
the application process/window. The companion extension in
`backend/vscode-extension` reports `vscode.workspace.isTrusted` for the exact
single-folder workspace and observes `onDidGrantWorkspaceTrust`. It reports
state only for registered projects under `D:\CLIROProjects`. When the workspace
is restricted, CLIRO displays a **Trust this CLIRO project** action; after the
user selects it, the extension opens VS Code's native Manage Workspace Trust
controls. The user must still make the trust decision in VS Code. CLIRO never
sets trust, disables Restricted Mode, or changes VS Code security settings.
Without a recent report from the companion extension, CLIRO reports the trust
state as unavailable instead of guessing. Project and workspace verification
remain separate from workspace trust verification.
The companion extension source is in `backend/vscode-extension` and is not
silently installed into a VS Code profile. For local development, open that
folder in VS Code and launch it with **F5** (Extension Development Host); for
normal use, package and install it into the intended VS Code profile, then
reload that profile's window so its trust reports are available to CLIRO.

## Approval-gated project changes

Requests to add or fix project code are classified before reaching the model.
CLIRO inspects only bounded, registered-project source files, requests a
structured file-change proposal from the selected Ollama/OpenAI language
provider, and displays the exact complete file contents for review. Nothing is
written until the user approves that one-use proposal. The patch validator
rejects traversal, linked paths, sensitive files, unsupported file types, and
files outside the registered project under `D:\CLIROProjects`; writes are
read back and compared with the approved content. This step does not run a
build or tests automatically; request those separately through the existing
ProjectExecutionEngine flow.

Project source included in a proposal is sent to the language provider
selected in CLIRO Settings. Selecting OpenAI therefore sends the bounded
project context to OpenAI; selecting Ollama keeps it local. If the selected
provider is unavailable, CLIRO reports the failure and does not apply a patch.

## Image generation

Image generation uses the backend-only OpenAI Images API provider. Configure
`OPENAI_API_KEY` and optionally set `IMAGE_GENERATION_PROVIDER=openai` in the
backend environment. The frontend receives only provider configuration
status, never credentials. CLIRO displays the image prompt, count, provider,
and planned output paths and waits for the existing approval UI before making
the provider request. Project assets are written exclusively beneath the
selected registered project at `public/images/`, never overwrite existing
files, and are read back for verification. Small images can be previewed in
the chat; larger previews are omitted while the verified project file remains
available at the displayed path.

This provider currently supports new image generation only. Reference-image
editing and variations are explicitly reported as unsupported. No live image
generation is performed by tests.
