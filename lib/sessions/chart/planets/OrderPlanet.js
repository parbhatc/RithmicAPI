import { ClientPlanet } from "./ClientPlanet.js";

export class OrderPlanet extends ClientPlanet {
  constructor(session) {
    super(session, "Order", () => session.orderClient);
  }
}
