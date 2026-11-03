const { PublicError } = require('./connection-store.cjs');
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
// Only application-owned source appears in command text. Request values travel over stdin.
const SOURCE_BOOTSTRAP="import sys,json,io\np=json.loads(sys.stdin.read(262145))\nsys.stdin=io.StringIO(json.dumps(p['input']))\nexec(compile(p['source'],'<rootpath-helper>','exec'),{'__name__':'__main__'})";
function remoteJSON(record, source, input, { sudo = false, timeout = 30000, sourceStdin = false } = {}) {
 return new Promise((resolve, reject) => {
  const errorLog=require('./log-context.cjs').output('stderr');
  let channel, done = false, chunks = [], size = 0, code = null;
  const finish = error => { if (done) return; done = true; errorLog.end(); clearTimeout(timer); record.client.removeListener('close', closed); if (error) { channel?.close(); reject(error); } else { try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (code !== 0 || !value.ok) throw new PublicError(value.code || 'REMOTE_FAILED', value.message || 'The remote operation failed.'); resolve(value.value); } catch (e) { reject(e instanceof PublicError ? e : new PublicError('REMOTE_FAILED', 'The remote helper failed. Python 3 and any selected noninteractive sudo permission must be available.')); } } };
  const closed = () => finish(new PublicError('CONNECTION_LOST', 'Connection lost. The action may have run; inspect the server before retrying.'));
  const timer = setTimeout(() => finish(new PublicError('REMOTE_TIMEOUT', 'The request timed out. Check the server before retrying an action.')), timeout);
  record.client.once('close', closed);
  record.client.exec((sudo ? 'sudo -n -- ' : '') + '/usr/bin/env python3 -c ' + quote(sourceStdin?SOURCE_BOOTSTRAP:source), (error, stream) => {
   if (done) { stream?.close(); return; } if (error) return finish(new PublicError('EXEC_UNAVAILABLE', 'The SSH helper could not start.'));
   channel = stream; stream.on('data', b => { size += b.length; if (size > 2 * 1024 * 1024) finish(new PublicError('OUTPUT_LIMIT', 'The response exceeded the display limit.')); else chunks.push(Buffer.from(b)); });
   stream.stderr.on('data', b => { errorLog.write(b); size += b.length; if (size > 2 * 1024 * 1024) finish(new PublicError('OUTPUT_LIMIT', 'The response exceeded the display limit.')); });
   stream.once('error', closed); stream.once('exit', c => { code = c; }); stream.once('close', c => { if (Number.isInteger(c)) code = c; finish(); });
   stream.end(JSON.stringify(sourceStdin?{source,input}:input));
  });
 });
}
module.exports = { remoteJSON, quote, SOURCE_BOOTSTRAP };
