import { discover } from "../index.js";

const system = process.env.RITHMIC_SYSTEM ?? "LucidTrading";

const { systems, gateways } = await discover(system, { log: true });

console.log(`\n${systems.length} systems available`);
console.log(`Gateways for ${system}:\n`);
for (const g of gateways) {
  console.log(`  ${g.name} → ${g.uri}`);
}
