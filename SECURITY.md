# Security

Rootpath is an experimental alpha. It connects to systems that may contain credentials and production data. Local tests are useful, but they don't establish a security certification.

## Report a vulnerability

If this repository's **Security → Advisories → Report a vulnerability** option is enabled, use that private channel:

https://github.com/afnanplk/rootpath/security/advisories/new

If private reporting is unavailable, open an issue containing only a request for a private contact channel. Do not include exploit details, secrets, private hostnames or logs in that public request. Wait for a private channel before sharing sensitive material. No response-time guarantee or bounty programme is currently offered.

## Supported versions

Start with the newest published alpha. Older versions have no maintained security backport policy yet. Report the exact version and platform you tested.

## Before sharing a report

Remove passwords, GitHub tokens, private keys, database contents, saved application state and unreviewed log output. Prefer a disposable server and test repository. Never test against systems you don't have permission to access.

Saved credentials and host trust belong in local app storage, not this repository. An MIT licence and automated tests are not a guarantee that a release is safe for a particular production environment.
