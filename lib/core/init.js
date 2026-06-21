import { loadProto } from "../proto.js";
import { Client, MOBILE_URI } from "./Client.js";
import {
  RequestRithmicSystemInfo,
  RequestRithmicSystemGatewayInfo,
} from "../../protocol/index.js";

let ready = false;

export async function init(protoPath) {
  if (!ready) {
    await loadProto(protoPath);
    ready = true;
  }
}

export async function connect(options = {}) {
  await init();
  const client = new Client(options);
  await client.connect();
  return client;
}

export async function discover(systemName, options = {}) {
  await init();

  const discoverOpts = {
    timeoutMs: options.timeoutMs ?? 45_000,
    connectRetries: options.connectRetries ?? 3,
    uri: options.uri ?? MOBILE_URI,
    log: options.log,
  };

  const client1 = await connect({ ...discoverOpts, label: "socket-1" });
  let gateways;
  try {
    gateways = await client1.exchange(
      new RequestRithmicSystemGatewayInfo({ system_name: systemName }),
    );
  } finally {
    client1.close();
  }

  const client2 = await connect({ ...discoverOpts, label: "socket-2" });
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

export { Client, MOBILE_URI };
