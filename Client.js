import WebSocket from "ws";
import { Packet, parseFrame } from "./protocol/Packet.js";
import { toPlain } from "./lib/util.js";

export const MOBILE_URI = "wss://rprotocol-mobile.rithmic.com/";

export class Client {
  constructor({ uri = MOBILE_URI, label = "Rithmic", timeoutMs = 15_000, log = false } = {}) {
    this.uri = uri;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.ws = null;
    this.#recvQueue = [];
    this.#recvWaiters = [];
  }

  #recvQueue = [];
  #recvWaiters = [];

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.uri, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`${this.label}: connect timed out`));
      }, this.timeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = Buffer.from(data);
      if (this.#recvWaiters.length) this.#recvWaiters.shift()(frame);
      else this.#recvQueue.push(frame);
    });

    if (this.log) console.log(`[${this.label}] connected`);
  }

  send(packet) {
    if (!(packet instanceof Packet)) {
      throw new Error("send() expects a Packet instance");
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.label}: not connected`);
    }

    const frame = packet.toFrame();
    if (this.log) this.#log("send", packet, frame);
    this.ws.send(frame);
    return packet;
  }

  async receive() {
    const raw = await this.#readFrame();
    const packet = Packet.decodeFrame(raw);
    if (this.log) this.#log("recv", packet, parseFrame(raw).frame);
    return packet;
  }

  async exchange(request) {
    this.send(request);
    const response = await this.receive();
    const Expected = request.constructor.Response;
    if (Expected && !(response instanceof Expected)) {
      throw new Error(`expected ${Expected.MESSAGE_NAME}, got ${response.constructor.MESSAGE_NAME}`);
    }
    return response;
  }

  sendAll(packets) {
    for (const packet of packets) this.send(packet);
  }

  /** Read until no message arrives for `idleMs` (max `max` packets). */
  async drain({ idleMs = 400, max = 30 } = {}) {
    const received = [];
    const savedTimeout = this.timeoutMs;
    this.timeoutMs = idleMs;

    try {
      while (received.length < max) {
        try {
          received.push(await this.receive());
        } catch {
          break;
        }
      }
    } finally {
      this.timeoutMs = savedTimeout;
    }
    return received;
  }

  close() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000);
    this.ws = null;
  }

  #readFrame() {
    return new Promise((resolve, reject) => {
      if (this.#recvQueue.length) {
        resolve(this.#recvQueue.shift());
        return;
      }

      const timer = setTimeout(() => {
        const i = this.#recvWaiters.indexOf(done);
        if (i >= 0) this.#recvWaiters.splice(i, 1);
        reject(new Error(`${this.label}: timed out waiting for response`));
      }, this.timeoutMs);

      const done = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.#recvWaiters.push(done);
    });
  }

  #log(dir, packet, frame) {
    console.log(`[${this.label}] ${dir} ${packet.constructor.MESSAGE_NAME}`);
    console.log(JSON.stringify(toPlain(packet.toObject()), null, 2));
    if (dir === "send" || dir === "recv") {
      console.log(`  wire: ${frame.toString("base64")}`);
    }
  }
}
