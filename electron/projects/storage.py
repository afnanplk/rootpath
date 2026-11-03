"""Read-only, bounded allocated-size scan. Never open project file contents."""
import os, sys, json, stat, pwd, time
BASE = '/var/www'
ENTRY_LIMIT = 200000
SECONDS = 15
started = time.monotonic()
visited = 0
warnings = []

def owner(uid):
 try: return pwd.getpwuid(uid).pw_name
 except KeyError: return str(uid)

def measure(parent, name, expected):
 global visited
 total = 0
 partial = False
 reasons = set()
 seen = set()
 def walk(fd, device, depth):
  nonlocal total, partial
  global visited
  if depth > 64:
   partial = True; reasons.add('Depth limit'); return
  try:
   with os.scandir(fd) as entries:
    for entry in entries:
     if visited >= ENTRY_LIMIT or time.monotonic() - started >= SECONDS:
      partial = True; reasons.add('Scan limit reached'); return
     visited += 1
     try:
      s = entry.stat(follow_symlinks=False)
      if s.st_dev != device:
       partial = True; reasons.add('Other filesystem excluded'); continue
      key = (s.st_dev, s.st_ino)
      if key in seen: continue
      seen.add(key)
      if stat.S_ISDIR(s.st_mode):
       child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
       try:
        actual = os.fstat(child)
        if (actual.st_dev, actual.st_ino) != key:
         partial = True; reasons.add('Directory changed'); continue
        total += actual.st_blocks * 512
        walk(child, device, depth + 1)
       finally: os.close(child)
      else: total += s.st_blocks * 512
     except OSError:
      partial = True; reasons.add('Unreadable or changed entries')
  except OSError:
   partial = True; reasons.add('Permission denied or directory changed')
 try:
  fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
  try:
   s = os.fstat(fd)
   if (s.st_dev, s.st_ino) != (expected.st_dev, expected.st_ino): raise OSError('changed')
   total += s.st_blocks * 512; seen.add((s.st_dev, s.st_ino)); walk(fd, s.st_dev, 0)
  finally: os.close(fd)
 except OSError:
  return None, True, ['Permission denied or directory changed']
 return total, partial, sorted(reasons)

projects = []
try:
 base = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
 try:
  with os.scandir(base) as entries:
   count = 0
   for index, entry in enumerate(entries):
    if index >= 2000:
     warnings.append('Only the first 2,000 entries under /var/www were inspected.'); break
    try:
     s = entry.stat(follow_symlinks=False)
     if not stat.S_ISDIR(s.st_mode): continue
     if count >= 200:
      warnings.append('Only the first 200 project directories were inspected.'); break
     count += 1
     size, partial, reasons = measure(base, entry.name, s)
     projects.append(dict(name=entry.name, directory=BASE+'/'+entry.name, uid=s.st_uid, owner=owner(s.st_uid), bytes=size, partial=partial, warnings=reasons))
    except OSError:
     warnings.append('A directory changed during discovery.')
 finally: os.close(base)
except OSError:
 warnings.append('Cannot list /var/www with this account. No elevated access was attempted.')
projects.sort(key=lambda p: (p['bytes'] is None, -(p['bytes'] or 0), p['name']))
print(json.dumps({'ok':True,'value':dict(projects=projects, warnings=warnings, base=BASE, scannedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()), account=owner(os.getuid()), uid=os.getuid(), partial=bool(warnings) or any(p['partial'] for p in projects))}))
