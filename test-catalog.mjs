/**
 * Unit tests for lib/catalog.js — the file maintainers edit when Cloudflare's
 * model line-up or neuron prices change. Run: `node test-catalog.mjs`.
 */
import assert from 'node:assert/strict'
import {
  CAPABILITIES,
  DEFAULTS,
  MODEL_CATALOG,
  PRICING,
  TIERS,
  catalogForClient,
  estimateCall,
  estimateText,
  fileNameFor,
  modelSlug,
  officialPriceText,
  validateCatalog,
} from './lib/catalog.js'

let checks = 0
function check(name, fn) {
  try {
    fn()
    checks += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

const byId = (capability, id) => MODEL_CATALOG[capability].find((entry) => entry.id === id)

check('catalogue is structurally valid', () => {
  assert.deepEqual(validateCatalog(), [])
})

check('validator reports duplicates, bad tiers, bad prices and missing defaults', () => {
  const broken = {
    image: [
      { id: '@cf/x/a', tier: 'nope', price: { free: true } },
      { id: '@cf/x/a', tier: 'cheap', price: {} },
    ],
    speech: [],
    transcription: [],
  }
  const problems = validateCatalog(broken, { image: '@cf/x/missing', speech: 's', transcription: 't' })
  // unknown tier + duplicate id + empty price shape + 3 empty catalogues/defaults
  assert.equal(problems.length, 8, problems.join('\n'))
})

check('every capability has at least one entry and a default inside the catalogue', () => {
  for (const capability of CAPABILITIES) {
    assert.ok(MODEL_CATALOG[capability].length > 0, capability)
    assert.ok(
      MODEL_CATALOG[capability].some((entry) => entry.id === DEFAULTS[capability]),
      `${capability} default ${DEFAULTS[capability]} must be in the catalogue`,
    )
  }
})

check('all tiers used by models exist in TIERS (so their CSS tone exists)', () => {
  for (const capability of CAPABILITIES) {
    for (const entry of MODEL_CATALOG[capability]) {
      assert.ok(TIERS[entry.tier] !== undefined, `${entry.id} uses unknown tier ${entry.tier}`)
    }
  }
})

check('model ids are unique across the whole catalogue', () => {
  const ids = CAPABILITIES.flatMap((capability) => MODEL_CATALOG[capability].map((entry) => entry.id))
  assert.equal(new Set(ids).size, ids.length)
})

check('modelSlug strips the @cf/ prefix and lower-cases separators', () => {
  assert.equal(modelSlug('@cf/black-forest-labs/flux-1-schnell'), 'black-forest-labs-flux-1-schnell')
  assert.equal(modelSlug('@cf/openai/whisper-large-v3-turbo'), 'openai-whisper-large-v3-turbo')
  assert.equal(modelSlug('custom/model_v2'), 'custom-model-v2')
})

check('fileNameFor embeds the model', () => {
  assert.equal(
    fileNameFor('cloudflare-image', '@cf/leonardo/lucid-origin'),
    'cloudflare-image-leonardo-lucid-origin',
  )
})

check('officialPriceText renders every supported price shape', () => {
  const flux = byId('image', DEFAULTS.image)
  assert.match(officialPriceText(flux), /4\.8 neurons\/512² tile \+ 9\.6 neurons\/step/)

  const free = byId('image', '@cf/lykon/dreamshaper-8-lcm')
  assert.match(officialPriceText(free), /免费/)

  const aura = byId('speech', '@cf/deepgram/aura-1')
  assert.match(officialPriceText(aura), /1363\.64 neurons\/千字符.*\$0\.015/)

  const whisper = byId('transcription', DEFAULTS.transcription)
  assert.match(officialPriceText(whisper), /46\.63 neurons\/音频分钟.*\$0\.0005/)

  assert.equal(officialPriceText({ id: 'x' }), '')
})

check('estimateCall: image = tiles × tile rate + steps × step rate', () => {
  const flux = byId('image', DEFAULTS.image)
  const estimate = estimateCall(flux, { width: 1024, height: 1024, steps: 4 })
  assert.equal(estimate.neurons, 4 * 4.8 + 4 * 9.6)
  assert.ok(Math.abs(estimate.usd - estimate.neurons * PRICING.usdPerNeuron) < 1e-12)
})

check('estimateCall uses the model geometry for Leonardo premium models', () => {
  const lucid = byId('image', '@cf/leonardo/lucid-origin')
  const estimate = estimateCall(lucid, { width: 1120, height: 1120 })
  // 1120/512 → 3 tiles per axis = 9 tiles, plus 8 steps
  assert.equal(estimate.neurons, 9 * 636 + 8 * 12)
  assert.ok(estimate.neurons / PRICING.freeNeuronsPerDay > 0.5, 'must read as >50% of the daily free allowance')
})

check('estimateCall: free models cost nothing', () => {
  assert.deepEqual(estimateCall(byId('image', '@cf/lykon/dreamshaper-8-lcm'), {}), { neurons: 0, usd: 0 })
  assert.match(estimateText(byId('image', '@cf/lykon/dreamshaper-8-lcm')), /免费/)
})

check('estimateCall: character-billed speech and minute-billed transcription', () => {
  assert.equal(estimateCall(byId('speech', '@cf/deepgram/aura-1'), { chars: 100 }).neurons, 1363.64)
  assert.equal(estimateCall(byId('transcription', DEFAULTS.transcription), { minutes: 1 }).neurons, 46.63)
})

check('estimateText mentions the free-daily-allowance share', () => {
  const text = estimateText(byId('image', DEFAULTS.image), { width: 1024, height: 1024, steps: 4 })
  assert.match(text, /占免费日额度 \d/)
})

check('catalogForClient fills tier, price and estimate fields for the settings page', () => {
  const catalog = catalogForClient()
  assert.deepEqual(Object.keys(catalog).sort(), [...CAPABILITIES].sort())
  for (const capability of CAPABILITIES) {
    for (const entry of catalog[capability]) {
      assert.equal(typeof entry.id, 'string')
      assert.equal(typeof entry.tierLabel, 'string')
      assert.equal(typeof entry.official, 'string')
      assert.ok(entry.official.length > 0, `${entry.id} needs a price line`)
      assert.ok(entry.estimate.length > 0, `${entry.id} needs an estimate line`)
    }
  }
  const lucid = catalog.image.find((entry) => entry.id === '@cf/leonardo/lucid-origin')
  assert.equal(lucid.tierLabel, '很贵')
  assert.match(lucid.warn, /高消耗/)
})

check('premium/free tier labels come from TIERS, not hard-coded strings', () => {
  const catalog = catalogForClient()
  const free = catalog.image.find((entry) => entry.tier === 'free')
  assert.equal(free.tierLabel, TIERS.free.label)
})

console.log(`\nall ${checks} catalogue checks passed`)
