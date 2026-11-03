# Rootpath static recipe v1. Application-owned source; all Git processes run as the login account.
import os,sys,json,subprocess,re,hashlib,stat,tarfile,configparser,shutil,selectors,time,signal
import urllib.request,urllib.parse
def static_health(url,emit):
 u=urllib.parse.urlsplit(url)
 if u.scheme not in ['http','https'] or not u.hostname or u.username or u.password or u.fragment or len(url)>2048:refuse('INVALID_HEALTH','Choose a public HTTP/HTTPS health URL without credentials.')
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args):return None
 opener=urllib.request.build_opener(NoRedirect())
 for i in range(8):
  try:
   with opener.open(urllib.request.Request(url,headers={'User-Agent':'Rootpath-health/1'}),timeout=10) as response:
    if 200<=response.status<300:emit('HTTP 2xx health verified.');return
  except (OSError,urllib.error.URLError):pass
  time.sleep(2)
 refuse('HEALTH_FAILED','HTTP health did not pass after the code update. Inspect the verified recovery archive; no rollback was performed.')
class Refused(Exception):
 def __init__(self,code,message):self.code=code;super().__init__(message)
def refuse(code,message):raise Refused(code,message)
def run_recipe(q,backup_fd=None,emit=lambda s:None,before_update=lambda:None):
 d=q['directory'];s=os.stat(d)
 if os.path.realpath(d)!=d or str(s.st_dev)!=q['device'] or str(s.st_ino)!=q['inode']:refuse('PROJECT_CHANGED','Project directory identity changed.')
 gd=d+'/.git'
 if os.path.islink(gd) or not os.path.isdir(gd):refuse('UNSUPPORTED_REPOSITORY','A regular .git directory is required; linked worktrees are not supported.')
 count=0
 for base,dirs,files in os.walk(gd):
  for name in dirs+files:
   count+=1
   if count>100000 or os.path.islink(base+'/'+name):refuse('UNSAFE_REPOSITORY','Git metadata contains links or exceeds the review limit.')
 if any(os.path.exists(gd+'/'+x) for x in ['objects/info/alternates','objects/info/http-alternates','shallow','info/grafts','MERGE_HEAD','CHERRY_PICK_HEAD','rebase-merge','rebase-apply','index.lock']):refuse('UNSUPPORTED_REPOSITORY','Finish repository maintenance, merges or rebases before deploying. Shallow/shared repositories are not supported.')
 cfg=configparser.RawConfigParser(strict=True);cfg.read(gd+'/config')
 allowed={'core':{'repositoryformatversion','filemode','bare','logallrefupdates','ignorecase','precomposeunicode'},'user':{'name','email'}}
 for section in cfg.sections():
  keys=allowed.get(section,{'url','fetch'} if re.fullmatch(r'remote "[A-Za-z0-9_.-]+"',section) else {'remote','merge'} if re.fullmatch(r'branch "[^"\n]+"',section) else set())
  if any(k not in keys for k in cfg[section]):refuse('UNSAFE_GIT_CONFIG','Repository config contains unsupported executable or extended settings. Review it outside this recipe.')
 git=shutil.which('git',path='/usr/bin:/bin:/usr/local/bin')
 if not git:refuse('GIT_REQUIRED','Install Git before using static deployment.')
 env={'PATH':'/usr/bin:/bin:/usr/local/bin','HOME':os.path.expanduser('~'),'LANG':'C.UTF-8','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_NO_REPLACE_OBJECTS':'1','GIT_SSH_COMMAND':'/usr/bin/ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ConnectTimeout=15'}
 prefix=[git,'--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-c','protocol.allow=never','-c','protocol.ssh.allow=always','-c','gc.auto=0','-c','maintenance.auto=false','-c','submodule.recurse=false','-C',d]
 def g(*args,allow=False):
  child=subprocess.Popen(prefix+list(args),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ,0);selector.register(child.stderr,selectors.EVENT_READ,1);chunks=[bytearray(),bytearray()];started=time.monotonic()
  try:
   while selector.get_map():
    if time.monotonic()-started>90:refuse('GIT_TIMEOUT','Git timed out. Refresh the repository before retrying.')
    for key,_ in selector.select(1):
     data=os.read(key.fileobj.fileno(),65536)
     if not data:selector.unregister(key.fileobj);continue
     chunks[key.data].extend(data)
     if len(chunks[0])>1024*1024 or len(chunks[1])>65536:refuse('REPOSITORY_TOO_LARGE','Git output exceeds this recipe’s review limit.')
   r=subprocess.CompletedProcess(prefix+list(args),child.wait(timeout=5),bytes(chunks[0]),bytes(chunks[1]))
  finally:
   selector.close()
   if child.poll() is None:
    os.killpg(child.pid,signal.SIGKILL);child.wait()
   child.stdout.close();child.stderr.close()
  if r.returncode and not allow:refuse('GIT_FAILED','Git refused the operation. Verify repository access and the Git host key in the VPS account’s known_hosts. Rootpath never accepts an unknown Git host automatically.')
  return r
 def text(*args):return g(*args).stdout.decode('utf-8','replace').strip()
 branch=q.get('branch','');remote=q.get('remote','origin');output=q.get('output','')
 if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,199}',branch) or '..' in branch or '@{' in branch or branch.endswith(('/', '.')):refuse('INVALID_BRANCH','Choose a normal named branch.')
 if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}',remote):refuse('INVALID_REMOTE','Choose a configured SSH remote.')
 if output and (not re.fullmatch(r'[A-Za-z0-9_./ -]{1,200}',output) or any(x in ('','..','.') for x in output.split('/')) or output.startswith('/')):refuse('INVALID_OUTPUT','Use a relative output folder, or leave it empty for the repository root.')
 head=text('rev-parse','--verify','HEAD');current=text('symbolic-ref','--short','HEAD')
 if current!=branch:refuse('BRANCH_MISMATCH','The selected branch must already be checked out. Rootpath will not switch existing projects silently.')
 url=cfg.get('remote "'+remote+'"','url',fallback='')
 if not (re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_./-]+',url) or q.get('artifact') and re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',url) or re.fullmatch(r'ssh://[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?/[A-Za-z0-9_./-]+',url)):refuse('SSH_REMOTE_REQUIRED','Select an SSH remote without embedded passwords or custom transports.')
 action=q.get('action','static-deploy');app_mode=action=='app-deploy'
 if action=='static-recover':
  target=q.get('target','')
  if not re.fullmatch(r'[0-9a-f]{40,64}',target):refuse('INVALID_REVISION','Choose a recorded recovery commit.')
  target=text('rev-parse','--verify',target+'^{commit}')
 elif q.get('artifact'):
  a=q['artifact'];artifact=a.get('path','');ast=os.lstat(artifact)
  if not stat.S_ISREG(ast.st_mode) or ast.st_mode&0o022 or ast.st_uid not in (0,os.getuid()) or ast.st_size!=a.get('size') or ast.st_size>512*1024*1024 or not re.fullmatch(r'refs/rootpath/delivery/[a-f0-9-]{36}',a.get('ref','')) or not re.fullmatch(r'[a-f0-9]{40,64}',a.get('commit','')):refuse('INVALID_ARTIFACT','The staged Git bundle is invalid.')
  ah=hashlib.sha256()
  with open(artifact,'rb') as f:
   for chunk in iter(lambda:f.read(262144),b''):ah.update(chunk)
  if ah.hexdigest()!=a.get('sha256'):refuse('ARTIFACT_CHANGED','The staged bundle changed. Prepare a new deployment review.')
  prefix[1:1]=['-c','protocol.file.allow=always']
  g('bundle','verify',artifact)
  emit('Fetching the reviewed local Git bundle. GitHub credentials are not used on the VPS.')
  g('fetch','--no-tags','--no-recurse-submodules','--no-auto-maintenance','--',artifact,a['ref'])
  target=text('rev-parse','--verify','FETCH_HEAD^{commit}')
  if target!=a['commit']:refuse('ARTIFACT_CHANGED','The bundle revision differs from the approved commit.')
 else:
  emit('Fetching selected SSH branch. Existing working files are unchanged.')
  g('fetch','--no-tags','--no-recurse-submodules','--no-auto-maintenance','--',url,'refs/heads/'+branch)
  target=text('rev-parse','--verify','FETCH_HEAD^{commit}')
 # Review names and status only: never return source or environment-file contents.
 dirty=g('status','--porcelain=v1','-z','--untracked-files=all').stdout
 tracked=g('ls-files','-z').stdout.split(b'\0');targetrows=g('ls-tree','-r','-z',target).stdout.split(b'\0')
 targetpaths=[]
 for row in targetrows:
  if not row:continue
  meta,p=row.split(b'\t',1);mode=meta.split()[0];name=p.decode('utf-8','strict');targetpaths.append(name)
  if mode not in (b'100644',b'100755'):refuse('UNSUPPORTED_FILES','Symlinks and submodules require a separately reviewed deployment recipe.')
  parts=name.split('/')
  if app_mode and any(x in ['node_modules','.venv','venv'] for x in parts):refuse('TRACKED_RUNTIME','Keep dependency directories and virtual environments outside tracked application code.')
  if any(x=='.env' or x.startswith('.env.') and x not in ['.env.example','.env.sample','.env.template'] or x.endswith(('.pem','.key','.bak','.sql','.sqlite3')) for x in parts):refuse('PRIVATE_FILES_TRACKED','The target contains private configuration or backup files. Remove these from tracked static content before deploying.')
 index=(output+'/' if output else '')+'index.html'
 if not app_mode and index not in targetpaths:refuse('OUTPUT_MISSING','The selected commit has no '+index+'. Static recipes deploy prebuilt content; they do not run a build script.')
 ff=g('merge-base','--is-ancestor',head,target,allow=True).returncode==0
 # Enumerate and fingerprint all working content, including ignored files, without following links.
 content=[];hashes={};size=0;digest=hashlib.sha256()
 for base,dirs,files in os.walk(d,followlinks=False):
  dirs.sort();files.sort()
  if base==d:dirs[:]=[x for x in dirs if x!='.git']
  if app_mode:dirs[:]=[x for x in dirs if x not in ['node_modules','.venv','venv']]
  for name in sorted(dirs+files):
   p=base+'/'+name;rel=os.path.relpath(p,d);st=os.lstat(p)
   if app_mode and q.get('kind')=='django' and re.search(r'\.sqlite3(?:-(?:journal|wal|shm))?$',name):continue
   if stat.S_ISLNK(st.st_mode) or not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):refuse('UNSUPPORTED_FILES','Working folders contain symlinks or special files. Review them before deployment.')
   if stat.S_ISREG(st.st_mode):
    size+=st.st_size;content.append(rel)
    if len(content)>20000 or size>512*1024*1024:refuse('BACKUP_LIMIT','This recipe supports up to 20,000 files and 512 MiB before deployment.')
    digest.update(rel.encode());digest.update(str(st.st_mode).encode())
    filehash=hashlib.sha256();readbytes=0
    with open(p,'rb') as f:
     for chunk in iter(lambda:f.read(262144),b''):
      readbytes+=len(chunk)
      if readbytes>512*1024*1024:refuse('BACKUP_LIMIT','A working file grew beyond the recipe limit.')
      digest.update(chunk);filehash.update(chunk)
    hashes[rel]=filehash.hexdigest()
 untracked=set(content)-{x.decode('utf-8','strict') for x in tracked if x}
 if any(u==p or u.startswith(p+'/') or p.startswith(u+'/') for u in untracked for p in targetpaths):refuse('UNTRACKED_CONFLICT','The target would overwrite an untracked or ignored file. Move it explicitly before deployment.')
 revision=hashlib.sha256(json.dumps([head,target,branch,url,output,digest.hexdigest(),dirty.hex()],sort_keys=True).encode()).hexdigest()
 preview={'head':head,'target':target,'branch':branch,'remote':remote,'repository':url,'output':output,'revision':revision,'dirty':bool(dirty),'fastForward':ff,'backupBytes':size,'files':text('diff','--name-status',head,target).splitlines()[:200],'commits':text('log','--format=%h %s','-20',head+'..'+target).splitlines(),'warnings':[]}
 if dirty:preview['warnings'].append('Local tracked or untracked changes exist. Fast-forward deployment is blocked.')
 if not ff:preview['warnings'].append('Branches diverged or the remote was rewound. Fast-forward deployment is blocked.')
 if app_mode:
  if q.get('kind')=='django':
   if any(x not in targetpaths for x in ['manage.py',q.get('requirements','requirements.txt')]):refuse('PROJECT_FILES_MISSING','The selected Django commit needs manage.py and the reviewed requirements file.')
  else:
   applications=[]
   for folder in ['']+([q['frontend']] if q.get('frontend') else []):
    prefixpath=folder+'/' if folder else '';manifestpath=prefixpath+'package.json'
    if manifestpath not in targetpaths:refuse('PROJECT_FILES_MISSING','The selected commit lacks the configured package.json.')
    package=json.loads(text('show',target+':'+manifestpath));locks=[x for x in ['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock'] if prefixpath+x in targetpaths]
    manager,locked=app_installation(package,locks,lambda name:json.loads(text('show',target+':'+prefixpath+name)))
    if not locked and q.get('installMode')!='install':refuse('INSTALL_CHOICE_REQUIRED','A compatible lockfile is missing. Explicitly choose installation without a compatible lockfile.')
    applications.append({'folder':folder,'manager':manager,'locked':locked})
   preview['applications']=applications
 if backup_fd is None:return preview
 if revision!=q.get('revision'):refuse('REVIEW_CHANGED','Files or selected remote commit changed after review. Create a new preview.')
 if action in ['static-deploy','app-deploy'] and (dirty or not ff):refuse('FAST_FORWARD_REQUIRED','A clean repository and fast-forward update are required. Review replacement separately.')
 if min(os.statvfs(d).f_bavail*os.statvfs(d).f_frsize,os.fstatvfs(backup_fd).f_bavail*os.fstatvfs(backup_fd).f_frsize)<size*2+16*1024*1024:refuse('DISK_SPACE','Not enough free disk space for a reviewed backup and update.')
 emit('Creating a protected recovery archive of working files; .git is excluded.')
 with os.fdopen(os.dup(backup_fd),'wb',closefd=True) as raw:
  with tarfile.open(fileobj=raw,mode='w|') as tar:
   for rel in sorted(content):tar.add(d+'/'+rel,arcname=rel,recursive=False)
  raw.flush();os.fsync(raw.fileno())
 os.lseek(backup_fd,0,os.SEEK_SET)
 with os.fdopen(os.dup(backup_fd),'rb') as raw:
  with tarfile.open(fileobj=raw,mode='r|') as tar:
   names=[]
   for member in tar:
    if not member.isfile():refuse('BACKUP_FAILED','Backup verification failed.')
    names.append(member.name)
    f=tar.extractfile(member)
    filehash=hashlib.sha256()
    for chunk in iter(lambda:f.read(262144),b''):filehash.update(chunk)
    if hashes.get(member.name)!=filehash.hexdigest():refuse('BACKUP_FAILED','Backup content verification failed; working files are unchanged.')
   if sorted(names)!=sorted(content):refuse('BACKUP_FAILED','Backup verification failed.')
 # Recheck the complete reviewed content after the archive; no writes if files changed during backup.
 if run_recipe(q)['revision']!=revision:refuse('REVIEW_CHANGED','Project changed during backup. No working files were updated.')
 before_update()
 emit('Backup verified. Updating tracked files to reviewed commit '+target+'. Cancellation now waits for Git to finish; no rollback is implied.')
 if action in ['static-deploy','app-deploy']:g('merge','--ff-only','--no-edit',target)
 else:g('reset','--hard',target)
 if text('rev-parse','HEAD')!=target or (not app_mode and not os.path.isfile(d+'/'+index)):refuse('VERIFY_FAILED','Commit or output verification failed. Inspect the protected backup before recovery.')
 if not app_mode and q.get('healthUrl'):static_health(q['healthUrl'],emit)
 emit('Reviewed application code updated; dependency, migration, restart and health stages still pending.' if app_mode else 'Tracked code and required output verified. No service, Nginx or database changes were made.')
 return preview
if __name__=='__main__':
 try:
  q=json.loads(sys.stdin.read(65537));v=run_recipe(q);print(json.dumps({'ok':True,'value':v}))
 except Refused as e:print(json.dumps({'ok':False,'code':e.code,'message':str(e)}));sys.exit(1)
 except Exception:print(json.dumps({'ok':False,'code':'REPOSITORY_CHECK_FAILED','message':'Repository inspection failed. Verify permissions, Git configuration and file names; no deployment was performed.'}));sys.exit(1)
