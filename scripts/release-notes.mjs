#!/usr/bin/env node
// Prints the CHANGELOG section for one version, so GitHub Release notes stay in
// sync with the repository instead of being retyped inside the workflow.
import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>')
  process.exit(1)
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const registry = 'https://registry.npmjs.org/dsh-cloudflare-media/-/npm/v1/attestations/dsh-cloudflare-media@'

function propose(body) {
  console.log(
    [body, '', '---', '', `安装：\`dsh plugin --profile desktop add dsh-cloudflare-media@${version}\``, '', `npm：https://www.npmjs.com/package/dsh-cloudflare-media/v/${version}`].join('\n'),
  )
}

const start = changelog.indexOf(`## ${version}`)

// A release whose CHANGELOG entry was forgotten still gets a usable body rather
// than an empty one — the workflow must not fail on a missing note.
if (start === -1) {
  propose(`## ${version}\n\n本次发布未在 CHANGELOG.md 中记录条目。`)
  process.exit(0)
}

// CHANGELOG headings carry the date after the version (“## 0.6.4 — 2026-10-23”),
// so keep that whole line and take everything up to the next version heading.
const headingEnd = changelog.indexOf('\n', start)
const heading = changelog.slice(start, headingEnd === -1 ? changelog.length : headingEnd)
const rest = changelog.slice(headingEnd === -1 ? changelog.length : headingEnd + 1)
const nextHeading = rest.search(/^## /m)
const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim()

propose([heading, '', section].join('\n'))
