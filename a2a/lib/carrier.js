'use strict';
/* Carrier layer (ADR-0042): moves bytes toward "whichever side can write the room" when a process
   has no live fast path (HTTP federation, Yggdrasil overlay, or the libp2p relay from ADR-0041).
   This is NOT a second message system -- every carrier's job ends at the existing room API
   (Agent#sendRoomMessage / POST /api/rooms/:id/messages, private-room E2E included). `class:'fast'`
   carriers exist only as router entries so routing can prefer them; the actual fast paths (HTTP,
   Ygg, libp2p) are the existing SDK/server code and are untouched by this file.

   Used by processes that sit BETWEEN a constrained medium (serial/LoRa/packet radio) and MOYE --
   e.g. a bridge holding its own DID on behalf of a networkless board (ADR-0042 §2.3) -- not by
   the MOYE server itself, and not by ordinary online agents (they just call sendRoomMessage()
   directly; this module only matters once there's more than one way to get bytes out). */

class Carrier {
  constructor({ name, class: cls, send }) {
    if (!name) throw new Error('carrier requires a name');
    if (cls !== 'fast' && cls !== 'constrained') throw new Error("carrier class must be 'fast' or 'constrained'");
    if (typeof send !== 'function') throw new Error('carrier requires a send(bytes) function');
    this.name = name;
    this.class = cls;
    this._send = send;
  }
  async send(bytes) { return this._send(bytes); }
}

class CarrierRouter {
  constructor() {
    this._carriers = [];
  }
  register(carrier) {
    if (!(carrier instanceof Carrier)) throw new Error('register() requires a Carrier instance');
    if (this._carriers.some((c) => c.name === carrier.name)) throw new Error(`carrier '${carrier.name}' already registered`);
    this._carriers.push(carrier);
    return this;
  }
  hasFast() { return this._carriers.some((c) => c.class === 'fast'); }

  // Routing per ADR-0042 §2.2: a registered fast carrier always wins, UNLESS the caller explicitly
  // names a carrier (an operator forcing traffic over radio for a test, or a bridge process that
  // only ever has a constrained carrier configured to begin with).
  async send(bytes, { via = null } = {}) {
    let chosen;
    if (via) {
      chosen = this._carriers.find((c) => c.name === via);
      if (!chosen) throw new Error(`no registered carrier named '${via}'`);
    } else {
      chosen = this._carriers.find((c) => c.class === 'fast') || this._carriers.find((c) => c.class === 'constrained');
    }
    if (!chosen) throw new Error('no carrier registered');
    await chosen.send(bytes);
    return { via: chosen.class === 'fast' ? chosen.name : `constrained:${chosen.name}`, carrier: chosen.name, class: chosen.class };
  }
}

module.exports = { Carrier, CarrierRouter };
