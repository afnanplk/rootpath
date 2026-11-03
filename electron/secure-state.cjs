const fs=require('node:fs/promises'),path=require('node:path');const{fail}=require('./connection-store.cjs');
// Encrypted whole-record storage; no credentials or pending secret values in JSON metadata.
class SecureState{
 constructor(file,vault,initial){this.file=file;this.vault=vault;this.data=initial;this.queue=Promise.resolve();}
 async available(){try{return await this.vault.isAsyncEncryptionAvailable();}catch{return false;}}
 async init(){await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});let bytes;try{bytes=await fs.readFile(this.file);}catch(e){if(e.code==='ENOENT')return;fail('STORE_UNAVAILABLE','Private settings could not be read. Existing data is preserved.');}if(!await this.available())fail('VAULT_UNAVAILABLE','Unlock OS-backed storage to open private settings.');try{const value=await this.vault.decryptStringAsync(bytes);this.data=JSON.parse(value.result);}catch{fail('STORE_UNAVAILABLE','Private settings could not be decrypted. Existing data is preserved.');}}
 persist(){const value=JSON.stringify(this.data);const task=this.queue.catch(()=>{}).then(async()=>{if(!await this.available())fail('VAULT_UNAVAILABLE','OS-backed encryption is required to save these settings.');const encrypted=await this.vault.encryptStringAsync(value);const tmp=this.file+'.tmp';await fs.writeFile(tmp,encrypted,{mode:0o600});await fs.chmod(tmp,0o600);await fs.rename(tmp,this.file);});this.queue=task;return task;}
}
module.exports={SecureState};
