process.env.ROOTPATH_TEST_FIXTURES='1';
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startFixture } = require('../scripts/ssh-fixture.cjs');
const { seedFiles } = require('../scripts/sftp-fixture.cjs');
(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-monitor-ui-')), root = path.join(tmp, 'remote'); await seedFiles(root); await fs.writeFile(path.join(root, 'phase6.txt'), 'saved text\n');
  const fixture = await startFixture({ fsRoot: root }); let app; const errors = [];
  try {
    app = await electron.launch({ args: ['.', '--connection-data=' + path.join(tmp, 'data')] }); const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.getByLabel('Server name', { exact: true }).fill('Monitoring lab'); await page.getByLabel('IP address or hostname').fill('127.0.0.1'); await page.getByLabel('Port', { exact: true }).fill(String(fixture.port)); await page.getByLabel('Username', { exact: true }).fill('explorer'); await page.locator('#ssh-password').fill('explorer-test-only'); await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.getByRole('button', { name: 'Trust & connect' }).click(); await page.getByRole('button', { name: 'Browse server files', exact: true }).click();
    await page.getByRole('region', { name: 'Live SFTP explorer', exact: true }).getByRole('button', { name: 'Server dashboard', exact: true }).click();
    const dashboard = page.getByRole('region', { name: 'Server dashboard', exact: true });
     await dashboard.getByRole('tab',{name:'Storage',exact:true}).click();await expect(dashboard.locator('.metric-cards')).toContainText('37.5%'); await dashboard.getByLabel('Refresh every 5 seconds', { exact: true }).uncheck(); await dashboard.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(dashboard.locator('.metric-cards')).toContainText('20.0%');
    await page.screenshot({ path: 'artifacts/phase-6-overview.png' });
    await dashboard.locator('.dashboard-advanced > summary').click();await dashboard.getByRole('tab', { name: 'Processes', exact: true }).click(); await expect(dashboard).toContainText('test-worker'); await dashboard.getByLabel('Filter dashboard entries').fill('explorer'); await expect(dashboard.locator('tbody tr')).toHaveCount(1);
    await dashboard.getByRole('tab', { name: 'Services & logs', exact: true }).click(); await dashboard.getByRole('button', { name: /vps-explorer-test.service/ }).click(); await expect(dashboard.getByLabel('Service journal')).toContainText('Simulated journal');
    await dashboard.getByRole('button', { name: 'Restart service', exact: true }).click(); let review = page.getByRole('dialog', { name: 'Review server action', exact: true }); await expect(review).toContainText('vps-explorer-test.service'); await review.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(fixture.monitoring.actions.length, 0);
    await dashboard.getByRole('button', { name: 'Restart service', exact: true }).click(); await review.getByRole('button', { name: 'Confirm restart', exact: true }).click(); await expect(dashboard.getByRole('alert')).toContainText('Permission denied'); assert.equal(fixture.monitoring.actions.length, 0);
    await dashboard.getByRole('button', { name: 'Dismiss dashboard error' }).click();
    await dashboard.getByRole('button', { name: 'Restart service', exact: true }).click(); await review.getByLabel('Use sudo (noninteractive) for this action', { exact: true }).check(); await expect(review.getByLabel('Use sudo (noninteractive) for this action', { exact: true })).toBeChecked(); await page.screenshot({ path: 'artifacts/phase-6-confirmation.png' }); await review.getByRole('button', { name: 'Confirm restart', exact: true }).click(); await expect(dashboard.getByRole('status')).toContainText('Service action finished'); assert.equal(fixture.monitoring.actions[0].kind, 'restart');
    await page.screenshot({ path: 'artifacts/phase-6-services.png' });
    await dashboard.getByRole('tab', { name: 'Operation history', exact: true }).click(); await expect(dashboard.locator('.operation-row')).toHaveCount(2); await dashboard.getByLabel('Filter dashboard entries').fill('permission'); await expect(dashboard.locator('.operation-row')).toHaveCount(1); assert.equal((await dashboard.textContent()).includes('PASSWORD-SHOULD-NOT-LEAK'), false);
    await dashboard.getByRole('button', { name: 'Back to workspace', exact: true }).click();
    await page.getByTestId('live-remote-phase6.txt').dblclick(); const editor = page.getByRole('textbox', { name: 'Remote text editor', exact: true }); await editor.focus(); await editor.press('ControlOrMeta+A'); await page.keyboard.insertText('unsaved draft\n');
    await page.getByRole('region', { name: 'Live SFTP explorer', exact: true }).getByRole('button', { name: 'Server dashboard', exact: true }).click(); await dashboard.getByRole('tab',{name:'Storage',exact:true}).click();await dashboard.getByRole('button', { name: 'Reboot', exact: true }).click(); await expect(dashboard.getByRole('alert')).toContainText('Save or close');
    await dashboard.getByRole('button', { name: 'Back to workspace', exact: true }).click(); await page.getByRole('button', { name: 'Close editor /phase6.txt', exact: true }).click();
    await page.getByRole('region', { name: 'Live SFTP explorer', exact: true }).getByRole('button', { name: 'Server dashboard', exact: true }).click(); await dashboard.getByRole('tab',{name:'Storage',exact:true}).click();await dashboard.getByRole('button', { name: 'Reboot', exact: true }).click(); await expect(review.getByRole('button', { name: 'Confirm reboot', exact: true })).toBeDisabled(); await review.getByLabel('Use sudo (noninteractive) for this action', { exact: true }).check(); await expect(review.getByLabel('Use sudo (noninteractive) for this action', { exact: true })).toBeChecked(); await review.getByLabel('Type 127.0.0.1 to confirm', { exact: true }).fill('127.0.0.1'); await review.getByRole('button', { name: 'Confirm reboot', exact: true }).click(); await expect(dashboard.getByRole('status')).toContainText('Power request accepted'); assert.equal(fixture.monitoring.actions.at(-1).kind, 'reboot');
    await page.setViewportSize({ width: 960, height: 660 }); await page.screenshot({ path: 'artifacts/phase-6-small.png' }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await fixture.dropClients(); await expect(dashboard.getByRole('alert')).toContainText('Disconnected'); await expect(dashboard.getByRole('button', { name: 'Reboot', exact: true })).toBeDisabled();
    assert.deepEqual(errors, []); console.log('Phase 6 desktop passed: labeled metrics, sampling, processes/filter, service logs, cancel/denied/sudo restart, sanitized searchable history, draft power guard, typed-host simulated reboot, minimum layout and disconnect.');
  } catch (error) { if (app) { const page = await app.firstWindow(); await page.screenshot({ path: 'artifacts/phase-6-failure.png' }); } throw error; }
  finally { if (app) await app.close(); await fixture.close(); await fs.rm(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
