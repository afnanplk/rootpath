# Rootpath GitHub setup

Connect GitHub with a fine-grained access token. No application registration is required, and no credentials are preinstalled.

## Connect without registering an app

1. Open Rootpath → **GitHub & code**. Use **Get an access token** → **Open GitHub token settings** if you do not have a fine-grained token.
2. In your GitHub account, choose an expiry and **Only select repositories**, then select the disposable test repository first. Set repository **Contents: read/write**, **Pull requests: read/write**, **Checks: read**, **Commit statuses: read**, and automatic **Metadata: read**. Do not grant administration or workflow writing. Organization approval can be required by the repository owner.
3. Paste the token into Rootpath’s masked **GitHub access token** field and choose **Connect GitHub**. Rootpath verifies the account, clears the input, and encrypts the token using OS-backed storage. Saved tokens are never returned to the UI or sent to the VPS or AI clients.
4. Refresh repositories, then choose the repository to work on. On expiration or revocation, disconnect locally and connect with a new token. No Rootpath GitHub App, Client ID, client secret or application registration is needed.

GitHub no longer accepts account passwords for Git/API access. A fine-grained token is the supported password alternative for this release. Account authentication and authorization must still be performed by the account owner; Rootpath cannot bypass that authorization. Browser/device sign-in was removed from the release at the user’s request because it required product-owner App registration.

Official documentation: [GitHub authentication](https://docs.github.com/en/get-started/git-basics/why-is-git-always-asking-for-my-credentials), [fine-grained access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

## Add a website

Connect to the VPS → Websites → Add website. Choose the GitHub repository and branch, confirm detected root application settings, supply domains and masked environment values, and save or check setup. Advanced settings contain build/output/runtime details. The selected GitHub workspace fixes repository identity and branch.

Missing fixed system packages have a separate package installation review. Repository discovery does not execute code. Deployment review shows the exact commit, account, new folder, generated Nginx/systemd configuration and masked environment names. Review only trusted repository build/dependency scripts.

Accepted jobs receive a verified Git bundle and protected environment before they detach. New folders must be absent. Existing domain owners and configuration filenames are refused. The job validates Nginx before reload, starts only its generated application service and requires HTTP 2xx through the generated Nginx virtual host. Public DNS and certificate issuance remain separate checks/reviewed actions. A local virtual-host health check does not verify public DNS, firewall or HTTPS.

Django requires a reviewed new SQLite filename or existing local PostgreSQL association. Use Databases & backups to create PostgreSQL databases/users first. The job verifies the configured database, creates a verified backup and pauses for a separate migration review. MySQL-backed Django deployment backups and nested/ambiguous application layouts require a separate supported recipe; they are not silently guessed.

Successfully created directories are registered automatically after their protected identity and pinned commit are discovered. Migration pauses can appear in Websites → Background jobs. Reconnect recovers the existing identity; never resubmit an uncertain job.

## Edit, publish and deploy

1. Open GitHub & code, refresh repositories and prepare a local workspace from the selected branch. Native Git must be installed on the computer.
2. Open a text file, make an edit and choose **Review local change**. Approve the before/after review before applying it to the private local workspace. New files, folders (`.gitkeep`) and renames follow the same review.
3. Enter PR title/description and choose **Review commit and publication**. Inspect the complete diff, repository, managed branch and exact commit, then type the repository name to approve push and PR creation.
4. Merge on GitHub. **Refresh merge and checks** verifies the published head, checks and merge ancestry. Rootpath does not merge automatically. If a reply is lost, use the saved publication identity and **Review publication recovery**, rather than creating another PR.
5. In the connected server’s GitHub & code page, select the reviewed website, confirm deployment settings and health endpoint, then prepare the deployment review. The repository and checked-out branch must match. Unmerged local PRs, dirty VPS content or divergent history block deployment.

Workspace limits: UTF-8 text up to 2 MiB, review up to 200 changed files, repository tree up to 30,000 files/512 MiB. Symlinks, submodules, binary publication, tracked secrets, Git internals and workflow editing are blocked. Windows-incompatible path names and collisions are refused. The release does not run arbitrary local test commands.

## Custom scripts

Website card → Advanced & details → Custom deployment scripts. Save Bash text with a health URL and optional discovered environment file. Secrets belong in protected environment values, not script text.

Review the Deploy-button binding separately. Each execution still requires a review of the exact revision, server, ordinary account and directory. Editing a script, switching its binding or returning to guided deployment invalidates pending script execution reviews. Scripts run with Bash exit-on-error/pipefail, without administrative privilege, and a 30-minute limit. A verified code archive precedes execution; runtime dependencies and databases are excluded. Nonzero exits and failed health checks fail the job. No automatic rollback is claimed.

## Current acceptance limits

This is an unsigned test build, not a production certification. Automated tests use disposable local Git repositories, SSH transport and HTTP servers; GitHub API and administrative actions are simulated where labelled. Live fine-grained-token authentication, real Linux systemd/Nginx/sudo deployment and recovery, actual Windows execution, public HTTPS and signing/notarization remain external acceptance requirements. MCP is not included in this checkpoint.
