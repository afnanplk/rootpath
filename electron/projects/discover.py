import os,sys,json,stat,re,configparser,hashlib,pwd,shutil,itertools
q=json.loads(sys.stdin.readline(16385));warnings=['Discovery inspects up to 200 candidate directories, two project levels and 500 entries per inspected directory. Complex configuration requires review.']
def owner(uid):
 try:return pwd.getpwuid(uid).pw_name
 except KeyError:return str(uid)
def read(p,limit=262144):
 try:
  s=os.lstat(p)
  if not stat.S_ISREG(s.st_mode) or s.st_size>limit:return ''
  with open(p,encoding='utf8',errors='replace') as f:return f.read(limit)
 except (OSError,ValueError):return ''
def children(p):
 try:return list(itertools.islice(os.scandir(p),500))
 except OSError:warnings.append('Could not inspect '+p);return []
def clean(s):return re.sub(r'(://[^/:\s]+:)[^@\s]+@',r'\1[REDACTED]@',s)[:1024]
def repo(p):
 g=os.path.join(p,'.git')
 if os.path.islink(g):return {'repository':'','branch':'','commit':''}
 head=read(os.path.join(g,'HEAD'),256).strip();branch='';commit=''
 if head.startswith('ref: refs/heads/'):
  branch=head[16:];ref=head[5:]
  if '..' not in ref and re.fullmatch(r'[\w./-]+',ref):commit=read(os.path.join(g,ref),128).strip()
  if not commit:
   for line in read(os.path.join(g,'packed-refs')).splitlines():
    parts=line.split(' ')
    if len(parts)==2 and parts[1]==ref:commit=parts[0]
 elif re.fullmatch('[0-9a-f]{40,64}',head):commit=head
 c=configparser.RawConfigParser(strict=False);remote=''
 try:
  c.read_string(read(os.path.join(g,'config')));remote=c.get('remote "origin"','url',fallback='')
 except configparser.Error:pass
 return {'repository':clean(remote),'branch':branch,'commit':commit if re.fullmatch('[0-9a-f]{40,64}',commit or '') else ''}
services=[]
for e in children('/etc/systemd/system'):
 if e.name.endswith('.service') and e.is_file(follow_symlinks=False):
  text=read(e.path);dirs=re.findall(r'^WorkingDirectory\s*=\s*(.+)$',text,re.M);sockets=re.findall(r'(?:unix:|--bind\s+unix:)(/[^\s;]+)',text)
  if len(dirs)==1:services.append({'name':e.name,'directory':dirs[0].strip(),'sockets':list(dict.fromkeys(sockets))[:8]})
sites=[]
for base in ['/etc/nginx/sites-available','/etc/nginx/conf.d']:
 for e in children(base):
  text=read(e.path)
  if not text:continue
  text=re.sub(r'#.*','',text);roots=re.findall(r'\b(?:root|alias)\s+([^;]+);',text);domains=[]
  for d in re.findall(r'\bserver_name\s+([^;]+);',text):domains.extend(x for x in d.split() if re.fullmatch(r'[A-Za-z0-9*_.-]+',x) and x!='_')
  sockets=re.findall(r'unix:(/[^\s;]+)',text)
  sites.append({'config':e.path,'roots':roots[:20],'domains':list(dict.fromkeys(domains))[:30],'sockets':sockets[:10]})
paths=[]
for e in children('/var/www'):
 if e.is_dir(follow_symlinks=False):
  paths.append(e.path)
  for child in children(e.path):
   if child.is_dir(follow_symlinks=False) and child.name not in ['node_modules','venv','.venv','.git','static','media','dist','build'] and (os.path.isdir(child.path+'/.git') or os.path.isfile(child.path+'/manage.py') or os.path.isfile(child.path+'/package.json')):paths.append(child.path)
projects=[]
for p in paths[:200]:
 r=repo(p);kind='static';issues=[];data={}
 try:data=json.loads(read(p+'/package.json'))
 except (ValueError,TypeError):pass
 if os.path.isfile(p+'/manage.py'):kind='django'
 elif isinstance(data,dict) and data:kind='react' if any(isinstance(data.get(k),dict) and 'react' in data[k] for k in ['dependencies','devDependencies']) else 'node'
 if not r['repository']:issues.append('Repository is not verified. Git worktrees and linked metadata require separate review.')
 svc=[s for s in services if s['directory']==p];sockets=[x for s in svc for x in s['sockets']];ng=[s for s in sites if any(x==p or x.startswith(p+'/') for x in s['roots']) or any(x in sockets for x in s['sockets'])];domains=list(dict.fromkeys(x for s in ng for x in s['domains']))
 if len(svc)>1:issues.append('Multiple service mappings require review.')
 if len(ng)>1:issues.append('Multiple Nginx configurations require review.')
 if any(s['sockets'] for s in ng) and not svc:issues.append('Socket ownership is not verified against a service.')
 env=[p+'/'+n for n in ['.env','.env.production','.env.local'] if os.path.isfile(p+'/'+n)];db='unverified' if kind=='django' or env else 'not-associated'
 scripts=[e.name for e in children(p) if e.name.startswith('deploy-') and e.is_file(follow_symlinks=False)]
 if scripts:issues.append('Existing deployment scripts have not been reviewed or enabled.')
 s=os.stat(p);identity={'owner':owner(s.st_uid),'readable':os.access(p,os.R_OK|os.X_OK),'directory':p,'device':str(s.st_dev),'inode':str(s.st_ino),'uid':s.st_uid,'gid':s.st_gid}
 projects.append(dict(identity,name=os.path.basename(p),type=kind,environment='Unspecified',services=[x['name'] for x in svc],sockets=sockets,nginx=[x['config'] for x in ng],domains=domains,envFiles=env,database=db,backupStatus='Unverified',health='Not checked',issues=issues,scripts=scripts,**r))
for p in projects:
 for domain in p['domains']:
  if sum(domain in x['domains'] for x in projects)>1:p['issues'].append('Domain '+domain+' also maps to another candidate.')
 p['revision']=hashlib.sha256(json.dumps(p,sort_keys=True).encode()).hexdigest()
u=pwd.getpwuid(os.getuid())
print(json.dumps({'ok':True,'value':{'projects':projects,'warnings':warnings[:30],'account':{'username':u.pw_name,'uid':u.pw_uid,'gid':u.pw_gid},'durableAvailable':sys.platform.startswith('linux') and os.path.isdir('/run/systemd/system') and bool(shutil.which('systemd-run')) and bool(shutil.which('sudo')),'fixture':False}}))
