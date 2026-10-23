// Offline smoke test for dsh-cloudflare-media: no network, no DSH host.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const plugin = await import(pathToFileURL(path.resolve('lib/index.js')).href)

const tools = new Map()
const calls = []
const workspace = await mkdtemp(path.join(tmpdir(), 'cfmedia-'))

const ctx = {
  /** Host services are reached through `ctx.get(name)`; the mock keeps them as own fields. */
  get(name) {
    return ctx[name]
  },
  inject(_names, callback) {
    const scope = {
      configEditor: {
        configuration: () => [{
          entry: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
          inherited: {},
          override: {
            providers: {
              'cloudflare-workers-ai': {
                name: 'Cloudflare Workers AI',
                apiKeyEnv: 'CLOUDFLARE_WORKERS_AI_API_KEY',
                baseURL: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1',
                models: [{ id: '@cf/meta/llama-3.1-8b-instruct' }],
              },
            },
          },
        }],
      },
      systemPrompt: { context: (section) => { ctx.promptSection = section } },
    }
    const dispose = callback(scope)
    return typeof dispose === 'function' ? dispose : () => {}
  },
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
  attachments: {
    saveImage: async (input) => ({
      attachmentId: 'att_test_1',
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }),
  },
  credentials: {
    resolve: async (ref) => (ref === 'CLOUDFLARE_WORKERS_AI_API_KEY' ? { value: '  test-token  ' } : undefined),
  },
  logger: { warn() {}, info() {} },
}

plugin.apply(ctx, {})
assert.deepEqual([...tools.keys()].sort(), [
  'cloudflare_generate_image',
  'cloudflare_media_status',
  'cloudflare_speech_to_text',
  'cloudflare_text_to_speech',
].sort())

globalThis.fetch = async (url, init) => {
  const body = init.body === undefined
    ? undefined
    : typeof init.body === 'string'
      ? JSON.parse(init.body)
      : { kind: init.body?.constructor?.name ?? typeof init.body }
  calls.push({ url, body, headers: init.headers })
  const png = Buffer.from(PNG_1PX, 'base64')
  if (url.endsWith('/client/v4/accounts')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () => new Response(JSON.stringify({
        success: true,
        result: [{ id: 'feedfacefeedfacefeedfacefeedface', name: 'Demo Account' }],
      })).arrayBuffer(),
      json: async () => ({ success: true, result: [{ id: 'feedfacefeedfacefeedfacefeedface', name: 'Demo Account' }] }),
    }
  }
  if (url.endsWith('/ai/run/@cf/black-forest-labs/flux-1-schnell')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () => new Response(JSON.stringify({ result: { image: PNG_1PX } })).arrayBuffer(),
    }
  }
  if (url.includes('/ai/run/@cf/myshell-ai/melotts')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => new Response(Buffer.from('ID3fake-mp3-bytes')).arrayBuffer(),
    }
  }
  if (url.includes('/ai/run/@cf/openai/whisper-large-v3-turbo')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () => new Response(JSON.stringify({ result: { text: 'hello world', word_count: [1, 2] } })).arrayBuffer(),
    }
  }
  return {
    ok: false,
    status: 404,
    headers: new Headers({ 'content-type': 'application/json' }),
    arrayBuffer: async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'unexpected url' }] })).arrayBuffer(),
  }
}

const exec = { agent: { session: { header: { cwd: workspace } } }, signal: undefined }

const image = await tools.get('cloudflare_generate_image').execute(
  { prompt: 'a red cube', steps: 4 },
  exec,
)
assert.equal(image.model, '@cf/black-forest-labs/flux-1-schnell')
assert.equal(image.mediaType, 'image/png')
assert.equal(image.attachment.attachmentId, 'att_test_1')
assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/black-forest-labs/flux-1-schnell')
assert.equal(calls[0].headers.authorization, 'Bearer test-token')
assert.equal(calls[0].body.steps, 4)

const rendered = tools.get('cloudflare_generate_image').output.render({ prompt: 'x' }, image)
assert.equal(rendered[1].type, 'image')
assert.equal(rendered[1].attachment.attachmentId, 'att_test_1')

const speech = await tools.get('cloudflare_text_to_speech').execute({ text: 'hello', language: 'zh' }, exec)
assert.equal(speech.mediaType, 'audio/mpeg')
assert.equal(calls[1].body.prompt, 'hello')
assert.equal(calls[1].body.lang, 'zh')
const audioBytes = await readFile(speech.path)
assert.equal(audioBytes.toString(), 'ID3fake-mp3-bytes')

const stt = await tools.get('cloudflare_speech_to_text').execute({ path: speech.path }, exec)
assert.equal(stt.text, 'hello world')
assert.equal(stt.word_count, 2)

const status = await tools.get('cloudflare_media_status').execute({}, exec)
assert.match(status.text, /0123456789abcdef0123456789abcdef/)
assert.match(status.text, /已取到值/)
assert.equal(status.tokenPresent, true)

// Missing-token diagnostics stay actionable.
const noKeyCtx = {
  ...ctx,
  credentials: { resolve: async () => undefined },
  tools: { register: () => () => {} },
}
plugin.apply(noKeyCtx, {})

// Zero-config path: the live Cloudflare provider stores only apiKeyEnv + models,
// so the account id must come from token discovery.
const fresh = await import(`${pathToFileURL(path.resolve('lib/index.js')).href}?discovery`)
const discoveredTools = new Map()
const discoveryCtx = {
  ...ctx,
  replace: undefined,
  tools: { register: (definition) => { discoveredTools.set(definition.name, definition); return () => {} } },
  inject(_names, callback) {
    const scope = {
      configEditor: {
        configuration: () => [{
          entry: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
          override: {
            providers: {
              'cloudflare-workers-ai': {
                models: [{ id: '@cf/zai-org/glm-5.3-flash' }],
                apiKeyEnv: 'CLOUDFLARE_WORKERS_AI_API_KEY',
              },
            },
          },
        }],
      },
      systemPrompt: { context: () => {} },
    }
    const dispose = callback(scope)
    return typeof dispose === 'function' ? dispose : () => {}
  },
}
fresh.apply(discoveryCtx, {})
const discovered = await discoveredTools.get('cloudflare_media_status').execute({}, exec)
assert.equal(discovered.accountId, 'feedfacefeedfacefeedfacefeedface')
assert.equal(discovered.accountSource, 'auto-discovered')
assert.match(discovered.text, /自动发现/)

console.log('smoke ok')
console.log(JSON.stringify({
  tools: [...tools.keys()],
  imageEndpoints: calls.map((entry) => entry.url),
  promptSection: ctx.promptSection?.name,
}, null, 2))
