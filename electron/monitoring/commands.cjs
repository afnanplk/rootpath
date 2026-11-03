const { fail } = require('../connection-store.cjs');
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const prefix = 'export LC_ALL=C LANG=C PATH=/usr/sbin:/usr/bin:/sbin:/bin SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat;\n';
const scripts = {
  capabilities: `printf '__VPS_SYSTEM__\\n'; uname -s; uname -r; uname -m; id -u; hostname
printf '__VPS_RELEASE__\\n'; cat /etc/os-release 2>/dev/null
printf '\\n__VPS_TOOLS__\\n'
for tool in df ps systemctl journalctl sudo; do if command -v "$tool" >/dev/null 2>&1; then printf '%s=1\\n' "$tool"; fi; done
if [ -d /run/systemd/system ]; then printf 'systemdBooted=1\\n'; fi
if [ -r /proc/stat ] && [ -r /proc/meminfo ]; then printf 'proc=1\\n'; fi
printf '__VPS_END__\\n'`,
  metrics: `printf '__VPS_CPU__\\n'; head -n 1 /proc/stat
printf '__VPS_MEMORY__\\n'; cat /proc/meminfo
printf '__VPS_UPTIME__\\n'; cat /proc/uptime
printf '__VPS_LOAD__\\n'; cat /proc/loadavg
printf '__VPS_NETWORK__\\n'; cat /proc/net/dev
printf '__VPS_DISKS__\\n'; df -P -B1 -x tmpfs -x devtmpfs 2>/dev/null
printf '__VPS_END__\\n'`,
  processes: 'ps -eo pid=,user=,pcpu=,pmem=,rss=,stat=,comm= --sort=-pcpu | head -n 200',
  services: `printf '__VPS_LOADED__\\n'; systemctl list-units --type=service --all --no-legend --plain --no-pager --no-ask-password || exit $?
printf '__VPS_INSTALLED__\\n'; systemctl list-unit-files --type=service --no-legend --no-pager --no-ask-password`,
};
function unitName(value) {
  if (typeof value !== 'string' || value.length > 255 || !/^[A-Za-z0-9_][A-Za-z0-9_.:@-]*\.service$/.test(value)) fail('INVALID_UNIT', 'Choose a service with a supported unit name from the discovered list.');
  return value;
}
function command(kind, unit, sudo = false) {
  let script;
  if (Object.hasOwn(scripts, kind)) script = scripts[kind];
  else if (kind === 'status') script = 'systemctl show --no-pager --no-ask-password --property=Id,LoadState,ActiveState,SubState,MainPID,Description,FragmentPath,UnitFileState -- ' + quote(unitName(unit));
  else if (kind === 'logs') script = 'journalctl --no-pager --quiet --output=short-iso --lines=200 --unit=' + quote(unitName(unit));
  else if (['start', 'stop', 'restart'].includes(kind)) script = (sudo ? 'sudo -n -- ' : '') + 'systemctl --no-pager --no-ask-password ' + kind + ' -- ' + quote(unitName(unit));
  else if (['reboot', 'shutdown'].includes(kind)) script = (sudo ? 'sudo -n -- ' : '') + 'systemctl --no-pager --no-ask-password --no-block ' + (kind === 'shutdown' ? 'poweroff' : 'reboot');
  else fail('INVALID_ACTION', 'This dashboard action is not supported.');
  // Nothing from the renderer is evaluated as a script; the sole argument is escaped.
  return '/bin/sh -c ' + quote(prefix + script);
}
module.exports = { command, scripts, unitName };
