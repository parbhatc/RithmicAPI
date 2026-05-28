#!/usr/bin/env node
import { init } from "../init.js";
import { Packet } from "../protocol/Packet.js";
import { parseFrame } from "../protocol/Packet.js";

const b64 = process.argv[2];
if (!b64) {
  console.error("Usage: node tools/decode.js <base64-frame>");
  process.exit(1);
}

await init();

const raw = Buffer.from(b64, "base64");
const { length, body } = parseFrame(raw);
const packet = Packet.decodeBody(body);

console.log(`frame bytes: ${raw.length} (payload ${length})`);
console.log(`message: ${packet.constructor.MESSAGE_NAME}`);
console.log(JSON.stringify(packet.toObject(), null, 2));
