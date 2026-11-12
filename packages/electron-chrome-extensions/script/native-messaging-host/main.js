const fs = require('node:fs')

/*
  Reads one message the way a native messaging host must: a 4-byte little-endian BYTE length, then
  that many bytes of UTF-8 JSON. A single readSync may return fewer bytes than asked for once the
  message is larger than the pipe hands over at a time, so both reads loop until they have it all.
*/
function readExactly(length) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const read = fs.readSync(0, buffer, offset, length - offset, null)
    if (read === 0) process.exit(1)
    offset += read
  }
  return buffer
}

function readMessage() {
  const messageLength = readExactly(4).readUInt32LE(0)
  return JSON.parse(readExactly(messageLength).toString('utf8'))
}

// The prefix counts bytes, not characters: `json.length` is wrong as soon as the message carries a
// character outside ASCII, which is exactly what the multi-byte spec sends.
function sendMessage(message) {
  const json = JSON.stringify(message)
  const byteLength = Buffer.byteLength(json, 'utf8')
  const buffer = Buffer.alloc(4 + byteLength)
  buffer.writeUInt32LE(byteLength, 0)
  buffer.write(json, 4, 'utf8')

  fs.writeSync(1, buffer)
}

/*
  One message, one echo, then exit — what the round-trip specs need. A message carrying
  `__stayOpen` is echoed and the host keeps reading instead, like a real host (a password manager's
  desktop app) that never exits on its own: the lifecycle specs use it to see whether the library
  ends the process itself.
*/
let message = readMessage()
sendMessage(message)
while (message && typeof message === 'object' && message.__stayOpen) {
  message = readMessage()
  sendMessage(message)
}
