const { fail } = require('../connection-store.cjs');
const { pm2Remote } = require('./pm2-remote.cjs');
const q = text => "'" + text.replace(/'/g, "'\"'\"'") + "'";
const prefix = 'export LC_ALL=C LANG=C NO_COLOR=1 COMPOSE_ANSI=never; PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"; export PATH; unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH;\n';
const projection = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"state":{{json .State.Status}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"restarts":{{json .RestartCount}}}';
const listing = '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}},"ports":{{json .Ports}},"project":{{json (.Label "com.docker.compose.project")}},"directory":{{json (.Label "com.docker.compose.project.working_dir")}},"configs":{{json (.Label "com.docker.compose.project.config_files")}}}';
function absolute(value) { if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 4096) fail('INVALID_PATH', 'Choose an existing absolute configuration path without control characters.'); return value; }
function targetId(kind, value) { if (typeof value !== 'string' || !(kind === 'docker' ? /^[a-f0-9]{64}$/ : kind === 'compose' ? /^[a-z0-9][a-z0-9_-]{0,127}$/ : /^(0|[1-9][0-9]{0,8})$/).test(value)) fail('INVALID_TARGET', 'Choose an application from the discovered list.'); return value; }
function command(kind, action, target = {}, sudo = false) {
  let script;
  if (kind === 'capabilities') script = `printf '__VPS_APPLICATIONS__\\n'; for tool in docker pm2 node; do if command -v "$tool" >/dev/null 2>&1; then printf '%s=1\\n' "$tool"; fi; done
socket=/var/run/docker.sock
if [ -n "\${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/docker.sock" ]; then socket="$XDG_RUNTIME_DIR/docker.sock"; elif [ -S "/run/user/$(id -u)/docker.sock" ]; then socket="/run/user/$(id -u)/docker.sock"; fi
printf 'socket=%s\\n' "$socket"`;
  else if (kind === 'pm2') {
    if (sudo) fail('INVALID_ELEVATION', 'PM2 uses only the connected account’s existing daemon.');
    if (action !== 'list') targetId(kind, target.id);
    if (target.revision && !/^[a-f0-9]{64}$/.test(target.revision)) fail('INVALID_TARGET', 'Invalid application revision.');
    script = 'binary=$(command -v pm2) || exit 127; node -e ' + q('(' + pm2Remote.toString() + ')()') + ' "$binary" ' + [action, target.id || '', target.revision || ''].map(q).join(' ');
  } else {
    const docker = (sudo ? 'sudo -n -- ' : '') + 'docker --host=' + q('unix://' + absolute(target.socket));
    if (action === 'compose-version') script = docker + ' compose version --short';
    else if (action === 'list') script = docker + ' container ls --all --no-trunc --format ' + q(listing);
    else if (kind === 'docker') {
      const id = q(targetId(kind, target.id));
      if (action === 'status') script = docker + ' container inspect --format ' + q(projection) + ' -- ' + id;
      else if (action === 'logs') script = docker + ' container logs --tail 200 --timestamps -- ' + id;
      else if (['start', 'stop', 'restart'].includes(action)) script = docker + ' container ' + action + ' -- ' + id;
      else fail('INVALID_ACTION', 'This container action is unavailable. Redeploy is supported through an existing Compose project.');
    } else if (kind === 'compose') {
      const id = targetId(kind, target.id); absolute(target.directory);
      if (!Array.isArray(target.files) || !target.files.length || target.files.length > 16) fail('INVALID_CONFIG', 'Compose needs up to 16 discovered configuration files.');
      const compose = docker + ' compose --ansi never --project-name ' + q(id) + ' --project-directory ' + q(target.directory) + target.files.map(file => ' --file ' + q(absolute(file))).join('');
      if (action === 'version') script = docker + ' compose version --short';
      else if (action === 'hash') script = compose + ' config --hash ' + q('*');
      else if (action === 'services') script = compose + ' config --services';
      else if (action === 'logs') script = compose + ' logs --no-color --timestamps --tail 200';
      else if (action === 'redeploy') script = compose + ' up --detach --force-recreate --no-build --pull never';
      else if (['start', 'stop', 'restart'].includes(action)) script = compose + ' ' + action;
      else fail('INVALID_ACTION', 'Unsupported Compose action.');
      script = 'cd -- ' + q(target.directory) + ' && ' + script;
    } else fail('INVALID_KIND', 'Choose Docker, Compose or PM2.');
  }
  return '/bin/sh -c ' + q(prefix + script);
}
module.exports = { command, targetId, absolute };
