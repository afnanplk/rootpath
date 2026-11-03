# App-owned stages for the GitHub setup job. Called only as the project account.
def new_site_stage(q,stage,backup_fd=None,database_fd=None,emit=lambda s:None):
 if stage=='clone':
  create_site(dict(q,cloneOnly=True),emit)
  return {}
 if stage=='prepare':
  q=dict(q)
  if q['kind']=='static':q.pop('healthUrl',None)
  q['action']='app-deploy' if q['kind']!='static' else 'static-deploy'
  q['revision']=run_recipe(q)['revision']
  if q['kind']=='static':run_recipe(q,backup_fd,emit);return {'backupVerified':True}
  return app_stage(q,stage,backup_fd,database_fd,emit)
 if stage=='health':
  # A Host header checks the generated virtual host without waiting for DNS propagation.
  class NoRedirect(urllib.request.HTTPRedirectHandler):
   def redirect_request(self,*args):return None
  opener=urllib.request.build_opener(NoRedirect())
  for i in range(8):
   try:
    with opener.open(urllib.request.Request('http://127.0.0.1/',headers={'Host':q['site']['domains'][0],'User-Agent':'Rootpath-health/1'}),timeout=10) as response:
     if 200<=response.status<300:return {'health':'HTTP 2xx verified'}
   except (OSError,urllib.error.URLError):pass
   time.sleep(2)
  refuse('HEALTH_FAILED','The generated website did not return HTTP 2xx. Inspect its service and Nginx logs; no rollback was performed.')
 if q['kind']=='static':return {}
 return app_stage(q,stage,backup_fd,database_fd,emit)
