# Release acceptance

This release removes the sample filesystem/workspace, preset sample servers, sample navigation, demo switch, simulation banners and lab launchers from the product. The browser displays a desktop-required page. The desktop opens to SSH connections with no prefilled root account. Developer fixtures remain outside installers for regression testing.

Installed builds reject marked test responses at capability/discovery/workflow boundaries before management jobs can be submitted. The development URL switch and developer-tools menu are unavailable in installed builds. The UI retains real server errors; it never substitutes sample results.

Only the previously supplied localhost lab is retired, using the exact combination of loopback hostname, port 2222, explorer account and its published SSH fingerprint. Real saved connections, credentials and trusted fingerprints remain. Retired metadata has a private local recovery archive. Old encrypted test-server log history is retained on disk for audit but excluded from current log queries and summaries; live log subscriptions for that retired server are removed.

Generated Nginx drafts in both hosting entry points deny hidden/private files, backup archives, dumps and dependency metadata. They disable symlink traversal. Existing site configurations are not rewritten automatically. Review and validate any draft before activation.

## Check the installed app

1. Launch at 900×620 without maximizing. Confirm the real connection form appears, no sample button/server/files exist, and Logs do not occupy the disconnected workspace.
2. Connect to a designated disposable Linux server, verify its real host fingerprint, and test wrong credentials, disconnect and reconnect.
3. Create a directory/file over real SFTP, rename it, transfer content, edit it, and inspect permissions and symlinks. Confirm logs persist across restart and contain no submitted passwords.
4. On a disposable Ubuntu 24.04 system with real systemd, verify reviewed deployment, failure paths, graphical sudo, detached job recovery, migration review, timers, Nginx validation/recovery and database backup/restore into a separate target.
5. Verify `.env`, `.git`, dump/archive and symlink requests are denied by a generated test site. Test a public disposable domain and certificate issuance.
6. Install and run the Windows build on actual Windows. A Windows installer produced on a Mac does not satisfy this check.
7. Sign/notarize the Mac distribution and sign the Windows installer with the relevant accounts/certificates before public distribution.

## Production readiness

The application has real connection/file/deployment code, and removal/hardening checks can be verified here. Real Linux privilege boundaries, hosting/database compatibility, public ACME, Windows execution and signing cannot be certified from this Mac's simulated administrative tests. Production acceptance remains explicitly pending in the app until those checks are completed. No production deploy, migration, package install, restart or DNS change was performed in this upgrade.

Reference for the generated symlink policy: [NGINX core module — disable_symlinks](https://nginx.org/en/docs/http/ngx_http_core_module.html#disable_symlinks).
