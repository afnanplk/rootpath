// Invoked by Git only. The credential is delivered over an authenticated local pipe,
// never through Git arguments, environment variables, repository config or disk.
const net=require('node:net');
const socket=net.createConnection(process.env.ROOTPATH_AUTH_PIPE);let data='';
socket.setTimeout(10000,()=>socket.destroy());
socket.on('connect',()=>socket.write(JSON.stringify({nonce:process.env.ROOTPATH_AUTH_NONCE,prompt:process.argv[2]})+'\n'));
socket.on('data',chunk=>{data+=chunk;if(data.length>16384)socket.destroy();});
socket.on('end',()=>{try{const r=JSON.parse(data);if(typeof r.value!=='string')throw Error();process.stdout.write(r.value+'\n');}catch{process.exitCode=1;}});
socket.on('error',()=>{process.exitCode=1;});
