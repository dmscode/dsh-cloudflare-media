# 更新日志

## 0.6.4 — 2026-10-23

### 工程
- 新增 `.github/workflows/release.yml`：推送 `v*` tag 时用 npm trusted publishing（OIDC）发布并附带 provenance，先校验 tag 与 `package.json` 版本一致、再跑 `npm test`；仓库不再需要长期 npm token。
- README「分发」更新发版流程与一次性 Trusted publisher 绑定步骤。

## 0.6.3 — 2026-10-23

### 新增
- 插件列表图标：`package.json` 增加 `"icon": "./assets/icon.svg"`。宿主 `dsh-app-boot` 的 `iconOf()` 只认清单里的相对路径（要求文件留在包目录内、≤256 KiB、SVG/PNG/JPEG/WebP），所以此前一直落到默认图标。
- 中英文显示名与简介：新增 `locale/zh.json`、`locale/en.json`（结构 `{"meta":{"title","description"}}`），并在 `exports` 放行 `"./locale/*.json"`——不放行时 ESM 解析会因 `exports` 白名单抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，本地化静默失效。

## 0.6.2 — 2026-10-23

### 文档
- 安装说明改正：主路径改为 GUI 的「设置 → 插件 → 安装」填写包名 `dsh-cloudflare-media`，并给出 CLI 形式 `dsh plugin --profile desktop add dsh-cloudflare-media`。
- 说明 `plugin_manager action=install_bundle` 是模型工具而非 shell 命令；`npm i` 只改依赖、不登记 `dsh.profile.bundles`，不能当安装命令。
- 合并「开发」小节里重复了两遍的代码块与 lib 说明。

## 0.6.1 — 2026-10-23

### Fixed
- 图标与封面改用 Chrome DevTools Protocol 渲染（`assets/render.mjs`）：此前用 `msedge --screenshot`，Windows 125% 缩放会让视口按设备像素计算，右、下边缘被静默裁掉。现在固定布局视口，两侧完整，并加了标记点探针验证。

### Added
- 品牌资产：透明底应用图标（SVG 源 + 1024/512/256/128/64 PNG）、1600×900 功能封面与 3200×1800 母版；设置页标题左侧改用该图标。

## 0.5.0 — 2026-10-23

首个公开发布版本。

### 功能

- 四个工具：`cloudflare_generate_image`、`cloudflare_text_to_speech`、`cloudflare_speech_to_text`、`cloudflare_media_status`。
- 复用已配置的 Cloudflare Workers AI 提供商凭据；Account ID 与 Token 只存 DSH 凭据库，页面与状态工具只显示掩码。
- 设置页（设置 → 插件 → dsh-cloudflare-media）：两项凭据、三类默认模型、输出目录、工作区保存、请求超时、可选网关 baseURL。
- 模型下拉框带档位徽标、官方单价、本次调用预估与免费日额度占比；`@cf/leonardo/lucid-origin` 等高消耗模型有醒目提示。
- 品牌资产：ssets/icon.svg 图标、ssets/cover-1600x900.png 功能封面，README 顶部展示，设置页标题带同款矢量图标。
- 生成文件名自动带上模型名：`cloudflare-<类型>-<模型名>-<时间戳>-<随机串>.<扩展名>`。

### 结构

- `lib/catalog.js` 是模型与单价的唯一数据源（`MODEL_CATALOG` / `PRICING` / `TIERS` / `DEFAULTS`）；改模型只改这一处。
- 设置页后端 5 条路由挂在 `/cloudflare-media/api/*`，写接口要求自定义头，凭据接口校验 Origin。
- 目录写坏时 `cloudflare_media_status` 会列出具体的校验失败项。

### 已知限制

- Cloudflare 官方没有余额查询接口；页面只展示“免费 10,000 neurons/天”的静态说明。
- 语音合成/转写返回的文件路径以文本给出，音频不会作为附件内嵌到对话里。
- `@cf/runwayml/stable-diffusion-v1-5-img2img` 需要账号已开通，部分账号返回 403。
- 宿主侧改动需要重启 Harness 内核才能生效。

## 0.4.x — 内部迭代

- 定价、档位徽标、模型名文件名、每日额度说明。
- 代码质量专项：CSRF 防护、路径校验、超大请求体、凭据缓存 TTL、掩码统一到 `settings-store.js`。
