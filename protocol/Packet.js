import { peekTemplateId, toPlain } from "../lib/util.js";

let loader = null;

export function setPacketLoader(instance) {
  loader = instance;
}

function getLoader() {
  if (!loader) throw new Error("Call init() before sending packets.");
  return loader;
}

export function frameMessage(payload) {
  const header = Buffer.alloc(4);
  header.writeInt32BE(payload.length, 0);
  return Buffer.concat([header, Buffer.from(payload)]);
}

export function parseFrame(buffer) {
  if (buffer.length < 4) {
    throw new Error(`frame too short (${buffer.length} bytes)`);
  }
  const length = buffer.readInt32BE(0);
  const end = 4 + length;
  if (buffer.length < end) {
    throw new Error(`incomplete frame: need ${end} bytes, got ${buffer.length}`);
  }
  return {
    length,
    body: buffer.subarray(4, end),
    frame: buffer.subarray(0, end),
  };
}

const requestByTemplateId = new Map();
const responseByTemplateId = new Map();

export class Packet {
  static MESSAGE_NAME = null;
  static TEMPLATE_ID = null;
  /** @type {typeof Packet | null} */
  static Response = null;

  /**
   * @param {number[]} [extraTemplateIds] Additional wire template_id values for the same message shape.
   */
  static register(extraTemplateIds = []) {
    if (this.TEMPLATE_ID == null || !this.MESSAGE_NAME) return;
    const map = this.MESSAGE_NAME.startsWith("Request")
      ? requestByTemplateId
      : responseByTemplateId;
    for (const id of [this.TEMPLATE_ID, ...extraTemplateIds]) {
      map.set(id, this);
    }
  }

  static getRequestClass(templateId) {
    return requestByTemplateId.get(templateId) ?? null;
  }

  static getResponseClass(templateId) {
    return responseByTemplateId.get(templateId) ?? null;
  }

  static getRequestClasses() {
    return [...requestByTemplateId.values()];
  }

  static getResponseClasses() {
    return [...responseByTemplateId.values()];
  }

  static decodeBody(buffer) {
    const templateId = peekTemplateId(buffer);
    const Cls =
      responseByTemplateId.get(templateId) ?? requestByTemplateId.get(templateId);
    if (!Cls) {
      throw new Error(`No packet class for template_id ${templateId}`);
    }
    return Cls.decode(buffer);
  }

  static decodeFrame(frameBuffer) {
    const { body } = parseFrame(frameBuffer);
    return this.decodeBody(body);
  }

  /** @param {Record<string, unknown>} obj */
  static fromObject(obj) {
    const packet = new this();
    packet.applyObject(obj);
    return packet;
  }

  /** @param {Record<string, unknown>} obj */
  applyObject(obj) {
    const plain = toPlain(obj);
    for (const [key, value] of Object.entries(plain)) {
      this[key] = value;
    }
  }

  toObject() {
    const out = {};
    for (const key of Object.keys(this)) {
      if (typeof this[key] !== "function") {
        out[key] = this[key];
      }
    }
    return out;
  }

  encode() {
    return getLoader().encode(this.constructor.MESSAGE_NAME, this.toObject());
  }

  toFrame() {
    return frameMessage(this.encode());
  }

  static decode(buffer) {
    const message = getLoader().decode(this.MESSAGE_NAME, buffer);
    return this.fromObject(message);
  }
}
