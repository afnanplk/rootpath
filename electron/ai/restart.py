import json,sys,subprocess,os,stat,re
q=json.loads(sys.stdin.read(65537))
def refuse(code,message):
 print(json.dumps({'ok':False,'code':code,'message':message}));sys.exit(1)
try:
 unit=q['unit']
 if not re.fullmatch(r'[A-Za-z0-9_.@:-]+\.service',unit):refuse('INVALID_UNIT','Invalid mapped service.')
 s=os.lstat(q['directory'])
 if not stat.S_ISDIR(s.st_mode) or s.st_dev!=q['device'] or s.st_ino!=q['inode']:refuse('PROJECT_CHANGED','Project identity changed.')
 def show():
  r=subprocess.run(['/usr/bin/systemctl','show','--',unit],capture_output=True,text=True,timeout=15,check=True)
  return dict(line.split('=',1) for line in r.stdout.splitlines() if '=' in line)
 v=show()
 if v.get('Id')!=unit or v.get('User')!=q['username'] or os.path.realpath(v.get('WorkingDirectory',''))!=q['directory']:refuse('SERVICE_CHANGED','Service account or directory no longer matches this project.')
 f=v.get('FragmentPath','');a=os.lstat(f)
 if not f.startswith(('/etc/systemd/system/','/usr/lib/systemd/system/','/lib/systemd/system/')) or not stat.S_ISREG(a.st_mode) or a.st_uid!=0 or a.st_mode&0o022:refuse('SERVICE_CHANGED','Service configuration is not protected.')
 if any(v.get(k,'')!=q['state'].get(k,'') for k in ['Id','LoadState','ActiveState','SubState','MainPID']):refuse('SERVICE_CHANGED','Service state changed after review.')
 subprocess.run(['/usr/bin/systemctl','restart','--',unit],capture_output=True,timeout=30,check=True)
 v=show()
 if v.get('ActiveState')!='active':refuse('RESTART_UNVERIFIED','Service restart did not produce an active service.')
 print(json.dumps({'ok':True,'value':{'unit':unit,'status':'active'}}))
except (OSError,ValueError,KeyError,subprocess.SubprocessError):refuse('RESTART_FAILED','Mapped service restart failed or timed out. Inspect service status before retrying.')
