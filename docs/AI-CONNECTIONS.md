# Rootpath AI connections — 1.3.0-alpha.2

Open **AI connections** in the header. This feature connects an assistant you already use; Rootpath does not supply an AI model or subscription.

## Start with inspection

1. Connect your VPS normally and review/import a disposable website’s discovered mappings. Discovery alone never enables management or AI access.
2. If you want code editing, connect GitHub through **GitHub & code** using a fine-grained token and prepare a private workspace for the same repository. GitHub account passwords are unsupported. Rootpath needs native Git; it does not silently import terminal credentials.
3. In **AI connections**, choose your client, name it and create a connection. It initially has **zero website grants**.
4. Select the connection. Check only the desired websites and capabilities. Associate the matching managed workspace for code access. Review the trusted server fingerprint. Metrics include server-wide resource totals; storage rows are limited to the selected project. Logs share only locally collected, redacted deployment-job output for that project, not terminal sessions or database contents.
5. Read the provider disclosure and click **Save permissions**. Code/logs returned to the assistant can be sent to that assistant’s provider.
6. Choose **Show client configuration**, then copy it into that client’s local MCP configuration. Rootpath must stay open. Moving the Rootpath application requires regenerating the configuration.
7. **Test local connection** verifies the private bridge only. In the actual assistant, ask it to list Rootpath websites and verify that only the selected website appears. Each real client remains unverified until this checkpoint is performed.

Codex uses the generated `[mcp_servers.rootpath]` TOML entry. Claude’s developer/manual local configuration and Antigravity use the generated `mcpServers` JSON entry. Merge the entry into existing settings; do not replace unrelated settings. Current Claude Desktop versions also offer desktop extensions; this release provides a manual stdio configuration, not a signed MCPB extension. Configuration values reference a private credential file; they never embed the bearer credential itself.

Official setup references: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Claude local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [Antigravity MCP](https://antigravity.google/docs/mcp/).

## Ask for a change

Example: “Using Rootpath, read the granted website’s index.html and propose a new heading. Do not publish or deploy.”

Open the request in **AI connections → Requests awaiting your review**. Rootpath shows the exact before/after text, client and target. Type the displayed website name to approve. The file changes only in the managed local branch. Rejecting a request changes no project file.

Publishing requires a separate request and review showing repository, branch, commit, title, body and diff. The user merges on GitHub. Deployment then requires another review, verified merge state when a PR exists, a clean compatible production repository, configured deployment settings and a health check. Dependency/build scripts run only after the human approves their displayed effects. Django migrations retain their separate verified-backup and migration-review checkpoint.

AI can prepare mapped ordinary-account systemd service restarts. Rootpath rechecks protected unit configuration, account, working directory and service state; a graphical sudo prompt appears if necessary. This short restart is not a detached deployment job. Connection loss gives an uncertain result requiring inspection, never an automatic retry.

Static recovery can reference only a saved job with a verified recovery archive for the same project. It restores code, not a production database or reverse migrations.

New-site proposals can create a new website from the granted workspace’s repository. The preview uses the existing protected directory, hosting and durable-job system. No secret values come from MCP. Django starts with a new SQLite association; missing secrets/dependencies require completing the saved setup in Rootpath. New repositories or a newly created website need their own explicit grants; an assistant cannot expand its scope through a new-site request.

## Available tools

- `rootpath_projects`: selected project metadata and granted capabilities.
- `rootpath_files`, `rootpath_read_file`: safe UTF-8 local workspace files and content revisions.
- `rootpath_branches`, `rootpath_publications`: selected repository branches, PR/check/merge status.
- `rootpath_metrics`: server resource totals and selected project storage.
- `rootpath_logs`: selected redacted deployment-job logs, with bounded pagination.
- `rootpath_jobs`: selected project job status, failures and migration-review information.
- `rootpath_propose`: code edit/create/folder/rename, PR publication, guided deployment, mapped service restart, static code recovery or new-site creation request.
- `rootpath_proposal_status`: only the authenticated client’s own request state.

There is no approve tool, password input, arbitrary shell endpoint, custom-script execution endpoint, database-content access, automatic merge or production deletion tool. Native file/runtime limits and path/secret/workflow restrictions also apply to AI work.

## Pause and revoke

**Pause AI access** blocks all AI requests. **Revoke this connection** removes that client’s credential and grants. **Revoke all connections** removes all pairings. Changed grants invalidate outstanding reviews; altered host identities and repository mappings block access. Already-approved detached VPS jobs continue independently; revocation does not pretend to cancel or roll them back.

The connection uses newline-delimited UTF-8 JSON-RPC over stdio and the stable MCP 2025-11-25 initialization flow. The helper connects through a private local Unix socket or Windows named pipe, authenticated with a separate random credential per client. No network listener or VPS agent is added. Grant and approval records are encrypted using OS-backed storage. The helper credential lives in a protected local file so the approved client can authenticate; keep it private. Rootpath permissions govern its own tools and cannot constrain an assistant’s other filesystem, terminal or network tools.

## Acceptance checklist

1. Pair with no grants: the assistant sees no websites.
2. Grant one disposable website: a second website and secret/workflow paths are denied.
3. Request a harmless local text change: verify unchanged before approval, review and approve, then verify the exact change. Reject a second request and confirm no file appears.
4. Publish a disposable branch/PR with its separate review, merge on GitHub and deploy the merged revision with another review. Deliberately fail the health check and inspect the failed job.
5. Pause/revoke while the client is open: requests fail. Re-pairing must not silently restore the old grants.
6. Close/reopen Rootpath: approved durable jobs recover without duplicate execution; AI access is unavailable while it is closed.

Actual Codex, Claude Desktop, Antigravity and Windows execution, live GitHub publication, privileged Linux deployment/recovery, public HTTPS and release signing remain acceptance requirements. Automated generic MCP tests and simulated SSH services do not substitute for those results. Production sites were not changed by development tests.
