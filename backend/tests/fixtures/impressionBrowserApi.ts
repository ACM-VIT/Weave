import {assertDisposableDatabase} from '../database/disposableDatabase.js';
assertDisposableDatabase();
const [{default:app},{getApplicationRuntime},{default:redis},{sqlClient}]=await Promise.all([
 import('../../app.js'),import('../../runtime/applicationRuntime.js'),import('../../config/redis.js'),import('../../db/index.js')]);
const server=app.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string')console.log(`IMPRESSION_API_PORT=${address.port}`);});
process.once('SIGTERM',()=>void(async()=>{
 server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
 await getApplicationRuntime().supervisor.stop();redis.disconnect();await sqlClient.end({timeout:1});process.exit(0);
})());
