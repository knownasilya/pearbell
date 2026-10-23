// Newline-delimited JSON over any byte stream (DHT connections and the
// Bare Kit IPC pipe). Works in Node and in Bare.
import b4a from 'b4a'

const NEWLINE = 10

export function writeJSON (stream, obj) {
  if (stream.destroyed) return false
  return stream.write(b4a.from(JSON.stringify(obj) + '\n'))
}

export function onJSON (stream, fn) {
  let pending = null

  stream.on('data', (chunk) => {
    let buf = pending ? b4a.concat([pending, chunk]) : chunk
    let i

    while ((i = buf.indexOf(NEWLINE)) !== -1) {
      const line = b4a.toString(buf.subarray(0, i))
      buf = buf.subarray(i + 1)
      if (!line.trim()) continue

      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      fn(msg)
    }

    pending = buf.byteLength ? buf : null
  })
}
