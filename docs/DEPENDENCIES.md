# Dependency review — 2 November 2026

Runtime dependencies: Electron 45.1.0 (packaged runtime), React 19, ssh2, xterm.js, Monaco, pg 8.23.1 and mysql2. Exact resolved versions are locked in package-lock.json. DOMPurify remains pinned through the patched override.

`npm audit --omit=dev --json` reports **0 runtime dependency vulnerabilities** at the time of this build. The full development tree reports **15 moderate findings**, all from minimatch and transitive packaging-tool dependencies in electron-builder 26.18.1 after compatible `npm audit fix` updates. A forced audit fix proposed an incompatible downgrade of electron-builder; that downgrade was not applied. Older minimatch consumers require the legacy callable API, so an untested major override was not introduced. These tools consume project-controlled build paths and are excluded from the installed app; track upstream fixes before public release. This is not a claim that the full dependency tree has zero findings.

The production bundle includes only dist/, electron/ and required production node_modules. Tests, generated test keys, .ssh-lab, source fixtures, development tools, release archives and project history are excluded. Packaging disables npm native rebuilds because database clients are JavaScript; ssh2 optional native acceleration can fall back to JavaScript. Windows execution still needs native acceptance.

Builds are unsigned and unnotarized. Electron sandbox/context isolation remain enabled; no renderer Node integration or public HTTP service. Requests use a sender-checked, explicit IPC allowlist. Hosting scripts are application-owned; request values and DB secrets are sent over SSH stdin, not interpolated into shell command text. Database names are validated and quoted, and SQL is limited to defined management actions. Diagnostics use an explicit data allowlist.

No auto-update service, telemetry, cloud credential relay, provisioning, or automatic publishing is configured. The GitHub workflow is manual and has not been run in this projectless workspace. Certificates and native platform/server acceptance remain release requirements.
