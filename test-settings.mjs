/**
 * Offline checks for the settings store and the settings-page API.
 * Run with: node test-settings.mjs
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = await mkdtemp(path.join(tmpdir(), 'cfm-'))
process.env.DSH_HOME = home

const store = await import('./lib/settings-store.js')
const api = await import('./lib/http-api.js')

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('defaults apply when nothing is stored', async () => {
  const { values, sources } = await store.effectiveSettings({})
  assert.equal(values.imageModel, store.DEFAULT_IMAGE_MODEL)
  assert.equal(values.saveToWorkspace, true)
  assert.equal(sources.imageModel, 'default')
})

check('settings file wins over plugin config', async () => {
  await store.writeSettingsFile({ imageModel: '@cf/black-forest-labs/flux-2-dev', outputFolder: 'media/out' })
  const { values, sources } = await store.effectiveSettings({ imageModel: '@cf/stable-diffusion-xl', requestTimeoutMs: 9000 })
  assert.equal(values.imageModel, '@cf/black-forest-labs/flux-2-dev')
  assert.equal(sources.imageModel, 'settings-page')
  assert.equal(values.requestTimeoutMs, 9000)
  assert.equal(sources.requestTimeoutMs, 'plugin-config')
  const raw = JSON.parse(await readFile(store.settingsFilePath(), 'utf8'))
  assert.equal(raw.accountId, undefined)
})

check('validation rejects bad values', () => {
  const { values, errors } = store.validateSettings({
    imageModel: 'flux',
    outputFolder: '../escape',
    requestTimeoutMs: 10,
    baseURL: 'ftp://x',
    apiTokenEnv: 'bad name!',
  })
  assert.ok(errors.imageModel && errors.outputFolder && errors.requestTimeoutMs && errors.baseURL && errors.apiTokenEnv)
  assert.deepEqual(values, {})
})

check('validation accepts good values', () => {
  const { values, errors } = store.validateSettings({
    imageModel: '@cf/lykon/dreamshaper-8-lcm',
    speechModel: '@cf/deepgram/aura-1',
    transcriptionModel: '@cf/openai/whisper',
    outputFolder: 'media/out',
    saveToWorkspace: false,
    requestTimeoutMs: 60000,
    baseURL: 'https://example.com/client/v4/accounts/x/ai/v1/',
    apiTokenEnv: 'CLOUDFLARE_WORKERS_AI_API_KEY',
  })
  assert.deepEqual(errors, {})
  assert.equal(values.baseURL, 'https://example.com/client/v4/accounts/x/ai/v1')
  assert.equal(values.saveToWorkspace, false)
})

// A fake host: one web server, one credential store, one access resolver.
function fakeHost(overrides = {}) {
  const routes = new Map()
  const credentials = {
    store: new Map([['CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32)], ['CLOUDFLARE_WORKERS_AI_API_KEY', 'tok_123']]),
    async describe(name) { return { configured: this.store.has(name) } },
    async set(name, value) { this.store.set(name, value) },
    async unset(name) { this.store.delete(name) },
    async resolve(name) { return this.store.get(name) },
  }
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } : undefined),
  }
  const deps = {
    config: () => ({}),
    resolveAccess: async () => ({ accountId: credentials.store.get('CLOUDFLARE_ACCOUNT_ID'), accountSource: 'credential', token: 'tok_123', tokenEnv: 'CLOUDFLARE_WORKERS_AI_API_KEY' }),
    discoverAccounts: async () => ({ ids: [], names: [], status: 403, errors: ['denied'] }),
    credentials: () => credentials,
    settingsFilePath: () => store.settingsFilePath(),
    timeoutMs: async () => 5000,
    IMAGE_MODELS: [{ id: '@cf/x/y', label: 'Y', note: 'n' }],
    SPEECH_MODELS: [],
    TRANSCRIPTION_MODELS: [],
    catalogForClient: () => ({
      image: [{ id: '@cf/x/y', note: 'n', tier: 'cheap', tierLabel: '便宜', official: '4.8 neurons/512² tile + 9.6 neurons/step', estimate: '≈58 neurons/张，≈$0.0006', warn: '', unavailable: false }],
      speech: [],
      transcription: [],
    }),
    FREE_NEURONS_PER_DAY: 10000,
    ...overrides,
  }
  return { ctx, deps, routes, credentials }
}

/** Minimal Node-style request: a readable stream with method/headers. */
class FakeReq extends Readable {
  constructor({ method = 'GET', headers = {}, body } = {}) {
    super()
    this.method = method
    this.headers = headers
    this.url = '/'
    if (body !== undefined) this.push(Buffer.from(body))
    this.push(null)
  }
}

/** Minimal Node-style response capturing status, headers and payload. */
class FakeRes {
  constructor() {
    this.status = 0
    this.headers = {}
    this.payload = undefined
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = headers ?? {}
    return this
  }
  end(payload) {
    this.payload = typeof payload === 'string' ? payload : payload?.toString?.()
    return this
  }
}

const call = async (routes, pathName, init = {}) => {
  const route = routes.get(pathName)
  assert.ok(route, `route ${pathName} registered`)
  const req = new FakeReq(init)
  const res = new FakeRes()
  await route.handler(req, res)
  return { status: res.status, body: JSON.parse(res.payload ?? '{}') }
}

check('GET settings masks the account id and exposes the catalogue', async () => {
  const { ctx, deps, routes } = fakeHost()
  api.registerWebApi(ctx, deps)
  const { status, body } = await call(routes, '/cloudflare-media/api/settings')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.match(body.account.masked, /a{4}$/)
  assert.ok(!JSON.stringify(body).includes(credentialsValue(deps)))
  assert.equal(body.catalog.image[0].id, '@cf/x/y')
  assert.equal(body.capabilities.writable, true)
})

check('PUT settings requires the plugin header and validates', async () => {
  const { ctx, deps, routes } = fakeHost()
  api.registerWebApi(ctx, deps)
  const denied = await call(routes, '/cloudflare-media/api/settings', { method: 'PUT', body: JSON.stringify({ values: { imageModel: '@cf/a/b' } }) })
  assert.equal(denied.status, 403)
  const invalid = await call(routes, '/cloudflare-media/api/settings', {
    method: 'PUT',
    headers: { 'x-dsh-cloudflare-media': '1' },
    body: JSON.stringify({ values: { imageModel: 'nope' } }),
  })
  assert.equal(invalid.status, 400)
  assert.ok(invalid.body.errors.imageModel)
  const ok = await call(routes, '/cloudflare-media/api/settings', {
    method: 'PUT',
    headers: { 'x-dsh-cloudflare-media': '1' },
    body: JSON.stringify({ values: { imageModel: '@cf/a/b' } }),
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.values.imageModel, '@cf/a/b')
})

check('POST credentials writes and clears both secrets', async () => {
  const { ctx, deps, routes, credentials } = fakeHost()
  api.registerWebApi(ctx, deps)
  const bad = await call(routes, '/cloudflare-media/api/credentials', {
    method: 'POST',
    headers: { 'x-dsh-cloudflare-media': '1' },
    body: JSON.stringify({ accountId: 'short' }),
  })
  assert.equal(bad.status, 400)
  const saved = await call(routes, '/cloudflare-media/api/credentials', {
    method: 'POST',
    headers: { 'x-dsh-cloudflare-media': '1' },
    body: JSON.stringify({ accountId: 'b'.repeat(32), apiToken: 'fresh' }),
  })
  assert.equal(saved.status, 200)
  assert.equal(credentials.store.get('CLOUDFLARE_ACCOUNT_ID'), 'b'.repeat(32))
  assert.equal(credentials.store.get('CLOUDFLARE_WORKERS_AI_API_KEY'), 'fresh')
  const cleared = await call(routes, '/cloudflare-media/api/credentials', {
    method: 'POST',
    headers: { 'x-dsh-cloudflare-media': '1' },
    body: JSON.stringify({ apiToken: '' }),
  })
  assert.equal(cleared.status, 200)
  assert.equal(credentials.store.has('CLOUDFLARE_WORKERS_AI_API_KEY'), false)
})

function credentialsValue() {
  return 'tok_123'
}

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`)
  }
}
await rm(home, { recursive: true, force: true })
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
