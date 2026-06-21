import WebSocket from "ws";
import { Packet, parseFrame } from "../../protocol/Packet.js";
import { toPlain } from "../util.js";

export const MOBILE_URI = "wss://rprotocol-mobile.rithmic.com/";

const CONNECT_RETRYABLE = /timed out|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i;

export class Client {
  constructor({
    uri = MOBILE_URI,
    label = "Rithmic",
    timeoutMs = 30_000,
    connectRetries = 3,
    log = false,
  } = {}) {
    this.uri = uri;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.connectRetries = connectRetries;
    this.log = log;
    this.ws = null;
  }

  #recvQueue = [];
  #recvWaiters = [];
  #pendingPackets = [];

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const attempts = Math.max(1, this.connectRetries);
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        this.ws = await this.#openSocket();
        break;
      } catch (err) {
        lastErr = err;
        const retryable =
          attempt < attempts && CONNECT_RETRYABLE.test(String(err?.message ?? err));
        if (!retryable) throw err;
        if (this.log) {
          console.log(
            `[${this.label}] connect attempt ${attempt}/${attempts} failed: ${err.message}`,
          );
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!this.ws) throw lastErr;

    this.ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = Buffer.from(data);
      if (this.#recvWaiters.length) this.#recvWaiters.shift()(frame);
      else this.#recvQueue.push(frame);
    });

    if (this.log) console.log(`[${this.label}] connected`);
  }

  #openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.uri, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`${this.label}: connect timed out (${this.uri})`));
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
    if (this.#pendingPackets.length) {
      const packet = this.#pendingPackets.shift();
      if (this.log) this.#log("recv", packet);
      return packet;
    }
    return this.#receiveFromWire();
  }

  async exchange(request, { maxPush = 100 } = {}) {
    this.send(request);
    const Expected = request.constructor.Response;
    let pushed = 0;

    while (true) {
      const response = await this.#receiveFromWire();
      if (!Expected || response instanceof Expected) {
        return response;
      }
      this.#pendingPackets.push(response);
      pushed += 1;
      if (pushed >= maxPush) {
        throw new Error(
          `expected ${Expected.MESSAGE_NAME}, got ${maxPush} push messages first (last: ${response.constructor.MESSAGE_NAME})`,
        );
      }
    }
  }

  sendAll(packets) {
    for (const packet of packets) this.send(packet);
  }

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
    this.#pendingPackets = [];
  }

  async #receiveFromWire() {
    const raw = await this.#readFrame();
    const packet = Packet.decodeFrame(raw);
    if (this.log) this.#log("recv", packet, parseFrame(raw).frame);
    return packet;
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
    if ((dir === "send" || dir === "recv") && frame) {
      console.log(`  wire: ${frame.toString("base64")}`);
    }
  }
}
