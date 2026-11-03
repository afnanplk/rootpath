# External hosting and database acceptance

Follow FINAL-TEST-CHECKLIST.md on disposable systems. No container runtime, Linux VM, Nginx/Certbot, or real PostgreSQL/MySQL server was available in this Mac workspace.

## Required environments

- Ubuntu/Debian VM: existing Nginx using sites-available/sites-enabled, Python 3, ordinary SSH account and separately authorized sudo -n access. Create a sample site/file outside production.
- Rocky/Alma/RHEL VM: existing Nginx using /etc/nginx/conf.d, Python 3, SELinux/firewall configured by the administrator. Conf.d enable/disable is intentionally not automated; edit/validate/reload and backups are supported.
- Existing Certbot plus a public DNS hostname pointing to a disposable VPS, reachable HTTP port 80, a canonical existing webroot served for ACME challenge paths, and a contact email. The app supports one hostname per lineage and webroot certonly issuance. HTTPS listener configuration is a separate reviewed Nginx edit. Test renewals safely outside production first.
- PostgreSQL: existing loopback listener, postgres maintenance database, password login and a deliberately limited administrative test account. Install a compatible pg_dump/pg_restore on that server. Check PostgreSQL 16–18 in native acceptance; no engine-version compatibility claim is made from protocol fixtures.
- MySQL 8.x / MariaDB: existing IPv4 loopback listener/password account and compatible dump/client tools. Test both products separately. @localhost matching can depend on server name resolution and account configuration. Unix-socket-only, peer-only or DB TLS-only deployments need separate configuration.

## Safety and recovery

Record each Nginx backup ID; backups persist with mode 0600 under /etc/nginx/.vps-explorer-backups, in a private directory. A metadata sidecar identifies the site. The UI can restore an ID after restart. On uncertain/disconnected actions inspect actual configuration and `nginx -t` before retrying. Successful reload submission is not an HTTP health check.

Restore databases must be newly named and absent. Existing targets are never dropped by the app. Dumps/archives can run SQL with the supplied account's rights, so trust is explicitly required. A malicious dump is not confined to the target merely because a new target is selected. Only restore backups you control, ideally using a dedicated account in an isolated test environment. Interrupted restores can leave partial data and an ongoing server command; inspect native server activity. The app never automatically replays a mutation after reconnecting.

Backups stream without loading the whole dump into memory. MySQL option-file credentials use an anonymous descriptor through /proc/self/fd on Linux; a mounted proc filesystem is required. PostgreSQL uses PGPASSWORD in the short-lived remote process environment, which can be inspected by privileged/same-account processes. No credential is passed as a command argument. Use disposable credentials for acceptance.

## References

- Nginx switches: https://nginx.org/en/docs/switches.html
- Certbot usage: https://eff-certbot.readthedocs.io/en/stable/using.html
- PostgreSQL restore: https://www.postgresql.org/docs/current/app-pgrestore.html
- MySQL dump: https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html
- Electron security: https://www.electronjs.org/docs/latest/tutorial/security/
