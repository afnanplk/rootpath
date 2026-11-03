"""Real file/Git/config helper tests; administrative ownership and systemctl are simulated on macOS.
These tests do not verify Linux root/systemd isolation or public certificate issuance.
"""
import os,sys,unittest,tempfile,types,json,subprocess,shutil,uuid,copy
from pathlib import Path
SOURCE=Path('electron/workflows/remote.py').read_text().split('\ntry:\n q=json.loads')[0]
class Workflows(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='rootpath-workflows-');self.addCleanup(self.tmp.cleanup);self.root=Path(os.path.realpath(self.tmp.name));self.www=self.root/'www';self.project=self.www/'sample';self.project.mkdir(parents=True);self.units=self.root/'units';self.units.mkdir();self.nginx=self.root/'nginx';(self.nginx/'sites-available').mkdir(parents=True);(self.nginx/'sites-enabled').mkdir();(self.root/'lib').mkdir();self.user=__import__('pwd').getpwuid(os.getuid());self.events=[]
  source=SOURCE.replace('/var/www',str(self.www)).replace('/var/lib',str(self.root/'lib')).replace('/etc/nginx',str(self.nginx)).replace('/etc/systemd/system',str(self.units)).replace('s.st_uid!=0','s.st_uid!=os.getuid()').replace('parent.st_uid!=0','parent.st_uid!=os.getuid()')
  self.n={'__name__':'fixture'};exec(compile(source,'workflow-helper','exec'),self.n);self.Refused=self.n['Refused'];self.n['account']=lambda q,admin=False:self.user
  proxy=types.SimpleNamespace(**{k:getattr(os,k) for k in dir(os)});proxy.geteuid=lambda:0;proxy.fchown=lambda *args:None;self.n['os']=proxy
  st=self.project.stat();self.q={'directory':str(self.project),'device':str(st.st_dev),'inode':str(st.st_ino),'projectId':str(uuid.uuid4()),'username':self.user.pw_name,'file':'.env'}
  self.site={'name':'sample','kind':'static','repository':'git@example.test:owner/repo.git','branch':'main','domains':['sample.example.test'],'port':8000,'output':'','entry':'server.js','requirements':'requirements.txt','runtimeBin':'','staticDir':'staticfiles','https':False}
 def call(self,op,**extra):return self.n['main']({**self.q,'operation':op,**extra})
 def refused(self,code,fn):
  with self.assertRaises(self.Refused) as e:fn()
  self.assertEqual(e.exception.code,code)
 def test_masked_inspection_and_preserved_comments(self):
  (self.project/'.env').write_text('# keep comment\nSECRET=never-return-this\nEMPTY=\n')
  v=self.call('envInspect');self.assertNotIn('never-return-this',json.dumps(v));self.assertEqual(v['fields'][0],{'key':'SECRET','hasValue':True})
  self.call('envSave',revision=v['revision'],changes=[{'key':'NEW','value':'private-new-value'}]);self.assertIn('# keep comment\nSECRET=never-return-this',(self.project/'.env').read_text());self.assertEqual((self.project/'.env').stat().st_mode&0o777,0o600)
 def test_versions_hash_restore_and_stale_review(self):
  (self.project/'.env').write_text('A=old\n');v=self.call('envInspect');saved=self.call('envSave',revision=v['revision'],changes=[{'key':'A','value':'new'}]);self.refused('CONFIG_CHANGED',lambda:self.call('envSave',revision=v['revision'],changes=[{'key':'A','value':'stale'}]));v=self.call('envInspect');self.assertEqual(len(v['backups']),1);self.call('envRestore',revision=v['revision'],backup=saved['backup']);self.assertEqual((self.project/'.env').read_text(),'A=old\n');self.assertEqual(len(self.call('envInspect')['backups']),2)
 def test_link_paths_and_directory_replacement_refused(self):
  outside=self.root/'private';outside.write_text('PASSWORD=private\n');(self.project/'.env').symlink_to(outside);self.refused('UNSAFE_PATH',lambda:self.call('envInspect'));(self.project/'.env').unlink();self.q['inode']='0';self.refused('PROJECT_CHANGED',lambda:self.call('envInspect'))
 def test_invalid_values_and_duplicate_keys(self):
  (self.project/'.env').write_text('A=one\nA=two\n');self.refused('DUPLICATE_ENV',lambda:self.call('envInspect'));(self.project/'.env').write_text('A=one\n');v=self.call('envInspect');self.refused('COMPLEX_ENV',lambda:self.call('envSave',revision=v['revision'],changes=[{'key':'A','value':'$(id)'}]));self.assertEqual((self.project/'.env').read_text(),'A=one\n')
 def test_corrupt_version_refused(self):
  v=self.call('envInspect');x=self.call('envSave',revision=v['revision'],changes=[{'key':'A','value':'first'}]);folder=self.n['store'](self.q,self.user);Path(folder,x['backup']+'.env').write_text('tampered');v=self.call('envInspect');self.assertEqual(v['backups'],[]);self.refused('BACKUP_CHANGED',lambda:self.call('envRestore',revision=v['revision'],backup=x['backup']))
 def test_templates_protect_private_files_and_bind_loopback(self):
  for kind in ['static','react','node','django']:
   site={**self.site,'kind':kind,'entry':'config.wsgi:application' if kind=='django' else 'server.js'};v=self.n['templates'](site,self.user.pw_name);self.assertIn('deny all',v['nginx']);self.assertIn('well-known',v['nginx']);self.assertIn('sqlite3',v['nginx']);self.assertIn('dump',v['nginx']);self.assertIn('backups?',v['nginx']);self.assertIn('package(?:-lock)?',v['nginx'])
   if kind in ['node','django']:self.assertIn('127.0.0.1:8000',v['nginx']);self.assertIn('User='+self.user.pw_name,v['service']);self.assertNotIn('/bin/sh',v['service'])
 def test_new_directory_and_unsafe_site_input_refused(self):
  self.refused('DIRECTORY_EXISTS',lambda:self.n['site_preview']({'site':self.site},self.user))
  for extra in [{'name':'../etc'},{'repository':'https://user:pass@example.test/repo'},{'domains':['example.test;id']},{'output':'../../private'},{'branch':'--upload-pack=sh'}]:self.refused(next(iter(['INVALID_SITE' if 'name'in extra else 'SSH_REMOTE_REQUIRED' if 'repository'in extra else 'INVALID_DOMAIN' if 'domains'in extra else 'INVALID_PATH' if 'output'in extra else 'INVALID_BRANCH'])),lambda:self.n['site_validate']({**self.site,**extra}))
 def configure(self,fail=False):
  (self.project/'index.html').write_text('sample');self.n['execute']=lambda args,timeout=30:(self.events.append(args) or types.SimpleNamespace(returncode=1 if fail and args[-1]=='-t' else 0,stdout=b'',stderr=b''));return self.call('siteConfigure',site=self.site)
 def test_nginx_validate_precedes_reload_and_never_overwrites(self):
  self.configure();self.assertLess(next(i for i,x in enumerate(self.events) if x[-1]=='-t'),next(i for i,x in enumerate(self.events) if 'reload'in x));self.refused('DOMAIN_CONFLICT',lambda:self.configure())
 def test_invalid_nginx_rolls_back_only_created_files(self):
  self.refused('NGINX_INVALID',lambda:self.configure(True));self.assertEqual(list((self.nginx/'sites-available').iterdir()),[]);self.assertFalse(any('reload'in x for x in self.events))
 def test_existing_enabled_link_is_preserved(self):
  link=self.nginx/'sites-enabled/rootpath-sample.conf';link.symlink_to('/a/preexisting/site');self.refused('CONFIG_EXISTS',lambda:self.configure());self.assertTrue(link.is_symlink());self.assertEqual(os.readlink(link),'/a/preexisting/site')
 def test_protected_hosting_restore_validates_and_preserves_current_on_failure(self):
  self.configure();path=self.nginx/'sites-available/rootpath-sample.conf';original=path.read_bytes();i=self.n['nginx_backup'](self.q,self.user,str(path),original);path.write_text('current HTTP and HTTPS configuration');v=self.call('siteVersions')['versions'][0];self.assertEqual(v['id'],i);self.call('siteRestore',backup=i,revision=v['currentRevision']);self.assertEqual(path.read_bytes(),original)
  path.write_text('current configuration must remain');v=next(x for x in self.call('siteVersions')['versions'] if x['id']==i);self.n['execute']=lambda *a,**kw:types.SimpleNamespace(returncode=1);self.refused('NGINX_INVALID',lambda:self.call('siteRestore',backup=i,revision=v['currentRevision']));self.assertEqual(path.read_text(),'current configuration must remain')
 def test_reviewed_git_trust_preserves_existing_keys_and_refuses_changes(self):
  home=self.root/'account';home.mkdir();u=types.SimpleNamespace(pw_dir=str(home),pw_uid=os.getuid(),pw_gid=os.getgid(),pw_name=self.user.pw_name);keyfile=self.root/'test-key';subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(keyfile)],check=True);public=keyfile.with_suffix('.pub').read_text().split();line='example.test '+public[0]+' '+public[1];current=''
  def execute(args,timeout=30):return types.SimpleNamespace(returncode=0,stdout=(line+'\n' if 'ssh-keyscan' in args[0] else current).encode(),stderr=b'')
  self.n['execute']=execute;q={'site':self.site};preview=self.n['git_trust'](q,u);self.assertTrue(preview['fingerprints'][0]['fingerprint'].startswith('SHA256:'));self.n['git_trust']({**q,'keys':preview['keys'],'revision':preview['revision']},u,True);path=home/'.ssh/known_hosts';self.assertIn(line,path.read_text());self.assertEqual(path.stat().st_mode&0o777,0o600)
  current='example.test ssh-ed25519 DIFFERENTKEY\n';preview=self.n['git_trust'](q,u);self.refused('GIT_HOST_CHANGED',lambda:self.n['git_trust']({**q,'keys':preview['keys'],'revision':preview['revision']},u,True));self.assertIn(line,path.read_text())
 def test_helper_output_flood_and_nonzero_status_are_bounded(self):
  result=self.n['execute']([sys.executable,'-c','import sys;print("ok");sys.exit(7)']);self.assertEqual(result.returncode,7);self.assertIn(b'ok',result.stdout);self.refused('OUTPUT_LIMIT',lambda:self.n['execute']([sys.executable,'-c','print("x"*2000000)']))
 def test_timer_discovery_checks_protected_files_and_effective_service_account(self):
  timer=self.units/'sample.timer';service=self.units/'sample.service';timer.write_text('[Timer]\nOnCalendar=daily\n');service.write_text('[Service]\nUser='+self.user.pw_name+'\nWorkingDirectory='+str(self.project)+'\nExecStart=/usr/bin/true\n')
  pathproxy=types.SimpleNamespace(**{k:getattr(os.path,k) for k in dir(os.path)});pathproxy.isdir=lambda p:p=='/run/systemd/system' or os.path.isdir(p);self.n['os'].path=pathproxy
  def execute(args,timeout=30):
   if 'list-units' in args:return types.SimpleNamespace(returncode=0,stdout=b'sample.timer loaded active waiting Sample\n')
   name=args[-1];isTimer=name.endswith('.timer');text='Id='+name+'\nUser='+('' if isTimer else self.user.pw_name)+'\nWorkingDirectory='+('' if isTimer else str(self.project))+'\nFragmentPath='+str(timer if isTimer else service)+'\nDropInPaths=\nActiveState=active\nUnitFileState=enabled\nTriggers='+('sample.service' if isTimer else '')+'\n';return types.SimpleNamespace(returncode=0,stdout=text.encode())
  self.n['execute']=execute;rows=self.call('timers')['timers'];self.assertTrue(rows[0]['manageable']);revision=rows[0]['revision'];service.write_text(service.read_text().replace('ExecStart=','ExecStart=+'));self.assertEqual(self.call('timers')['timers'],[])
 def test_timer_changed_mapping_and_failed_service(self):
  timer={'name':'sample.timer','service':'sample.service','revision':'reviewed','manageable':True};self.n['timers']=lambda q,u:{'timers':[timer]};self.refused('TIMER_CHANGED',lambda:self.call('timerRun',unit='sample.timer',revision='stale'));self.n['execute']=lambda *a,**kw:types.SimpleNamespace(returncode=0);self.n['unit_info']=lambda name:{'Result':'exit-code','ExecMainStatus':'7'};self.refused('SERVICE_FAILED',lambda:self.call('timerRun',unit='sample.timer',revision='reviewed'))
 def test_journal_mapping_and_nginx_path_restrictions(self):
  self.n['timers']=lambda q,u:{'timers':[]};self.refused('LOG_MAPPING_REQUIRED',lambda:self.call('logs',source='journal',target='unrelated.service'));self.refused('LOG_MAPPING_REQUIRED',lambda:self.call('logs',source='nginx',target='/etc/shadow'))
 def test_real_git_creation_and_existing_directory_refusal(self):
  source=Path('electron/deployments/static.py').read_text();app=Path('electron/deployments/application.py').read_text();create=Path('electron/workflows/site.py').read_text();n={'__name__':'rootpath_recipe'};exec(source+'\n'+app+'\n'+create,n)
  origin=self.root/'origin';origin.mkdir();subprocess.run(['git','init','-b','main'],cwd=origin,check=True,capture_output=True);subprocess.run(['git','-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','init'],cwd=origin,check=True,capture_output=True);(origin/'index.html').write_text('created');subprocess.run(['git','add','.'],cwd=origin,check=True,capture_output=True);subprocess.run(['git','-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','content'],cwd=origin,check=True,capture_output=True)
  # Test-only transport replacement; production accepts SSH only with strict host trust.
  create=create.replace("'protocol.allow=never'","'protocol.allow=always'");exec(create,n);n['app_options']=lambda q:None;n['app_environment']=lambda q:({'PATH':os.environ['PATH'],'HOME':str(self.root)},[])
  site={**self.site,'repository':str(origin)};q={'directory':str(self.project),'site':site};n['create_site'](q,self.events.append);self.assertEqual((self.project/'index.html').read_text(),'created');self.assertIn('/.env',(self.project/'.git/info/exclude').read_text());self.assertEqual(subprocess.check_output(['git','status','--porcelain'],cwd=self.project,text=True),'')
  with self.assertRaises(n['Refused']):n['create_site'](q,self.events.append)
if __name__=='__main__':unittest.main(verbosity=2)
