// Minimal ASAR reader for inspection: list entries and grep file contents.
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const asarPath = process.argv[2]
const mode = process.argv[3] // 'list' | 'grep'
const arg = process.argv[4]

const fd = openSync(asarPath, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const jsonLength = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLength)
readSync(fd, jsonBuf, 0, jsonLength, 16)
const tree = JSON.parse(jsonBuf.toString('utf8'))
const dataStart = 8 + headerSize

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const full = `${prefix}/${name}`
    if (child.files) walk(child, full, out)
    else out.push({ path: full, size: child.size, offset: Number(child.offset) })
  }
  return out
}

const entries = walk(tree, '', [])

if (mode === 'list') {
  for (const entry of entries) {
    if (entry.path.includes(arg)) console.log(`${entry.size}\t${entry.path}`)
  }
} else if (mode === 'cat') {
  const match = entries.find((entry) => entry.path === arg)
  if (!match) throw new Error(`not found: ${arg}`)
  const buf = Buffer.alloc(match.size)
  readSync(fd, buf, 0, match.size, dataStart + match.offset)
  process.stdout.write(buf.toString('utf8'))
} else if (mode === 'grep') {
  const [pattern, maxHits] = arg.split('|')
  const re = new RegExp(pattern, 'i')
  let hits = 0
  for (const entry of entries) {
    if (!/\.(js|mjs|cjs|json|ts)$/.test(entry.path)) continue
    if (!Number.isFinite(entry.offset) || !Number.isFinite(entry.size) || entry.size <= 0) continue
    const buf = Buffer.alloc(entry.size)
    if (entry.size > 0) readSync(fd, buf, 0, entry.size, dataStart + entry.offset)
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits < Number(maxHits || 40); i += 1) {
      if (re.test(lines[i])) {
        hits += 1
        console.log(`${entry.path}:${i + 1}: ${lines[i].slice(0, 700)}`)
      }
    }
    if (hits >= Number(maxHits || 40)) break
  }
}
closeSync(fd)
console.error(`entries=${entries.length} header=${headerSize}`)
