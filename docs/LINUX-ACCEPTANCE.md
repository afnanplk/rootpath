# Real Linux acceptance for Phase 6

These steps remain pending. No VM/container runtime was available on the development Mac. The local SSH lab simulates Linux commands and never changes host services or power.

Use a disposable Ubuntu/Debian or Rocky/Alma/RHEL VM/VPS with OpenSSH, SFTP, a booted systemd manager, GNU df, procps ps and /proc. Keep the provider console open for power/recovery tests. Do not use a production server.

1. Connect from VPS Explorer using the VM's ordinary SSH account and verify the fingerprint independently.
2. Open Server dashboard. Confirm the simulated-lab banner is absent. Compare OS/kernel, uptime, disks and memory with the VM's tools. Wait for the second sample to inspect CPU and NIC rates.
3. Compare the process names and loaded/installed service list. Processes deliberately omit command arguments to avoid exposing secrets. The list is bounded to 200 processes and 5,000 service units.
4. Copy `scripts/linux-test-service.sh` from this project to the disposable VM. Review it, then explicitly run `sudo sh linux-test-service.sh --install` there. It refuses an existing unit and installs only `vps-explorer-test.service`; its process is sleep and it is not enabled at boot.
5. In Services & logs, refresh, select that exact test unit and review its state/journal. Restart it with the account's existing permissions. A non-root account may be denied. Only request optional sudo if its policy permits noninteractive execution; the app never asks for a sudo password or reuses the SSH password. No sudoers changes are installed by this project.
6. Verify restart changes MainPID, Stop makes the unit inactive, and Start restores it. Compare journal output with `journalctl -u vps-explorer-test.service -n 200 --no-pager`. Some accounts can read only a limited journal.
7. Cancel a reviewed restart and confirm no action occurred. Review another action, change the unit state through the VM console, then confirm; the app should reject the stale preview. Verify a disconnection never replays an action.
8. Test power actions only if losing/recreating this VM is acceptable. Finish file jobs and drafts first. Review the action, explicitly request sudo only if needed, and type the host exactly. A successful request can immediately drop SSH; a missing exit status is recorded as uncertain, not retried. Check the VM/provider console and reconnect manually. Shutdown needs provider-console power-on.
9. Remove the test unit with `sudo sh linux-test-service.sh --remove` inside the VM. It checks its marker before deleting anything.

Record distribution/version, account privileges, service results, timing/disconnect behavior and pass/fail feedback. Actual Ubuntu/Debian and RHEL-family compatibility, power behavior, journal access policies and Windows execution must not be marked verified from simulated lab tests.

Implementation references: [systemctl](https://www.freedesktop.org/software/systemd/man/262/systemctl.html) and [Linux /proc](https://www.kernel.org/doc/html/latest/filesystems/proc.html). The app uses noninteractive, pager-free command execution and bounded parsing of Linux counters.
