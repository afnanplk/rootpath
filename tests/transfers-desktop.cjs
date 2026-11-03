process.env.ROOTPATH_TEST_FIXTURES='1';
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { startFixture } = require('../scripts/ssh-fixture.cjs');
const { seedFiles } = require('../scripts/sftp-fixture.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-transfer-ui-')), remoteDir = path.join(tmp, 'remote'), localDir = path.join(tmp, 'local'), downloadDir = path.join(tmp, 'downloads');
  await seedFiles(remoteDir); await fs.mkdir(localDir); await fs.mkdir(downloadDir); await fs.mkdir(path.join(remoteDir, 'dest'));
  const binary = randomBytes(384 * 1024 + 17); await fs.writeFile(path.join(localDir, 'upload.bin'), binary); await fs.writeFile(path.join(localDir, 'drag.txt'), 'Drag through panes'); await fs.writeFile(path.join(localDir, 'external.txt'), 'Native File-backed drop'); await fs.mkdir(path.join(localDir, 'a folder')); await fs.writeFile(path.join(localDir, 'a folder/مرحبا.txt'), 'Folder upload'); await fs.writeFile(path.join(localDir, 'cancel.bin'), Buffer.alloc(8 * 1024 * 1024, 4));
  const fixture = await startFixture({ fsRoot: remoteDir, ioDelayMs: 3 }); let app; const errors = [];
  try {
    app = await electron.launch({ args: ['.', '--connection-data=' + path.join(tmp, 'data')] }); const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    const picker = paths => app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, paths);
    await page.getByLabel('Server name', { exact: true }).fill('Transfer lab'); await page.getByLabel('IP address or hostname').fill('127.0.0.1'); await page.getByLabel('Port', { exact: true }).fill(String(fixture.port)); await page.getByLabel('Username', { exact: true }).fill('explorer'); await page.locator('#ssh-password').fill('explorer-test-only'); await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.getByRole('button', { name: 'Trust & connect' }).click(); await page.getByRole('button', { name: 'Browse server files' }).click();
    const remote = page.getByRole('region', { name: 'Remote filesystem pane', exact: true }); await expect(page.getByTestId('live-remote-docs')).toBeVisible();
    async function latest() { return page.evaluate(async () => { const result = await window.vps.transfers.snapshot(); return result.value[result.value.length - 1]; }); }
    async function done() { await expect.poll(async () => (await latest())?.status, { timeout: 15000 }).toBe('completed'); }
    async function add() { const previous = (await latest())?.id; await page.getByRole('button', { name: 'Add to queue', exact: true }).click(); await expect.poll(async () => (await latest())?.id).not.toBe(previous); }
    async function closeQueue() { const close = page.getByRole('button', { name: 'Close transfer queue', exact: true }); if (await close.count()) await close.click(); }
    await picker([path.join(localDir, 'upload.bin')]); await remote.getByRole('button', { name: 'Upload', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('upload.bin'); await add(); await done(); assert.equal(hash(await fs.readFile(path.join(remoteDir, 'upload.bin'))), hash(binary));
    await closeQueue(); await remote.getByLabel('Filter remote entries').fill('upload.bin'); await expect(page.getByTestId('live-remote-upload.bin')).toBeVisible();
    await picker([path.join(localDir, 'upload.bin')]); await remote.getByRole('button', { name: 'Upload', exact: true }).click(); await add(); await page.getByRole('dialog', { name: 'This destination already exists' }).waitFor(); await page.screenshot({ path: 'artifacts/phase-4-conflict.png' }); await page.getByRole('button', { name: 'Keep both', exact: true }).click(); await done(); assert.equal(hash(await fs.readFile(path.join(remoteDir, 'upload (copy 1).bin'))), hash(binary));
    await closeQueue();
    await picker([path.join(localDir, 'a folder')]); await remote.getByRole('button', { name: 'Upload a folder', exact: true }).click(); await add(); await done(); assert.equal(await fs.readFile(path.join(remoteDir, 'a folder/مرحبا.txt'), 'utf8'), 'Folder upload'); await closeQueue();
    await remote.getByLabel('Filter remote entries').fill('upload.bin'); await page.getByTestId('live-remote-upload.bin').click(); await picker([downloadDir]); await remote.getByRole('button', { name: 'Download', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText(downloadDir); await add(); await done(); assert.equal(hash(await fs.readFile(path.join(downloadDir, 'upload.bin'))), hash(binary)); await closeQueue();
    await remote.getByLabel('Filter remote entries').fill('upload.bin'); await page.getByTestId('live-remote-upload.bin').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Copy to folder…', exact: true }).click(); await page.getByLabel('Destination folder', { exact: true }).fill('/dest'); await add(); await done(); assert.equal(hash(await fs.readFile(path.join(remoteDir, 'dest/upload.bin'))), hash(binary)); await closeQueue();
    await remote.getByLabel('Filter remote entries').fill('upload (copy 1).bin'); await page.getByTestId('live-remote-upload (copy 1).bin').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click(); await page.getByLabel('Destination folder', { exact: true }).fill('/dest'); await add(); await done(); await assert.rejects(fs.stat(path.join(remoteDir, 'upload (copy 1).bin'))); assert.ok(await fs.stat(path.join(remoteDir, 'dest/upload (copy 1).bin'))); await closeQueue();
    // Internal HTML drag-and-drop from a granted local folder to the remote pane.
    await picker([localDir]); await page.getByRole('button', { name: 'Choose local folder', exact: true }).click(); await expect(page.getByTestId('live-local-drag.txt')).toBeVisible();
    const local = page.getByRole('region', { name: 'Local filesystem pane', exact: true }); const remoteViewport = remote.getByRole('region', { name: 'Real remote files', exact: true }); const localViewport = local.getByRole('region', { name: 'Real local files', exact: true });
    await page.getByTestId('live-local-drag.txt').dragTo(remote.locator('.live-pane-title'));  await page.getByRole('dialog', { name: 'Upload — review transfer' }).waitFor(); await add(); await done(); assert.equal(await fs.readFile(path.join(remoteDir, 'drag.txt'), 'utf8'), 'Drag through panes'); await closeQueue();
    await remote.getByLabel('Filter remote entries').fill('README.md'); await page.getByTestId('live-remote-README.md').dragTo(local.locator('.live-pane-title'));  await page.getByRole('dialog', { name: 'Download — review transfer' }).waitFor(); await add(); await done(); assert.match(await fs.readFile(path.join(localDir, 'README.md'), 'utf8'), /SFTP test workspace/); await closeQueue();
    // A real disk-backed File object exercises webUtils in the isolated preload.
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'native-drop-test'; document.body.append(input); });
    await page.locator('#native-drop-test').setInputFiles(path.join(localDir, 'external.txt'));
    await remoteViewport.evaluate((element) => { const input = document.querySelector('#native-drop-test'); const data = new DataTransfer(); data.items.add(input.files[0]); element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })); });
    await page.getByRole('dialog', { name: 'Upload — review transfer' }).waitFor(); await add(); await done(); assert.equal(await fs.readFile(path.join(remoteDir, 'external.txt'), 'utf8'), 'Native File-backed drop'); await closeQueue(); await page.locator('#native-drop-test').evaluate(element => element.remove());
    // Cancel in flight, then retry explicitly.
    await picker([path.join(localDir, 'cancel.bin')]); await remote.getByRole('button', { name: 'Upload', exact: true }).click(); await add(); await expect.poll(async () => (await latest())?.bytesDone > 0).toBe(true); const interrupted = await latest(); await page.getByRole('button', { name: 'Cancel ' + interrupted.id, exact: true }).click(); await expect.poll(async () => (await latest()).status).toBe('cancelled'); await assert.rejects(fs.stat(path.join(remoteDir, 'cancel.bin')));
    await page.getByRole('button', { name: 'Retry ' + interrupted.id, exact: true }).click(); await done(); assert.equal((await fs.stat(path.join(remoteDir, 'cancel.bin'))).size, 8 * 1024 * 1024);
    await page.screenshot({ path: 'artifacts/phase-4-queue.png' });
    await page.setViewportSize({ width: 960, height: 660 }); await page.screenshot({ path: 'artifacts/phase-4-small.png' }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const invalidDrop = await page.evaluate(() => window.vps.transfers.dropFiles([new File(['fake'], 'fake.txt')])); assert.equal(invalidDrop.ok, false);
    assert.deepEqual(errors, []);
    console.log('Phase 4 desktop workflow passed: upload/download/folders, overwrite, copy/move, pane drag-and-drop, disk-backed native File drop bridge, progress/cancel/retry, queue and minimum layout.');
  } finally { if (app) await app.close(); await fixture.close(); await fs.rm(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
