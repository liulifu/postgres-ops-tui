import {GatewayClient} from './gateway.js';

const gateway = new GatewayClient();
try {
  const snapshot = await gateway.snapshot();
  console.log(`container=${snapshot.container}`);
  console.log(`databases=${snapshot.databases.length} activity=${snapshot.activity.length} locks=${snapshot.locks.length} logs=${snapshot.logs.length}`);
  console.log(snapshot.server_version.split(',')[0]);
} finally {
  gateway.close();
}
