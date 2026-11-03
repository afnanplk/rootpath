const{fail}=require('./connection-store.cjs');
let enforced=false;
// Main enables this unconditionally in installed builds. Test fixtures stay outside the package.
function enableProduction(){enforced=true;}
function realServer(value){if(enforced&&(value?.fixture===true||value?.simulated===true))fail('TEST_SERVER_REJECTED','This server returned test data. Connect to your actual Linux server.');return value;}
module.exports={enableProduction,realServer};
