// Deterministic database wire-protocol fixtures. They are not actual database engines.
const net=require('node:net');const mysql=require('mysql2');
async function startDatabaseFixture(engine='mysql'){
 const queries=[],sockets=new Set(),databases=new Set(['sample']),users=new Set(['admin']);let server;
 if(engine==='mysql'){
  server=mysql.createServer();server.on('connection',c=>{sockets.add(c.stream);c.stream.on('close',()=>sockets.delete(c.stream));c.on('error',()=>{});c.serverHandshake({protocolVersion:10,serverVersion:'8.0.0-SIMULATED',connectionId:1,statusFlags:2,characterSet:45,authCallback(_data,done){done(null);c._resetSequenceId();},capabilityFlags:0x00000200|0x00008000|0x00080000});
   const result=(rows,columns)=>{c.writeColumns(columns.map(name=>({catalog:'def',schema:'',table:'',orgTable:'',name,orgName:name,columnType:253,characterSet:45,columnLength:255,flags:0,decimals:0})));for(const row of rows)c.writeTextRow(row);c.writeEof();};
   c.on('packet',()=>c._resetSequenceId());c.on('stmt_prepare',sql=>{queries.push(sql);c.writeOk();});
   c.on('query',sql=>{queries.push(sql);if(sql==='SHOW DATABASES')return result([...databases].map(n=>[n]),['Database']);if(sql.startsWith('SELECT User'))return result([...users].map(n=>[n,'localhost']),['name','host']);let m=sql.match(/^CREATE DATABASE `([a-z_][a-z0-9_]*)`$/);if(m){if(databases.has(m[1]))return c.writeError({code:1007,message:'Already exists'});databases.add(m[1]);}m=sql.match(/^CREATE USER '([a-z_][a-z0-9_]*)'/);if(m)users.add(m[1]);c.writeOk();});
  });
 }else{
  const i32=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;};const i16=n=>{const b=Buffer.alloc(2);b.writeInt16BE(n);return b;};const str=s=>Buffer.from(s+'\0');const packet=(t,b)=>Buffer.concat([Buffer.from(t),i32(b.length+4),b]);
  server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer=Buffer.alloc(0),startup=true,auth=false;const write=(t,b)=>socket.write(packet(t,b));const ready=()=>write('Z',Buffer.from('I'));
   const result=(fields,rows)=>{write('T',Buffer.concat([i16(fields.length),...fields.map(n=>Buffer.concat([str(n),i32(0),i16(0),i32(25),i16(-1),i32(-1),i16(0)]))]));for(const row of rows)write('D',Buffer.concat([i16(row.length),...row.map(v=>{const b=Buffer.from(String(v));return Buffer.concat([i32(b.length),b]);})]));write('C',str('SELECT '+rows.length));ready();};
   socket.on('data',b=>{buffer=Buffer.concat([buffer,b]);while(buffer.length>4){if(startup){const len=buffer.readInt32BE();if(buffer.length<len)return;buffer=buffer.subarray(len);startup=false;write('R',i32(3));continue;}if(buffer.length<5)return;const type=String.fromCharCode(buffer[0]),len=buffer.readInt32BE(1);if(buffer.length<1+len)return;const body=buffer.subarray(5,1+len);buffer=buffer.subarray(1+len);
    if(type==='p'){if(body.toString()!=='database-test-only\0'){write('E',Buffer.concat([str('SFATAL'),str('C28P01'),str('MAuthentication failed'),Buffer.from([0])]));socket.end();return;}auth=true;write('R',i32(0));write('S',Buffer.concat([str('server_version'),str('18.0-SIMULATED')]));write('S',Buffer.concat([str('client_encoding'),str('UTF8')]));write('K',Buffer.concat([i32(1),i32(2)]));ready();}
    if(type==='X')return socket.end();if(type==='Q'&&auth){const sql=body.toString().slice(0,-1);queries.push(sql);if(sql.includes('FROM pg_database'))result(['name','owner'],[...databases].map(n=>[n,'admin']));else if(sql.includes('FROM pg_roles'))result(['name','login'],[...users].map(n=>[n,'t']));else{const m=sql.match(/^CREATE DATABASE "([a-z_][a-z0-9_]*)"$/);if(m)databases.add(m[1]);write('C',str('OK'));ready();}}
   }});
  });
 }
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});const port=(server._server||server).address().port;
 return{port,engine,queries,databases,users,close:()=>new Promise(res=>{for(const s of sockets)s.destroy();server.close(res);})};
}
module.exports={startDatabaseFixture};
