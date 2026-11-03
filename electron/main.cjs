const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, clipboard, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Connections } = require('./connections.cjs');
const { Files } = require('./files.cjs');
const { Editor } = require('./editor.cjs');
const { Terminals } = require('./terminal.cjs');
const { Hosting } = require('./hosting.cjs');
const { Databases } = require('./databases.cjs');
const { diagnostics } = require('./diagnostics.cjs');
const { Applications } = require('./applications.cjs');
const { Monitoring } = require('./monitoring.cjs');
const { Transfers } = require('./transfers.cjs');
const { Projects } = require('./projects.cjs');
const { Workflows } = require('./workflows.cjs');
const { Jobs } = require('./jobs.cjs');
const { GitHub } = require('./github.cjs');
const { Workspaces } = require('./development/workspaces.cjs');
const { Delivery } = require('./development/delivery.cjs');
const { Setups } = require('./development/setups.cjs');
const { Scripts } = require('./development/scripts.cjs');
const {AIService}=require('./ai/service.cjs');
const {AIAdapter}=require('./ai/adapter.cjs');
const {AIBridge}=require('./ai/bridge.cjs');
const { Logs } = require('./logging/logs.cjs');
const { LogSources } = require('./logging/sources.cjs');
const { operation } = require('./logging/operations.cjs');
const { PublicError } = require('./connection-store.cjs');
const { allowedSender } = require('./ipc-security.cjs');
const dev = !app.isPackaged && process.argv.includes('--dev');
if(app.isPackaged||process.env.ROOTPATH_TEST_FIXTURES!=='1')require('./production.cjs').enableProduction();
// Test isolation is an explicit command-line option, never renderer controlled.
const dataArg = process.argv.find(arg => arg.startsWith('--connection-data='));
// Retain the original settings location across the product rename.
app.setPath('userData', dataArg ? path.resolve(dataArg.slice('--connection-data='.length)) : path.join(app.getPath('appData'), 'VPS Explorer'));
app.setName('Rootpath');
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
let ai, aiBridge, aiError, github, development, delivery, scripts, setups, developmentError, workflows, projects, jobs, manager, files, transfers, editor, terminals, monitoring, applications, hosting, databases, logs, logSources, mainWindow, startupError, projectsError;
const rendererPath = path.join(__dirname, '../dist/index.html');
const expectedURL = dev ? 'http://127.0.0.1:5173/' : pathToFileURL(rendererPath).href;
function registerIPC() {
  const handle = (channel, handler) => ipcMain.handle('connections:' + channel, async (event, input) => {
    if (!allowedSender(event, mainWindow, expectedURL)) return { ok: false, error: { code: 'FORBIDDEN', message: 'This window cannot access SSH connections.' } };
    try {
      if (startupError) throw startupError;
      return { ok: true, value: await operation(logs,channel,input,{manager,files,transfers,editor,terminals,monitoring,applications,hosting,databases,projects,jobs,workflows,PublicError},handler) };
    } catch (error) {
      return { ok: false, error: error instanceof PublicError ? { code: error.code, message: error.message } : { code: 'CONNECTION_ERROR', message: 'The operation could not be completed. Check your settings and try again.' } };
    }
  });
  for(const method of ['snapshot','create','grant','control','review','cancelReview','reject','approve'])handle('ai:'+method,input=>{if(aiError)throw aiError;if(!ai)throw new PublicError('AI_UNAVAILABLE','AI connections could not initialize.');return ai[method](input);});
  handle('ai:configuration',input=>{if(aiError)throw aiError;const c=ai.store.data.clients.find(c=>c.id===input?.clientId&&!c.revoked);if(!c)throw new PublicError('AI_DENIED','Select an active client.');const spec={command:process.execPath,args:[path.join(__dirname,'ai/helper.cjs'),path.join(ai.root,'clients',c.id+'.json')],env:{ELECTRON_RUN_AS_NODE:'1'}};return{json:JSON.stringify({mcpServers:{rootpath:spec}},null,2),toml:'[mcp_servers.rootpath]\ncommand = '+JSON.stringify(spec.command)+'\nargs = '+JSON.stringify(spec.args)+'\n\n[mcp_servers.rootpath.env]\nELECTRON_RUN_AS_NODE = "1"\n',note:'Keep Rootpath open. Copy this configuration into the selected client’s local MCP settings. It references a protected local credential file. Live client compatibility is unverified.'};});
  handle('ai:test',async input=>{if(aiError)throw aiError;const c=ai.client(input?.clientId);return require('./ai/helper.cjs').request(path.join(ai.root,'clients',c.id+'.json'),'ping');});
  for(const [name,service,methods] of [['github',()=>github,['snapshot','connectToken','disconnect','open','repositories','branches']],['development',()=>development,['snapshot','create','status','read','settings','propose','proposal','approve','reject','preparePublish','prepareResume','publish','refreshPublication','openPublication']],['delivery',()=>delivery,['prepare','perform','cancel']],['setups',()=>setups,['snapshot','save','inspect','prepare','perform','cancel']],['scripts',()=>scripts,['snapshot','save','prepareBinding','approveBinding','unbind','prepareRun','cancel']]])for(const method of methods)handle(name+':'+method,input=>{if(developmentError)throw developmentError;return service()[method](input);});
  for(const method of ['snapshot','discover','storage','prepare','import','cancel'])handle('projects:'+method,input=>{if(projectsError)throw projectsError;return projects[method](input);} );
  for(const method of ['snapshot','refresh','detail','preview','prepare','perform','cancelReview'])handle('jobs:'+method,input=>{if(projectsError)throw projectsError;return jobs[method](input);} );
  for(const method of ['inspect','prepare','perform','cancel','connections','readiness'])handle('workflows:'+method,input=>{if(projectsError)throw projectsError;return workflows[method](input);});
  handle('logs:query',input=>logs.query(input));
  handle('logs:snapshot',()=>({...logs.snapshot(),sources:logSources.snapshot()}));
  handle('logs:catalog',input=>logSources.catalog(input));
  handle('logs:watch',input=>logSources.watch(input));
  handle('logs:stop',input=>logSources.stop(input));
  handle('logs:remove',input=>logSources.remove(input));
  handle('logs:export',async input=>{
    const result=await logs.query({...input,limit:500});
    const body=result.events.map(e=>JSON.stringify(e)).join('\n')+'\n';
    const review=await dialog.showMessageBox(mainWindow,{type:'warning',buttons:['Cancel','Export reviewed selection'],defaultId:0,cancelId:0,message:'Export these redacted log entries?',detail:`Export ${result.events.length} matching entries (maximum 500). Logs can contain server names, paths and unrecognized sensitive application output. Review the visible selection before exporting. Diagnostics do not include these logs.`});
    if(review.response!==1)return{saved:false};
    const choice=await dialog.showSaveDialog(mainWindow,{title:'Save reviewed redacted logs',defaultPath:'rootpath-reviewed-logs.jsonl'});
    if(choice.canceled)return{saved:false};await require('node:fs/promises').writeFile(choice.filePath,body,{mode:0o600});return{saved:true,count:result.events.length};
  });
  for (const method of ['list','inspect','certificates','validate','prepare','perform','cancel','snapshot']) handle('hosting:'+method,input=>hosting[method](input));
  for (const method of ['connect','disconnect','list','prepare','perform','cancel','snapshot','cancelJob']) handle('databases:'+method,input=>databases[method](input));
  handle('databases:chooseBackup',async()=>{const r=await dialog.showOpenDialog(mainWindow,{title:'Choose a trusted database backup',properties:['openFile']});return r.canceled?null:databases.grantInput(r.filePaths[0]);});
  handle('databases:backup',async input=>{const c=databases.get(input);const {identifier}=require('./databases.cjs');const name=identifier(input.database);const r=await dialog.showSaveDialog(mainWindow,{title:'Save database backup (new file only)',defaultPath:name+(c.engine==='postgres'?'.dump':'.sql')});return r.canceled?null:databases.backup(input,r.filePath);});
  handle('diagnostics:export',async()=>{const r=await dialog.showSaveDialog(mainWindow,{title:'Export sanitized diagnostics',defaultPath:'rootpath-diagnostics.json'});if(r.canceled)return{saved:false};await require('node:fs/promises').writeFile(r.filePath,JSON.stringify(diagnostics({app,manager,transfers,monitoring,applications,hosting,databases}),null,2),{mode:0o600});return{saved:true};});
  for (const method of ['capabilities', 'list', 'details', 'logs', 'prepare', 'perform', 'cancel', 'snapshot']) handle('applications:' + method, input => applications[method](input));
  for (const method of ['capabilities', 'metrics', 'processes', 'services', 'status', 'logs', 'prepare', 'cancel', 'perform', 'snapshot']) handle('monitoring:' + method, input => monitoring[method](input));
  for (const method of ['open', 'reload', 'save', 'restore', 'dirty', 'close']) handle('editor:' + method, input => editor[method](input));
  for (const method of ['open', 'write', 'resize', 'ack', 'close']) handle('terminal:' + method, input => terminals[method](input));
  handle('workspace:copy', async value => { if (typeof value !== 'string' || Buffer.byteLength(value) > 2 * 1024 * 1024) throw new PublicError('INVALID_INPUT', 'Copy up to 2 MiB of text.'); await clipboard.writeText(value); });
  handle('workspace:paste', async () => { const value = await clipboard.readText(); if (Buffer.byteLength(value) > 1024 * 1024) throw new PublicError('INVALID_INPUT', 'Paste up to 1 MiB of text at a time.'); return value; });
  handle('workspace:confirmAction', async kind => {
    const messages = { discard: 'Discard this unsaved draft?', reload: 'Reload the remote file and discard this draft?', restore: 'Restore the previous saved version?' };
    if (!Object.hasOwn(messages, kind)) throw new PublicError('INVALID_INPUT', 'Invalid editor confirmation.');
    return (await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, message: messages[kind], detail: kind === 'restore' ? 'The current remote file will also receive a backup. Unsaved edits in this tab will be discarded.' : 'Unsaved changes in this editor tab will be lost.' })).response === 1;
  });
  handle('workspace:confirmDiscard', async () => !editor.hasDirty() || (await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Keep editing', 'Discard unsaved changes'], defaultId: 0, cancelId: 0, message: 'Discard unsaved editor changes?', detail: 'Your unsaved drafts will be lost. Saved remote files and backups remain on the server.' })).response === 1);
  handle('snapshot', () => manager.snapshot());
  handle('connect', input => manager.connect(input));
  handle('disconnect', id => manager.disconnect(id));
  handle('decide-host', input => manager.decideHost(input));
  handle('remove-profile', id => manager.removeProfile(id));
  handle('forget-secret', id => manager.forgetSecret(id));
  for (const method of ['releaseListing', 'list', 'properties', 'create', 'rename', 'chmod', 'prepareDelete', 'delete', 'cancelDelete', 'listLocal', 'localProperties']) handle('files:' + method, input => files[method](input));
  handle('files:chooseLocal', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose a local folder to browse (read only)', properties: ['openDirectory'] });
    return result.canceled ? null : files.addLocalRoot(result.filePaths[0]);
  });
  for (const method of ['snapshot', 'enqueue', 'cancel', 'retry', 'resolve', 'clearFinished', 'discardSelections']) handle('transfers:' + method, input => transfers[method](input));
  handle('transfers:grantLocal', input => transfers.grantLocal(input));
  handle('transfers:grantLocalDestination', input => transfers.grantLocal(input, true));
  handle('transfers:drop', paths => transfers.grantUpload(paths));
  handle('transfers:chooseUpload', async kind => {
    if (!['files', 'folder'].includes(kind)) throw new PublicError('INVALID_INPUT', 'Choose files or a folder.');
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose files or a folder to upload', properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'] });
    return result.canceled ? null : transfers.grantUpload(result.filePaths);
  });
  handle('transfers:chooseDestination', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose a download destination folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : transfers.grantDestination(result.filePaths[0]);
  });
  handle('choose-key', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose an SSH private key', properties: ['openFile'] });
    return result.canceled ? null : manager.selectKey(result.filePaths[0]);
  });
}
function createWindow() {
  const win = new BrowserWindow({ width: 1120, height: 760, minWidth: 900, minHeight: 620,
    title: 'Rootpath', icon: path.join(__dirname, 'assets/rootpath-icon.png'), backgroundColor: '#101419',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  mainWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.on('will-prevent-unload', event => { if (shutdownFinished) event.preventDefault(); });
  win.on('close', event => { if (!shutdownFinished) { event.preventDefault(); app.quit(); } });
  win.on('closed', () => { mainWindow = null; app.quit(); });
  if (dev) win.loadURL('http://127.0.0.1:5173'); else win.loadFile(rendererPath);
}
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
if (ownsInstance) app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets/rootpath-icon.png'));
  logs = new Logs(path.join(app.getPath('userData'),'logs'),safeStorage); await logs.init();
  logs.on('change',batch=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('logs:events',batch);});
  logs.on('sources',sources=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('logs:sources',sources);});
  manager = new Connections({ root: path.join(app.getPath('userData'), 'ssh'), vault: safeStorage });
  files = new Files(manager);
  transfers = new Transfers(files); editor = new Editor(files); terminals = new Terminals(files);
  monitoring = new Monitoring(files, { beforePower: sessionId => {
    if (databases?.busy.has(sessionId) || [...editor.docs.values()].some(doc => doc.sessionId === sessionId && doc.dirty) || files.locks.has(sessionId) || transfers.snapshot().some(job => job.sessionId === sessionId && ['queued', 'scanning', 'running', 'conflict'].includes(job.status))) throw new PublicError('WORK_IN_PROGRESS', 'Save or close unsaved editor drafts and finish or cancel pending file and database operations before a power action.');
  } });
  applications = new Applications(files, monitoring, { beforeDeploy: sessionId => { if (databases?.busy.has(sessionId) || [...editor.docs.values()].some(doc => doc.sessionId === sessionId && doc.dirty) || files.locks.has(sessionId) || transfers.snapshot().some(job => job.sessionId === sessionId && ['queued', 'scanning', 'running', 'conflict'].includes(job.status))) throw new PublicError('WORK_IN_PROGRESS', 'Save or close editor drafts and finish or cancel file and database operations before redeploying.'); } });
  hosting = new Hosting(files,monitoring); databases = new Databases(files);
  logSources = new LogSources(logs,files,monitoring,applications);
  projects=new Projects(files,applications,path.join(app.getPath('userData'),'projects'),logs);
  try{await projects.init();jobs=new Jobs(projects,logs);workflows=new Workflows(projects,jobs,databases,logs);}catch(error){projectsError=error;}
  try{github=new GitHub(path.join(app.getPath('userData'),'github'),safeStorage,logs,{openExternal:url=>shell.openExternal(url)});await github.init();development=new Workspaces(path.join(app.getPath('userData'),'development'),safeStorage,github,logs);await development.init();if(!projectsError){delivery=new Delivery(development,projects,jobs);scripts=new Scripts(path.join(app.getPath('userData'),'development'),safeStorage,projects,jobs,logs);await scripts.init();setups=new Setups(path.join(app.getPath('userData'),'development'),safeStorage,development,projects,jobs,workflows,logs,delivery.staging);await setups.init();}}catch(error){developmentError=error;}
  const transferStates=new Map();
  transfers.on('change',jobs=>{for(const job of jobs){if(transferStates.get(job.id)===job.status)continue;transferStates.set(job.id,job.status);const session=manager.snapshot().sessions.find(s=>s.id===job.sessionId);logs.add({type:'operation',source:'transfers',jobId:job.id,action:job.kind,target:job.destination,serverId:session?.profile.id,server:session?.profile.name,sessionId:job.sessionId,status:['queued','scanning','running','conflict'].includes(job.status)?'running':job.status,severity:job.status==='failed'?'error':job.status==='conflict'?'warn':'info',text:`${job.kind}: ${job.status}${job.error?' · '+job.error:''}`});}});
  applications.on('change', history => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('applications:history', history); });
  monitoring.on('change', history => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monitoring:history', history); });
  terminals.on('event', event => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:event', event); });
  transfers.on('change', jobs => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('transfers:state', jobs); });
  try { await manager.init();if(!projectsError){const retired=await require('./retire-test-data.cjs').retireTestData(manager,projects);logs.excludedServers=new Set(retired);for(const[id,row]of logs.jobs)if(retired.includes(row.serverId))logs.jobs.delete(id);for(const[id,row]of logSources.sources)if(retired.includes(row.serverId))logSources.remove({id});} } catch (error) { startupError = error; }
  const sessionStates=new Map();
  manager.on('change', state => { for(const session of state.sessions){if(sessionStates.get(session.id)!==session.status){sessionStates.set(session.id,session.status);logs.add({source:'connections',serverId:session.profile.id,server:session.profile.name,sessionId:session.id,severity:session.status==='error'?'error':'info',text:`SSH ${session.status}: ${session.message}`});}} if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('connections:state', state); });
  try{if(developmentError||projectsError)throw developmentError||projectsError;ai=new AIService(path.join(app.getPath('userData'),'ai'),safeStorage,new AIAdapter({projects,manager,development,monitoring,logStore:logs,jobService:jobs,scripts,delivery,setups}));await ai.init();aiBridge=new AIBridge(ai);await aiBridge.start();}catch(error){await aiBridge?.dispose().catch(()=>{});await ai?.dispose().catch(()=>{});aiError=new PublicError('AI_UNAVAILABLE','AI connections could not initialize. Existing server tools remain available.');}
  registerIPC();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Rootpath', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, ...(!app.isPackaged?[{role:'toggleDevTools'}]:[]), { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }
  ]));
  createWindow();
});
let shuttingDown = false, shutdownFinished = false;
app.on('before-quit', event => {
  if (shutdownFinished || !transfers) return;
  event.preventDefault(); if (shuttingDown) return; shuttingDown = true;
  (async () => {
    if (editor?.hasDirty() && mainWindow && (await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Keep editing', 'Discard and quit'], defaultId: 0, cancelId: 0, message: 'Quit with unsaved editor changes?', detail: 'Unsaved drafts will be lost. Remote files and saved backups remain on the server.' })).response !== 1) { shuttingDown = false; return; }
    await aiBridge?.dispose();await ai?.dispose();github?.dispose();delivery?.dispose();await development?.dispose();await setups?.dispose();await scripts?.store.queue.catch(()=>{});
    workflows?.dispose();jobs?.dispose();projects?.dispose();await projects?.queue.catch(()=>{});logSources?.dispose(); databases?.dispose(); hosting?.dispose(); applications?.dispose(); monitoring?.dispose(); terminals?.dispose();
    await Promise.race([transfers.dispose(), new Promise(resolve => setTimeout(resolve, 3000))]);
    files?.dispose(); manager?.dispose();await jobs?.drain();await projects?.queue.catch(()=>{}); await logs?.close(); shutdownFinished = true; app.quit();
  })();
});
app.on('window-all-closed', () => app.quit());
