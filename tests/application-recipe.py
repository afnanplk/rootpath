import importlib.util,unittest,os,json,subprocess,sys,sqlite3,threading,http.server,tarfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('static_tests',Path(__file__).with_name('static-recipe.py'));base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
PYTHON=os.environ.get('ROOTPATH_TEST_PYTHON','/tmp/rootpath-phase4-venv/bin/python')
class Applications(base.StaticRecipe):
 # Inherit the Git fixture, not the static tests.
 def setUp(self):
  super().setUp();self.logs=[]
  source=base.SOURCE.replace("g('fetch','--no-tags'","g('-c','protocol.file.allow=always','fetch','--no-tags'").replace("'--',url,'refs/heads/'","'--',"+repr(str(self.origin))+",'refs/heads/'")
  self.bundle="__name__='rootpath_recipe'\n"+source+'\n'+Path('electron/deployments/application.py').read_text();self.bundle=self.bundle.replace("'PATH':'/usr/local/bin:/usr/bin:/bin'","'PATH':"+repr(os.path.dirname(subprocess.check_output(['which','node'],text=True).strip())+':/usr/local/bin:/usr/bin:/bin'))
  self.ns={'__name__':'fixture'};exec(compile(self.bundle,'application.py','exec'),self.ns);self.run=self.ns['run_recipe'];self.Refused=self.ns['Refused'];self.q.update(action='app-deploy',kind='react',runtimeBin=os.path.dirname(subprocess.check_output(['which','node'],text=True).strip()),output='dist',healthUrl='http://127.0.0.1:1/',envFile='',allowedEnvFiles=[],installMode='locked',build=True,frontend='',frontendOutput='dist');self.stage=lambda stage,**fds:self.ns['app_stage'](self.q,stage,emit=self.logs.append,**fds)
 def publish(self):self.commit('Application revision');self.git(self.author,'push','origin','main')
 def baseline(self):self.git(self.site,'fetch',str(self.origin),'main');self.git(self.site,'reset','--hard','FETCH_HEAD')
 def node(self,folder=''):
  d=self.author/folder;d.mkdir(exist_ok=True);(d/'package.json').write_text(json.dumps({'name':'rootpath-fixture','version':'1.0.0','scripts':{'build':'node build.cjs'}}));(d/'build.cjs').write_text("require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/index.html','built');")
  r=subprocess.run(['npm','install','--package-lock-only','--ignore-scripts','--offline','--no-audit','--no-fund'],cwd=d,capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
 def django(self,bad=False):
  self.q.update(kind='django',output='',python=PYTHON,requirements='requirements.txt',databaseAlias='default',service='sample.service')
  if not Path(PYTHON).exists():self.fail('Set ROOTPATH_TEST_PYTHON to a Python virtual environment with Django 5.2 installed.')
  (self.author/'manage.py').write_text("import os,sys\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','settings')\nfrom django.core.management import execute_from_command_line\nexecute_from_command_line(sys.argv)\n")
  (self.author/'settings.py').write_text("from pathlib import Path\nBASE_DIR=Path(__file__).parent\nSECRET_KEY='fixture-long-secret-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFG'\nDEBUG=False\nALLOWED_HOSTS=['localhost','127.0.0.1']\nINSTALLED_APPS=['django.contrib.contenttypes','django.contrib.auth','django.contrib.sessions','django.contrib.staticfiles','sample']\nMIDDLEWARE=['django.middleware.security.SecurityMiddleware','django.contrib.sessions.middleware.SessionMiddleware','django.middleware.csrf.CsrfViewMiddleware','django.contrib.auth.middleware.AuthenticationMiddleware','django.middleware.clickjacking.XFrameOptionsMiddleware']\nDATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':BASE_DIR/'db.sqlite3'}}\nSTATIC_URL='/static/'\nSTATIC_ROOT=BASE_DIR/'collected'\nSECURE_HSTS_SECONDS=31536000\nSECURE_HSTS_INCLUDE_SUBDOMAINS=True\nSECURE_HSTS_PRELOAD=True\nSECURE_SSL_REDIRECT=True\nSESSION_COOKIE_SECURE=True\nCSRF_COOKIE_SECURE=True\nROOT_URLCONF='urls'\nDEFAULT_AUTO_FIELD='django.db.models.AutoField'\n")
  (self.author/'urls.py').write_text('urlpatterns=[]\n');(self.author/'requirements.txt').write_text('');(self.author/'.gitignore').write_text('db.sqlite3\n__pycache__/\ncollected/\n.env\nnode_modules/\ndist/\nfrontend/node_modules/\nfrontend/dist/\n')
  app=self.author/'sample';(app/'migrations').mkdir(parents=True);(app/'__init__.py').write_text('');(app/'migrations/__init__.py').write_text('');(app/'models.py').write_text('from django.db import models\nclass Item(models.Model):\n name=models.CharField(max_length=20)\n');(app/'migrations/0001_initial.py').write_text("from django.db import migrations,models\nclass Migration(migrations.Migration):\n initial=True\n dependencies=[]\n operations=[migrations.CreateModel(name='Item',fields=[('id',models.AutoField(primary_key=True)),('name',models.CharField(max_length=20))])]\n")
  self.publish();self.baseline();r=subprocess.run([PYTHON,str(self.site/'manage.py'),'migrate','--noinput'],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
  migration="from django.db import migrations,models\nclass Migration(migrations.Migration):\n dependencies=[('sample','0001_initial')]\n operations=[migrations.AddField(model_name='item',name='note',field=models.CharField(max_length=20,default=''))]\n"
  if bad:migration="from django.db import migrations\ndef fail(apps,schema_editor):raise RuntimeError('intentional migration failure')\nclass Migration(migrations.Migration):\n dependencies=[('sample','0001_initial')]\n operations=[migrations.RunPython(fail)]\n"
  (app/'migrations/0002_note.py').write_text(migration);self.publish()
 def prepare(self):
  v=self.ns['app_preview'](self.q);self.q.update(revision=v['revision'],head=v['head'],target=v['target']);self.backup=open(self.root/'code.tar','w+b');self.database=open(self.root/'database.backup','w+b');self.addCleanup(self.backup.close);self.addCleanup(self.database.close);return self.stage('prepare',backup_fd=self.backup.fileno(),database_fd=self.database.fileno())
 def test_application_node_build_and_combined_frontend(self):
  self.node();self.node('frontend');(self.author/'.gitignore').write_text('node_modules/\ndist/\nfrontend/node_modules/\nfrontend/dist/\n');self.publish();self.q['frontend']='frontend';v=self.prepare();self.assertTrue(v['backupVerified']);self.stage('install');self.stage('validate');self.assertEqual((self.site/'dist/index.html').read_text(),'built');self.assertEqual((self.site/'frontend/dist/index.html').read_text(),'built')
 def test_application_django_backup_migration_review_and_collect(self):
  self.django();v=self.prepare();self.assertTrue(v['databaseVerified']);self.assertEqual(sqlite3.connect(self.root/'database.backup').execute('PRAGMA quick_check').fetchone()[0],'ok');self.stage('install');plan=self.stage('validate');self.assertTrue(plan['pendingMigrations']);self.q['migrationHash']=plan['migrationHash'];self.stage('migrate');self.stage('collect');columns=sqlite3.connect(self.site/'db.sqlite3').execute('PRAGMA table_info(sample_item)').fetchall();self.assertIn('note',[x[1] for x in columns])
 def test_application_migration_failure_and_changed_plan_stop(self):
  self.django(bad=True);self.prepare();self.stage('install');plan=self.stage('validate');self.q['migrationHash']='0'*64;self.refused('MIGRATION_PLAN_CHANGED',lambda:self.stage('migrate'));self.q['migrationHash']=plan['migrationHash'];self.refused('STAGE_FAILED',lambda:self.stage('migrate'));self.assertFalse((self.site/'collected').exists())
 def test_application_install_and_build_failures(self):
  self.node();p=json.loads((self.author/'package.json').read_text());p['scripts']['build']="node -e \"process.exit(7)\"";(self.author/'package.json').write_text(json.dumps(p));self.publish();self.prepare();self.stage('install');self.refused('STAGE_FAILED',lambda:self.stage('validate'));self.assertFalse((self.site/'dist').exists())
 def test_application_lockfile_choice_and_conflict(self):
  self.node();(self.author/'package-lock.json').unlink();self.publish();self.refused('INSTALL_CHOICE_REQUIRED',lambda:self.ns['app_preview'](self.q));self.q['installMode']='install';self.assertFalse(self.ns['app_preview'](self.q)['applications'][0]['locked']);(self.author/'yarn.lock').write_text('fixture');(self.author/'pnpm-lock.yaml').write_text('fixture');self.publish();self.refused('LOCKFILE_CONFLICT',lambda:self.ns['app_preview'](self.q))
 def test_application_environment_redaction_split_output_and_validation(self):
  self.node();(self.author/'build.cjs').write_text("process.stdout.write(process.env.API_TOKEN.slice(0,8));setTimeout(()=>{console.log(process.env.API_TOKEN.slice(8));require('node:fs').mkdirSync('dist');require('node:fs').writeFileSync('dist/index.html','ok')},20)");(self.author/'.gitignore').write_text('.env\nnode_modules/\ndist/\n');self.publish();self.baseline();(self.site/'.env').write_text('API_TOKEN=fixture-sensitive-token-value\n');self.q.update(envFile=str(self.site/'.env'),allowedEnvFiles=[str(self.site/'.env')]);self.prepare();self.stage('install');self.stage('validate');self.assertNotIn('fixture-sensitive-token-value','\n'.join(self.logs));self.assertIn('[REDACTED]','\n'.join(self.logs));(self.site/'.env').write_text('PATH=/evil\n');self.refused('UNSAFE_ENV',lambda:self.stage('install'))
 def test_application_durable_coordinator_waits_and_resumes_real_migration(self):
  self.django();preview=self.ns['app_preview'](self.q);self.q.update(revision=preview['revision'],head=preview['head'],target=preview['target'])
  import uuid,pwd,time
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_GET(self):self.send_response(200);self.end_headers()
   def log_message(self,*a):pass
  server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown);self.q['healthUrl']='http://127.0.0.1:'+str(server.server_port)+'/'
  job=self.root/'durable';job.mkdir();locks=self.root/'locks';locks.mkdir();user=pwd.getpwuid(os.getuid());manifest={'version':1,'id':str(uuid.uuid4()),'projectId':str(uuid.uuid4()),'action':'app-deploy','uid':user.pw_uid,'gid':user.pw_gid,'username':user.pw_name,'directory':str(self.site),'device':self.q['device'],'inode':self.q['inode'],'bootId':'fixture','recipe':self.q};(job/'manifest.json').write_text(json.dumps(manifest));(job/'static-v1.py').write_text(self.bundle)
  runner=Path('electron/jobs/runner.py').read_text().replace("os.chown(tmp,0,m['gid'])","None").replace("os.fchown(fd,0,m['gid'])","None").replace("os.fchown(backup,0,m['gid'])","None").replace("os.fchown(database,0,m['gid'])","None").replace("'/var/lib/rootpath/jobs-v1/locks/'",repr(str(locks)+'/')).replace("user=user.pw_uid,group=user.pw_gid,extra_groups=os.getgrouplist(user.pw_name,user.pw_gid),",'')
  a=runner.index('def service_properties(');b=runner.index('\ntry:\n fcntl',a);runner=runner[:a]+"def service_properties(service):return {'User':"+repr(user.pw_name)+",'WorkingDirectory':"+repr(str(self.site))+"}\n"+runner[b:];runner=runner.replace('/usr/bin/systemctl','/usr/bin/true')
  proc=subprocess.Popen(['python3','-c',runner,str(job)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);self.addCleanup(lambda:proc.kill() if proc.poll() is None else None)
  deadline=time.monotonic()+30;state={}
  while time.monotonic()<deadline:
   try:state=json.loads((job/'status.json').read_text())
   except (OSError,ValueError):pass
   if state.get('status') in ['awaiting-review','failed']:break
   time.sleep(.1)
  self.assertEqual(state.get('status'),'awaiting-review',(job/'events.jsonl').read_text());self.assertTrue(state['databaseVerified']);self.assertNotIn('note',[x[1] for x in sqlite3.connect(self.site/'db.sqlite3').execute('PRAGMA table_info(sample_item)')]);(job/'migration-approval.json').write_text(json.dumps({'hash':state['migrationHash']}));out,err=proc.communicate(timeout=30);self.assertEqual(proc.returncode,0,err);final=json.loads((job/'status.json').read_text());self.assertEqual(final['status'],'completed',(job/'events.jsonl').read_text());self.assertIn('note',[x[1] for x in sqlite3.connect(self.site/'db.sqlite3').execute('PRAGMA table_info(sample_item)')]);self.assertTrue((job/'database.backup').stat().st_size>0)
 def test_application_missing_database_stops_before_code_update(self):
  self.django();previous=self.git(self.site,'rev-parse','HEAD');(self.site/'db.sqlite3').unlink();self.refused('STAGE_FAILED',lambda:self.prepare());self.assertEqual(self.git(self.site,'rev-parse','HEAD'),previous);self.assertFalse((self.site/'db.sqlite3').exists())
 def test_application_dependency_failure_and_missing_venv(self):
  self.django();bad=dict(self.q,python=str(self.site/'missing/bin/python'));self.refused('VENV_REQUIRED',lambda:self.ns['app_preview'](bad));(self.author/'requirements.txt').write_text('/rootpath-fixture-missing-package.whl\n');self.publish();self.prepare();self.refused('STAGE_FAILED',lambda:self.stage('install'));self.assertFalse((self.site/'collected').exists())
 def test_application_health_success_failure_and_redirect(self):
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_GET(self):self.send_response(200 if self.path=='/ok' else 302 if self.path=='/redirect' else 503);self.end_headers()
   def log_message(self,*a):pass
  server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown);self.q['healthUrl']='http://127.0.0.1:'+str(server.server_port)+'/ok';self.assertEqual(self.stage('health')['health'],'HTTP 2xx verified');original=self.ns['time'].sleep;self.ns['time'].sleep=lambda n:None;self.addCleanup(setattr,self.ns['time'],'sleep',original)
  for path in ['/failed','/redirect']:self.q['healthUrl']='http://127.0.0.1:'+str(server.server_port)+path;self.refused('HEALTH_FAILED',lambda:self.stage('health'))
# Only run the application-specific tests, avoiding inherited static tests in this suite.
if __name__=='__main__':
 suite=unittest.TestSuite(Applications(name) for name in unittest.defaultTestLoader.getTestCaseNames(Applications) if name.startswith('test_application_'));result=unittest.TextTestRunner(verbosity=2).run(suite);sys.exit(not result.wasSuccessful())
