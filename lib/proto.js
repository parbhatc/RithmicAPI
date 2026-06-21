import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdir } from "node:fs/promises";
import protobuf from "protobufjs";
import { Packet, setPacketLoader } from "../protocol/Packet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function defaultProtoPaths() {
  const root = join(__dirname, "..", "proto");
  const files = (await readdir(root))
    .filter((f) => f.endsWith(".proto"))
    .sort()
    .map((f) => join(root, f));
  if (!files.length) throw new Error("No .proto files found under proto/");
  return files;
}

let instance = null;

export async function loadProto(protoPath) {
  await import("../protocol/index.js");

  const loader = new ProtoLoader();
  await loader.init(protoPath);
  setPacketLoader(loader);
  instance = loader;
  return loader;
}

export function getProto() {
  if (!instance) {
    throw new Error("Call init() before using the client.");
  }
  return instance;
}

class ProtoLoader {
  #types = new Map();

  async init(protoPath) {
    const paths = protoPath ?? (await defaultProtoPaths());
    const root = new protobuf.Root();
    await root.load(paths, { keepCase: true });

    for (const Cls of [...Packet.getRequestClasses(), ...Packet.getResponseClasses()]) {
      const path = `rti.${Cls.MESSAGE_NAME}`;
      try {
        this.#types.set(Cls.MESSAGE_NAME, root.lookupType(path));
      } catch {
        /* packet stub exists but no schema yet */
      }
    }
  }

  encode(messageName, data) {
    const type = this.#types.get(messageName);
    if (!type) throw new Error(`no such type: rti.${messageName}`);
    return type.encode(data).finish();
  }

  decode(messageName, buffer) {
    const type = this.#types.get(messageName);
    if (!type) throw new Error(`no such type: rti.${messageName}`);
    return type.decode(buffer);
  }
}
