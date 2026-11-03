# Contributing to Rootpath

Thanks for taking a look. Rootpath is an alpha, and useful, reproducible reports help more than a long feature wish list.

## Report a bug

Include the app version, Mac/Windows version, server distribution and the smallest set of steps that reproduces the problem. Say what you expected and what happened. Use a disposable project when you can.

Don't post passwords, tokens, private keys, database dumps or unreviewed logs. For security problems, follow [SECURITY.md](SECURITY.md).

## Make a change

1. Fork the repository and make a branch for one change.
2. Install with `npm ci`; run with `npm run dev`.
3. Run `npm run build` and the relevant checks in [docs/TESTING.md](docs/TESTING.md).
4. Explain the problem, the change and how you tested it in your pull request.

Keep SSH access, secrets, Git credentials and privileged execution outside the renderer. Add explicit IPC/MCP validation when adding an operation. AI requests must never approve themselves. Don't add arbitrary shell execution, silent destructive retries or automatic rollback claims.

The test tree contains deliberately fake credentials and locally generated test keys. Keep them isolated from real credentials and resources. Don't remove a regression test just to make a check pass.

Changes should remain compatible with the project's MIT licence. Keep third-party notices when reusing code or assets. Contributions remain subject to the repository licence.
