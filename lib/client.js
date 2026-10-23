/**
 * dsh-cloudflare-media — 浏览器半侧。
 *
 * 这是“设置 → 插件 → dsh-cloudflare-media”页面里的配置卡片：账号、令牌、
 * 三个能力各自的默认模型、输出目录与高级选项。全部读写都走宿主半侧暴露的
 * 同源 JSON 路由（/cloudflare-media/api/*），页面本身不接触凭据存储，也不会
 * 拿到账号或令牌的明文——宿主只回masked 值。
 *
 * 打包形态与其他第三方客户端插件一致：
 *   window.__ModuleLoader__.load({ id, factory })
 * 物化后导出 `inject` 与 `apply`，由 Loader 挂载。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cloudflare-media',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const API = '/cloudflare-media/api'
    const PLUGIN_HEADERS = { 'content-type': 'application/json', 'x-dsh-cloudflare-media': '1' }
    const CUSTOM = '__custom__'

    const CAPABILITIES = [
      { key: 'imageModel', catalog: 'image', label: '图片生成', hint: '提示词 → 图片' },
      { key: 'speechModel', catalog: 'speech', label: '语音合成', hint: '文本 → 音频' },
      { key: 'transcriptionModel', catalog: 'transcription', label: '语音转写', hint: '音频 → 文本' },
    ]

    const CSS = `
.cfm-card { display:flex; flex-direction:column; gap:18px; padding:20px 22px; border:1px solid var(--dsw-alias-border-l1); border-radius:14px; background:var(--dsw-alias-bg-layer-1); }
.cfm-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.cfm-title { display:flex; align-items:center; gap:10px; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.cfm-logo { width:26px; height:26px; display:grid; place-items:center; flex:none; }
.cfm-logo svg { width:26px; height:26px; display:block; border-radius:7px; }
.cfm-sub { margin:6px 0 0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.cfm-badge { flex:none; padding:3px 9px; border-radius:999px; font-size:11px; letter-spacing:.02em; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.cfm-badge.ok { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.cfm-badge.warn { color:var(--dsw-alias-state-warn-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.cfm-section { display:flex; flex-direction:column; gap:10px; }
.cfm-legend { font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }
.cfm-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; }
.cfm-field { display:flex; flex-direction:column; gap:6px; min-width:0; }
.cfm-label { font-size:12px; color:var(--dsw-alias-label-secondary); }
.cfm-input, .cfm-select { width:100%; box-sizing:border-box; padding:8px 10px; font-size:13px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; outline:none; transition:border-color .15s, box-shadow .15s; }
.cfm-input:focus, .cfm-select:focus { border-color:var(--dsw-alias-brand-primary); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.cfm-input.mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; letter-spacing:.02em; }
.cfm-invalid { border-color:var(--dsw-alias-state-error-primary); }
.cfm-error { font-size:11px; color:var(--dsw-alias-state-error-primary); }
.cfm-row { display:flex; gap:8px; align-items:center; }
.cfm-row > * { min-width:0; }
.cfm-btn { flex:none; padding:8px 14px; font-size:12.5px; font-weight:500; border-radius:8px; cursor:pointer; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); transition:background .15s, border-color .15s, opacity .15s; }
.cfm-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.cfm-btn.primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
.cfm-btn.primary:hover:not(:disabled) { filter:brightness(1.05); }
.cfm-btn:disabled { opacity:.5; cursor:not-allowed; }
.cfm-cap { display:grid; grid-template-columns:104px 1fr; gap:10px; align-items:start; padding:10px 0; border-top:1px dashed var(--dsw-alias-border-l1); }
.cfm-cap:first-of-type { border-top:none; }
.cfm-meta { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:2px; }
.cfm-meta-text { font-size:12px; color:var(--dsw-alias-label-primary); }
.cfm-meta-official { font-size:11px; color:var(--dsw-alias-label-secondary); }
.cfm-meta-warn { font-size:11.5px; color:var(--dsw-alias-state-warn-primary); }
.cfm-tier { flex:none; padding:1px 8px; border-radius:999px; font-size:11px; line-height:18px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.cfm-tier.t-free { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.cfm-tier.t-cheap { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent); }
.cfm-tier.t-standard { color:var(--dsw-alias-label-primary); }
.cfm-tier.t-expensive { color:var(--dsw-alias-state-warn-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.cfm-tier.t-premium { color:var(--dsw-alias-state-error-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.cfm-note { font-size:12px; line-height:1.7; color:var(--dsw-alias-label-secondary); }
.cfm-cap-name { display:flex; flex-direction:column; font-size:13px; color:var(--dsw-alias-label-primary); }
.cfm-cap-hint { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:2px; }
.cfm-switch { position:relative; display:inline-flex; align-items:center; gap:8px; font-size:12.5px; color:var(--dsw-alias-label-primary); cursor:pointer; user-select:none; }
.cfm-switch input { position:absolute; opacity:0; width:0; height:0; }
.cfm-track { width:34px; height:19px; border-radius:999px; background:var(--dsw-alias-border-l2); position:relative; transition:background .15s; flex:none; }
.cfm-track::after { content:''; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:#fff; transition:transform .15s; box-shadow:0 1px 2px rgba(0,0,0,.25); }
.cfm-switch input:checked + .cfm-track { background:var(--dsw-alias-brand-primary); }
.cfm-switch input:checked + .cfm-track::after { transform:translateX(15px); }
.cfm-details { border-top:1px dashed var(--dsw-alias-border-l1); padding-top:12px; }
.cfm-details > summary { cursor:pointer; font-size:12px; color:var(--dsw-alias-label-secondary); }
.cfm-details[open] > summary { margin-bottom:12px; }
.cfm-foot { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.cfm-status { font-size:12px; color:var(--dsw-alias-label-secondary); }
.cfm-status.ok { color:var(--dsw-alias-state-success-primary); }
.cfm-status.err { color:var(--dsw-alias-state-error-primary); }
.cfm-spacer { flex:1; }
.cfm-muted { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.cfm-summary { display:flex; align-items:center; gap:10px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.cfm-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); flex:none; }
.cfm-dot.ok { background:var(--dsw-alias-state-success-primary); }
.cfm-dot.warn { background:var(--dsw-alias-state-warn-primary); }
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('cfm-style') !== null) return
      const style = document.createElement('style')
      style.id = 'cfm-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Fetch JSON from the host half; never throws, always resolves to a body. */
    async function call(path, init) {
      const response = await fetch(path, init)
      const text = await response.text()
      let body
      try {
        body = text === '' ? {} : JSON.parse(text)
      } catch {
        body = { ok: false, error: `响应不是 JSON（HTTP ${response.status}）` }
      }
      if (!response.ok && body.ok !== false) return { ok: false, error: `HTTP ${response.status}` }
      return body
    }

    const getSettings = () => call(`${API}/settings`, { headers: { accept: 'application/json' } })
    const putSettings = (values) => call(`${API}/settings`, { method: 'PUT', headers: PLUGIN_HEADERS, body: JSON.stringify({ values }) })
    const putCredentials = (body) => call(`${API}/credentials`, { method: 'POST', headers: PLUGIN_HEADERS, body: JSON.stringify(body) })
    const discover = () => call(`${API}/discover`, { method: 'POST', headers: PLUGIN_HEADERS, body: '{}' })
    const testConnection = () => call(`${API}/test`, { method: 'POST', headers: PLUGIN_HEADERS, body: '{}' })

    function Field(props) {
      return h(
        'label',
        { className: 'cfm-field' },
        h('span', { className: 'cfm-label' }, props.label),
        props.children,
        props.error !== undefined ? h('span', { className: 'cfm-error' }, props.error) : null,
      )
    }

    function Switch(props) {
      return h(
        'label',
        { className: 'cfm-switch' },
        h('input', { type: 'checkbox', checked: props.checked, onChange: (event) => props.onChange(event.target.checked) }),
        h('span', { className: 'cfm-track' }),
        props.label,
      )
    }

    /** One capability row: label + model picker (catalogue select or custom id). */
    function CapabilityRow(props) {
      const { capability, value, defaultValue, catalog, onChange } = props
      const entries = catalog?.[capability.catalog] ?? []
      const known = entries.some((entry) => entry.id === value)
      const [custom, setCustom] = React.useState(known ? '' : value)
      React.useEffect(() => {
        if (!known) setCustom(value ?? '')
      }, [value, known])
      const selected = value === '' ? '' : known ? value : CUSTOM
      // Price/badge rows describe what will actually be called: the default when
      // this capability is left on "跟随内置默认".
      const effectiveId = value === '' ? defaultValue : value
      const chosen = entries.find((entry) => entry.id === effectiveId)
      const meta = chosen === undefined
        ? null
        : h(
            'div',
            { className: 'cfm-meta' },
            h('span', { className: `cfm-tier t-${chosen.tier ?? 'standard'}` }, chosen.tierLabel ?? '标准'),
            chosen.estimate ? h('span', { className: 'cfm-meta-text' }, chosen.estimate) : null,
            chosen.unavailable ? h('span', { className: 'cfm-meta-warn' }, '⚠ 当前账号通常无权调用') : null,
            chosen.warn ? h('span', { className: 'cfm-meta-warn' }, `⚠ ${chosen.warn}`) : null,
          )
      return h(
        'div',
        { className: 'cfm-cap' },
        h(
          'div',
          { className: 'cfm-cap-name' },
          h('span', null, capability.label),
          h('span', { className: 'cfm-cap-hint' }, capability.hint),
        ),
        h(
          'div',
          { className: 'cfm-field' },
          h(
            'select',
            {
              className: 'cfm-select',
              value: selected,
              onChange: (event) => {
                const next = event.target.value
                if (next === CUSTOM) onChange(custom !== '' ? custom : (entries[0]?.id ?? ''))
                else onChange(next)
              },
            },
            entries.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.id)),
            h('option', { value: '' }, `跟随内置默认${defaultValue ? `（${defaultValue}）` : ''}`),
            h('option', { value: CUSTOM }, '自定义…'),
          ),
          selected === CUSTOM
            ? h('input', {
                className: 'cfm-input mono',
                placeholder: '@cf/…',
                value: custom,
                onChange: (event) => {
                  setCustom(event.target.value)
                  onChange(event.target.value)
                },
              })
            : null,
          chosen?.note ? h('span', { className: 'cfm-muted' }, chosen.note) : null,
          meta,
          chosen?.official ? h('span', { className: 'cfm-meta-official' }, `官方单价：${chosen.official}`) : null,
        ),
      )
    }

    /** The `page` form. */
    function SettingsForm() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState({})
      const [accountDraft, setAccountDraft] = React.useState('')
      const [tokenDraft, setTokenDraft] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [errors, setErrors] = React.useState({})
      const [accounts, setAccounts] = React.useState([])

      const load = React.useCallback(async () => {
        setBusy('load')
        const body = await getSettings()
        setBusy('')
        if (body.ok !== true) return setStatus({ kind: 'err', text: body.error ?? '读取设置失败' })
        setState(body)
        setDraft(body.values ?? {})
        setStatus(null)
        setAccounts([])
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

      const defaultModel = (key) => state?.defaults?.[key]
      const source = (key) => {
        const from = state?.sources?.[key]
        if (from === 'settings-page') return '本页'
        if (from === 'plugin-config') return '插件配置'
        return '默认'
      }

      const save = async () => {
        setBusy('save')
        setErrors({})
        const values = { ...draft }
        const result = await putSettings(values)
        if (result.ok !== true) {
          setBusy('')
          setErrors(result.errors ?? {})
          return setStatus({ kind: 'err', text: result.error ?? '保存失败，请检查标红的字段' })
        }
        let credentialText = ''
        const credentialBody = {}
        if (accountDraft.trim() !== '') credentialBody.accountId = accountDraft.trim()
        if (tokenDraft.trim() !== '') credentialBody.apiToken = tokenDraft.trim()
        if (Object.keys(credentialBody).length > 0) {
          const saved = await putCredentials(credentialBody)
          if (saved.ok !== true) {
            setBusy('')
            setErrors(saved.errors ?? {})
            return setStatus({ kind: 'err', text: saved.error ?? '凭据保存失败' })
          }
          credentialText = '，凭据已更新'
        }
        setAccountDraft('')
        setTokenDraft('')
        setBusy('')
        setState(result)
        setDraft(result.values ?? {})
        setStatus({ kind: 'ok', text: `设置已保存${credentialText}` })
      }

      const runDiscover = async () => {
        setBusy('discover')
        const result = await discover()
        setBusy('')
        if (result.ok !== true) {
          setStatus({ kind: 'err', text: result.error ?? '自动发现失败' })
          return
        }
        setAccounts(result.accounts ?? [])
        setStatus({ kind: 'ok', text: `发现 ${result.accounts.length} 个可用账号，点击即可填入` })
      }

      const runTest = async () => {
        setBusy('test')
        const result = await testConnection()
        setBusy('')
        setStatus({ kind: result.ok === true ? 'ok' : 'err', text: result.message ?? '测试完成' })
      }

      const restoreDefaults = () => {
        if (state === null) return
        setDraft((current) => ({ ...current, ...state.defaults }))
        setStatus({ kind: 'ok', text: '已填入内置默认值，记得点“保存设置”' })
      }

      if (state === null) {
        return h('section', { className: 'cfm-card' }, h('span', { className: 'cfm-muted' }, busy === 'load' ? '正在读取设置…' : '无法读取设置：请确认插件已启用'))
      }

      const account = state.account ?? {}
      const token = state.token ?? {}
      return h(
        'section',
        { className: 'cfm-card' },
        h(
          'header',
          { className: 'cfm-head' },
          h(
            'div',
            null,
            h(
              'div',
              { className: 'cfm-title' },
              h(
                'span',
                { className: 'cfm-logo' },
                h(
                  'svg',
                  { viewBox: '0 0 512 512', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true' },
                  h(
                    'defs',
                    null,
                    h(
                      'linearGradient',
                      { id: 'cfmIconBg', x1: '0', y1: '0', x2: '1', y2: '1' },
                      h('stop', { offset: '0', stopColor: '#FBF6EA' }),
                      h('stop', { offset: '1', stopColor: '#EFE4CE' }),
                    ),
                    h(
                      'linearGradient',
                      { id: 'cfmIconBolt', x1: '0', y1: '0', x2: '1', y2: '1' },
                      h('stop', { offset: '0', stopColor: '#F7A64B' }),
                      h('stop', { offset: '1', stopColor: '#EC7B2E' }),
                    ),
                  ),
                  h('rect', { x: '8', y: '8', width: '496', height: '496', rx: '112', fill: 'url(#cfmIconBg)' }),
                  h('rect', {
                    x: '8', y: '8', width: '496', height: '496', rx: '112',
                    fill: 'none', stroke: '#1F2933', strokeWidth: '12',
                  }),
                  h('path', {
                    d: 'M150 348 C 104 348 68 314 68 270 C 68 230 98 197 137 190 C 149 140 194 104 248 104 C 300 104 344 138 358 186 C 405 193 436 229 436 272 C 436 316 400 348 354 348 Z',
                    fill: '#FFFDF7', stroke: '#1F2933', strokeWidth: '13', strokeLinejoin: 'round',
                  }),
                  h('path', {
                    d: 'M276 146 L206 268 L252 268 L228 356 L318 226 L268 226 Z',
                    fill: 'url(#cfmIconBolt)', stroke: '#1F2933', strokeWidth: '13', strokeLinejoin: 'round',
                  }),
                  h(
                    'g',
                    { stroke: '#7BA05B', strokeWidth: '16', strokeLinecap: 'round' },
                    h('path', { d: 'M150 392 L150 414' }),
                    h('path', { d: 'M190 376 L190 430' }),
                    h('path', { d: 'M230 392 L230 414' }),
                  ),
                  h(
                    'g',
                    { stroke: '#1F2933', strokeWidth: '16', strokeLinecap: 'round' },
                    h('path', { d: 'M270 384 L270 422' }),
                    h('path', { d: 'M310 368 L310 438' }),
                    h('path', { d: 'M350 388 L350 418' }),
                  ),
                ),
              ),
              'Cloudflare Workers AI 多媒体',
            ),
            h('p', { className: 'cfm-sub' }, '在免费额度内提供生图、语音合成与语音转写。账号与令牌存放在本机 DSH 凭据库，不会写进插件代码或配置。'),
          ),
          h(
            'span',
            { className: `cfm-badge ${token.present && account.present ? 'ok' : 'warn'}` },
            token.present && account.present ? '已就绪' : token.present ? '待填账号' : '待填令牌',
          ),
        ),

        h(
          'div',
          { className: 'cfm-section' },
          h('div', { className: 'cfm-legend' }, '连接'),
          h(
            'div',
            { className: 'cfm-grid' },
            h(
              Field,
              { label: account.present ? `Account ID（已保存 ${account.masked ?? ''}）` : 'Account ID', error: errors.accountId },
              h(
                'div',
                { className: 'cfm-row' },
                h('input', {
                  className: 'cfm-input mono',
                  placeholder: account.present ? '留空则保持不变' : '32 位十六进制，例如 0123456789abcdef0123456789abcdef',
                  value: accountDraft,
                  spellCheck: false,
                  onChange: (event) => setAccountDraft(event.target.value),
                }),
                h('button', { className: 'cfm-btn', type: 'button', disabled: busy !== '', onClick: runDiscover }, busy === 'discover' ? '发现中…' : '自动发现'),
              ),
              accounts.length > 0
                ? h(
                    'div',
                    { className: 'cfm-row' },
                    accounts.map((entry) =>
                      h(
                        'button',
                        { key: entry.id, className: 'cfm-btn', type: 'button', onClick: () => setAccountDraft(entry.id) },
                        `${entry.name} · ${entry.masked}`,
                      ),
                    ),
                  )
                : null,
            ),
            h(
              Field,
              { label: token.present ? 'API Token（已保存，留空则不修改）' : 'API Token', error: errors.apiToken },
              h('input', {
                className: 'cfm-input mono',
                type: 'password',
                autoComplete: 'off',
                placeholder: token.present ? '••••••••（已保存）' : '粘贴 Workers AI 的 API Token',
                value: tokenDraft,
                onChange: (event) => setTokenDraft(event.target.value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'cfm-row' },
            h('button', { className: 'cfm-btn', type: 'button', disabled: busy !== '', onClick: runTest }, busy === 'test' ? '测试中…' : '测试连接'),
            h('span', { className: 'cfm-muted' }, `令牌凭据名：${token.env ?? '—'}${state.capabilities?.writable === false ? '（凭据服务不可用，仅能读环境变量）' : ''}`),
          ),
        ),

        h(
          'div',
          { className: 'cfm-section' },
          h('div', { className: 'cfm-legend' }, '默认模型'),
          CAPABILITIES.map((capability) =>
            h(CapabilityRow, {
              key: capability.key,
              capability,
              catalog: state.catalog,
              value: draft[capability.key] ?? '',
              defaultValue: defaultModel(capability.key),
              onChange: (next) => update(capability.key, next),
            }),
          ),
          h(
            'div',
            { className: 'cfm-muted' },
            '调用时也可以在单个请求里临时指定模型；这里选的是默认值。当前取值来源：',
            CAPABILITIES.map((capability, index) =>
              h('span', { key: capability.key }, `${index === 0 ? '' : ' · '}${capability.label} ${source(capability.key)}`),
            ),
          ),
        ),

        h(
          'div',
          { className: 'cfm-section' },
          h('div', { className: 'cfm-legend' }, '输出'),
          h(
            'div',
            { className: 'cfm-grid' },
            h(
              Field,
              { label: '输出目录（相对当前工作目录）', error: errors.outputFolder },
              h('input', {
                className: 'cfm-input mono',
                value: draft.outputFolder ?? '',
                placeholder: 'cloudflare-media',
                onChange: (event) => update('outputFolder', event.target.value),
              }),
            ),
            h(
              Field,
              { label: '保存到会话工作区' },
              h(
                'div',
                { style: { paddingTop: '6px' } },
                h(Switch, {
                  checked: draft.saveToWorkspace !== false,
                  label: '生成的文件落到工作区，模型可直接引用',
                  onChange: (checked) => update('saveToWorkspace', checked),
                }),
              ),
            ),
          ),
        ),

        h(
          'details',
          { className: 'cfm-details' },
          h('summary', null, '高级选项'),
          h(
            'div',
            { className: 'cfm-grid', style: { marginTop: '12px' } },
            h(
              Field,
              { label: '请求超时（毫秒）', error: errors.requestTimeoutMs },
              h('input', {
                className: 'cfm-input',
                type: 'number',
                min: 1000,
                max: 600000,
                step: 1000,
                value: draft.requestTimeoutMs ?? 120000,
                onChange: (event) => update('requestTimeoutMs', Number(event.target.value)),
              }),
            ),
            h(
              Field,
              { label: 'API 基址（留空使用官方地址）', error: errors.baseURL },
              h('input', {
                className: 'cfm-input mono',
                value: draft.baseURL ?? '',
                placeholder: 'https://api.cloudflare.com/client/v4',
                onChange: (event) => update('baseURL', event.target.value),
              }),
            ),
            h(
              Field,
              { label: '令牌凭据名', error: errors.apiTokenEnv },
              h('input', {
                className: 'cfm-input mono',
                value: draft.apiTokenEnv ?? '',
                placeholder: 'CLOUDFLARE_WORKERS_AI_API_KEY',
                onChange: (event) => update('apiTokenEnv', event.target.value),
              }),
            ),
          ),
        ),

        h(
          'div',
          { className: 'cfm-section' },
          h('div', { className: 'cfm-legend' }, '用量与计费'),
          h(
            'div',
            { className: 'cfm-note' },
            '免费额度 10,000 neurons/天（UTC 00:00 重置），超出 $0.011/千 neurons（需 Workers Paid）；Cloudflare 未提供余额查询接口，实际用量见 Dashboard → Workers AI。每个模型下方是官方单价与单次估算，费用以 neurons 计量。',
          ),
        ),

        h(
          'footer',
          { className: 'cfm-foot' },
          h('button', { className: 'cfm-btn primary', type: 'button', disabled: busy !== '', onClick: save }, busy === 'save' ? '保存中…' : '保存设置'),
          h('button', { className: 'cfm-btn', type: 'button', disabled: busy !== '', onClick: restoreDefaults }, '填入默认值'),
          h('span', { className: 'cfm-spacer' }),
          status !== null ? h('span', { className: `cfm-status ${status.kind}` }, status.text) : h('span', { className: 'cfm-status' }, `设置文件：${state.capabilities?.settingsFile ?? ''}`),
        ),
      )
    }

    /** The `summary` one-liner shown above the page body. */
    function SettingsSummary() {
      const [state, setState] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        void getSettings().then((body) => {
          if (alive && body.ok === true) setState(body)
        })
        return () => {
          alive = false
        }
      }, [])
      const ready = state?.token?.present === true && state?.account?.present === true
      return h(
        'div',
        { className: 'cfm-summary' },
        h('span', { className: `cfm-dot ${ready ? 'ok' : 'warn'}` }),
        h(
          'span',
          null,
          state === null
            ? 'Cloudflare Workers AI 多媒体'
            : ready
              ? `已连接 ${state.account.masked ?? ''} · ${state.values?.imageModel ?? ''} / ${state.values?.speechModel ?? ''} / ${state.values?.transcriptionModel ?? ''}`
              : '尚未配置账号或令牌，点开本插件页面填写',
        ),
      )
    }

    function Entry(props) {
      return props.view === 'summary' ? h(SettingsSummary, null) : h(SettingsForm, null)
    }

    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-cloudflare-media',
            order: 10,
            label: 'Cloudflare Workers AI 多媒体',
          },
          Entry,
        ),
      )
    }

    exports.name = 'dsh-cloudflare-media'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
