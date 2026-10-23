/**
 * dsh-cloudflare-media — Cloudflare Workers AI multimedia tools for DeepSeek Harness.
 *
 * Workers AI exposes text-to-image, text-to-speech and speech-to-text models on
 * the free plan, but their REST contract (`/accounts/<id>/ai/run/<model>` with
 * model-specific JSON bodies) is unlike an OpenAI-style chat provider, so the
 * Harness text provider cannot reach them. This plugin adds the missing tools
 * and reuses the Cloudflare Workers AI credentials/provider settings the user
 * already configured for text models.
 *
 * @module dsh-cloudflare-media
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ACCOUNT_ID_CREDENTIAL,
  effectiveSettings,
  maskAccountId,
  settingsFilePath,
} from './settings-store.js'
import { registerWebApi } from './http-api.js'

export const name = 'dsh-cloudflare-media'
export const inject = ['tools', 'attachments', 'credentials']

const API_ORIGIN = 'https://api.cloudflare.com'
const DEFAULT_API_KEY_ENV = 'CLOUDFLARE_WORKERS_AI_API_KEY'

/** Human labels for how the account id was found (shown by the status tool). */
const ACCOUNT_SOURCE_LABEL = {
  configured: '插件设置/provider 配置',
  credential: '提供商凭据记录（CLOUDFLARE_ACCOUNT_ID）',
  'credential-ref': '凭据库中的 CLOUDFLARE_ACCOUNT_ID',
  'auto-discovered': '用 Token 自动发现',
  unresolved: '未解析',
}
const DEFAULT_OUTPUT_FOLDER = 'cloudflare-media'
/** Whisper rejects audio above 25 MB, so fail fast with the same limit. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

// Model catalogue and pricing live in ./catalog.js — the single file to edit
// when Cloudflare changes its line-up or neuron rates.
import {
  CAPABILITIES,
  DEFAULTS,
  FREE_NEURONS_PER_DAY,
  MODEL_CATALOG,
  PRICING,
  TIERS,
  TIER_LABELS,
  catalogForClient,
  estimateCall,
  estimateText,
  fileNameFor,
  modelSlug,
  officialPriceText,
  validateCatalog,
  withPricing,
} from './catalog.js'

export {
  CAPABILITIES,
  DEFAULTS,
  FREE_NEURONS_PER_DAY,
  MODEL_CATALOG,
  PRICING,
  TIERS,
  TIER_LABELS,
  catalogForClient,
  estimateCall,
  estimateText,
  modelSlug,
  officialPriceText,
  validateCatalog,
  withPricing,
}
export const IMAGE_MODELS = MODEL_CATALOG.image
export const SPEECH_MODELS = MODEL_CATALOG.speech
export const TRANSCRIPTION_MODELS = MODEL_CATALOG.transcription

const DEFAULT_IMAGE_MODEL = DEFAULTS.image
const DEFAULT_SPEECH_MODEL = DEFAULTS.speech
const DEFAULT_TRANSCRIPTION_MODEL = DEFAULTS.transcription

// ---------------------------------------------------------------------------
// Tool definition helpers
// ---------------------------------------------------------------------------

/**
 * Local fallback for `@deepseek-ai/dsh-tools#defineTool`, used only when the
 * core package is not importable from this plugin. It accepts the same author
 * spec shape (`required: true` per property) and emits raw JSON Schema.
 */
function fallbackDefineTool(options) {
  const compile = (node) => {
    const out = {}
    if (node.type !== undefined) out.type = node.type
    if (node.description !== undefined) out.description = node.description
    if (node.enum !== undefined) out.enum = [...node.enum]
    if (node.type === 'array') out.items = compile(node.items ?? { type: 'string' })
    if (node.type === 'object') {
      const properties = node.properties ?? {}
      out.properties = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, compile(value)]),
      )
      const required = Object.entries(properties).filter(([, value]) => value.required === true).map(([key]) => key)
      if (required.length > 0) out.required = required
      out.additionalProperties = node.additionalProperties ?? true
    }
    return out
  }
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters ?? {})) {
    const { required: isRequired, ...rest } = spec
    properties[key] = compile(rest)
    if (isRequired === true) required.push(key)
  }
  const parameters = { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: compile(options.output?.schema ?? { type: 'object', additionalProperties: true }),
      render: (args, value) => options.output?.render?.(args, value) ?? [],
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      for (const key of required) {
        if (args?.[key] === undefined || args?.[key] === null) {
          throw new Error(`invalid arguments: ${key} is required`)
        }
      }
      return options.execute(args, exec)
    },
  }
}

let defineTool = fallbackDefineTool
try {
  const core = await import('@deepseek-ai/dsh-tools')
  if (typeof core.defineTool === 'function') defineTool = core.defineTool
} catch {
  // The bundled fallback keeps the plugin working on hosts that do not expose
  // the core package to plugins.
}

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

let Schema = null
try {
  const mod = await import('schemastery').catch(() => import('@deepseek-ai/schemastery'))
  Schema = mod.default ?? mod.z ?? mod.Schema ?? null
} catch {
  Schema = null
}

/** Deployment-level defaults; the settings page writes a separate file that wins. */
export const Config = Schema === null ? undefined : Schema.object({
  accountId: Schema.string()
    .description('（可选，部署级）Cloudflare Account ID。日常使用请在插件设置页填写，页面会存进 DSH 凭据库，不会出现在这里。')
    .default(''),
  apiTokenEnv: Schema.string()
    .description('（可选）保存 API Token 的凭据名。留空时沿用 Workers AI 提供商的 apiKeyEnv，默认 CLOUDFLARE_WORKERS_AI_API_KEY。')
    .default(''),
  imageModel: Schema.string()
    .description('默认文生图模型。留空时使用插件设置页（或 @cf/black-forest-labs/flux-1-schnell）。')
    .default(''),
  speechModel: Schema.string()
    .description('默认语音合成模型。留空时使用插件设置页（或 @cf/myshell-ai/melotts）。')
    .default(''),
  transcriptionModel: Schema.string()
    .description('默认语音转写模型。留空时使用插件设置页（或 @cf/openai/whisper-large-v3-turbo）。')
    .default(''),
  outputFolder: Schema.string()
    .description('（可选）在当前工作目录下保存图片和音频的子目录。')
    .default(''),
  saveToWorkspace: Schema.boolean()
    .description('（可选）是否把生成的媒体另存到工作目录。')
    .default(true),
  requestTimeoutMs: Schema.number()
    .description('（可选）单次 Workers AI 请求的超时时间（毫秒）。')
    .default(120000),
  baseURL: Schema.string()
    .description('（可选）Workers AI 基础地址覆盖，一般无需修改。')
    .default(''),
})

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Read a plain object out of a Schemastery-backed config proxy. */
function plainConfig(source) {
  const out = {}
  if (source === null || typeof source !== 'object') return out
  for (const [key, value] of Object.entries(source)) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function accountFromBaseURL(baseURL) {
  if (typeof baseURL !== 'string') return undefined
  const match = baseURL.match(/\/accounts\/([A-Za-z0-9_-]{8,})/)
  return match === null ? undefined : match[1]
}

function base64ToBytes(value) {
  const clean = String(value).replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '')
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

/**
 * Bytes win over headers: some Workers AI image models advertise `image/png`
 * while actually returning JPEG, and the attachment service validates the
 * declared type against the real magic bytes.
 */
function sniffImageType(bytes, contentType) {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 11 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  const declared = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (declared.startsWith('image/')) return declared
  return 'image/png'
}

/** True when the bytes carry a recognisable audio container signature. */
function looksLikeAudio(bytes) {
  if (bytes.length > 11 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41) return true
  if (bytes.length > 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true
  if (bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true
  if (bytes.length > 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return true
  if (bytes.length > 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return true
  return false
}

function sniffAudioType(bytes, contentType) {
  if (bytes.length > 11 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41) return 'audio/wav'
  if (bytes.length > 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg'
  if (bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (bytes.length > 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'audio/ogg'
  if (bytes.length > 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return 'audio/flac'
  const declared = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (declared.startsWith('audio/')) return declared
  return 'audio/mpeg'
}

function extensionOf(mediaType) {
  const value = (mediaType ?? '').toLowerCase()
  if (value.includes('jpeg')) return 'jpg'
  if (value.includes('webp')) return 'webp'
  if (value.includes('wav')) return 'wav'
  if (value.includes('ogg')) return 'ogg'
  if (value.includes('flac')) return 'flac'
  if (value.includes('mpeg')) return 'mp3'
  return 'png'
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function workspaceRootOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

function resolveUserPath(exec, input) {
  if (typeof input !== 'string' || input.trim().length === 0) throw new Error('path is required')
  const root = workspaceRootOf(exec)
  const candidate = input.trim()
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
}

/** Save generated bytes under the configured workspace folder (or tmp). */
async function persistBytes(config, exec, bytes, mediaType, prefix, model) {
  const folder = firstNonEmpty(config.outputFolder, DEFAULT_OUTPUT_FOLDER)
    .replace(/^[\\/]+/, '')
    .replace(/\.\./g, '')
  const slug = typeof model === 'string' && model !== '' ? `-${modelSlug(model)}` : ''
  const fileName = `${prefix}${slug}-${stamp()}-${randomUUID().slice(0, 6)}.${extensionOf(mediaType)}`
  const saveEnabled = config.saveToWorkspace !== false
  const directory = saveEnabled
    ? path.join(workspaceRootOf(exec), folder)
    : path.join(tmpdir(), 'dsh-cloudflare-media')
  await mkdir(directory, { recursive: true })
  const filePath = path.join(directory, fileName)
  await writeFile(filePath, bytes)
  return {
    filePath,
    relativePath: saveEnabled ? path.join(folder, fileName).split(path.sep).join('/') : filePath,
    savedToWorkspace: saveEnabled,
  }
}

// ---------------------------------------------------------------------------
// Cloudflare provider discovery (reuse the text provider's settings)
// ---------------------------------------------------------------------------

/**
 * Find the Cloudflare provider block inside the live `llm-pi-ai` Plugin Config
 * (or any other plugin entry that carries a `providers` map), so the media
 * tools can reuse the same account and credential as the text models.
 */
function findCloudflareProvider(entries) {
  if (!Array.isArray(entries)) return undefined
  const seen = new Set()
  const visit = (value, depth) => {
    if (value === null || typeof value !== 'object' || depth > 4 || seen.has(value)) return undefined
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = visit(item, depth + 1)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    const providers = value.providers
    if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
      for (const [id, provider] of Object.entries(providers)) {
        if (provider === null || typeof provider !== 'object') continue
        const haystack = `${id} ${provider.name ?? ''} ${provider.label ?? ''} ${provider.baseURL ?? provider.baseUrl ?? ''}`.toLowerCase()
        if (haystack.includes('cloudflare') || haystack.includes('workers-ai') || haystack.includes('@cf/')) {
          return provider
        }
      }
    }
    for (const key of ['config', 'entry', 'inherited', 'override', 'settings', 'value']) {
      if (Object.hasOwn(value, key)) {
        const hit = visit(value[key], depth + 1)
        if (hit !== undefined) return hit
      }
    }
    return undefined
  }
  return visit(entries, 0)
}

let accountDiscovery

/**
 * Ask Cloudflare which accounts the token can reach. The Workers AI provider
 * block in `llm-pi-ai` often stores only `apiKeyEnv` + `models` (the account id
 * is resolved inside pi-ai), so discovery keeps the media tools zero-config.
 */
async function discoverAccounts(token) {
  if (accountDiscovery !== undefined) return accountDiscovery
  const pending = (async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/client/v4/accounts`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
      const payload = await response.json().catch(() => undefined)
      const entries = Array.isArray(payload?.result) ? payload.result : []
      const usable = entries.filter((entry) => typeof entry?.id === 'string' && entry.id.length >= 8)
      const errors = Array.isArray(payload?.errors) ? payload.errors.map((entry) => entry?.message ?? '').filter(Boolean) : []
      return {
        ids: usable.map((entry) => entry.id),
        names: usable.map((entry) => entry.name ?? entry.id),
        status: response.status,
        errors,
      }
    } catch (error) {
      return { ids: [], names: [], status: 0, errors: [error instanceof Error ? error.message : String(error)] }
    }
  })()
  const result = await pending
  if (result.ids.length > 0) accountDiscovery = result
  return result
}

/** Fetch an optional service without throwing in an inactive scope. */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the account id out of a stored provider credential.
 *
 * `llm-pi-ai`'s Cloudflare login flow prompts for the account id and keeps it in
 * the credential record's `env` map (`{ type: 'api_key', key, env: { CLOUDFLARE_ACCOUNT_ID } }`),
 * so the media tools can reuse exactly what the text provider already stores
 * instead of asking the user to paste the same id twice.
 */
/**
 * Cached lookup: walking every credential record on each media call is wasteful,
 * and the account id changes only when the user edits the provider config.
 */
let accountRecordCache = { at: 0, value: undefined }
const ACCOUNT_RECORD_TTL_MS = 15_000

async function accountFromCredentialRecords(credentials) {
  const now = Date.now()
  if (accountRecordCache.value !== undefined && now - accountRecordCache.at < ACCOUNT_RECORD_TTL_MS) {
    return accountRecordCache.value
  }
  try {
    const list = await credentials?.listRecords?.()
    if (!Array.isArray(list)) return undefined
    for (const entry of list) {
      const record = await credentials.readRecord(entry.key)
      const env = record?.env
      if (env === null || typeof env !== 'object') continue
      const value = firstNonEmpty(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID)
      if (value !== undefined) {
        accountRecordCache = { at: now, value }
        return value
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Summarize stored credential records for the status tool (addresses only, never values). */
async function describeCredentialRecords(credentials) {
  try {
    const list = await credentials?.listRecords?.()
    if (!Array.isArray(list)) return { available: false, count: 0, cloudflare: [], accountIdFound: false }
    const cloudflare = []
    let accountIdFound = false
    for (const entry of list) {
      const key = String(entry.key)
      if (/cloudflare/i.test(key)) cloudflare.push(key)
      const record = await credentials.readRecord(entry.key)
      const env = record?.env
      if (env !== null && typeof env === 'object' && typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' && env.CLOUDFLARE_ACCOUNT_ID.length > 0) {
        accountIdFound = true
      }
    }
    return { available: true, count: list.length, cloudflare, accountIdFound, refs: await describeAccountRefs(credentials) }
  } catch (error) {
    return { available: false, count: 0, cloudflare: [], accountIdFound: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Presence of the conventional account-id credential references (no values). */
async function describeAccountRefs(credentials) {
  const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKERS_AI_ACCOUNT_ID']
  const out = []
  for (const name of names) {
    try {
      const info = await credentials?.describe?.(name)
      out.push(`${name}:${info?.configured === true ? '有值' : '无值'}`)
    } catch {
      out.push(`${name}:查询失败`)
    }
  }
  return out
}

/**
 * Resolve the account id from the credential store under the conventional
 * environment-variable names (this is how `llm-pi-ai` feeds
 * `{CLOUDFLARE_ACCOUNT_ID}` into the provider baseURL).
 */
async function accountFromCredentialRefs(credentials) {
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKERS_AI_ACCOUNT_ID']) {
    try {
      const resolved = await credentials?.resolve?.(name)
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    } catch {
      continue
    }
  }
  return undefined
}

/** Resolve account id, credential name and token for one tool call. */
async function resolveAccess(ctx, config, getEditor) {
  const credentials = optionalService(ctx, 'credentials')
  let provider
  try {
    const editor = getEditor()
    if (editor !== undefined && typeof editor.configuration === 'function') {
      provider = findCloudflareProvider(editor.configuration())
    }
  } catch {
    provider = undefined
  }

  const providerBaseURL = firstNonEmpty(provider?.baseURL, provider?.baseUrl, provider?.base_url)
  let accountId = firstNonEmpty(
    config.accountId,
    provider?.accountId,
    provider?.account_id,
    accountFromBaseURL(providerBaseURL),
    process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID,
  )
  let accountSource = accountId === undefined ? 'unresolved' : 'configured'
  if (accountId === undefined) {
    accountId = await accountFromCredentialRecords(credentials)
    if (accountId !== undefined) accountSource = 'credential'
  }
  if (accountId === undefined) {
    accountId = await accountFromCredentialRefs(credentials)
    if (accountId !== undefined) accountSource = 'credential-ref'
  }
  const tokenEnv = firstNonEmpty(config.apiTokenEnv, provider?.apiKeyEnv, provider?.apiKeyEnvVar, DEFAULT_API_KEY_ENV)
  let token
  if (tokenEnv !== undefined) {
    try {
      const resolved = await credentials?.resolve?.(tokenEnv)
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      if (typeof value === 'string' && value.trim().length > 0) token = value.trim()
    } catch {
      token = undefined
    }
    if (token === undefined && typeof process.env[tokenEnv] === 'string') {
      const fromEnv = process.env[tokenEnv].trim()
      if (fromEnv.length > 0) token = fromEnv
    }
  }

  if (accountId === undefined && token !== undefined) {
    const discovery = await discoverAccounts(token)
    if (discovery.ids.length === 1) {
      accountId = discovery.ids[0]
      accountSource = 'auto-discovered'
    }
  }
  return { accountId, accountSource, token, tokenEnv, providerBaseURL, providerModels: provider?.models }
}

export { maskAccountId } from './settings-store.js'

function runEndpoint(access, config, model) {
  const base = firstNonEmpty(config.baseURL, access.providerBaseURL)
  if (base !== undefined) {
    const normalized = base.replace(/\/+$/, '')
    const accountMatch = normalized.match(/^(https?:\/\/[^/]+)\/client\/v4\/accounts\/([^/]+)\/ai(?:\/v1)?$/)
    if (accountMatch !== null) return `${accountMatch[1]}/client/v4/accounts/${accountMatch[2]}/ai/run/${model}`
    if (/\/accounts\/[^/]+\/ai$/.test(normalized)) return `${normalized}/run/${model}`
    if (/\/workers-ai(?:\/v1)?$/i.test(normalized)) return `${normalized.replace(/\/v1$/i, '')}/${model}`
    if (/\/ai\/v1$/.test(normalized)) return `${normalized.slice(0, -3)}/run/${model}`
  }
  if (access.accountId !== undefined) {
    return `${API_ORIGIN}/client/v4/accounts/${access.accountId}/ai/run/${model}`
  }
  throw new Error('无法确定 Cloudflare Account ID：请在 设置 → 插件 → dsh-cloudflare-media 填写 Account ID，或让 Workers AI 提供商的 baseURL 形如 https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1。')
}

function requireToken(access) {
  if (access.token !== undefined) return access.token
  throw new Error(`缺少 Cloudflare API Token：请在 设置 → 插件 → dsh-cloudflare-media 把凭据名设为与 Workers AI 提供商一致的名称（当前为 ${access.tokenEnv ?? DEFAULT_API_KEY_ENV}），或直接在环境中设置该变量。`)
}

/** POST a JSON body and return raw bytes plus content type. */
async function postJSON(url, token, body, { exec, timeoutMs }) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120000))
  const signal = exec?.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, image/*, audio/*, */*',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (exec?.signal?.aborted === true) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Cloudflare Workers AI 请求失败：${reason}。若当前网络必须经代理访问 Cloudflare，请为 Harness 进程设置 HTTPS_PROXY（Node 24 可加 NODE_USE_ENV_PROXY=1）后重试。`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) throw new Error(describeFailure(response.status, contentType, bytes))
  return { bytes, contentType }
}

function describeFailure(status, contentType, bytes) {
  let detail = ''
  if (contentType.includes('json')) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(bytes))
      const errors = Array.isArray(payload?.errors) ? payload.errors.map((entry) => entry?.message ?? JSON.stringify(entry)) : []
      detail = errors.length > 0 ? errors.join('; ') : (payload?.message ?? JSON.stringify(payload).slice(0, 400))
    } catch {
      detail = ''
    }
  }
  if (detail === '') detail = new TextDecoder().decode(bytes.slice(0, 400)).trim()
  if (status === 401 || status === 403) {
    return `Cloudflare Workers AI 鉴权失败（HTTP ${status}）：${detail}。请确认凭据保存的是 Workers AI 可用的 API Token。`
  }
  if (status === 404) return `Cloudflare Workers AI 返回 404：${detail}。请确认模型 ID 与 Account ID 正确。`
  if (status === 429) return `Cloudflare Workers AI 触发限流（HTTP 429）：${detail}。免费额度（10000 neurons/天）可能已用尽。`
  return `Cloudflare Workers AI 请求失败（HTTP ${status}）：${detail}`
}

/** Pull `result.image` style payloads out of a Workers AI response. */
function extractImage(payload, contentType) {
  const declared = contentType.toLowerCase()
  if (declared.startsWith('image/')) return { data: payload, mediaType: sniffImageType(payload, contentType) }
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    throw new Error('Cloudflare 返回了无法识别的内容（既不是图片，也不是 JSON）。')
  }
  if (parsed?.success === false) throw new Error(describeFailure(200, 'application/json', payload))
  const result = parsed?.result ?? parsed
  const candidate = typeof result === 'string'
    ? result
    : (result?.image ?? result?.images?.[0] ?? result?.data?.[0]?.b64_json ?? result?.output?.[0])
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`Cloudflare 响应中没有图片数据：${JSON.stringify(parsed).slice(0, 300)}`)
  }
  const data = base64ToBytes(candidate)
  return { data, mediaType: sniffImageType(data, '') }
}

function extractAudio(payload, contentType) {
  if (contentType.toLowerCase().startsWith('audio/')) {
    return { data: payload, mediaType: sniffAudioType(payload, contentType) }
  }
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    if (!looksLikeAudio(payload)) {
      throw new Error('Cloudflare 返回了无法识别的内容（既不是音频，也不是 JSON）。')
    }
    return { data: payload, mediaType: sniffAudioType(payload, '') }
  }
  if (parsed?.success === false) throw new Error(describeFailure(200, 'application/json', payload))
  const result = parsed?.result ?? parsed
  const candidate = typeof result === 'string'
    ? result
    : (result?.audio ?? result?.data ?? result?.output)
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`Cloudflare 响应中没有音频数据：${JSON.stringify(parsed).slice(0, 300)}`)
  }
  const data = base64ToBytes(candidate)
  return { data, mediaType: sniffAudioType(data, '') }
}

// ---------------------------------------------------------------------------
// Model-specific request bodies
// ---------------------------------------------------------------------------

function imageRequestBody(model, args, sourceBytes) {
  const body = { prompt: args.prompt }
  if (typeof args.seed === 'number') body.seed = args.seed
  if (model.includes('flux')) {
    if (typeof args.steps === 'number') body.steps = args.steps
  } else {
    if (typeof args.negative_prompt === 'string' && args.negative_prompt.length > 0) body.negative_prompt = args.negative_prompt
    if (typeof args.width === 'number') body.width = args.width
    if (typeof args.height === 'number') body.height = args.height
    if (typeof args.steps === 'number') body.num_steps = args.steps
  }
  if (sourceBytes !== undefined) {
    body.image = Array.from(sourceBytes)
    if (typeof args.strength === 'number') body.strength = args.strength
  }
  return body
}

function speechRequestBody(model, args) {
  const text = args.text
  if (model.includes('melotts')) {
    const body = { prompt: text, lang: firstNonEmpty(args.language, 'en') }
    if (typeof args.voice === 'string' && args.voice.length > 0) body.speaker = args.voice
    return body
  }
  if (model.includes('aura')) {
    return { text, ...(firstNonEmpty(args.voice) === undefined ? {} : { voice: args.voice }) }
  }
  if (model.includes('indic-parler')) {
    return {
      prompt: text,
      ...(firstNonEmpty(args.voice) === undefined ? {} : { speaker: args.voice }),
      ...(firstNonEmpty(args.description) === undefined ? {} : { description: args.description }),
    }
  }
  return {
    text,
    ...(firstNonEmpty(args.voice) === undefined ? {} : { voice: args.voice }),
    ...(firstNonEmpty(args.language) === undefined ? {} : { lang: args.language }),
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig = {}) {
  const patchConfig = () => plainConfig(rawConfig)
  /** Effective settings: defaults ← plugin config ← settings page. */
  const readSettings = async () => (await effectiveSettings(patchConfig())).values

  let configEditor
  ctx.inject(['configEditor'], (scoped) => {
    configEditor = scoped.configEditor
    return () => { configEditor = undefined }
  })

  const access = async () => resolveAccess(ctx, await readSettings(), () => configEditor)
  const timeoutMs = async (settings) => (settings ?? await readSettings()).requestTimeoutMs ?? 120000

  // -- One-time migration --------------------------------------------------
  // Older installs kept the account id in the plugin Config row. Move it into
  // the credential store (where the settings page writes it) so the shipped
  // plugin never needs a hard-coded account, then the Config row can drop it.
  ctx.inject(['credentials'], (scoped) => {
    const legacy = patchConfig().accountId
    if (typeof legacy !== 'string' || legacy.trim() === '') return
    void (async () => {
      try {
        const described = await scoped.credentials.describe(ACCOUNT_ID_CREDENTIAL)
        if (described?.configured === true) return
        await scoped.credentials.set(ACCOUNT_ID_CREDENTIAL, legacy.trim())
        ctx.logger?.info?.('cloudflare-media: migrated accountId from plugin config to the credential store')
      } catch (error) {
        ctx.logger?.warn?.(`cloudflare-media: account id migration skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  })

  // -- Settings page API ---------------------------------------------------
  // Registered only while the host actually serves HTTP (desktop, `dsh web`);
  // a headless CLI run simply has no settings page to talk to.
  ctx.inject(['webServer'], (scoped) => {
    const disposers = registerWebApi(scoped, {
      config: patchConfig,
      resolveAccess: access,
      discoverAccounts: (token) => discoverAccounts(token),
      credentials: () => optionalService(ctx, 'credentials'),
      settingsFilePath,
      timeoutMs,
      IMAGE_MODELS,
      SPEECH_MODELS,
      TRANSCRIPTION_MODELS,
      catalogForClient,
      FREE_NEURONS_PER_DAY,
      PRICING,
    })
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* the server may already be gone during shutdown */
        }
      }
    }
  })

  // -- Text to image -------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'cloudflare_generate_image',
    description: 'Generate an image with a Cloudflare Workers AI text-to-image model (free plan). Use when the user explicitly wants Cloudflare/Workers AI image generation, or when the configured Cloudflare account should produce the picture. The image is attached to the conversation automatically; do not read or search for it afterwards.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete visual prompt: subject, composition, style, lighting, colors, and any exact text.' },
      model: { type: 'string', description: `Optional Workers AI image model id for this call only. Common choices: ${IMAGE_MODELS.map((entry) => entry.id).join(', ')}.` },
      width: { type: 'integer', description: 'Optional output width in pixels (SD-family models only).' },
      height: { type: 'integer', description: 'Optional output height in pixels (SD-family models only).' },
      steps: { type: 'integer', description: 'Optional inference steps (flux-1-schnell: 1-8, default 4; SD-family: num_steps).' },
      seed: { type: 'integer', description: 'Optional seed for reproducibility.' },
      negative_prompt: { type: 'string', description: 'Optional negative prompt (SD-family models only).' },
      image: { type: 'string', description: 'Optional workspace-relative path of a source image, for image-to-image models such as @cf/runwayml/stable-diffusion-v1-5-img2img.' },
      strength: { type: 'number', description: 'Optional img2img strength 0-1 (default 0.6).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          attachment: { type: 'object', required: true, additionalProperties: true, properties: {} },
          savedTo: { type: 'string' },
          elapsedMs: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const saved = typeof value.savedTo === 'string' ? ` 已同时保存到工作区：${value.savedTo}。` : ''
        return [
          { type: 'text', text: `已用 ${value.model} 生成图片（${value.mediaType}，耗时 ${value.elapsedMs ?? 0} ms）。图片已附到对话中。${saved} 直接向用户展示结果即可，不要再去读取或搜索这张图片。` },
          { type: 'image', attachment: value.attachment },
        ]
      },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const started = Date.now()
      const settings = await readSettings()
      const credentials = await access()
      const model = firstNonEmpty(args.model, settings.imageModel, DEFAULT_IMAGE_MODEL)
      const endpoint = runEndpoint(credentials, settings, model)
      let sourceBytes
      if (typeof args.image === 'string' && args.image.length > 0) {
        sourceBytes = new Uint8Array(await readFile(resolveUserPath(exec, args.image)))
      }
      const body = imageRequestBody(model, args, sourceBytes)
      const { bytes, contentType } = await postJSON(endpoint, requireToken(credentials), body, { exec, timeoutMs: await timeoutMs(settings) })
      const image = extractImage(bytes, contentType)
      const attachment = await ctx.attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: fileNameFor('cloudflare-image', model) })
      const persisted = await persistBytes(settings, exec, image.data, image.mediaType, 'cloudflare-image', model)
      return {
        model,
        mediaType: image.mediaType,
        attachment,
        elapsedMs: Date.now() - started,
        ...(persisted.savedToWorkspace ? { savedTo: persisted.relativePath } : {}),
      }
    },
  }))

  // -- Text to speech ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'cloudflare_text_to_speech',
    description: 'Synthesize speech audio with a Cloudflare Workers AI text-to-speech model (free plan) and save it to the workspace. Returns the audio file path for the user to play or use; the model cannot listen to the audio itself.',
    parameters: {
      text: { type: 'string', required: true, description: 'Exact text to speak.' },
      model: { type: 'string', description: `Optional Workers AI TTS model id. Common choices: ${SPEECH_MODELS.map((entry) => entry.id).join(', ')}.` },
      voice: { type: 'string', description: 'Optional voice: melotts speaker, Deepgram voice name (asteria, luna, orion…), or Indic Parler speaker.' },
      language: { type: 'string', description: 'Optional language code, e.g. en or zh (MelotTS and compatible models).' },
      description: { type: 'string', description: 'Optional voice-style description (Indic Parler TTS only).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          path: { type: 'string', required: true },
          relativePath: { type: 'string' },
          bytes: { type: 'integer', required: true },
          elapsedMs: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已用 ${value.model} 生成语音（${value.mediaType}，${value.bytes} 字节，耗时 ${value.elapsedMs ?? 0} ms），文件：${value.path}${value.relativePath === undefined ? '' : `（工作区相对路径 ${value.relativePath}）`}。请把路径告知用户，方便其播放；你无法直接收听该音频。`,
      }],
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const started = Date.now()
      const settings = await readSettings()
      const credentials = await access()
      const model = firstNonEmpty(args.model, settings.speechModel, DEFAULT_SPEECH_MODEL)
      const endpoint = runEndpoint(credentials, settings, model)
      const body = speechRequestBody(model, args)
      const { bytes, contentType } = await postJSON(endpoint, requireToken(credentials), body, { exec, timeoutMs: await timeoutMs(settings) })
      const audio = extractAudio(bytes, contentType)
      const persisted = await persistBytes(settings, exec, audio.data, audio.mediaType, 'cloudflare-speech', model)
      return {
        model,
        mediaType: audio.mediaType,
        path: persisted.filePath,
        relativePath: persisted.savedToWorkspace ? persisted.relativePath : undefined,
        bytes: audio.data.byteLength,
        elapsedMs: Date.now() - started,
      }
    },
  }))

  // -- Speech to text ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'cloudflare_speech_to_text',
    description: 'Transcribe (or translate to English) an audio file with a Cloudflare Workers AI speech-to-text model (free plan). Pass a workspace-relative or absolute path to a local audio file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the audio file (workspace-relative or absolute).' },
      model: { type: 'string', description: `Optional transcription model id. Common choices: ${TRANSCRIPTION_MODELS.map((entry) => entry.id).join(', ')}.` },
      language: { type: 'string', description: 'Optional language hint such as zh or en (Whisper auto-detects when omitted).' },
      task: { type: 'string', enum: ['transcribe', 'translate'], description: 'transcribe keeps the source language; translate converts speech to English text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          text: { type: 'string', required: true },
          word_count: { type: 'integer' },
          elapsedMs: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `转写完成（${value.model}，${value.word_count ?? 0} 个词，耗时 ${value.elapsedMs ?? 0} ms）：\n\n${value.text}`,
      }],
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const started = Date.now()
      const settings = await readSettings()
      const credentials = await access()
      const model = firstNonEmpty(args.model, settings.transcriptionModel, DEFAULT_TRANSCRIPTION_MODEL)
      const filePath = resolveUserPath(exec, args.path)
      const bytes = new Uint8Array(await readFile(filePath))
      if (bytes.byteLength === 0) throw new Error(`音频文件为空：${filePath}`)
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`音频文件过大（${(bytes.byteLength / 1048576).toFixed(1)} MB），Whisper 建议 25 MB 以内。`)
      const endpoint = runEndpoint(credentials, settings, model)
      // Whisper endpoints differ in accepted encodings; try each until one is taken.
      const filename = filePath.split(/[\\/]/).pop() ?? 'audio.wav'
      const payload = {
        ...(firstNonEmpty(args.language) === undefined ? {} : { language: args.language }),
        ...(firstNonEmpty(args.task) === undefined ? {} : { task: args.task }),
      }
      const requestTimeoutMs = await timeoutMs(settings)
      const strategies = [
        () => postMultipart(endpoint, requireToken(credentials), bytes, filename, { exec, timeoutMs: requestTimeoutMs }),
        () => postRawAudio(endpoint, requireToken(credentials), bytes, { exec, timeoutMs: requestTimeoutMs }),
        () => postJSON(endpoint, requireToken(credentials), { audio: Array.from(bytes), ...payload }, { exec, timeoutMs: requestTimeoutMs }),
      ]
      let responseBytes
      let contentType
      let lastError
      for (const strategy of strategies) {
        try {
          ({ bytes: responseBytes, contentType } = await strategy())
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          if (!/audio|Type mismatch|400/i.test(error instanceof Error ? error.message : '')) throw error
        }
      }
      if (lastError !== undefined) throw lastError
      let parsed
      try {
        parsed = JSON.parse(new TextDecoder().decode(responseBytes))
      } catch {
        throw new Error(`Cloudflare 返回了无法解析的转写结果：${new TextDecoder().decode(responseBytes.slice(0, 300))}`)
      }
      if (parsed?.success === false) throw new Error(describeFailure(200, 'application/json', responseBytes))
      const result = parsed?.result ?? parsed
      const text = typeof result?.text === 'string' ? result.text : ''
      if (text.length === 0) throw new Error(`Cloudflare 响应中没有转写文本：${JSON.stringify(parsed).slice(0, 300)}（content-type ${contentType}）`)
      const wordCount = Array.isArray(result?.word_count) ? result.word_count.length : (result?.word_count ?? 0)
      return { model, text: text.trim(), word_count: typeof wordCount === 'number' ? wordCount : 0, elapsedMs: Date.now() - started }
    },
  }))

  // -- Diagnostics ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'cloudflare_media_status',
    description: 'Report how the Cloudflare multimedia tools resolved their account, credential and model settings, and list the supported Workers AI image/speech models. Use when a Cloudflare media call fails or the user asks which models are available.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 20000,
    async execute() {
      const settings = await readSettings()
      const { accountId, accountSource, token, tokenEnv, providerBaseURL, providerModels } = await access()
      const records = await describeCredentialRecords(optionalService(ctx, 'credentials'))
      const discovery = token === undefined ? undefined : await discoverAccounts(token)
      const accountHint = accountId !== undefined
        ? `（来源：${ACCOUNT_SOURCE_LABEL[accountSource] ?? accountSource}）`
        : discovery === undefined
          ? '（未解析到：没有可用的 Token，无法自动发现账号，请在插件设置中填写 accountId）'
          : discovery.names.length > 1
            ? `（该 Token 可见多个账号：${discovery.names.join('、')}，请在插件设置 accountId 中指定其一）`
            : `（未解析到：账号自动发现失败 HTTP ${discovery.status}${discovery.errors.length > 0 ? `：${discovery.errors.join('; ')}` : ''}。若 Token 没有 Account:Read 权限，请直接在插件设置中填写 accountId）`
      const lines = [
        'Cloudflare Workers AI 多媒体工具状态',
        `- Account ID: ${accountId === undefined ? '未解析到' : maskAccountId(accountId)}${accountHint}`,
        `- 凭据名: ${tokenEnv ?? DEFAULT_API_KEY_ENV}（${token === undefined ? '未取到值' : '已取到值'}）`,
        `- 凭据记录: ${records.available ? `${records.count} 条${records.cloudflare.length > 0 ? `，cloudflare 相关 ${records.cloudflare.length} 条` : '，无 cloudflare 相关记录'}${records.accountIdFound ? '，其中含 CLOUDFLARE_ACCOUNT_ID' : '，均不含 CLOUDFLARE_ACCOUNT_ID'}` : `不可用${records.error === undefined ? '' : `（${records.error}）`}`}`,
        `- 账号凭据引用: ${records.refs === undefined ? '未查询' : records.refs.join('，')}`,
        `- 提供商 baseURL: ${providerBaseURL ?? '未发现 Cloudflare 提供商配置（将使用 api.cloudflare.com 默认地址）'}`,
        `- 提供商文本模型: ${Array.isArray(providerModels) && providerModels.length > 0 ? providerModels.map((entry) => entry.id ?? entry).join(', ') : '未读到'}`,
        `- 默认图片模型: ${settings.imageModel ?? DEFAULT_IMAGE_MODEL}`,
        `- 默认语音模型: ${settings.speechModel ?? DEFAULT_SPEECH_MODEL}`,
        `- 默认转写模型: ${settings.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL}`,
        `- 工作区保存目录: ${settings.outputFolder ?? DEFAULT_OUTPUT_FOLDER}（${settings.saveToWorkspace === false ? '已关闭' : '已开启'}）`,
        '',
        '可用图片模型（价格为单位价，估算按 1024×1024）：',
        ...IMAGE_MODELS.map((entry) => `- ${entry.id}：${entry.note}｜${TIER_LABELS[entry.tier] ?? '标准'}｜${officialPriceText(entry)}｜${estimateText(entry, { width: 1024, height: 1024 })}`),
        '',
        '可用语音合成模型（估算按 100 字）：',
        ...SPEECH_MODELS.map((entry) => `- ${entry.id}：${entry.note}｜${TIER_LABELS[entry.tier] ?? '标准'}｜${officialPriceText(entry)}｜${estimateText(entry, { chars: 100 })}`),
        '',
        '可用语音转写模型（估算按 1 分钟音频）：',
        ...TRANSCRIPTION_MODELS.map((entry) => `- ${entry.id}：${entry.note}｜${TIER_LABELS[entry.tier] ?? '标准'}｜${officialPriceText(entry)}｜${estimateText(entry, { minutes: 1 })}`),
      ]
      // A malformed catalogue edit (duplicate id, unknown tier, bad price shape)
      // should be visible in the product, not only in the test run.
      const catalogProblems = validateCatalog()
      if (catalogProblems.length > 0) {
        lines.push('', '⚠ 模型目录校验失败（请修正 lib/catalog.js）：', ...catalogProblems.map((problem) => `- ${problem}`))
      }
      return {
        text: lines.join('\n'),
        accountId: accountId ?? null,
        accountSource: accountSource ?? 'unresolved',
        tokenEnv: tokenEnv ?? null,
        tokenPresent: token !== undefined,
      }
    },
  }))

  // -- System prompt hint --------------------------------------------------
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.systemPrompt.context({
      name: 'dsh-cloudflare-media',
      order: 55,
      text: () => [
        'Cloudflare Workers AI media tools are available on the free plan:',
        '- `cloudflare_generate_image` — text-to-image (default @cf/black-forest-labs/flux-1-schnell); images are attached to the conversation.',
        '- `cloudflare_text_to_speech` — speech synthesis (default @cf/myshell-ai/melotts); returns a local audio file path.',
        '- `cloudflare_speech_to_text` — transcription of a local audio file (default @cf/openai/whisper-large-v3-turbo).',
        '- `cloudflare_media_status` — resolved account/credential and model catalogue.',
        'Prefer these over other image or audio tools only when the user asks for Cloudflare/Workers AI or when the other provider is unavailable.',
      ].join('\n'),
    })
  })
}
/** Multipart upload used by Whisper endpoints, which reject JSON-as-string audio. */
/** Audio container → MIME type, for the multipart field Whisper reads. */
export function audioMimeType(filename) {
  const extension = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (extension === 'wav') return 'audio/wav'
  if (extension === 'mp3') return 'audio/mpeg'
  if (extension === 'ogg' || extension === 'oga') return 'audio/ogg'
  if (extension === 'flac') return 'audio/flac'
  if (extension === 'm4a') return 'audio/mp4'
  if (extension === 'webm') return 'audio/webm'
  return 'application/octet-stream'
}

async function postMultipart(url, token, bytes, filename, { exec, timeoutMs }) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120000))
  const signal = exec?.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])
  const form = new FormData()
  form.set('audio', new Blob([bytes], { type: audioMimeType(filename) }), filename)
  let response
  try {
    response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, body: form, signal })
  } catch (error) {
    if (exec?.signal?.aborted === true) throw error
    throw new Error(`Cloudflare Workers AI 请求失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const buffer = new Uint8Array(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) throw new Error(describeFailure(response.status, contentType, buffer))
  return { bytes: buffer, contentType }
}
/** Raw binary body variant some Workers AI audio endpoints expect. */
async function postRawAudio(url, token, bytes, { exec, timeoutMs }) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120000))
  const signal = exec?.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav', accept: 'application/json' }, body: bytes, signal })
  const buffer = new Uint8Array(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) throw new Error(describeFailure(response.status, contentType, buffer))
  return { bytes: buffer, contentType }
}
