const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('vps', {
  ai:Object.fromEntries(['snapshot','create','grant','control','configuration','test','review','cancelReview','reject','approve'].map(method=>[method,input=>ipcRenderer.invoke('connections:ai:'+method,input)])),
  setups:Object.fromEntries(['snapshot','save','inspect','prepare','perform','cancel'].map(method=>[method,input=>ipcRenderer.invoke('connections:setups:'+method,input)])),
  github:Object.fromEntries(['snapshot','connectToken','disconnect','open','repositories','branches'].map(method=>[method,input=>ipcRenderer.invoke('connections:github:'+method,input)])),
  development:Object.fromEntries(['snapshot','create','status','read','settings','propose','proposal','approve','reject','preparePublish','prepareResume','publish','refreshPublication','openPublication'].map(method=>[method,input=>ipcRenderer.invoke('connections:development:'+method,input)])),
  delivery:Object.fromEntries(['prepare','perform','cancel'].map(method=>[method,input=>ipcRenderer.invoke('connections:delivery:'+method,input)])),
  scripts:Object.fromEntries(['snapshot','save','prepareBinding','approveBinding','unbind','prepareRun','cancel'].map(method=>[method,input=>ipcRenderer.invoke('connections:scripts:'+method,input)])),
  workflows: Object.fromEntries(['inspect','prepare','perform','cancel','connections','readiness'].map(method=>[method,input=>ipcRenderer.invoke('connections:workflows:'+method,input)])),
  projects: Object.fromEntries(['snapshot','discover','storage','prepare','import','cancel'].map(method=>[method,input=>ipcRenderer.invoke('connections:projects:'+method,input)])),
  jobs: Object.fromEntries(['snapshot','refresh','detail','preview','prepare','perform','cancelReview'].map(method=>[method,input=>ipcRenderer.invoke('connections:jobs:'+method,input)])),
  logs: { ...Object.fromEntries(['query','snapshot','catalog','watch','stop','remove','export'].map(method=>[method,input=>ipcRenderer.invoke('connections:logs:'+method,input)])), subscribe: listener=>{const fn=(_event,batch)=>listener(batch);ipcRenderer.on('logs:events',fn);return()=>ipcRenderer.removeListener('logs:events',fn);}, subscribeSources:listener=>{const fn=(_event,sources)=>listener(sources);ipcRenderer.on('logs:sources',fn);return()=>ipcRenderer.removeListener('logs:sources',fn);} },
  diagnostics: { export: () => ipcRenderer.invoke('connections:diagnostics:export') },
  hosting: Object.fromEntries(['list','inspect','certificates','validate','prepare','perform','cancel','snapshot'].map(method=>[method,input=>ipcRenderer.invoke('connections:hosting:'+method,input)])),
  databases: Object.fromEntries(['connect','disconnect','list','prepare','perform','cancel','backup','chooseBackup','snapshot','cancelJob'].map(method=>[method,input=>ipcRenderer.invoke('connections:databases:'+method,input)])),
  applications: { ...Object.fromEntries(['capabilities', 'list', 'details', 'logs', 'prepare', 'perform', 'cancel', 'snapshot'].map(method => [method, input => ipcRenderer.invoke('connections:applications:' + method, input)])), subscribe: listener => { const wrapped = (_event, history) => listener(history); ipcRenderer.on('applications:history', wrapped); return () => ipcRenderer.removeListener('applications:history', wrapped); } },
  monitoring: { ...Object.fromEntries(['capabilities', 'metrics', 'processes', 'services', 'status', 'logs', 'prepare', 'cancel', 'perform', 'snapshot'].map(method => [method, input => ipcRenderer.invoke('connections:monitoring:' + method, input)])), subscribe: listener => { const wrapped = (_event, history) => listener(history); ipcRenderer.on('monitoring:history', wrapped); return () => ipcRenderer.removeListener('monitoring:history', wrapped); } },
  workspace: { copy: text => ipcRenderer.invoke('connections:workspace:copy', text), paste: () => ipcRenderer.invoke('connections:workspace:paste'), confirmAction: kind => ipcRenderer.invoke('connections:workspace:confirmAction', kind), confirmDiscard: () => ipcRenderer.invoke('connections:workspace:confirmDiscard') },
  editor: Object.fromEntries(['open', 'reload', 'save', 'restore', 'dirty', 'close'].map(method => [method, input => ipcRenderer.invoke('connections:editor:' + method, input)])),
  terminal: { ...Object.fromEntries(['open', 'write', 'resize', 'ack', 'close'].map(method => [method, input => ipcRenderer.invoke('connections:terminal:' + method, input)])), subscribe: listener => { const wrapped = (_event, value) => listener(value); ipcRenderer.on('terminal:event', wrapped); return () => ipcRenderer.removeListener('terminal:event', wrapped); } },
  connections: {
  snapshot: () => ipcRenderer.invoke('connections:snapshot'),
  connect: input => ipcRenderer.invoke('connections:connect', input),
  disconnect: id => ipcRenderer.invoke('connections:disconnect', id),
  decideHost: input => ipcRenderer.invoke('connections:decide-host', input),
  chooseKey: () => ipcRenderer.invoke('connections:choose-key'),
  removeProfile: id => ipcRenderer.invoke('connections:remove-profile', id),
  forgetSecret: id => ipcRenderer.invoke('connections:forget-secret', id),
  subscribe: listener => { const wrapped = (_event, state) => listener(state); ipcRenderer.on('connections:state', wrapped); return () => ipcRenderer.removeListener('connections:state', wrapped); }
}, files: Object.fromEntries(['releaseListing', 'list', 'properties', 'create', 'rename', 'chmod', 'prepareDelete', 'delete', 'cancelDelete', 'chooseLocal', 'listLocal', 'localProperties'].map(method => [method, input => ipcRenderer.invoke('connections:files:' + method, input)])), transfers: {
  ...Object.fromEntries(['snapshot', 'chooseUpload', 'chooseDestination', 'grantLocal', 'grantLocalDestination', 'enqueue', 'cancel', 'retry', 'resolve', 'clearFinished', 'discardSelections'].map(method => [method, input => ipcRenderer.invoke('connections:transfers:' + method, input)])),
  dropFiles: files => {
    try { const paths = Array.from(files, file => webUtils.getPathForFile(file)); if (!paths.length || paths.some(path => !path)) throw new Error(); return ipcRenderer.invoke('connections:transfers:drop', paths); }
    catch { return Promise.resolve({ ok: false, error: { code: 'INVALID_DROP', message: 'Drop actual files from your computer, or use the upload picker.' } }); }
  },
  subscribe: listener => { const wrapped = (_event, jobs) => listener(jobs); ipcRenderer.on('transfers:state', wrapped); return () => ipcRenderer.removeListener('transfers:state', wrapped); }
} });
