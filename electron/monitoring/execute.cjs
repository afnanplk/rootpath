const { PublicError } = require('../connection-store.cjs');
function execute(record, command, { limit = 2 * 1024 * 1024, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const outputLog=require('../log-context.cjs').output('stdout'), errorOutput=require('../log-context.cjs').output('stderr');
    let channel, done = false, output = [], errors = [], bytes = 0, code = null;
    const started = performance.now();
    function finish(error) { if (done) return; done = true; outputLog.end(); errorOutput.end(); clearTimeout(timer); record.client.removeListener('close', disconnected); if (error) { channel?.close(); reject(error); } else resolve({ stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), code, duration: performance.now() - started }); }
    const disconnected = () => finish(new PublicError('PROBE_DISCONNECTED', 'The connection closed during this request. Refresh after reconnecting; an action may already have run.'));
    const timer = setTimeout(() => finish(new PublicError('PROBE_TIMEOUT', 'The request timed out. An action may already have run. Refresh before trying it again.')), timeout);
    record.client.once('close', disconnected);
    function collect(target, chunk) { bytes += chunk.length; if (bytes > limit) { finish(new PublicError('OUTPUT_LIMIT', 'The server response exceeded the display limit. Narrow the request or use the terminal.')); return; } target.push(Buffer.from(chunk)); }
    try { record.client.exec(command, (error, stream) => {
      if (done) { stream?.close(); return; }
      if (error) { finish(new PublicError('EXEC_UNAVAILABLE', 'The server refused this SSH command channel. Check SSH execution permissions.')); return; }
      channel = stream; channel.on('data', chunk => { outputLog.write(chunk); collect(output, chunk); }); channel.stderr.on('data', chunk => { errorOutput.write(chunk); collect(errors, chunk); });
      channel.once('exit', exitCode => { code = Number.isInteger(exitCode) ? exitCode : null; });
      channel.once('error', () => finish(new PublicError('PROBE_DISCONNECTED', 'The command channel failed. Refresh before retrying an action.')));
      channel.once('close', exitCode => { if (Number.isInteger(exitCode)) code = exitCode; if (code === null) finish(new PublicError('NO_EXIT_STATUS', 'The server closed the channel without an exit status. An action may already have run; verify its state before retrying.')); else finish(); });
    }); } catch { finish(new PublicError('EXEC_UNAVAILABLE', 'The SSH command could not be started.')); }
  });
}
module.exports = { execute };
