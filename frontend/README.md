# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Local vision controls

Camera access is requested only after selecting **Enable Vision**. Camera
connection and local MediaPipe hand-tracking readiness are reported separately;
the existing model and WASM files are served from `public/models` and
`public/mediapipe`.

A one-hand pose must reach at least 80% MediaPipe handedness confidence and
pass four-frame, 650 ms hold, cooldown, and neutral-rearm checks before it
dispatches a structured UI action. Open palm toggles the existing voice
listener; a V-sign toggles speech for typed responses; pointing and pinch
focus the current CLIRO view. Thumbs-up approves only the currently visible
CLIRO permission dialog, and thumbs-down cancels it. A closed fist closes the
active eligible Chrome tab; right/left palm turns select the next/previous
or right/left horizontal index points select the next/previous eligible tab.
All three actions are permission-checked by the existing backend
`PermissionEngine` at `LOW_RISK` through `ToolRegistry` before reaching the
extension. Gestures never initiate arbitrary tools or control Windows
applications, processes, files, or commands.

## Local Chrome tab bridge

Install the optional local extension in Chrome:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select `frontend/chrome-extension`.
3. Confirm the extension appears as **CLIRO Local Chrome Tab Bridge**.
4. Reload the CLIRO page at `http://localhost:5173` (or
   `http://127.0.0.1:5173`).
5. Check the small **CHROME CONNECTED** indicator in CLIRO's top status row.
   Without the extension it reads **CHROME BRIDGE UNAVAILABLE**. The tooltip
   reports only the number of eligible tabs in Chrome's last-focused window.

The page-to-extension bridge uses a fixed message allow-list in the injected
content script; the Manifest V3 service worker uses Chrome's `tabs` API to
inspect the last-focused normal window, select the active eligible tab, and
perform the requested operation. It verifies closure by checking that the
previous tab ID no longer exists, and verifies a switch by querying Chrome's
active tab ID after activation. A one-use, 30-second authorization from the
backend is required before each operation; the backend checks `LOW_RISK` using
the existing `ToolRegistry` and `PermissionEngine`, then records the verified
or unavailable result. Authorization is limited to the three fixed action
names; tab IDs never come from gesture or user text.

The extension declares exactly one API permission: `tabs`. Its content script
is scoped to the two local CLIRO HTTP origins on port 5173; it has no
`host_permissions`, history, cookies, storage, or network permissions. The
bridge does not send tab URLs, titles, page text, credentials, cookies, or
browsing history to CLIRO or any network service, and it does not persist
browsing data. Extension message payloads contain only a request ID and a
fixed action name; response payloads contain only operation status and a
short message.

Only HTTP and HTTPS pages are eligible. `chrome://`, `chrome-extension://`,
`devtools://`, other special schemes, and Chrome Web Store pages are protected.
If the active tab is protected, no tab is closed or switched. Switching
requires at least two eligible tabs in the same normal window; navigation
wraps at the ends of that eligible-tab list. The extension never kills Chrome
or executes a process or shell command. If Chrome has no eligible active tab,
the bridge is disconnected, or Chrome cannot verify the operation, CLIRO
reports unavailable/failed rather than success.

For troubleshooting, first confirm Chrome is running, the extension is
enabled, and the CLIRO page was reloaded after installation or extension
updates. If the indicator remains unavailable, open the extension's
**Errors** panel at `chrome://extensions`, reload the CLIRO tab, and verify it
is using one of the two supported local origins on port 5173. The extension
must be installed separately in each Chrome profile. Manual action functions
(`closeCurrentChromeTab()`, `nextChromeTab()`, `previousChromeTab()`, and
`getChromeBridgeStatus()`) are exported by `src/chromeTabActions.ts` for
internal callers and tests; no arbitrary tab IDs are accepted.

Voice responses are spoken with browser-local speech synthesis. Spoken replies
to voice commands are always enabled; speech for typed replies can be enabled
in Settings. CLIRO prefers a female English system voice when available and
allows a specific installed browser voice, rate, pitch, and volume to be
selected. These preferences are stored in local browser storage. Synthetic
speech is sanitized and queued in sentence-aware chunks; streaming responses
are collected completely before speech starts. Say “stop”, “stop talking”,
“be quiet”, or “cancel speech” to clear the queue, and say “repeat”, “repeat
that”, “say that again”, or “what did you say?” to replay the latest suitable
assistant response. New recognized speech interrupts active playback. The
agent status and Settings page expose the current speech playback state.

Voice listening uses the browser's speech-recognition service, which may
process audio according to browser behavior; CLIRO receives recognized text.
The voice controls include Automatic, English (India), and Tamil (India)
recognition locales. Choose Tamil (India) when the browser's automatic locale
does not recognize spoken Tamil.
The local speech-synthesis queue itself does not require a cloud TTS service.

Gesture confirmation requires a single high-confidence hand, at least four
stable frames, and a 650 ms hold. A camera tracking gap over 500 ms resets the
hold timer; actions still use the existing cooldown and neutral-pose re-arm.
The displayed gesture progress reflects this same hold threshold.

Recognizer, speech, and Chrome bridge tests can be run with:

```sh
node --test test/gesture-recognizer.test.mjs test/speech.test.mjs test/chrome-tab-bridge.test.mjs
```

## Project starters and provider status

The Projects workspace creates blank, basic, Node.js, TypeScript, Python,
HTML/CSS/JavaScript, and React/TypeScript/Vite starters. Chat-based creation
shows the backend-issued approval request before making any changes; approval
is bound to that request, single-use, and expires after five minutes. Creation
does not overwrite an existing destination and reports the verified filesystem
scan before displaying success. When the approved chat command explicitly asks
to open the project in VS Code, CLIRO reports verified project creation and
verified VS Code process/window status as separate results.

General conversation can use Ollama or the optional backend-only OpenAI
provider. Configure `OPENAI_API_KEY` in the backend environment to enable the
OpenAI option in Settings. The key is never sent to the browser. Current facts
continue to use the verified-source path, and deterministic computer actions
do not go through either language model. The right status panel shows the
provider that actually returned the last response and structured execution
stages received from the backend.

## Local computer actions

Typed and recognized voice requests share the backend's deterministic action
planner. Supported requests include opening known Windows folders or installed
applications, focusing an application, gracefully closing an approved
application/window, typing the exact text included by the user, a fixed set of
keyboard keys, and bounded Notepad/Chrome-search/Calculator action chains.
The backend reports the specific failure or verification state and stops a
chain when a step fails. Closing windows and pasting clipboard contents require
explicit approval.

Folder names resolve only within known user folders and configured CLIRO
project paths. An explicit folder path must already exist as a directory.
Text input never comes from Ollama output, and CLIRO blocks text/key input to
command shells and terminals. CLIRO never force-kills applications or
terminates the Windows Explorer shell. Arbitrary shell commands, executable
paths, and destructive filesystem actions are rejected. Clicks and scrolling
are not available until a semantic UI target can be safely identified and
verified; no guessed screen coordinates are used.

Typed and recognized voice requests also pass through one multilingual
intent-understanding layer before the existing router. It extracts supported
project, application, system-query, and cancellation parameters from English,
Tamil, Tanglish, and mixed-language requests; it does not execute tools or
rewrite the conversation. Project creation, execution, opening, and stopping
continue through the existing PermissionEngine, approval, path validation,
ToolRegistry, and verification flows. Project modifications currently produce
a project-contextual suggestion; they do not edit files automatically.
Ambiguous requests ask for clarification.

## Local command-center interface

The main workspace uses a fixed desktop navigation rail, a scrollable
conversation or workspace region, and a live system-status panel. Its
holographic globe is drawn with inline SVG and CSS rather than an image; it
stays behind the message layer while only conversation content scrolls. The
globe's motion is CSS-only and is disabled when the operating system requests
reduced motion. Quick-example buttons submit prompts through the regular chat
handler.
