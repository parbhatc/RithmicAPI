export class LivePlanet {
  #session;

  constructor(session) {
    this.#session = session;
  }

  start(options = {}) {
    return this.#session.liveFeed.start(this.#session, this.#session.ctx(), options);
  }

  stop() {
    return this.#session.liveFeed.stop(this.#session, this.#session.ctx());
  }

  get active() {
    return this.#session.liveFeed.live;
  }
}
