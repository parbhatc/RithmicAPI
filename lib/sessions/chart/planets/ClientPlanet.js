export class ClientPlanet {
  #session;
  #name;
  #getter;

  constructor(session, name, getter) {
    this.#session = session;
    this.#name = name;
    this.#getter = getter;
  }

  get client() {
    const c = this.#getter.call(this.#session);
    if (!c) {
      throw new Error(
        `${this.#name} plant is disabled. Pass plants: { ${this.#name.toLowerCase()}: true } to ChartSession.open()`,
      );
    }
    return c;
  }

  send(packet) {
    return this.client.send(packet);
  }

  exchange(packet, opts) {
    return this.client.exchange(packet, opts);
  }

  receive() {
    return this.client.receive();
  }

  drain(opts) {
    return this.client.drain(opts);
  }
}
