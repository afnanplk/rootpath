// Deliberately simulated. Never starts a child process or an operating-system shell.
const { parse } = require('shell-quote');
const path = require('node:path');
const fs = require('node:fs/promises');
function attachTerminal(accept, reject, command, root) {
  const outer = parse(command);
  if (outer.length !== 3 || outer[0] !== '/bin/sh' || outer[1] !== '-c' || typeof outer[2] !== 'string') return reject();
  const args = parse(outer[2]);
  if (args.length !== 8 || args[0] !== 'cd' || args[1] !== '--' || typeof args[2] !== 'string' || args[3]?.op !== '&&' || args[4] !== 'exec' || args[6] !== '-i') {
    // shell-quote versions differ in expansion of ${SHELL:-/bin/sh}; only read the quoted cd argument.
    if (args[0] !== 'cd' || args[1] !== '--' || typeof args[2] !== 'string' || args[3]?.op !== '&&' || args[4] !== 'exec') return reject();
  }
  const cwd = args[2], channel = accept(); let line = '';
  const prompt = () => channel.write('explorer@simulated-lab:' + cwd + '$ ');
  channel.write('\r\nVPS EXPLORER LAB — SIMULATED SHELL\r\nSupported: pwd, ls, echo, clear, exit. No OS commands run.\r\n'); prompt();
  let queue = Promise.resolve();
  async function run(value) {
    const command = value.trim();
    if (command === 'exit') { channel.exit(0); channel.end(); return; }
    if (command === 'pwd') channel.write(cwd + '\r\n');
    else if (command === 'ls') {
      const target = path.resolve(root, '.' + cwd);
      if (target === root || target.startsWith(root + path.sep)) { try { channel.write((await fs.readdir(target)).join('  ') + '\r\n'); } catch { channel.write('Cannot list folder\r\n'); } }
    } else if (command === 'clear') channel.write('\x1b[2J\x1b[H');
    else if (command.startsWith('echo ')) channel.write(command.slice(5) + '\r\n');
    else if (command) channel.write('Simulated lab: command unavailable. Try pwd, ls, echo, clear or exit.\r\n');
    prompt();
  }
  channel.on('data', chunk => { for (const char of chunk.toString('utf8')) { if (char === '\r' || char === '\n') { channel.write('\r\n'); const value = line; line = ''; queue = queue.then(() => run(value)).catch(() => {}); } else if (char === '\x7f' || char === '\b') { if (line) { line = line.slice(0, -1); channel.write('\b \b'); } } else if (char === '\x03') { line = ''; channel.write('^C\r\n'); prompt(); } else if (char >= ' ' && line.length < 4096) { line += char; channel.write(char); } } });
}
module.exports = { attachTerminal };
