import { loadProto } from "./lib/proto.js";
import { Client, MOBILE_URI } from "./Client.js";
import {
  RequestRithmicSystemInfo,
  RequestRithmicSystemGatewayInfo,
} from "./protocol/index.js";

let ready = false;

/** Load protobuf definitions. Safe to call multiple times. */
export async function init(protoPath) {
  if (!ready) {
    await loadProto(protoPath);
    ready = true;
  }
}

/** Connect to Rithmic and return a ready client. */
export async function connect(options = {}) {
  await init();
  const client = new Client(options);
  await client.connect();
  return client;
}

/**
 * Mobile app discovery on rprotocol-mobile (two sockets).
 *
 * The app opens both at once; we run them sequentially for reliability:
 * - Socket 1: RequestRithmicSystemGatewayInfo (20) → regional URLs
 * - Socket 2: RequestRithmicSystemInfo (16) → system list
 */
export async function discover(systemName, options = {}) {
  await init();

  const client1 = await connect({ ...options, label: "socket-1" });
  let gateways;
  try {
    gateways = await client1.exchange(
      new RequestRithmicSystemGatewayInfo({ system_name: systemName }),
    );
  } finally {
    client1.close();
  }

  const client2 = await connect({ ...options, label: "socket-2" });
  let systems;
  try {
    systems = await client2.exchange(new RequestRithmicSystemInfo());
  } finally {
    client2.close();
  }

  if (!systems.system_name?.length) {
    throw new Error("System list response was empty");
  }
  if (!gateways.gateway_name?.length) {
    throw new Error("Gateway list response was empty");
  }

  return {
    systems: systems.system_name,
    gateways: gateways.getGateways(),
    raw: { systems, gateways },
  };
}

export { MOBILE_URI };
