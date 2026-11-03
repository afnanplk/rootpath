process.env.ROOTPATH_TEST_FIXTURES='1';
const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-explorer-smoke-'));
  const app = await electron.launch({ args: ['.', '--connection-data=' + root] });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('region', { name: 'SSH connection workspace' }).waitFor();
    assert.equal(await page.getByRole('button',{name:'Demo explorer',exact:true}).count(),0);
    await page.getByRole('button',{name:'New connection',exact:true}).click();
    await page.screenshot({path:'artifacts/live-only-startup.png'});
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.deepEqual(errors, []);
    console.log('Desktop smoke test passed: packaged renderer loads, navigation works, security isolation enabled.');
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
