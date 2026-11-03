import sys,os,json,subprocess,tempfile,shutil,signal
q=json.loads(sys.stdin.buffer.readline(32769))
env={**os.environ,'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}
credential_file=None
passed_fds=()
try:
 if q['engine']=='postgres':
  env['PGPASSWORD']=q['password']; env['PGCONNECT_TIMEOUT']='10'
  base=['--host=127.0.0.1','--port='+str(q['port']),'--username='+q['username'],'--no-password']
  args=(['pg_dump']+base+['--format=custom','--no-owner','--no-privileges','--dbname='+q['database']]) if q['action']=='backup' else (['pg_restore']+base+['--no-owner','--no-privileges','--exit-on-error','--dbname='+q['database']])
 else:
  credential_file=tempfile.TemporaryFile(mode='w+b'); fd=credential_file.fileno(); os.fchmod(fd,0o600); passed_fds=(fd,)
  def escape(s): return '"'+s.replace('\\','\\\\').replace('"','\\"').replace('\n','\\n').replace('\r','\\r').replace('\t','\\t')+'"'
  credential_file.write(('[client]\nhost=127.0.0.1\nprotocol=tcp\nport='+str(q['port'])+'\nuser='+escape(q['username'])+'\npassword='+escape(q['password'])+'\n').encode()); credential_file.flush(); credential_file.seek(0)
  tool=('mysqldump' if shutil.which('mysqldump',path=env['PATH']) else 'mariadb-dump') if q['action']=='backup' else ('mysql' if shutil.which('mysql',path=env['PATH']) else 'mariadb')
  args=[tool,'--defaults-extra-file=/proc/self/fd/'+str(fd)]
  if q['action']=='backup': args+=['--single-transaction','--skip-lock-tables','--hex-blob','--no-tablespaces',q['database']]
  else: args+=['--binary-mode','--database='+q['database']]
 if not shutil.which(args[0],path=env['PATH']): raise RuntimeError('missing')
 # Buffering stdin in Python must not consume bytes beyond the JSON line before piping restore data.
 with tempfile.TemporaryFile() as errors:
  if q['action']=='backup':
   result=subprocess.run(args,env=env,pass_fds=passed_fds,stdin=subprocess.DEVNULL,stdout=sys.stdout.buffer,stderr=errors,timeout=600)
  else:
   def expired(_signum,_frame): raise TimeoutError('Restore deadline reached')
   signal.signal(signal.SIGALRM,expired); signal.alarm(600)
   child=subprocess.Popen(args,env=env,pass_fds=passed_fds,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=errors)
   try:
    while True:
     b=sys.stdin.buffer.read(65536)
     if not b: break
     child.stdin.write(b)
    child.stdin.close(); child.wait(timeout=600)
    result=child
   finally:
    signal.alarm(0)
    if child.poll() is None: child.kill(); child.wait()
  sys.exit(0 if result.returncode==0 else 1)
finally:
 if credential_file: credential_file.close()
