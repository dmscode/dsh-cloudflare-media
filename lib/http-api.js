/**
 * The settings page's host-side API.
 *
 * The browser half cannot reach the credential store or the settings file, so
 * this module exposes four same-origin JSON routes under
 * `/cloudflare-media/api/`:
 *
 *   GET  settings      resolved values, where each one came from, model catalogue
 *   PUT  settings      validate + persist the non-secret settings
 *   POST credentials   save/clear the account id and the API token
 *   POST discover      ask Cloudflare which accounts the token can reach
 *   POST test          one end-to-end check with latency and a clear message
 *
 * Nothing here returns a credential value: the account id is always masked and
 * a token is only ever reported as present or absent.
 *
 * Transport note: DSH's `webServer` routes are Node `(req, res)` handlers, not
 * Fetch `Request`/`Response` pairs, so every route writes the response itself.
 *
 * @module dsh-cloudflare-media/http-api
 */
import {
  ACCOUNT_ID_CREDENTIAL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOKEN_ENV,
  effectiveSettings,
  isValidAccountId,
  maskAccountId,
  readSettingsFile,
  validateSettings,
  writeSettingsFile,
} from './settings-store.js'

const ROUTE_PREFIX = '/cloudflare-media/api'
const PLUGIN_HEADER = 'x-dsh-cloudflare-media'

/** Write one JSON response, honouring HEAD/CORS-free same-origin semantics. */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Collect and parse a small JSON body; malformed input yields an empty object. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('invalid json body')
    }
}

/** Route error mapping: an oversized body is a client error, not a server bug. */
function failure(res, error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'request body too large') return send(res, 413, { ok: false, error: '请求体过大' })
  if (message === 'invalid json body') return send(res, 400, { ok: false, error: '请求体不是合法 JSON' })
  return send(res, 500, { ok: false, error: message })
}

function headerValue(req, name) {
  const raw = req.headers?.[name]
  return Array.isArray(raw) ? raw[0] : raw
}

/** Reject cross-site writes; the settings page sends this header explicitly. */
function isTrustedWrite(req) {
  if (headerValue(req, PLUGIN_HEADER) !== '1') return false
  // Browsers attach Origin to state-changing fetches: when present it must be
  // this very server, otherwise a page on another site could drive the API.
  const origin = headerValue(req, 'origin')
  if (origin === undefined) return true
  const host = headerValue(req, 'host')
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Compose the resolved view the page renders on load. */
async function settingsView(deps, patchConfig) {
  const credentials = deps.credentials()
  const { values, sources, defaults } = await effectiveSettings(patchConfig)
  const access = await deps.resolveAccess()
  let accountPresent = false
  try {
    const info = await credentials?.describe?.(ACCOUNT_ID_CREDENTIAL)
    accountPresent = info?.configured === true
  } catch {
    accountPresent = false
  }
  return {
    ok: true,
    values,
    sources,
    defaults,
    catalog: deps.catalogForClient(),
    pricing: {
      freeNeuronsPerDay: deps.FREE_NEURONS_PER_DAY,
      usdPerThousandNeurons: Number((1000 / (deps.PRICING?.neuronsPerDollar ?? 909.090909)).toFixed(6)),
      note: 'Cloudflare Workers AI 每天免费 10,000 neurons，UTC 00:00 重置；超出部分 $0.011/千 neurons（需 Workers Paid）。官方 REST API 未提供余额查询接口，用量请见 Dashboard。',
    },
    account: {
      present: accountPresent || access.accountId !== undefined,
      masked: maskAccountId(access.accountId),
      source: access.accountSource,
      canAutoDiscover: access.token !== undefined,
    },
    token: {
      env: access.tokenEnv ?? DEFAULT_TOKEN_ENV,
      present: access.token !== undefined,
    },
    capabilities: {
      writable: credentials !== undefined,
      settingsFile: deps.settingsFilePath(),
    },
  }
}

/** The origin used for Workers AI calls, honouring a gateway base URL when set. */
function workersOrigin(access) {
  const raw = typeof access?.providerBaseURL === 'string' ? access.providerBaseURL : ''
  const match = raw.match(/^(https?:\/\/[^/]+)/)
  return match === null ? 'https://api.cloudflare.com' : match[1]
}

/**
 * Cheapest possible authentication proof: one embedding of one word.
 *
 * Used when `/accounts/:id` answers 403 — which is normal for a token whose
 * scope is Workers AI and nothing else.
 */
async function probeInference(access, timeoutMs) {
  const url = `${workersOrigin(access)}/client/v4/accounts/${access.accountId}/ai/run/@cf/baai/bge-small-en-v1.5`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: ['ping'] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) return { ok: true }
    const payload = await response.json().catch(() => undefined)
    const detail = Array.isArray(payload?.errors)
      ? payload.errors.map((entry) => entry?.message).filter(Boolean).join('; ')
      : `HTTP ${response.status}`
    return { ok: false, detail }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Register every route on the host web server.
 * @param ctx - host (or injected) context carrying `webServer`.
 * @param deps - plugin internals (config reader, access resolver, catalogues).
 * @returns disposers for every registered route.
 */
export function registerWebApi(ctx, deps) {
  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return []

  const disposers = []
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  route(`${ROUTE_PREFIX}/settings`, async (req, res) => {
    try {
      const patchConfig = deps.config()
      if (req.method === 'GET' || req.method === 'HEAD') {
        return send(res, 200, await settingsView(deps, patchConfig))
      }
      if (req.method !== 'PUT') return send(res, 405, { ok: false, error: 'method not allowed' })
      if (!isTrustedWrite(req)) return send(res, 403, { ok: false, error: 'missing plugin header' })
      const body = await readBody(req)
      const { values, errors } = validateSettings(body?.values ?? body)
      if (Object.keys(errors).length > 0) return send(res, 400, { ok: false, errors })
      await writeSettingsFile({ ...(await readSettingsFile()), ...values })
      return send(res, 200, await settingsView(deps, patchConfig))
    } catch (error) {
      return failure(res, error)
    }
  })

  route(`${ROUTE_PREFIX}/credentials`, async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
    if (!isTrustedWrite(req)) return send(res, 403, { ok: false, error: 'missing plugin header' })
    const credentials = deps.credentials()
    if (credentials === undefined) return send(res, 503, { ok: false, error: '凭据服务不可用' })
    try {
      const body = await readBody(req)
      if (body.accountId !== undefined) {
        const raw = typeof body.accountId === 'string' ? body.accountId.trim() : ''
        if (raw === '') await credentials.unset?.(ACCOUNT_ID_CREDENTIAL)
        else if (!isValidAccountId(raw)) return send(res, 400, { ok: false, errors: { accountId: 'Account ID 必须是 32 位十六进制字符' } })
        else await credentials.set(ACCOUNT_ID_CREDENTIAL, raw)
      }
      if (body.apiToken !== undefined) {
        const env = typeof body.tokenEnv === 'string' && body.tokenEnv.trim() !== '' ? body.tokenEnv.trim() : DEFAULT_TOKEN_ENV
        const raw = typeof body.apiToken === 'string' ? body.apiToken.trim() : ''
        if (raw === '') await credentials.unset?.(env)
        else if (raw.length > 512 || /\s/.test(raw)) return send(res, 400, { ok: false, errors: { apiToken: 'API Token 必须是单行字符串（不超过 512 字符）' } })
        else await credentials.set(env, raw)
      }
      return send(res, 200, await settingsView(deps, deps.config()))
    } catch (error) {
      return failure(res, error)
    }
  })

  route(`${ROUTE_PREFIX}/discover`, async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
    if (!isTrustedWrite(req)) return send(res, 403, { ok: false, error: 'missing plugin header' })
    try {
      const access = await deps.resolveAccess()
      if (access.token === undefined) return send(res, 400, { ok: false, error: '尚未保存 API Token，无法自动发现账号' })
      const discovery = await deps.discoverAccounts(access.token)
      if (discovery.ids.length === 0) {
        return send(res, 200, {
          ok: false,
          error: discovery.errors.length > 0
            ? discovery.errors.join('; ')
            : `Token 无法列出账号（HTTP ${discovery.status}）。请确认 Token 拥有 Account:Read 权限，或直接填写 Account ID。`,
          accounts: [],
        })
      }
      return send(res, 200, {
        ok: true,
        accounts: discovery.ids.map((id, index) => ({ id, name: discovery.names[index] ?? id, masked: maskAccountId(id) })),
      })
    } catch (error) {
      return send(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  route(`${ROUTE_PREFIX}/test`, async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
    if (!isTrustedWrite(req)) return send(res, 403, { ok: false, error: 'missing plugin header' })
    const started = Date.now()
    try {
      const access = await deps.resolveAccess()
      if (access.token === undefined) {
        return send(res, 200, { ok: false, step: 'token', message: `未找到 API Token：请在凭据名 ${access.tokenEnv ?? DEFAULT_TOKEN_ENV} 下保存` })
      }
      if (access.accountId === undefined) {
        return send(res, 200, { ok: false, step: 'account', message: '未解析到 Account ID：请在页面填写，或点“自动发现”' })
      }
      const configured = Number(await deps.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS)
      const timeout = Math.max(3000, Math.min(20000, Number.isFinite(configured) ? configured : DEFAULT_TIMEOUT_MS))
      const response = await fetch(`${workersOrigin(access)}/client/v4/accounts/${access.accountId}`, {
        headers: { authorization: `Bearer ${access.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      })
      const payload = await response.json().catch(() => undefined)
      const latencyMs = Date.now() - started
      if (!response.ok) {
        // A token scoped to Workers AI only cannot read the account object, yet
        // inference itself may work perfectly well. Verify with a real call to
        // the cheapest model in the catalogue before declaring the page broken.
        const probe = await probeInference(access, timeout)
        if (probe.ok) {
          return send(res, 200, {
            ok: true,
            latencyMs: Date.now() - started,
            step: 'inference',
            accountName: maskAccountId(access.accountId),
            message: `连接正常：账号 ${maskAccountId(access.accountId)}，已用 Workers AI 推理接口验证（${Date.now() - started} ms）。该 Token 没有账号资料读取权限，无法显示账号名。`,
          })
        }
        const detail = Array.isArray(payload?.errors) ? payload.errors.map((entry) => entry?.message).filter(Boolean).join('; ') : ''
        return send(res, 200, {
          ok: false,
          step: 'account',
          latencyMs,
          message: `账号校验失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}；推理接口也不可用：${probe.detail ?? '未知原因'}`,
        })
      }
      return send(res, 200, {
        ok: true,
        latencyMs,
        accountName: payload?.result?.name ?? maskAccountId(access.accountId),
        message: `连接正常：账号 ${payload?.result?.name ?? maskAccountId(access.accountId)}（${latencyMs} ms）`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return send(res, 200, {
        ok: false,
        latencyMs: Date.now() - started,
        step: 'network',
        message: `网络请求失败：${message}${/proxy/i.test(message) ? '' : '（如需代理，请为 Harness 进程设置 HTTPS_PROXY）'}`,
      })
    }
  })

  return disposers
}
