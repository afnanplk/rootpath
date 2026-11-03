# Real Linux application acceptance — pending

Use only a disposable Ubuntu/Debian or Rocky/Alma/RHEL VM with existing Docker/Compose v2 and/or Node plus PM2 5/6. This project does not install them. No Docker, Podman or VM runtime was available on the development Mac. The local SSH fixture simulates Docker/Compose; a separate real PM2 6.0.14 process was tested on Mac.

1. Connect as the account that owns the test resources. Verify the SSH fingerprint and open Server dashboard → Applications. Confirm the simulated banner is absent.
2. Compare Docker containers with the CLI on that VM. Confirm the app's selected Unix socket is the intended local daemon. It ignores Docker remote contexts. Try ordinary discovery first; explicitly request noninteractive sudo only if permitted by that account's existing policy. Root-equivalent Docker privileges are governed by your existing server setup.
3. Prepare a disposable Compose project named `vps-explorer-acceptance`. Use a Linux image with `/bin/sh` and sleep that is already available in that VM's local Docker image store; set VPS_EXPLORER_TEST_IMAGE in a `.env` beside this sample config. Do not use production networks, host mounts or data.

```yaml
name: vps-explorer-acceptance
services:
  worker:
    image: "${VPS_EXPLORER_TEST_IMAGE:?Set an existing local test image in .env}"
    command: ["sh", "-c", "echo disposable-worker-ready; while true; do sleep 30; done"]
```

Review the config, then create the sample outside this app with `docker compose up -d --no-build --pull never`. This manual setup is intentional: VPS Explorer manages existing resources rather than provisioning them.

4. Refresh Applications. Inspect the standalone container and Compose project, then start/stop/restart only these test resources. Check state and logs on disk/CLI. Cancel a review and confirm nothing changes.
5. Review a Compose redeploy, then edit the config or `.env` to change the normalized service config before confirming. Expect rejection and a fresh review. Try an invalid YAML/config and expect refusal. Confirm volumes are not deleted and no image pull/build is requested. A real approved recreation can replace writable container layers and create resources defined by the config.
6. With a fresh approved review, redeploy this test project. Verify the resulting container identity, status and logs. Do not equate a zero CLI exit status with application health; inspect the workload afterward. Check interruption/permission errors on this disposable system and verify no automatic retry.
7. For PM2, manually create an isolated PM2_HOME and sample interval-based Node process outside this app. Ensure PM2/Node are on the SSH noninteractive PATH and that PM2_HOME points to that existing daemon. Do not repoint the app at a production daemon. Test list/logs/stop/start/restart and stale ID/restart rejection. Use a synthetic environment secret to verify lists and history never expose environment data. Stop the daemon outside the app and confirm the app refuses to create another.
8. Remove only your designated test project and PM2 process/daemon after testing. Keep provider-console access available if you also test server power behavior. Record exact distro, Docker Engine, Compose, Node and PM2 versions, privilege scope, results and any residual resources after interruption.

The optional live adapter test on a development machine uses an isolated test-only PM2 package directory. Install a supported PM2 version in a scratch folder, then set `VPS_PM2_TEST_ROOT` to that folder and run `npm run test:pm2-live` from this project. The test creates its own temporary PM2_HOME, starts one disposable process, and cleans it up. It is not a production dependency or a Linux compatibility claim.

References: [Docker container listing](https://docs.docker.com/reference/cli/docker/container/ls/), [Compose up](https://docs.docker.com/reference/cli/docker/compose/up/), [PM2 commands](https://pm2.keymetrics.io/docs/usage/commands/). The PM2 adapter connects to the installed package's existing RPC socket and never calls its auto-starting CLI for discovery/actions.
