'use strict';
/* Hardware-bypass bridge (ADR-0042 §2.3): a process holding its own DID that receives bytes off a
   constrained carrier (see lib/carriers/loopback_carrier.js for the in-process stand-in this
   ships with, or a real serial/LoRa carrier built to the same Carrier contract) and writes them
   into a real MOYE room via the ordinary SDK call. The board on the far end of the constrained
   link never needs its own DID or a full Node -- this process IS "the local bridge" ADR-0042
   describes; the board just needs to get bytes to it.

   This is deliberately the entire bridge: no second inbox, no cursor, no store-and-forward layer.
   Delivery ends at sendRoomMessage(), same as any other agent's. */

function makeCarrierRoomBridge({ agent, roomId }) {
  if (!agent || !agent.did) throw new Error('bridge requires a registered Agent (DID)');
  if (!roomId) throw new Error('bridge requires a roomId');
  return async function onDeliver(bytes) {
    const content = Buffer.from(bytes).toString('utf8');
    return agent.sendRoomMessage(roomId, content);
  };
}

module.exports = { makeCarrierRoomBridge };
