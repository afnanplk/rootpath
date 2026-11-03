import unittest,tempfile,subprocess,os,json,hashlib,tarfile,shutil
from pathlib import Path
SOURCE=Path('electron/deployments/static.py').read_text()
class StaticRecipe(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='rootpath-git-');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.origin=self.root/'origin.git';self.author=self.root/'author';self.site=self.root/'site'
  self.git(self.root,'init','--bare',str(self.origin));self.git(self.root,'clone',str(self.origin),str(self.author));self.git(self.author,'config','user.name','Fixture');self.git(self.author,'config','user.email','fixture@example.test');self.git(self.author,'checkout','-b','main');(self.author/'index.html').write_text('old');self.commit('initial');self.git(self.author,'push','origin','main');self.git(self.origin,'symbolic-ref','HEAD','refs/heads/main');self.git(self.root,'clone',str(self.origin),str(self.site));self.git(self.site,'remote','set-url','origin','git@example.test:team/site.git');self.git(self.site,'config','user.name','Fixture');self.git(self.site,'config','user.email','fixture@example.test');s=self.site.stat();self.q={'directory':str(self.site),'device':str(s.st_dev),'inode':str(s.st_ino),'branch':'main','remote':'origin','output':'','action':'static-deploy'}
  # Test-only substitution: actual Git commands/fetch/merge/reset, with a disposable filesystem remote.
  source=SOURCE.replace("g('fetch','--no-tags'","g('-c','protocol.file.allow=always','fetch','--no-tags'").replace("'--',url,'refs/heads/'","'--',"+repr(str(self.origin))+",'refs/heads/'")
  self.ns={'__name__':'fixture'};exec(compile(source,'static.py','exec'),self.ns);self.run=self.ns['run_recipe'];self.Refused=self.ns['Refused']
 def git(self,cwd,*args):
  r=subprocess.run(['git','-C',str(cwd),*args],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr);return r.stdout.strip()
 def commit(self,msg):self.git(self.author,'add','.');self.git(self.author,'commit','-m',msg)
 def advance(self):
  (self.author/'index.html').write_text('new');(self.author/'new file ü.txt').write_text('unicode');self.commit('updated');self.git(self.author,'push','origin','main')
 def execute(self,action='static-deploy',preview=None):
  self.q['action']=action;v=preview or self.run(self.q);self.q['revision']=v['revision'];self.q['target']=v['target'];fd=os.open(self.root/'backup.tar',os.O_RDWR|os.O_CREAT|os.O_TRUNC,0o600)
  try:return self.run(self.q,fd)
  finally:os.close(fd)
 def refused(self,code,fn):
  with self.assertRaises(self.Refused) as c:fn()
  self.assertEqual(c.exception.code,code)
 def test_fast_forward_backup_and_code_recovery(self):
  old=self.git(self.site,'rev-parse','HEAD');self.advance();p=self.run(self.q);self.assertTrue(p['fastForward']);self.assertFalse(p['dirty']);self.assertIn('M\tindex.html',p['files']);self.execute(preview=p);self.assertEqual((self.site/'index.html').read_text(),'new')
  with tarfile.open(self.root/'backup.tar') as t:self.assertEqual(t.extractfile('index.html').read(),b'old');self.assertNotIn('.git',t.getnames())
  self.q.update(action='static-recover',target=old);self.execute('static-recover');self.assertEqual((self.site/'index.html').read_text(),'old');self.assertEqual(self.git(self.site,'rev-parse','HEAD'),old)
 def test_dirty_replacement_preserves_ignored_and_untracked(self):
  self.advance();(self.site/'index.html').write_text('local');(self.site/'.env').write_text('PASSWORD=private-fixture-value');(self.site/'notes.txt').write_text('keep');p=self.run(self.q);self.assertTrue(p['dirty']);self.assertNotIn('private-fixture-value',json.dumps(p));self.refused('FAST_FORWARD_REQUIRED',lambda:self.execute(preview=p));self.execute('static-replace');self.assertEqual((self.site/'index.html').read_text(),'new');self.assertEqual((self.site/'notes.txt').read_text(),'keep');self.assertEqual((self.site/'.env').read_text(),'PASSWORD=private-fixture-value')
 def test_divergence_and_force_push(self):
  self.advance();(self.site/'local.txt').write_text('local commit');self.git(self.site,'add','.');self.git(self.site,'commit','-m','local');p=self.run(self.q);self.assertFalse(p['fastForward']);self.refused('FAST_FORWARD_REQUIRED',lambda:self.execute(preview=p));self.execute('static-replace');self.git(self.author,'reset','--hard','HEAD~1');self.git(self.author,'push','--force','origin','main');self.assertFalse(self.run(self.q)['fastForward'])
 def test_stale_content_and_remote_are_rejected(self):
  self.advance();p=self.run(self.q);(self.site/'index.html').write_text('changed');self.refused('REVIEW_CHANGED',lambda:self.execute(preview=p));self.assertEqual((self.site/'index.html').read_text(),'changed');self.git(self.site,'checkout','--','index.html');p=self.run(self.q);(self.author/'index.html').write_text('later');self.commit('later');self.git(self.author,'push','origin','main');self.refused('REVIEW_CHANGED',lambda:self.execute(preview=p))
 def test_missing_output_and_untracked_collision(self):
  (self.author/'index.html').unlink();self.commit('missing index');self.git(self.author,'push','origin','main');self.refused('OUTPUT_MISSING',lambda:self.run(self.q));self.git(self.author,'reset','--hard','HEAD~1');(self.author/'collision').write_text('remote');self.commit('collision');self.git(self.author,'push','--force','origin','main');(self.site/'collision').write_text('local');self.refused('UNTRACKED_CONFLICT',lambda:self.run(self.q));self.assertEqual((self.site/'collision').read_text(),'local')
 def test_unsafe_config_symlink_and_private_target(self):
  self.git(self.site,'config','core.sshCommand','touch /tmp/rootpath-should-never-exist');self.refused('UNSAFE_GIT_CONFIG',lambda:self.run(self.q));self.git(self.site,'config','--unset','core.sshCommand');os.symlink('/etc/passwd',self.site/'link');self.refused('UNSUPPORTED_FILES',lambda:self.run(self.q));(self.site/'link').unlink();(self.author/'.env').write_text('private-target');self.commit('bad tracked secret');self.git(self.author,'push','origin','main');self.refused('PRIVATE_FILES_TRACKED',lambda:self.run(self.q))
 def test_branch_remote_output_validation_and_backup_failure(self):
  for key,value,code in [('branch','--upload-pack=evil','INVALID_BRANCH'),('remote','-evil','INVALID_REMOTE'),('output','../other','INVALID_OUTPUT')]:
   old=self.q[key];self.q[key]=value;self.refused(code,lambda:self.run(self.q));self.q[key]=old
  self.advance();p=self.run(self.q);self.q['revision']=p['revision'];fd=os.open(self.root/'readonly',os.O_CREAT|os.O_RDONLY,0o600)
  try:
   with self.assertRaises(OSError):self.run(self.q,fd)
  finally:os.close(fd)
  self.assertEqual((self.site/'index.html').read_text(),'old')
 def test_no_hooks_executed(self):
  self.advance();hook=self.site/'.git/hooks/post-merge';hook.write_text('#!/bin/sh\ntouch '+str(self.root/'hook-ran'));hook.chmod(0o755);self.execute();self.assertFalse((self.root/'hook-ran').exists())
 def test_actual_coordinator_runner_with_git_and_backup_fd(self):
  self.advance();v=self.run(self.q);self.q.update(revision=v['revision'],target=v['target'],head=v['head'])
  job=self.root/'job';job.mkdir();locks=self.root/'locks';locks.mkdir();import uuid,pwd
  u=pwd.getpwuid(os.getuid());manifest={'version':1,'id':str(uuid.uuid4()),'projectId':str(uuid.uuid4()),'action':'static-deploy','uid':u.pw_uid,'gid':u.pw_gid,'username':u.pw_name,'directory':str(self.site),'device':self.q['device'],'inode':self.q['inode'],'bootId':'fixture','recipe':self.q}
  (job/'manifest.json').write_text(json.dumps(manifest));source=SOURCE.replace("g('fetch','--no-tags'","g('-c','protocol.file.allow=always','fetch','--no-tags'").replace("'--',url,'refs/heads/'","'--',"+repr(str(self.origin))+",'refs/heads/'");(job/'static-v1.py').write_text(source)
  # Exercise the real coordinator code locally; only privileged ownership, group switching and lock path are adapted.
  runner=Path('electron/jobs/runner.py').read_text().replace("os.chown(tmp,0,m['gid'])","None").replace("os.fchown(fd,0,m['gid'])","None").replace("os.fchown(backup,0,m['gid'])","None").replace("'/var/lib/rootpath/jobs-v1/locks/'",repr(str(locks)+'/')).replace("user=user.pw_uid,group=user.pw_gid,extra_groups=os.getgrouplist(user.pw_name,user.pw_gid),",'')
  r=subprocess.run(['python3','-c',runner,str(job)],capture_output=True,text=True,timeout=30);self.assertEqual(r.returncode,0,r.stderr);state=json.loads((job/'status.json').read_text());events=(job/'events.jsonl').read_text();self.assertEqual(state['status'],'completed',events);self.assertTrue(state['backupVerified']);self.assertIn('Backup verified',events);self.assertEqual((self.site/'index.html').read_text(),'new')
 def test_ssh_connection_failure_stops_preview(self):
  self.git(self.site,'remote','set-url','origin','ssh://git@127.0.0.1:1/site.git');ns={'__name__':'fixture'};exec(compile(SOURCE,'static.py','exec'),ns)
  with self.assertRaises(ns['Refused']) as c:ns['run_recipe'](self.q)
  self.assertEqual(c.exception.code,'GIT_FAILED');self.assertEqual((self.site/'index.html').read_text(),'old')
if __name__=='__main__':unittest.main(verbosity=2)
