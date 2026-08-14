'use strict';
/* Loopback constrained carrier (ADR-0042 landing gate item 1): simulates a constrained pipe
   (think half-duplex serial/LoRa) entirely in-process, so the Carrier contract and the
   bytes-to-room delivery path can be verified without real hardware.

   A real serial/LoRa carrier implements the exact same `Carrier{class:'constrained', send}`
   contract, physically transmitting instead of queueing in memory -- see
   docs/adr/0042-reticulum-carrier-absorption.md, "hardware bypass topology", for how that plugs
   in without touching this router or the room API at all. */
const { Carrier } = require('../carrier');

// Artificial per-byte delay so this genuinely behaves like a slow, ordered, half-duplex pipe
// rather than a same-tick function call. That matters for the landing-gate test: "fast wins when
// available" has to be checked against a constrained path that would actually be slow if chosen,
// not one that just happens to also be instant.
function makeLoopbackCarrier({ name = 'loopback', bytesPerSecond = 500, onDeliver } = {}) {
  if (typeof onDeliver !== 'function') throw new Error('makeLoopbackCarrier requires onDeliver(bytes)');
  const queue = [];
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const { bytes, resolve, reject } = queue.shift();
      const delayMs = Math.max(1, Math.ceil((bytes.length / bytesPerSecond) * 1000));
      await new Promise((r) => setTimeout(r, delayMs));
      try { await onDeliver(bytes); resolve(); } catch (e) { reject(e); }
    }
    draining = false;
  }

  return new Carrier({
    name,
    class: 'constrained',
    send: (bytes) => new Promise((resolve, reject) => {
      queue.push({ bytes: Buffer.from(bytes), resolve, reject });
      drain();
    }),
  });
}

module.exports = { makeLoopbackCarrier };
