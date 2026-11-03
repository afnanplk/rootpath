const { StringDecoder } = require('node:string_decoder');
class Redactor {
 constructor() { this.secrets = new Set(); this.bytes=0;this.saturated=false; }
 add(value) { if (typeof value !== 'string' || !value || value.length > 32768) return; if(this.secrets.has(value))return;if(this.secrets.size>=2048||this.bytes+value.length>1024*1024){this.saturated=true;return;}this.bytes+=value.length;this.secrets.add(value); if (value.length >= 4) { this.secrets.add(encodeURIComponent(value)); this.secrets.add(value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')); } }
 credentials(value, depth = 0) { if (!value || typeof value !== 'object' || depth > 3) return; for (const [key, v] of Object.entries(value)) { if (/password|passphrase|secret|token|api.?key|private.?key/i.test(key) && typeof v === 'string') this.add(v); else if (v && typeof v === 'object') this.credentials(v, depth + 1); } }
 env(text) { if (typeof text !== 'string') return; for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/); if (!m || !/password|secret|token|key|credential|database_url/i.test(m[1])) continue; let value = m[2].trim(); if (/^['"]/.test(value) && value.at(-1) === value[0]) value = value.slice(1, -1); this.add(value); } }
 clean(value) {
  if(this.saturated)return '[Output hidden: redaction capacity reached; restart Rootpath before collecting more output]';
  let text = String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const secret of [...this.secrets].sort((a,b)=>b.length-a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g, '[PRIVATE KEY REDACTED]')
   .replace(/\b((?:postgres(?:ql)?|mysql|mariadb|redis|https?):\/\/[^\s/:]+:)[^\s@]+@/gi, '$1[REDACTED]@')
   .replace(/((?:["']?[\w.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie)[\w.-]*["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, '$1[REDACTED]')
   .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/._=-]+/gi, '$1 [REDACTED]')
   .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,'[TOKEN REDACTED]');
 }
}
class Lines {
 constructor(redactor, emit, max = 32768) { this.redactor=redactor;this.emit=emit;this.max=max;this.decoder=new StringDecoder('utf8');this.pending='';this.omitting=false;this.privateKey=false; }
 line(line) { if (/-----BEGIN [\w ]*PRIVATE KEY-----/.test(line)) { this.privateKey=true;this.emit('[PRIVATE KEY REDACTED]'); } if(this.privateKey) { if(/-----END [\w ]*PRIVATE KEY-----/.test(line))this.privateKey=false;return; } if(line)this.emit(this.redactor.clean(line)); }
 write(chunk) { this.pending+=this.decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)); for(;;){const at=this.pending.search(/[\r\n]/);if(at<0)break;const line=this.pending.slice(0,at);this.pending=this.pending.slice(at+1);if(!this.omitting){if(line.length>this.max)this.emit('[Oversized log line omitted]');else this.line(line);}this.omitting=false;}if(this.pending.length>this.max){if(!this.omitting)this.emit('[Oversized log line omitted]');this.omitting=true;this.pending='';} }
 end() { this.pending+=this.decoder.end();if(!this.omitting&&this.pending)this.line(this.pending);this.pending=''; }
}
module.exports={Redactor,Lines};
