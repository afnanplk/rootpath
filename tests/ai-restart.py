import unittest,json,io,contextlib,os,stat,subprocess
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path
SOURCE=Path('electron/ai/restart.py').read_text()
class Restart(unittest.TestCase):
 def run_helper(self,change=None,fail_restart=False):
  q=dict(unit='site.service',directory='/var/www/site',device=1,inode=2,username='afnan',state=dict(Id='site.service',LoadState='loaded',ActiveState='active',SubState='running',MainPID='123'))
  state={**q['state'],'User':'afnan','WorkingDirectory':q['directory'],'FragmentPath':'/etc/systemd/system/site.service'}
  if change:state.update(change)
  calls=[]
  def run(args,**kwargs):
   calls.append(args)
   if 'restart' in args and fail_restart:raise subprocess.CalledProcessError(1,args)
   return SimpleNamespace(stdout='\n'.join(k+'='+v for k,v in state.items()))
  def lstat(p):return SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_dev=1,st_ino=2) if p==q['directory'] else SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=0)
  out=io.StringIO()
  with patch('sys.stdin',io.StringIO(json.dumps(q))),patch('os.lstat',lstat),patch('os.path.realpath',lambda x:x),patch('subprocess.run',run),contextlib.redirect_stdout(out):
   try:exec(compile(SOURCE,'restart.py','exec'),{})
   except SystemExit:pass
  return json.loads(out.getvalue()),calls
 def test_reviewed_service_only(self):
  v,c=self.run_helper();self.assertTrue(v['ok']);self.assertIn(['/usr/bin/systemctl','restart','--','site.service'],c)
 def test_account_directory_and_state_changes_block_restart(self):
  for change in [dict(User='root'),dict(WorkingDirectory='/var/www/other'),dict(MainPID='999'),dict(FragmentPath='/tmp/user.service')]:
   with self.subTest(change=change):
    v,c=self.run_helper(change);self.assertFalse(v['ok']);self.assertFalse(any('restart' in a for a in c))
 def test_nonzero_restart_is_failure(self):
  v,c=self.run_helper(fail_restart=True);self.assertFalse(v['ok']);self.assertEqual(v['code'],'RESTART_FAILED')
if __name__=='__main__':unittest.main(verbosity=2)
