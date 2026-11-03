import os,sys,json,stat,subprocess,re,time
q=json.loads(sys.stdin.readline(16385));base='/var/lib/rootpath/jobs-v1/'+str(os.getuid());jobs=[]
try:
 with open('/proc/sys/kernel/random/boot_id') as f:boot=f.read().strip()
except OSError:boot='unknown'
try:names=os.listdir(base)
except FileNotFoundError:names=[]
except PermissionError:print(json.dumps({'ok':False,'code':'PERMISSION_DENIED','message':'Job coordination files are not readable for this account.'}));sys.exit(1)
if q.get('id'):names=[q['id']]
else:
 def modified(name):
  try:return os.stat(base+'/'+name).st_mtime
  except OSError:return 0
 names=sorted(names,key=modified,reverse=True)[:1000]
for name in names:
 if not re.fullmatch(r'[0-9a-f-]{36}',name) or (q.get('id') and name!=q['id']):continue
 p=base+'/'+name
 try:
  with open(p+'/manifest.json') as f:m=json.load(f)
  with open(p+'/status.json') as f:s=json.load(f)
  if m['uid']!=os.getuid():continue
  if s.get('status') in ['queued','running','awaiting-review']:
   r=subprocess.run(['/usr/bin/systemctl','show','rootpath-job-'+name+'.service','--property=ActiveState','--value'],capture_output=True,text=True,timeout=5)
   if s.get('bootId')!=boot:s.update(status='interrupted',message='The server rebooted during this job. It was not restarted automatically.')
   elif r.returncode==0 and r.stdout.strip() not in ['active','activating','deactivating','reloading']:s.update(status='unknown',message='The transient unit is no longer active; final completion could not be verified.')
  rows=[];offset=q.get('offset',0) if q.get('id')==name else 0;expired=False;size=0
  try:
   with open(p+'/events.jsonl','rb') as f:
    fileStat=os.fstat(f.fileno());size=fileStat.st_size
    if s.get('status') not in ['queued','running','awaiting-review'] and time.time()-fileStat.st_mtime>7*86400:expired=True;size=0
    if expired:offset=0
    if offset>size:offset=0;expired=True
    f.seek(offset);total=0
    while not expired and not q.get('metadataOnly') and len(rows)<200 and total<262144:
     line=f.readline(8193)
     if not line:break
     total+=len(line)
     if len(line)>8192 or not line.endswith(b'\n'):break
     rows.append(json.loads(line));offset=f.tell()
  except FileNotFoundError:expired=s.get('status') not in ['queued','running','awaiting-review']
  jobs.append({'manifest':{k:m[k] for k in ['id','uid','username','directory','device','inode','projectId','action','bootId'] if k in m } | ({'recipe':{k:m['recipe'][k] for k in ['head','target','output','branch','remote','scriptRevision'] if k in m['recipe']}} if 'recipe' in m else {}),'state':s,'events':rows,'offset':offset,'outputSize':size,'expired':expired})
 except (OSError,ValueError,KeyError,subprocess.SubprocessError):continue
print(json.dumps({'ok':True,'value':jobs}))
