/**
 * Write a minimal asar archive — the format Electron's own packer produces.
 *
 * The header is a DOUBLED pickle, and that doubling is the whole reason this
 * module exists: an archive is
 *
 *   [u32 4] [u32 H] [u32 P] [u32 J] [JSON of J bytes] [file contents…]
 *
 * where H is the header pickle's own length, P its payload length and J the JSON
 * byte length — so the JSON starts at offset 16 and the contents at `8 + H`. The
 * parser in `lib/desktop.js` guessed 8 and reported every real archive
 * unreadable (fixed 2026-10-15), which is why the tests build archives here
 * rather than shelling out to `@electron/asar`: the fixture states the format the
 * code depends on, and a regression shows up as a failing assertion instead of a
 * missing dependency.
 *
 * Entries are uncompressed, so a caller can also prove that a SAME-SIZE edit
 * inside an archive is caught: the bytes at `offset` are the file's bytes, and
 * `hashOfRange` reads exactly those.
 */

import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'

/**
 * A 4-byte little-endian length.
 * @param {number} value - the number.
 * @returns {Buffer} its bytes.
 */
function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

/**
 * Write an asar archive holding `entries`.
 * @param {string} file - where to write it.
 * @param {Array<{path: string, content: string | Buffer}>} entries - the files, in payload order.
 * @returns {string} the file written.
 */
export function writeAsar(file, entries) {
  const tree = { files: {} }
  const blobs = []
  let offset = 0
  for (const { path, content } of entries) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const parts = path.split('/')
    let node = tree
    for (const dir of parts.slice(0, -1)) {
      if (node.files[dir] === undefined) node.files[dir] = { files: {} }
      node = node.files[dir]
    }
    node.files[parts[parts.length - 1]] = { size: bytes.length, offset: String(offset) }
    blobs.push(bytes)
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  const header = Buffer.concat([u32(4 + json.length), u32(json.length), json])
  const sizes = Buffer.concat([u32(4), u32(header.length)])
  writeFileSync(file, Buffer.concat([sizes, header, ...blobs]))
  return file
}
