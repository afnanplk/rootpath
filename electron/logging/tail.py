import os,sys,json,time,stat,base64
q=json.loads(sys.stdin.readline(16385))
p=q.get('path')
if p not in ['/var/log/nginx/access.log','/var/log/nginx/error.log']: sys.exit(2)
def emit(v): print(json.dumps(v),flush=True)
f=None;pending=b'';discard=False
try:
 while True:
  try:
   info=os.stat(p)
   if not stat.S_ISREG(info.st_mode): emit({'error':'UNSUPPORTED_FILE'}); break
   if f is None or (info.st_dev,info.st_ino)!=(os.fstat(f.fileno()).st_dev,os.fstat(f.fileno()).st_ino):
    rotated=f is not None
    if f: f.close()
    fd=os.open(p,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW);f=os.fdopen(fd,'rb');current=os.fstat(fd)
    if not stat.S_ISREG(current.st_mode): emit({'error':'UNSUPPORTED_FILE'});break
    old=q.get('cursor') or {};same=old.get('dev')==str(current.st_dev) and old.get('ino')==str(current.st_ino)
    offset=old.get('offset',0) if same else 0
    if rotated or (old and not same): emit({'gap':'Log rotated; earlier output may be unavailable.'})
    if offset>current.st_size: offset=0;emit({'gap':'Log was truncated; reading from the beginning.'})
    if not old and not rotated:
     start=max(0,current.st_size-65536);f.seek(start)
     if start: f.readline(32769)
     data=f.read(65536);lines=data.splitlines(keepends=True);skip=sum(map(len,lines[:-200]));offset=f.tell()-len(data)+skip
    f.seek(offset);pending=b'';discard=False;q['cursor']={}
   if info.st_size<f.tell():f.seek(0);pending=b'';discard=False;emit({'gap':'Log was truncated; reading from the beginning.'})
   data=f.readline(32769)
   if not data:time.sleep(.3);continue
   pending+=data
   if len(pending)>32768:
    if not discard:emit({'gap':'Oversized log line omitted.'})
    discard=True;pending=b''
   if data.endswith(b'\n'):
    cursor={'dev':str(os.fstat(f.fileno()).st_dev),'ino':str(os.fstat(f.fileno()).st_ino),'offset':f.tell()}
    emit({'data':base64.b64encode(pending).decode() if not discard else '', 'cursor':cursor})
    pending=b'';discard=False
  except FileNotFoundError:
   emit({'gap':'Log file is not present; waiting for it to appear.'});time.sleep(3)
  except PermissionError:emit({'error':'PERMISSION_DENIED'});break
except (BrokenPipeError,ConnectionError):pass
finally:
 if f:f.close()
