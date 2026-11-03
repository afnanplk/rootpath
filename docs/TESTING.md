# Tests

The test suite protects SSH trust, credentials, file operations, deployments and AI approvals. Fixtures use disposable local resources and are excluded from packaged apps.

| Command | Coverage |
|---|---|
| `npm run test:backend` | SSH/SFTP, files, transfers, editor, management, logs, projects, storage and IPC validation |
| `npm run test:development` | Local Git, GitHub access, publication reviews and saved setup |
| `npm run test:ai` | Client identity, project grants, revocation, stale approvals and local MCP transport |
| `npm run test:websites` | Website discovery and state labels |
| `npm test` | Browser fallback, theme persistence and help |
| `npm run test:desktop-all` | Electron workflows, including AI reviews and compact windows |
| `python3 tests/ai-restart.py` | Restart target, account, directory and failure checks |

Recipe tests:

```sh
python3 tests/static-recipe.py
python3 tests/application-recipe.py
python3 tests/workflows.py
python3 tests/github-recipes.py
```

Some tests open localhost sockets and need permission to do so. Desktop tests require an unlocked graphical session. Do not rebuild `dist/` while Electron tests are running.

For a packaged Mac smoke test, set `VPS_EXECUTABLE` to the built app's `Contents/MacOS/Rootpath` executable, then run `tests/production-desktop.cjs` and `tests/ai-desktop.cjs` with Node.

Screenshots, logs, Python caches and browser reports are generated output. They can be removed after checking results. Keep the test source and referenced fixtures: the installed app never includes them, and they are needed to check future changes.

Real server/platform acceptance is documented in [LIVE-RELEASE.md](LIVE-RELEASE.md), [LINUX-ACCEPTANCE.md](LINUX-ACCEPTANCE.md), [APPLICATIONS-ACCEPTANCE.md](APPLICATIONS-ACCEPTANCE.md) and [HOSTING-DATABASE-ACCEPTANCE.md](HOSTING-DATABASE-ACCEPTANCE.md).
