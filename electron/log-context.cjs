const { AsyncLocalStorage }=require('node:async_hooks');
const { Lines }=require('./logging/redact.cjs');
const context=new AsyncLocalStorage();
function output(stream='stdout',enabled=true){const c=context.getStore();if(!c||!enabled||!c.capture)return{write(){},end(){}};return new Lines(c.logs.redactor,text=>c.logs.add({...c.meta,jobId:c.id,source:'command',severity:stream==='stderr'?'warn':'info',stream,text}));}
function register(value){context.getStore()?.logs.redactor.credentials(value);}
module.exports={context,output,register};
