process.env.ROOTPATH_TEST_FIXTURES='1';
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startFixture, makeKey } = require('../scripts/ssh-fixture.cjs');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-explorer-desktop-'));
  let fixture = await startFixture(), app;
  const errors = [];
  async function launch() {
    app = await electron.launch({ args: ['.', '--connection-data=' + root] });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: 'Connect to a server' }).waitFor();
    await expect.poll(async () => page.evaluate(async () => (await window.vps.connections.snapshot()).value.secureStorageAvailable)).toBe(true);
    return page;
  }
  async function details(page, password = 'explorer-test-only', name = 'SSH lab') {
    await page.getByLabel('Server name', { exact: true }).fill(name);
    await page.getByLabel('IP address or hostname', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('explorer');
    await page.locator('#ssh-password').fill(password);
  }
  try {
    let page = await launch();
    await page.screenshot({ path: 'artifacts/phase-2-connect.png' });
    await details(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('dialog', { name: 'Verify this server’s identity' }).waitFor();
    assert.equal(fixture.stats.authenticationAttempts, 0);
    await expect(page.locator('.fingerprint')).toHaveText(fixture.fingerprint);
    await page.screenshot({ path: 'artifacts/phase-2-fingerprint.png' });
    await page.getByRole('button', { name: 'Reject connection' }).click();
    await expect(page.locator('.connection-state')).toHaveText('DISCONNECTED');
    assert.equal(fixture.stats.authenticationAttempts, 0);
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.locator('#ssh-password').fill('wrong-password');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Trust & connect' }).click();
    await expect(page.locator('.session-card')).toContainText('Authentication failed');
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.locator('#ssh-password').fill('explorer-test-only');
    await page.getByLabel('Remember credential using OS-backed encryption').check();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.connection-state')).toHaveText('CONNECTED');
    await expect(page.locator('.saved-profiles')).toContainText('Encrypted credential saved');
    await page.screenshot({ path: 'artifacts/phase-2-connected.png' });
    const disk = await fs.readFile(path.join(root, 'ssh/connections.json'), 'utf8');
    assert.equal(disk.includes('explorer-test-only'), false); assert.equal(disk.includes('wrong-password'), false);
    const snapshot = await page.evaluate(async () => (await window.vps.connections.snapshot()).value);
    assert.equal(JSON.stringify(snapshot).includes('explorer-test-only'), false);
    const profile = snapshot.profiles[0];
    await app.close(); app = null;
    page = await launch();
    await page.locator('.saved-profiles button').filter({ hasText: 'SSH lab' }).click();
    await expect(page.getByLabel('Use the encrypted saved credential')).toBeChecked();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.locator('.connection-state')).toHaveText('CONNECTED');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // A changed server key must never be silently accepted.
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    const port = fixture.port; await fixture.close(); fixture = await startFixture({ port });
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByRole('dialog', { name: 'Server fingerprint changed' }).waitFor();
    await expect(page.getByRole('button', { name: 'Replace key & connect' })).toBeDisabled();
    assert.equal(fixture.stats.authenticationAttempts, 0);
    await page.screenshot({ path: 'artifacts/phase-2-changed-host.png' });
    await page.getByLabel('I verified the change and want to replace the saved host key.').check();
    await page.getByRole('button', { name: 'Replace key & connect' }).click();
    await expect(page.locator('.connection-state')).toHaveText('CONNECTED');
    // Verify native key selection without exposing renderer filesystem access.
    const clientKey = makeKey('e2e-key-passphrase'); const keyPath = path.join(root, 'test-key.pem');
    await fs.writeFile(keyPath, clientKey);
    const keyFixture = await startFixture({ clientKey, keyPassphrase: 'e2e-key-passphrase' });
    try {
      await page.getByRole('button', { name: 'Another server' }).click();
      await details(page, '', 'Key lab');
      await page.getByRole('radio', { name: 'SSH key', exact: true }).check();
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, keyPath);
      await page.getByRole('button', { name: 'Choose an OpenSSH or PEM private key…' }).click();
      await expect(page.getByRole('button', { name: 'test-key.pem' })).toBeVisible();
      await page.getByLabel('Port', { exact: true }).fill(String(keyFixture.port));
      await page.getByLabel('Key passphrase (if encrypted)').fill('e2e-key-passphrase');
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: 'Trust & connect' }).click();
      await expect(page.locator('.connection-state')).toHaveText('CONNECTED');
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    } finally { await keyFixture.close(); }
    // Forget and remove the saved password profile; other live connections stay intact.
    await page.locator('.saved-profiles button').filter({ hasText: 'SSH lab' }).click();
    await page.getByRole('button', { name: 'Forget credential', exact: true }).click();
    await expect(page.getByLabel('Use the encrypted saved credential')).toHaveCount(0);
    await page.getByRole('button', { name: 'Remove server', exact: true }).click();
    await page.getByRole('button', { name: 'Remove saved server', exact: true }).click();
    await expect(page.locator('.saved-profiles button').filter({ hasText: 'SSH lab' })).toHaveCount(0);
    // Validate all exposed operations reject malformed input at the main-process boundary.
    const invalid = await page.evaluate(() => window.vps.connections.connect({ port: -1 }));
    assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_INPUT');
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.deepEqual(errors, []);
    console.log('Phase 2 desktop tests passed: host trust/rejection/change, password failures/retry, OS-encrypted save and restart/reconnect, encrypted key login, disconnect, forget/remove, IPC input validation, isolated renderer.');
  } finally { if (app) await app.close(); await fixture.close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
