/**
 * Model catalogue + pricing for dsh-cloudflare-media.
 *
 * This is the ONLY file to touch when Cloudflare changes its model line-up or
 * its neuron prices — everything else (settings page, status tool, file names,
 * estimates) reads from here.
 *
 * HOW TO MAINTAIN
 * 1. Add / remove / retune a model: edit `MODEL_CATALOG` below. One object per
 *    model, per capability (`image` | `speech` | `transcription`).
 * 2. Prices are expressed in Workers AI *neurons* (official unit), and the USD
 *    figures are the same rates converted at `PRICING.usdPerNeuron`. If
 *    Cloudflare changes a price, edit the numbers in the model entry; if the
 *    neuron→USD rate or the free daily allowance changes, edit `PRICING`.
 * 3. `tier` picks the badge/colour shown in settings; tiers live in `TIERS`, so
 *    a new tier only needs an entry there plus a matching `.cfm-tier.t-<tone>`
 *    CSS rule in lib/client.js.
 * 4. Run `node test-catalog.mjs` — it validates ids, tiers, price shapes and
 *    that every capability has a usable default.
 *
 * PRICE SHAPES (pick exactly one per model)
 *   { free: true }                                     beta / free models
 *   { tile, step, steps?, width?, height?, usd? }      image models, per 512²
 *                                                      tile + per diffusion step
 *   { per1kChars, usdPer1kChars? }                     TTS billed per 1k chars
 *   { perMinute, usdPerMinute? }                       TTS/STT billed per minute
 *
 * No imports on purpose: this module must stay importable from tests and from
 * any other plugin half without pulling in DSH internals.
 */

/** Workers AI account-wide constants (dashboard: Workers AI → Pricing). */
export const PRICING = {
  /** Free neurons per account per day, resetting at UTC 00:00. */
  freeNeuronsPerDay: 10000,
  /** USD per neuron on the Workers Paid plan ($0.011 per 1,000 neurons). */
  usdPerNeuron: 0.011 / 1000,
}

/** Back-compat alias used by the status tool and tests. */
export const FREE_NEURONS_PER_DAY = PRICING.freeNeuronsPerDay

/** Badge tiers. `tone` must have a `.cfm-tier.t-<tone>` rule in lib/client.js. */
export const TIERS = {
  free: { label: '免费', tone: 'free' },
  cheap: { label: '便宜', tone: 'cheap' },
  standard: { label: '标准', tone: 'standard' },
  expensive: { label: '偏贵', tone: 'expensive' },
  premium: { label: '很贵', tone: 'premium' },
}

/** Back-compat map used by the status tool's price lines. */
export const TIER_LABELS = Object.fromEntries(Object.entries(TIERS).map(([id, tier]) => [id, tier.label]))

/**
 * The catalogue. Order matters: it is the order shown in the settings picker,
 * so keep the recommended/cheapest options first.
 */
export const MODEL_CATALOG = {
  image: [
    {
      id: '@cf/black-forest-labs/flux-1-schnell',
      note: 'Flux.1 schnell — 4 步快速出图，日常首选',
      tier: 'cheap',
      price: { tile: 4.8, step: 9.6, steps: 4, usd: { tile: 0.0000528, step: 0.0001056 } },
    },
    {
      id: '@cf/bytedance/stable-diffusion-xl-lightning',
      note: 'SDXL Lightning — 极快的 SDXL，Beta 期免费',
      tier: 'free',
      price: { free: true },
    },
    {
      id: '@cf/lykon/dreamshaper-8-lcm',
      note: 'DreamShaper 8 LCM — 插画/动漫风，Beta 期免费',
      tier: 'free',
      price: { free: true },
    },
    {
      id: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
      note: 'SDXL base — 20 步，质量稳但最慢；Beta 期免费',
      tier: 'free',
      price: { free: true },
    },
    {
      id: '@cf/leonardo/phoenix-1.0',
      note: 'Leonardo Phoenix 1.0 — 排版/文字表现好',
      tier: 'expensive',
      price: { tile: 530, step: 10, steps: 8, usd: { tile: 0.00583, step: 0.00011 } },
      warn: '偏高消耗：单张约占免费日额度四分之一',
    },
    {
      id: '@cf/leonardo/lucid-origin',
      note: 'Leonardo Lucid Origin — 画质强、文字准，但按 512² tile 计费，极贵',
      tier: 'premium',
      price: { tile: 636, step: 12, steps: 8, width: 1120, height: 1120, usd: { tile: 0.006996, step: 0.000132 } },
      warn: '高消耗：单张约占免费日额度一半以上',
    },
    {
      id: '@cf/runwayml/stable-diffusion-v1-5-img2img',
      note: 'SD 1.5 img2img（免费账号常返回 403，需账号已开通）',
      tier: 'free',
      price: { free: true },
      unavailable: true,
    },
  ],
  speech: [
    {
      id: '@cf/myshell-ai/melotts',
      note: 'MelotTS 多语言（en/zh/ja/ko/fr/es/it），44.1 kHz wav/mp3',
      tier: 'cheap',
      price: { perMinute: 18.63, usdPerMinute: 0.0002 },
    },
    {
      id: '@cf/deepgram/aura-1',
      note: 'Deepgram Aura-1 — 自然英文音色（voice: asteria / luna / orion …）',
      tier: 'standard',
      price: { per1kChars: 1363.64, usdPer1kChars: 0.015 },
    },
    {
      id: '@cf/deepgram/aura-2-en',
      note: 'Deepgram Aura-2 EN — 表现力更强的英文音色',
      tier: 'standard',
      price: { per1kChars: 2727.27, usdPer1kChars: 0.03 },
    },
    {
      id: '@cf/deepgram/aura-2-es',
      note: 'Deepgram Aura-2 ES — 西班牙语表现力音色',
      tier: 'standard',
      price: { per1kChars: 2727.27, usdPer1kChars: 0.03 },
    },
  ],
  transcription: [
    {
      id: '@cf/openai/whisper-large-v3-turbo',
      note: 'Whisper large-v3 turbo — 速度/质量最佳平衡',
      tier: 'cheap',
      price: { perMinute: 46.63, usdPerMinute: 0.0005 },
    },
    {
      id: '@cf/openai/whisper',
      note: 'Whisper（原版）— 更小更快，中文明显劣化',
      tier: 'cheap',
      price: { perMinute: 41.14, usdPerMinute: 0.0005 },
    },
  ],
}

/** Model used when neither the settings page nor the tool call names one. */
export const DEFAULTS = {
  image: '@cf/black-forest-labs/flux-1-schnell',
  speech: '@cf/myshell-ai/melotts',
  transcription: '@cf/openai/whisper-large-v3-turbo',
}

/** Capability names in catalogue order. */
export const CAPABILITIES = ['image', 'speech', 'transcription']

// ---------------------------------------------------------------------------
// Pure formatters (no I/O, safe to unit test)
// ---------------------------------------------------------------------------

/** `@cf/leonardo/lucid-origin` → `leonardo-lucid-origin` (used in file names). */
export function modelSlug(modelId) {
  return String(modelId).replace(/^@cf\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

/** Attachment / file base name that names the generating model. */
export function fileNameFor(prefix, model) {
  return `${prefix}-${modelSlug(model)}`
}

/** Badge datum for a model; unknown tiers fall back to `standard`. */
export function tierOf(entry) {
  return TIERS[entry?.tier] ?? TIERS.standard
}

function neuronsText(neurons) {
  if (!Number.isFinite(neurons)) return ''
  if (neurons === 0) return '0 neurons'
  return `${Math.round(neurons).toLocaleString('en-US')} neurons`
}

function usdText(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return ''
  return `$${usd < 0.01 ? usd.toFixed(6) : usd.toFixed(4)}`
}

/** Official unit price string, e.g. `4.8 neurons/512² tile + 9.6 neurons/step`. */
export function officialPriceText(entry) {
  const price = entry?.price
  if (price === undefined) return ''
  if (price.free === true) return 'Beta 期 $0.00/step（免费）'
  if (price.tile !== undefined) {
    const parts = [`${price.tile} neurons/512² tile`, `${price.step} neurons/step`]
    if (price.usd !== undefined) parts.push(`官方 $${price.usd.tile}/tile + $${price.usd.step}/step`)
    return parts.join(' + ')
  }
  if (price.per1kChars !== undefined) {
    const usd = price.usdPer1kChars !== undefined ? `（官方 $${price.usdPer1kChars}/千字符）` : ''
    return `${price.per1kChars} neurons/千字符${usd}`
  }
  if (price.perMinute !== undefined) {
    const usd = price.usdPerMinute !== undefined ? `（官方 $${price.usdPerMinute}/分钟）` : ''
    return `${price.perMinute} neurons/音频分钟${usd}`
  }
  return ''
}

/**
 * Estimate the neuron cost of one call.
 * Image: one 512×512 tile grid over width/height, plus one charge per diffusion step.
 * Speech: per 1,000 input characters (Aura) or per spoken minute (MelotTS, ≈4 chars/s).
 * Transcription: per audio minute.
 */
export function estimateCall(entry, options = {}) {
  const price = entry?.price
  if (price === undefined) return { neurons: Number.NaN, usd: Number.NaN }
  if (price.free === true) return { neurons: 0, usd: 0 }
  if (price.tile !== undefined) {
    const width = Number.isFinite(options.width) ? options.width : 1024
    const height = Number.isFinite(options.height) ? options.height : 1024
    const steps = Number.isFinite(options.steps) ? options.steps : (price.steps ?? 4)
    const tiles = Math.ceil(width / 512) * Math.ceil(height / 512)
    const neurons = tiles * price.tile + steps * price.step
    return { neurons, usd: neurons * PRICING.usdPerNeuron }
  }
  if (price.per1kChars !== undefined) {
    const chars = Number.isFinite(options.chars) ? options.chars : 100
    const neurons = Math.ceil(chars / 1000) * price.per1kChars
    return { neurons, usd: neurons * PRICING.usdPerNeuron }
  }
  if (price.perMinute !== undefined) {
    const minutes = Number.isFinite(options.minutes)
      ? options.minutes
      : (Number.isFinite(options.chars) ? options.chars / 4 / 60 : 1)
    const neurons = minutes * price.perMinute
    return { neurons, usd: neurons * PRICING.usdPerNeuron }
  }
  return { neurons: Number.NaN, usd: Number.NaN }
}

/** Human estimate line, e.g. `≈58 neurons/张（≈$0.0006，占免费日额度 0.6%）`. */
export function estimateText(entry, options = {}) {
  const { neurons, usd } = estimateCall(entry, options)
  if (!Number.isFinite(neurons)) return ''
  if (neurons === 0) return '免费（Beta 期 $0.00/step）'
  const unit = entry.price?.tile !== undefined
    ? '张'
    : entry.price?.per1kChars !== undefined
      ? '次'
      : options.chars !== undefined
        ? '次（约100字）'
        : '分钟'
  const parts = [`≈${neuronsText(neurons)}/${unit}`]
  if (Number.isFinite(usd) && usd > 0) parts.push(`≈${usdText(usd)}`)
  parts.push(`占免费日额度 ${((neurons / PRICING.freeNeuronsPerDay) * 100).toFixed(neurons < 100 ? 1 : 0)}%`)
  return parts.join('，')
}

/** Catalogue entry enriched with everything the settings page renders. */
export function withPricing(entry, sampleOptions) {
  const tier = tierOf(entry)
  return {
    id: entry.id,
    note: entry.note ?? '',
    tier: tier.tone,
    tierLabel: tier.label,
    official: officialPriceText(entry),
    estimate: estimateText(entry, sampleOptions),
    warn: entry.warn ?? '',
    unavailable: entry.unavailable === true,
  }
}

/** Samples used to illustrate one call's cost, per price shape. */
export function sampleFor(entry, kind) {
  const price = entry?.price ?? {}
  if (price.tile !== undefined) {
    return { width: price.width ?? 1024, height: price.height ?? 1024, steps: price.steps }
  }
  if (kind === 'speech') return { chars: 100 }
  return { minutes: 1 }
}

/** Catalogue enriched for the settings page and the status tool. */
export function catalogForClient() {
  return Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      (MODEL_CATALOG[capability] ?? []).map((entry) => withPricing(entry, sampleFor(entry, capability))),
    ]),
  )
}

/**
 * Structural checks for maintainers; returns human-readable problems.
 * `node test-catalog.mjs` fails when this is non-empty, and the status tool
 * prints it so a bad edit is visible in the product too.
 */
export function validateCatalog(catalog = MODEL_CATALOG, defaults = DEFAULTS) {
  const problems = []
  for (const capability of CAPABILITIES) {
    const entries = catalog[capability] ?? []
    if (entries.length === 0) problems.push(`${capability}: 目录为空`)
    const seen = new Set()
    for (const entry of entries) {
      const label = `${capability}/${entry?.id ?? '(缺少 id)'}`
      if (typeof entry?.id !== 'string' || !entry.id.startsWith('@cf/')) problems.push(`${label}: id 必须以 @cf/ 开头`)
      if (seen.has(entry?.id)) problems.push(`${label}: id 重复`)
      seen.add(entry?.id)
      if (entry?.tier !== undefined && TIERS[entry.tier] === undefined) problems.push(`${label}: 未知 tier "${entry.tier}"`)
      const price = entry?.price
      if (price === undefined) problems.push(`${label}: 缺少 price`)
      else if (price.free !== true && price.tile === undefined && price.per1kChars === undefined && price.perMinute === undefined) {
        problems.push(`${label}: price 不是受支持的形状`)
      }
    }
    if (!entries.some((entry) => entry.id === defaults[capability])) {
      problems.push(`${capability}: 默认模型 ${defaults[capability]} 不在目录中`)
    }
  }
  return problems
}
