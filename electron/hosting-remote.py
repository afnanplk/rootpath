import os, sys, json, re, shutil, subprocess, hashlib, stat, tempfile, time, fcntl
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
os.environ['PATH']=PATH
ROOT='/etc/nginx'
class Refusal(Exception):
 def __init__(self, code, message): self.code,self.message=code,message

def deny(code,message): raise Refusal(code,message)
def run(args,timeout=25):
 return subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,env={**os.environ,'LC_ALL':'C'})
def name(s):
 if not isinstance(s,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}',s): deny('INVALID_INPUT','Use a simple site name, without paths.')
 return s

def layout():
 if os.path.isdir(ROOT+'/sites-available') and os.path.isdir(ROOT+'/sites-enabled'): return 'debian'
 if os.path.isdir(ROOT+'/conf.d'): return 'rhel'
 deny('LAYOUT_UNSUPPORTED','No supported Nginx sites directory was found.')
def target(n): return ROOT+('/sites-available/' if layout()=='debian' else '/conf.d/')+name(n)
def read(p):
 if os.path.lexists(p):
  s=os.lstat(p)
  if not stat.S_ISREG(s.st_mode) or s.st_size>262144: deny('UNSUPPORTED_FILE','Only regular configuration files up to 256 KiB can be managed.')
  with open(p,'r',encoding='utf-8') as f: return f.read()
 return None

def state(n):
 p=target(n); text=read(p); mode=layout(); link=ROOT+'/sites-enabled/'+n
 if mode=='debian':
  enabled=os.path.islink(link) and os.readlink(link) in (p,'../sites-available/'+n)
  if os.path.lexists(link) and not enabled: deny('LINK_CONFLICT','The enable path is occupied by an unrelated file or link.')
 else: enabled=n.endswith('.conf')
 return {'name':n,'text':text,'exists':text is not None,'enabled':enabled,'revision':hashlib.sha256(json.dumps([text,enabled],ensure_ascii=False).encode()).hexdigest()}

def atomic(p,text,original=None):
 fd,tmp=tempfile.mkstemp(prefix='.vps-',dir=os.path.dirname(p))
 try:
  with os.fdopen(fd,'w',encoding='utf-8') as f: f.write(text); f.flush(); os.fsync(f.fileno())
  os.chmod(tmp,stat.S_IMODE(original.st_mode) if original else 0o644)
  if original: os.chown(tmp,original.st_uid,original.st_gid)
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)

def execute(q):
 action=q['action']
 nginx=shutil.which('nginx'); certbot=shutil.which('certbot')
 if action=='capabilities':
  try: mode=layout()
  except Refusal: mode=None
  return {'nginx':bool(nginx),'certbot':bool(certbot),'layout':mode,'fixture':False,'python':True}
 if action=='certificates':
  if not certbot: deny('MISSING_TOOL','Certbot is not installed. Manage an existing installation only.')
  r=run([certbot,'certificates','--non-interactive'],45)
  if r.returncode: deny('CERTBOT_FAILED','Certificate discovery failed. Check Certbot installation and permissions.')
  return {'text':r.stdout.decode(errors='replace')[-131072:]}
 if action in ('issue','renew'):
  if not certbot: deny('MISSING_TOOL','Certbot is not installed.')
  domain=q['domain']
  if not re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}',domain): deny('INVALID_INPUT','Enter one public DNS hostname without wildcards.')
  if action=='renew': args=[certbot,'renew','--cert-name',domain,'--non-interactive']
  else:
   webroot=q['webroot']; email=q['email']
   if not isinstance(webroot,str) or not webroot.startswith('/') or os.path.realpath(webroot)!=webroot or not os.path.isdir(webroot): deny('INVALID_INPUT','Select an existing canonical webroot directory.')
   if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email) or len(email)>254: deny('INVALID_INPUT','Enter an ACME contact email.')
   args=[certbot,'certonly','--webroot','--webroot-path',webroot,'--cert-name',domain,'-d',domain,'--non-interactive','--agree-tos','--email',email]
  r=run(args,180)
  if r.returncode: deny('CERTBOT_FAILED','Certbot failed. Verify DNS, inbound port 80, webroot routing, rate limits and permissions using the server logs.')
  return {'message':'Certbot completed. Refresh certificate status. Existing Certbot hooks may have run; new webroot certificates require HTTPS configuration.'}
 if not nginx: deny('MISSING_TOOL','Nginx is not installed. Manage an existing installation only.')
 mode=layout()
 # Refuse directory symlinks: managed paths must remain within the standard installation.
 for directory in [ROOT,ROOT+('/sites-available' if mode=='debian' else '/conf.d')]+([ROOT+'/sites-enabled'] if mode=='debian' else []):
  if os.path.realpath(directory)!=directory: deny('LAYOUT_UNSUPPORTED','Symlinked Nginx management directories require manual administration.')
 if action=='list':
  directory=ROOT+('/sites-available' if mode=='debian' else '/conf.d')
  result=[]
  for n in sorted(os.listdir(directory))[:2000]:
   if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}',n) or n.endswith('.vps-disabled'): continue
   if mode=='rhel' and not n.endswith('.conf'): continue
   try:
    s=state(n); result.append({'name':n,'enabled':s['enabled']})
   except (Refusal,UnicodeError): pass
  return {'sites':result,'layout':mode,'limit':2000}
 if action=='inspect': return state(name(q['name']))
 if action=='validate':
  if run([nginx,'-t']).returncode: deny('NGINX_INVALID','Nginx configuration validation failed. Check the server error log; no reload was attempted.')
  return {'message':'Nginx configuration passed validation. No reload was requested.'}
 # Serialize transactions across app sessions/processes; never follow a hostile lock symlink.
 fd=os.open(ROOT+'/.vps-explorer.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  n=name(q['name']); previous=state(n)
  if previous['revision']!=q['revision']: deny('REMOTE_CHANGED','The site changed after review. Refresh and review again.')
  p=target(n); original=os.stat(p) if previous['exists'] else None
  link=ROOT+'/sites-enabled/'+n; backup=None
  if mode=='rhel' and action in ('enable','disable'): deny('LAYOUT_UNSUPPORTED','Use configuration editing for conf.d sites; symlink enable/disable is available for Debian sites.')
  if action=='save':
   text=q['text']
   if not isinstance(text,str) or len(text.encode())>262144 or '\x00' in text: deny('INVALID_INPUT','Configuration must be UTF-8 text up to 256 KiB.')
   if mode=='rhel' and not n.endswith('.conf'): deny('INVALID_INPUT','A conf.d site name must end in .conf.')
  elif action=='restore':
   b=q['backup']
   if not re.fullmatch(r'[a-f0-9]{32}',b): deny('INVALID_INPUT','Invalid backup identifier.')
   bp=ROOT+'/.vps-explorer-backups/'+b
   with open(bp+'.json') as f: metadata=json.load(f)
   if metadata['name']!=n: deny('INVALID_INPUT','This backup belongs to another site.')
   text=read(bp)
   if text is None: deny('NOT_FOUND','The backup is unavailable.')
  elif action not in ('enable','disable','reload'): deny('INVALID_INPUT','Unsupported hosting action.')
  if action in ('enable','disable','reload') and not previous['exists']: deny('NOT_FOUND','The site no longer exists.')
  if action in ('save','restore') and previous['exists']:
   import uuid
   bd=ROOT+'/.vps-explorer-backups'
   if os.path.lexists(bd) and (os.path.islink(bd) or not os.path.isdir(bd)): deny('BACKUP_UNAVAILABLE','Backup directory is unsafe.')
   os.makedirs(bd,mode=0o700,exist_ok=True)
   if os.stat(bd).st_uid!=os.geteuid() or stat.S_IMODE(os.stat(bd).st_mode)&0o077: deny('BACKUP_UNAVAILABLE','Backup directory must be private to the acting account.')
   backup=uuid.uuid4().hex; bp=bd+'/'+backup
   with open(bp,'x',encoding='utf-8') as f: f.write(previous['text'])
   os.chmod(bp,0o600)
   with open(bp+'.json','x') as f: json.dump({'name':n,'time':time.time()},f)
   os.chmod(bp+'.json',0o600)
  oldlink=os.readlink(link) if mode=='debian' and previous['enabled'] else None
  def rollback():
   if action in ('save','restore'):
    if previous['exists']: atomic(p,previous['text'],original)
    elif os.path.exists(p): os.unlink(p)
   if mode=='debian' and action in ('enable','disable'):
    if os.path.islink(link): os.unlink(link)
    if oldlink: os.symlink(oldlink,link)
  try:
   if action in ('save','restore'): atomic(p,text,original)
   elif action=='enable' and not previous['enabled']: os.symlink(p,link)
   elif action=='disable' and previous['enabled']: os.unlink(link)
   # Validate inactive Debian drafts separately, then the entire installed configuration.
   if action in ('save','restore') and mode=='debian' and not previous['enabled']:
    fd,check=tempfile.mkstemp(prefix='.vps-check-',dir=ROOT)
    try:
     with os.fdopen(fd,'w') as f: f.write('events {}\nhttp { include /etc/nginx/mime.types; include '+p+'; }\n')
     if run([nginx,'-t','-c',check]).returncode: deny('NGINX_INVALID','The draft failed validation. Previous configuration was restored; no reload occurred.')
    finally: os.unlink(check)
   if run([nginx,'-t']).returncode: deny('NGINX_INVALID','Nginx validation failed. Previous configuration was restored; no reload occurred.')
   if run([nginx,'-s','reload']).returncode: deny('RELOAD_FAILED','Reload failed. Previous configuration was restored; inspect Nginx before continuing.')
  except BaseException:
   rollback()
   raise
  return {'message':'Configuration validated and reload signal sent. Verify the site response.','backup':backup,'name':n}
try:
 q=json.loads(sys.stdin.buffer.read(524289))
 result=execute(q)
 print(json.dumps({'ok':True,'value':result}))
except Refusal as e: print(json.dumps({'ok':False,'code':e.code,'message':e.message}))
except PermissionError: print(json.dumps({'ok':False,'code':'PERMISSION_DENIED','message':'Permission denied. Review noninteractive sudo access for this operation.'}))
except BlockingIOError: print(json.dumps({'ok':False,'code':'BUSY','message':'Another Nginx transaction is running. Refresh before retrying.'}))
except Exception: print(json.dumps({'ok':False,'code':'HOSTING_FAILED','message':'The hosting operation failed. Inspect the server state before retrying; no automatic retry is performed.'}))
