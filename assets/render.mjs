#!/usr/bin/env node
/**
 * Deterministic screenshot helper for the brand assets.
 *
 * `msedge --screenshot` sizes the viewport in *device* pixels while CSS uses
 * *layout* pixels, so on a 125%/150% Windows display it silently crops the
 * right and bottom edges. This drives Chrome DevTools Protocol instead:
 * Emulation.setDeviceMetricsOverride fixes the layout viewport, and
 * Page.captureScreenshot clips to exactly that box at the requested scale.
 *
 * Usage:
 *   node assets/render.mjs <file.html> <out.png> <width> <height> [scale=2]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const [input, output, widthArg, heightArg, scaleArg] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: node assets/render.mjs <file.html> <out.png> <width> <height> [scale]')
  process.exit(2)
}
const width = Number(widthArg ?? 1600)
const height = Number(heightArg ?? 900)
const scale = Number(scaleArg ?? 2)
const port = 9300 + Math.floor(Math.random() * 500)
const profile = await mkdtemp(join(tmpdir(), 'cfm-render-'))

const browser = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitForDevtools() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error('devtools endpoint never came up')
}

/** Minimal CDP client over the target's websocket. */
function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  const events = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
      return
    }
    events.push(message)
  })
  const ready = new Promise((done, fail) => {
    socket.addEventListener('open', () => done())
    socket.addEventListener('error', () => fail(new Error('websocket error')))
  })
  return {
    ready,
    events,
    send(method, params = {}) {
      const id = nextId++
      return new Promise((done, fail) => {
        pending.set(id, { resolve: done, reject: fail })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { socket.close() },
  }
}

try {
  await waitForDevtools()
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const client = connect(target.webSocketDebuggerUrl)
  await client.ready
  await client.send('Page.enable')
  await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale, mobile: false,
  })
  const url = pathToFileURL(resolve(input)).href
  await client.send('Page.navigate', { url })
  // Wait for the load event, then one more frame so fonts and images settle.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (client.events.some((event) => event.method === 'Page.loadEventFired')) break
    await sleep(50)
  }
  await client.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)' })
  await sleep(250)
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  })
  await writeFile(output, Buffer.from(shot.data, 'base64'))
  client.close()
  console.log(`rendered ${output} ${width}x${height} @${scale}x`)
} finally {
  browser.kill()
  await sleep(300)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
