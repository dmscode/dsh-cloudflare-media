/**
 * Persistent, human-editable settings for the Cloudflare multimedia tools.
 *
 * The plugin ships `Config` (the profile patch row) for declarative/headless
 * deployments, but the settings page needs a store it can write without going
 * through the Loader's YAML. This module owns that store:
 *
 *   <DSH_HOME>/cloudflare-media/settings.json
 *
 * Precedence, highest first: this file (written by the settings page) → the
 * plugin's `Config` row → built-in defaults. Secrets never land here: the
 * account id and the API token live in the DSH credential store, which is also
 * where `llm-pi-ai` keeps them, so both halves of the harness share one copy.
 *
 * @module dsh-cloudflare-media/settings-store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell'
export const DEFAULT_SPEECH_MODEL = '@cf/myshell-ai/melotts'
export const DEFAULT_TRANSCRIPTION_MODEL = '@cf/openai/whisper-large-v3-turbo'
export const DEFAULT_OUTPUT_FOLDER = 'cloudflare-media'
export const DEFAULT_TIMEOUT_MS = 120000
export const DEFAULT_TOKEN_ENV = 'CLOUDFLARE_WORKERS_AI_API_KEY'
export const ACCOUNT_ID_CREDENTIAL = 'CLOUDFLARE_ACCOUNT_ID'

/** Whether a value is a plausible Cloudflare account id (32 hex characters). */
export function isValidAccountId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value.trim())
}

/** Model ids must stay Worker-AI namespaced so a typo cannot hit another API. */
export function isValidModelId(value) {
  return typeof value === 'string' && /^@cf\/[A-Za-z0-9._\-/]+$/.test(value.trim())
}

/** Field-by-field validation shared by the settings page and the HTTP route. */
export function validateSettings(input) {
  const errors = {}
  const out = {}
  const text = (key) => (typeof input?.[key] === 'string' ? input[key].trim() : undefined)

  const imageModel = text('imageModel')
  if (imageModel !== undefined && imageModel !== '') {
    if (isValidModelId(imageModel)) out.imageModel = imageModel
    else errors.imageModel = '模型 ID 必须以 @cf/ 开头，例如 @cf/black-forest-labs/flux-1-schnell'
  }
  for (const key of ['speechModel', 'transcriptionModel']) {
    const value = text(key)
    if (value !== undefined && value !== '') {
      if (isValidModelId(value)) out[key] = value
      else errors[key] = '模型 ID 必须以 @cf/ 开头'
    }
  }

  const outputFolder = text('outputFolder')
  if (outputFolder !== undefined) {
    const clean = outputFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (clean === '') out.outputFolder = DEFAULT_OUTPUT_FOLDER
    else if (clean.split('/').some((part) => part === '..' || part === '.')) errors.outputFolder = "目录不能包含 '..' 或 '.'"
    else if (path.isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) errors.outputFolder = '请填写相对当前工作目录的路径'
    else out.outputFolder = clean
  }

  if (typeof input?.saveToWorkspace === 'boolean') out.saveToWorkspace = input.saveToWorkspace

  if (input?.requestTimeoutMs !== undefined) {
    const value = Number(input.requestTimeoutMs)
    if (!Number.isFinite(value) || value < 1000 || value > 600000) errors.requestTimeoutMs = '超时时间需在 1000–600000 毫秒之间'
    else out.requestTimeoutMs = Math.round(value)
  }

  const baseURL = text('baseURL')
  if (baseURL !== undefined) {
    if (baseURL === '') out.baseURL = ''
    else if (!/^https?:\/\//i.test(baseURL)) errors.baseURL = 'baseURL 必须以 http:// 或 https:// 开头'
    else out.baseURL = baseURL.replace(/\/+$/, '')
  }

  const tokenEnv = text('apiTokenEnv')
  if (tokenEnv !== undefined) {
    if (tokenEnv === '') out.apiTokenEnv = ''
    else if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(tokenEnv)) errors.apiTokenEnv = '凭据名只能使用字母、数字、下划线和短横线'
    else out.apiTokenEnv = tokenEnv
  }

  return { values: out, errors }
}

/** Show a credential exists without disclosing it. */
export function maskAccountId(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length === 0) return undefined
  if (text.length <= 4) return '*'.repeat(4)
  return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`
}

/** The settings file for this DSH home. */
export function settingsFilePath() {
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  return path.join(home, 'cloudflare-media', 'settings.json')
}

const KEYS = ['imageModel', 'speechModel', 'transcriptionModel', 'outputFolder', 'saveToWorkspace', 'requestTimeoutMs', 'baseURL', 'apiTokenEnv']

/** Read the settings file, tolerating absence and partial damage. */
export async function readSettingsFile() {
  const file = settingsFilePath()
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    const values = {}
    for (const key of KEYS) {
      if (parsed?.[key] !== undefined && parsed[key] !== null) values[key] = parsed[key]
    }
    return values
  } catch {
    // A malformed file must not take the tools down: keep it aside for the user
    // to inspect and let the settings page rewrite a clean one.
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* best effort only */
    }
    return {}
  }
}

/** Write a validated settings document atomically and refresh the cache. */
export async function writeSettingsFile(values) {
  const file = settingsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  const clean = {}
  for (const key of KEYS) if (values?.[key] !== undefined) clean[key] = values[key]
  const body = JSON.stringify({ ...clean }, null, 2)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, body, 'utf8')
  await rename(temporary, file)
  return clean
}

/** Resolve the effective settings: defaults ← patch config ← settings file. */
export async function effectiveSettings(patchConfig) {
  const fileValues = await readSettingsFile()
  const merged = {}
  const sources = {}
  const defaults = {
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: DEFAULT_SPEECH_MODEL,
    transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    outputFolder: DEFAULT_OUTPUT_FOLDER,
    saveToWorkspace: true,
    requestTimeoutMs: DEFAULT_TIMEOUT_MS,
    baseURL: '',
    apiTokenEnv: '',
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    const fromFile = fileValues[key]
    const fromPatch = patchConfig?.[key]
    if (fromFile !== undefined && fromFile !== '') {
      merged[key] = fromFile
      sources[key] = 'settings-page'
    } else if (fromPatch !== undefined && fromPatch !== '') {
      merged[key] = fromPatch
      sources[key] = 'plugin-config'
    } else {
      merged[key] = fallback
      sources[key] = 'default'
    }
  }
  return { values: merged, sources, fileValues, defaults }
}
