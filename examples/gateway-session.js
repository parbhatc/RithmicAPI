import {
  init,
  connect,
  discover,
  buildLoginPress,
  buildLoginAccountWave,
} from "../index.js";

const system = process.env.RITHMIC_SYSTEM ?? "LucidTrading";
const account = process.env.RITHMIC_ACCOUNT ?? "LFE025-I1DN5A30-TEST001";
const serverTag =
  process.env.RITHMIC_SERVER_TAG ??
  "rproto_srvr_63_ritpz02015@rithmic_46_domain:34241";

const fcm = process.env.RITHMIC_FCM ?? system;
const ib = process.env.RITHMIC_IB ?? system;

await init();

const { gateways } = await discover(system);
const chicago =
  gateways.find((g) => g.name.toLowerCase().includes("chicago")) ?? gateways[0];

console.log(`Gateway: ${chicago.name} → ${chicago.uri}\n`);

const client = await connect({ log: true, label: "login", uri: chicago.uri });

client.sendAll(buildLoginPress({ fcm_id: fcm, ib_id: ib, server_tag: serverTag }));
const batch1 = await client.drain({ idleMs: 800, max: 40 });
console.log(`\nAfter login press — ${batch1.length} message(s):`);
for (const p of batch1) {
  console.log(`  - ${p.constructor.MESSAGE_NAME}`);
}

client.sendAll(buildLoginAccountWave({ fcm_id: fcm, ib_id: ib, account_id: account }));
const batch2 = await client.drain({ idleMs: 800, max: 40 });
console.log(`\nAfter account wave — ${batch2.length} message(s):`);
for (const p of batch2) {
  console.log(`  - ${p.constructor.MESSAGE_NAME}`);
}

client.close();
