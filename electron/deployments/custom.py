# Reviewed user scripts run only in the ordinary-account child, never the coordinator.
def custom_snapshot(q,backup_fd=None,emit=lambda s:None):
 d=q['directory'];st=os.stat(d)
 if os.path.realpath(d)!=d or str(st.st_dev)!=q['device'] or str(st.st_ino)!=q['inode']:refuse('PROJECT_CHANGED','The project directory identity changed.')
 h=hashlib.sha256();files=[];size=0
 for base,dirs,names in os.walk(d,followlinks=False):
  dirs[:]=sorted(x for x in dirs if x not in ['.git','.venv','venv','node_modules','__pycache__'])
  for name in sorted(dirs+names):
   p=base+'/'+name;s=os.lstat(p);rel=os.path.relpath(p,d)
   if not stat.S_ISREG(s.st_mode) and not stat.S_ISDIR(s.st_mode):refuse('UNSUPPORTED_FILES','Script recovery requires regular files without symbolic links.')
   if not stat.S_ISREG(s.st_mode):continue
   files.append(rel);size+=s.st_size
   if len(files)>20000 or size>512*1024*1024:refuse('BACKUP_LIMIT','Script recovery supports 20,000 files and 512 MiB. Runtime dependency folders are excluded.')
   h.update((rel+'\0'+str(s.st_mode)+'\0').encode())
   with open(p,'rb') as f:
    for chunk in iter(lambda:f.read(262144),b''):h.update(chunk)
 revision=h.hexdigest()
 if backup_fd is None:return {'revision':revision,'backupBytes':size,'files':len(files)}
 if revision!=q.get('revision'):refuse('REVIEW_CHANGED','Project files changed after script review. Nothing was executed.')
 if min(os.statvfs(d).f_bavail*os.statvfs(d).f_frsize,os.fstatvfs(backup_fd).f_bavail*os.fstatvfs(backup_fd).f_frsize)<size*2+16777216:refuse('DISK_SPACE','Not enough space for script recovery.')
 expected={}
 with os.fdopen(os.dup(backup_fd),'wb') as raw:
  with tarfile.open(fileobj=raw,mode='w|') as tar:
   for rel in files:
    f=open(d+'/'+rel,'rb');info=tar.gettarinfo(d+'/'+rel,arcname=rel);datahash=hashlib.sha256()
    # Hash the archived bytes without loading entire files into memory.
    class Reader:
     def read(self,n):
      data=f.read(n);datahash.update(data);return data
    tar.addfile(info,Reader());f.close();expected[rel]=datahash.hexdigest()
  raw.flush();os.fsync(raw.fileno())
 os.lseek(backup_fd,0,os.SEEK_SET);seen=[]
 with os.fdopen(os.dup(backup_fd),'rb') as raw:
  with tarfile.open(fileobj=raw,mode='r|') as tar:
   for member in tar:
    if not member.isfile():refuse('BACKUP_FAILED','Unexpected recovery archive entry.')
    f=tar.extractfile(member);digest=hashlib.sha256()
    for chunk in iter(lambda:f.read(262144),b''):digest.update(chunk)
    if expected.get(member.name)!=digest.hexdigest():refuse('BACKUP_FAILED','Script recovery archive did not verify.')
    seen.append(member.name)
 if sorted(seen)!=sorted(files) or custom_snapshot(q)['revision']!=revision:refuse('REVIEW_CHANGED','Project changed while creating recovery. The script was not executed.')
 emit('Backup verified. Running the exact approved script as the connected account. No automatic rollback is promised.')
 return {'backupVerified':True}
def custom_run(q,backup_fd,emit):
 custom_snapshot(q,backup_fd,emit)
 p=q['scriptPath'];st=os.lstat(p)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_size>65536:refuse('SCRIPT_CHANGED','The protected approved script is invalid.')
 with open(p,'rb') as f:
  if hashlib.sha256(f.read()).hexdigest()!=q['scriptRevision']:refuse('SCRIPT_CHANGED','The approved script revision changed.')
 app_stage(q,'custom',emit=emit);app_stage(q,'health',emit=emit)
 emit('Approved script exited successfully and HTTP health passed.')
