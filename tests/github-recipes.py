import unittest,tempfile,subprocess,os,json,hashlib,tarfile,threading,http.server
from pathlib import Path
class GitHubRecipes(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='rootpath-github-recipes-');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.author=self.root/'author';self.author.mkdir();self.site=self.root/'site';self.site.mkdir();self.logs=[]
  self.git(self.author,'init','--initial-branch=main');self.git(self.author,'config','user.name','Fixture');self.git(self.author,'config','user.email','fixture@example.invalid');(self.author/'index.html').write_text('First revision');(self.author/'.gitignore').write_text('.env\nnode_modules/\n');self.git(self.author,'add','.');self.git(self.author,'commit','-m','Initial')
  self.pin='refs/rootpath/delivery/11111111-1111-4111-8111-111111111111';self.bundle=self.root/'code.bundle';self.artifact=self.make_bundle();s=self.site.stat();self.q={'directory':str(self.site),'device':str(s.st_dev),'inode':str(s.st_ino),'action':'site-deploy','artifact':self.artifact,'kind':'static','site':{'kind':'static','branch':'main','repository':'git@github.com:fixture/site.git','output':'','name':'test-site','domains':['test.example.com']},'branch':'main','remote':'origin','output':'','healthUrl':'http://127.0.0.1/','envFile':str(self.site/'.env'),'allowedEnvFiles':[str(self.site/'.env')]}
  source="__name__='rootpath_recipe'\n"+'\n'.join(Path(p).read_text() for p in ['electron/deployments/static.py','electron/deployments/application.py','electron/workflows/site.py','electron/workflows/newsite.py','electron/deployments/custom.py']);self.ns={};exec(compile(source,'recipe','exec'),self.ns)
 def git(self,d,*args):return subprocess.check_output(['git','-C',str(d),*args],stderr=subprocess.DEVNULL).decode().strip()
 def make_bundle(self):
  sha=self.git(self.author,'rev-parse','HEAD');self.git(self.author,'update-ref',self.pin,sha);self.git(self.author,'bundle','create',str(self.bundle),self.pin);os.chmod(self.bundle,0o600);return {'path':str(self.bundle),'sha256':hashlib.sha256(self.bundle.read_bytes()).hexdigest(),'size':self.bundle.stat().st_size,'ref':self.pin,'commit':sha}
 def stage(self,name,**kwargs):return self.ns['new_site_stage'](self.q,name,emit=self.logs.append,**kwargs)
 def refused(self,code,fn):
  with self.assertRaises(self.ns['Refused']) as cm:fn()
  self.assertEqual(cm.exception.code,code,str(cm.exception))
 def test_bundle_creation_preparation_and_exact_revision_update(self):
  self.stage('clone');self.assertEqual((self.site/'index.html').read_text(),'First revision');self.assertEqual(self.git(self.site,'rev-parse','HEAD'),self.artifact['commit']);self.q['action']='static-deploy';self.q.pop('healthUrl',None);self.assertFalse(self.ns['run_recipe'](self.q)['dirty']);(self.author/'index.html').write_text('Second revision');self.git(self.author,'add','.');self.git(self.author,'commit','-m','Second');self.q['artifact']=self.make_bundle();preview=self.ns['run_recipe'](self.q);self.q.update(revision=preview['revision']);self.assertTrue(preview['fastForward']);self.assertEqual((self.site/'index.html').read_text(),'First revision')
  with open(self.root/'backup.tar','w+b') as backup:self.ns['run_recipe'](self.q,backup.fileno(),self.logs.append)
  self.assertEqual((self.site/'index.html').read_text(),'Second revision');self.assertTrue(any('Git bundle' in x for x in self.logs));self.assertEqual(self.git(self.site,'remote','get-url','origin'),'git@github.com:fixture/site.git')
 def test_changed_bundle_and_nonempty_directory_refused(self):
  self.bundle.write_bytes(self.bundle.read_bytes()+b'changed');self.refused('ARTIFACT_CHANGED',lambda:self.stage('clone'));self.assertFalse((self.site/'.git').exists());(self.site/'existing').write_text('keep');self.refused('DIRECTORY_NOT_EMPTY',lambda:self.stage('clone'));self.assertEqual((self.site/'existing').read_text(),'keep')
 def test_custom_backup_stale_content_and_nonzero_script(self):
  (self.site/'index.html').write_text('before');q={**self.q,'kind':'node','action':'custom-deploy','envFile':'','allowedEnvFiles':[]};preview=self.ns['custom_snapshot'](q);q['revision']=preview['revision'];(self.site/'index.html').write_text('after')
  with open(self.root/'recovery.tar','w+b') as backup:self.refused('REVIEW_CHANGED',lambda:self.ns['custom_snapshot'](q,backup.fileno()))
  q['revision']=self.ns['custom_snapshot'](q)['revision']
  with open(self.root/'verified.tar','w+b') as backup:self.assertTrue(self.ns['custom_snapshot'](q,backup.fileno())['backupVerified'])
  script=self.root/'script.sh';script.write_text('echo safe-stage\nexit 7\necho should-not-run\n');q['scriptPath']=str(script);self.refused('STAGE_FAILED',lambda:self.ns['app_stage'](q,'custom',emit=self.logs.append));self.assertIn('safe-stage',self.logs);self.assertNotIn('should-not-run',self.logs)
 def test_new_site_durable_coordinator_finishes_only_after_activation_and_health(self):
  import pwd,uuid
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_GET(self):self.send_response(200 if self.headers.get('Host')=='test.example.com' else 503);self.end_headers()
   def log_message(self,*args):pass
  server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
  user=pwd.getpwuid(os.getuid());job=self.root/'durable';job.mkdir();locks=self.root/'locks';locks.mkdir();q={**self.q,'head':self.artifact['commit'],'target':self.artifact['commit']};manifest={'version':1,'id':str(uuid.uuid4()),'projectId':str(uuid.uuid4()),'action':'site-deploy','uid':user.pw_uid,'gid':user.pw_gid,'username':user.pw_name,'directory':str(self.site),'device':q['device'],'inode':q['inode'],'bootId':'fixture','recipe':q};(job/'manifest.json').write_text(json.dumps(manifest));(job/'environment.input').write_text("API_TOKEN='fixture-protected-value'\n");source="__name__='rootpath_recipe'\n"+'\n'.join(Path(p).read_text() for p in ['electron/deployments/static.py','electron/deployments/application.py','electron/workflows/site.py','electron/workflows/newsite.py']);source=source.replace("'http://127.0.0.1/'","'http://127.0.0.1:"+str(server.server_port)+"/'");(job/'static-v1.py').write_text(source)
  # Fixed administrative actions are substituted only in this non-root disposable coordinator test.
  (job/'hosting-v1.py').write_text("import os\ndef admin_lock():return os.open("+repr(str(self.root/'admin.lock'))+",os.O_CREAT|os.O_RDWR,0o600)\ndef configure_site(q,u):\n assert q['directory']=="+repr(str(self.site))+"\n assert open(q['directory']+'/.env').read()==\"API_TOKEN='fixture-protected-value'\\n\"\n open("+repr(str(self.root/'hosting-activated'))+",'w').write('validated')\n")
  runner=Path('electron/jobs/runner.py').read_text().replace("os.chown(tmp,0,m['gid'])","None").replace("os.fchown(fd,0,m['gid'])","None").replace("os.fchown(backup,0,m['gid'])","None").replace("'/var/lib/rootpath/jobs-v1/locks/'",repr(str(locks)+'/')).replace("user=user.pw_uid,group=user.pw_gid,extra_groups=os.getgrouplist(user.pw_name,user.pw_gid),",'')
  result=subprocess.run(['python3','-c',runner,str(job)],capture_output=True,text=True,timeout=30);self.assertEqual(result.returncode,0,result.stderr);state=json.loads((job/'status.json').read_text());events=(job/'events.jsonl').read_text();self.assertEqual(state['status'],'completed',events);self.assertTrue(state['cloneVerified']);self.assertTrue(state['backupVerified']);self.assertTrue((self.root/'hosting-activated').exists());self.assertFalse((job/'environment.input').exists());self.assertNotIn('fixture-protected-value',events);self.assertNotIn('fixture-protected-value',(job/'manifest.json').read_text());self.assertTrue((job/'recovery.tar').stat().st_size>0)
 def test_script_environment_redaction_and_health_failure(self):
  secret='fixture-$-private-quote"-value';(self.site/'.env').write_text('API_TOKEN='+json.dumps(secret)+'\n');script=self.root/'script.sh';script.write_text('printf "%s" "${API_TOKEN:0:7}"\nsleep .01\nprintf "%s\\n" "${API_TOKEN:7}"\n');q={**self.q,'kind':'node','scriptPath':str(script)};self.ns['app_stage'](q,'custom',emit=self.logs.append);self.assertNotIn(secret,'\n'.join(self.logs));self.assertIn('[REDACTED]','\n'.join(self.logs))
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_GET(self):self.send_response(503);self.end_headers()
   def log_message(self,*args):pass
  server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown);q['healthUrl']='http://127.0.0.1:'+str(server.server_port)+'/';original=self.ns['time'].sleep;self.ns['time'].sleep=lambda _:None
  try:self.refused('HEALTH_FAILED',lambda:self.ns['app_stage'](q,'health',emit=self.logs.append))
  finally:self.ns['time'].sleep=original
if __name__=='__main__':unittest.main(verbosity=2)
