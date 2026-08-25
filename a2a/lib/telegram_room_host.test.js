'use strict';
const { textForTelegram } = require('../lib/telegram_room_host');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(textForTelegram({ decrypted: 'hi', encrypted: true, content: 'cipher' }) === 'hi', 'prefer decrypted');
assert(textForTelegram({ encrypted: true, content: 'cipher' }) === '', 'omit ciphertext');
assert(textForTelegram({ encrypted: false, content: 'plain' }) === 'plain', 'plaintext ok');
assert(textForTelegram(null) === '', 'null');

console.log('ALL_OK telegram_room_host textForTelegram');
