const { Server, utils } = require('ssh2');
const { generateKeyPairSync, createHash, timingSafeEqual } = require('node:crypto');
function makeKey(passphrase) {
  return generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'pkcs1', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) } }).privateKey;
}
async function startFixture({ hostKey = makeKey(), clientKey = makeKey(), keyPassphrase, extraKeys = [], port = 0, password = 'explorer-test-only', fsRoot, ioDelayMs = 0, monitoringOptions = {}, applicationsOptions = {}, tcpPort = null, execHook = null, jobsOptions = {} } = {}) {
  if (fsRoot) fsRoot = await require('node:fs/promises').realpath(fsRoot);
  const parsed = utils.parseKey(clientKey, keyPassphrase);
  if (parsed instanceof Error) throw parsed;
  const keys = [parsed, ...extraKeys.map(({ key, passphrase }) => utils.parseKey(key, passphrase))];
  const monitoring = require('./monitoring-fixture.cjs').createMonitoringFixture(monitoringOptions);
  const applications = require('./applications-fixture.cjs').createApplicationsFixture(fsRoot, applicationsOptions);
  if(jobsOptions.applications)applications.state.pm2Apps.set('7',{id:'7',name:'sample-node',state:'online',cwd:'/var/www/sample-node',script:'/var/www/sample-node/server.js',pid:777,cpu:0,memory:1024});
  if (fsRoot) await applications.seed();
  const logging = require('./logging-fixture.cjs').createLoggingFixture();
  const jobs=require('./jobs-fixture.cjs').createJobsFixture(fsRoot,jobsOptions);if(jobsOptions.enabled)await jobs.seed();
  const hosting = require('./hosting-fixture.cjs').createHostingFixture();
  const clients = new Set();
  const stats = { authenticationAttempts: 0, terminalCommands: [], resizes: [] };
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', context => {
      if (context.method === 'password' || context.method === 'publickey') stats.authenticationAttempts++;
      if (context.username !== 'explorer') return context.reject();
      if (context.method === 'password' && context.password === password) return context.accept();
      const matching = context.method === 'publickey' && keys.find(key => { const publicKey = key.getPublicSSH(); return context.key.data.length === publicKey.length && timingSafeEqual(context.key.data, publicKey); });
      if (matching) {
        if (!context.signature || matching.verify(context.blob, context.signature, context.hashAlgo) === true) return context.accept();
      }
      context.reject(['password', 'publickey']);
    });
    client.on('tcpip',(accept,reject,info)=>{if(!tcpPort||info.destIP!=='127.0.0.1'||info.destPort!==tcpPort)return reject();const remote=require('node:net').connect(tcpPort,'127.0.0.1',()=>{const channel=accept();remote.pipe(channel).pipe(remote);channel.on('close',()=>remote.destroy());});remote.on('error',()=>{try{reject();}catch{}});});
    client.on('session', (accept, reject) => {
      if (!fsRoot) return reject();
      const session = accept();
      session.on('sftp', acceptSFTP => require('./sftp-fixture.cjs').attachSFTP(acceptSFTP(), fsRoot, { ioDelayMs }));
      session.on('pty', (acceptPTY, _rejectPTY, info) => { stats.resizes.push({ cols: info.cols, rows: info.rows }); acceptPTY(); });
      session.on('window-change', (acceptResize, _rejectResize, info) => { stats.resizes.push({ cols: info.cols, rows: info.rows }); acceptResize?.(); });
      session.on('exec', (acceptExec, rejectExec, info) => {
        if (jobsOptions.enabled && jobs.attach(acceptExec, info.command)) return;
        if (logging.attach(acceptExec, info.command)) return;
        if (execHook?.(acceptExec, info.command)) return;
        if (hosting.attach(acceptExec, info.command)) return;
        if (applications.attach(acceptExec, info.command)) return;
        if (monitoring.attach(acceptExec, info.command)) return;
        stats.terminalCommands.push(info.command);
        require('./terminal-fixture.cjs').attachTerminal(acceptExec, rejectExec, info.command, fsRoot);
      });
      session.on('shell', (_accept, rejectShell) => rejectShell());
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const host = utils.parseKey(hostKey);
  const fingerprint = 'SHA256:' + createHash('sha256').update(host.getPublicSSH()).digest('base64').replace(/=+$/, '');
  return { port: server.address().port, fingerprint, stats, logging, jobs, hosting: hosting.state, monitoring: monitoring.state, applications: applications.state, hostKey, clientKey, dropClients: () => { for (const client of clients) client.end(); }, close: () => new Promise(resolve => { jobs.close();for (const client of clients) client.end(); server.close(resolve); }) };
}
module.exports = { startFixture, makeKey };
