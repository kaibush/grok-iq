# GrokIQ

> 面向账号质量巡检的可视化工作台：批量发起探针、追踪任务与样本证据、识别异常表现，并支持后续处置与复测。

![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111827)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

## 一眼了解

GrokIQ 将日常账号巡检集中到一个界面中：从账号筛选、批量建测、排队执行，到样本详情、风险趋势和复测，所有操作都有清晰的进度与可回看记录。

- **账号探针**：按状态、判定等条件筛选账号，批量创建测试、启用或停用。
- **任务中心**：查看队列和执行进度，支持停止、删除、重测与批量操作。
- **风险判断**：风险周期内固定出口和临时切换出口的有效样本都会计分，阈值、权重和封顶都能在设置里调。
- **微信提醒**：账号进入风险状态、指定 Key 1 小时正常率下降，或 /status 近 15/30 分钟成功率下降时，可通过微信测试公众号模板消息提醒。
- **计划任务**：用 Cron 定期巡检，避免重复堆积任务。
- **Worker 可观测性**：查看并发执行状态、阻塞原因和近期日志。
- **聊天广场**：用于流式对话验证，支持多套模型配置、本地会话历史和 Markdown / HTML 预览。
- **SSO 检测**：可按行导入 SSO，也可对注册联动已保存 SSO 的账号批量检查登录态和 Bot 标记；每次执行保存独立报告，支持回看、筛选和批量删除。
- **密钥额度**：在公开上游状态页查询 grok2api Client Key 剩余额度和时间窗口使用量；不会回显密钥明文。
- **状态页登录**：`/status` 默认公开。在“系统设置 → 连接与凭据 → 状态页登录”打开 Linux.do Connect 开关后，需先登录才能查看。

## 界面预览

> 所有截图均为脱敏的示例数据：邮箱使用 `example.com`，IP 使用 RFC 示例地址段，不包含真实账号、密钥、代理或数据库内容。点击图片可查看原图。

<p align="center">
  <a href="docs/screenshots/monitoring-overview.png">
    <img src="docs/screenshots/monitoring-overview.png" alt="监控概览" width="100%" />
  </a>
  <br />
  <sub>监控概览：账号规模、风险数量、样本趋势、队列与风险排行</sub>
</p>

### 巡检与调度

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/account-probes.png"><img src="docs/screenshots/account-probes.png" alt="账号探针" /></a><br />
      <sub><b>账号探针</b> · 筛选账号、查看当前表现，以及批量操作</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/task-center.png"><img src="docs/screenshots/task-center.png" alt="任务中心" /></a><br />
      <sub><b>任务中心</b> · 任务队列、执行进度、重测、停止与删除</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/cron-schedules.png"><img src="docs/screenshots/cron-schedules.png" alt="定时计划" /></a><br />
      <sub><b>定时计划</b> · Cron 表达式、时区、重叠策略与调用记录</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/worker-runtime.png"><img src="docs/screenshots/worker-runtime.png" alt="Worker 运行状态" /></a><br />
      <sub><b>Worker 运行状态</b> · 并发实例、当前任务和队列阻塞情况</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/worker-logs.png"><img src="docs/screenshots/worker-logs.png" alt="Worker 日志" /></a><br />
      <sub><b>Worker 日志</b> · 最近执行记录，便于定位异常任务</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/probe-profiles.png"><img src="docs/screenshots/probe-profiles.png" alt="探针方案" /></a><br />
      <sub><b>探针方案</b> · 管理内置与自定义的测试内容和判定标记</sub>
    </td>
  </tr>
</table>

### 任务与样本证据

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/account-detail.png"><img src="docs/screenshots/account-detail.png" alt="账号详情" /></a><br />
      <sub><b>账号详情</b> · 风险原因、出口对比、最近任务和样本</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/run-detail.png"><img src="docs/screenshots/run-detail.png" alt="任务详情" /></a><br />
      <sub><b>任务详情</b> · 逐轮指标、样本分类与响应内容</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/decision-guide.png"><img src="docs/screenshots/decision-guide.png" alt="判定说明" /></a><br />
      <sub><b>判定说明</b> · 样本分类、风险累计、任务与恢复状态说明</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/expected-output-editor.png"><img src="docs/screenshots/expected-output-editor.png" alt="预期结果编辑器" /></a><br />
      <sub><b>预期结果编辑器</b> · 编辑参考输出，并预览 Markdown、HTML 或 SVG</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/profile-editor.png"><img src="docs/screenshots/profile-editor.png" alt="探针方案编辑" /></a><br />
      <sub><b>方案编辑</b> · 配置提示词、模型、校验标记和输出参考</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/cron-plan-editor.png"><img src="docs/screenshots/cron-plan-editor.png" alt="定时计划编辑" /></a><br />
      <sub><b>计划编辑</b> · 搜索、多选账号、选择方案、轮次与出口</sub>
    </td>
  </tr>
</table>

### 聊天与系统设置

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/chat-playground.png"><img src="docs/screenshots/chat-playground.png" alt="聊天广场" /></a><br />
      <sub><b>聊天广场</b> · 流式输出、思考内容、本地历史与多回复版本</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/html-preview.png"><img src="docs/screenshots/html-preview.png" alt="HTML 预览" /></a><br />
      <sub><b>HTML 预览</b> · 预览与源码切换，方便核对生成结果</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/playground-provider-settings.png"><img src="docs/screenshots/playground-provider-settings.png" alt="聊天提供商设置" /></a><br />
      <sub><b>聊天提供商</b> · 维护多套地址、密钥和模型列表</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/settings-connection.png"><img src="docs/screenshots/settings-connection.png" alt="连接设置" /></a><br />
      <sub><b>连接设置</b> · 在控制台完成服务连接与凭据配置</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/settings-queue.png"><img src="docs/screenshots/settings-queue.png" alt="任务队列设置" /></a><br />
      <sub><b>任务队列设置</b> · 并发、容量、重试与诊断参数</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/settings-risk.png"><img src="docs/screenshots/settings-risk.png" alt="风险设置" /></a><br />
      <sub><b>风险设置</b> · 异常条件、计分权重、状态保底分与自动处置</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/integration-settings.png"><img src="docs/screenshots/integration-settings.png" alt="联动设置" /></a><br />
      <sub><b>联动设置</b> · 配置导入后的自动巡检策略</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/first-time-setup.png"><img src="docs/screenshots/first-time-setup.png" alt="首次使用" /></a><br />
      <sub><b>首次使用</b> · 创建管理员后即可进入控制台</sub>
    </td>
  </tr>
</table>

## 能做什么

- **批量跑探针**：筛选、多选或全选账号后直接入队。不同账号并行，同一账号串行。
- **正常定检与异常诊断**：正常定检保持账号当前固定出口不变；只有人工诊断才临时切换出口。
- **两种执行模式**：完整对话用于看实际回复和指标；快速质量测试仅用于诊断出口质量。
- **定时执行**：每个计划单独配置 Cron、时区、账号、方案、轮次和出口。
- **保存完整结果**：记录首 Token、生成耗时、输出 Token、TPS、分类、错误和响应正文。
- **风险标记**：按风险周期内全部出口样本的异常占比、连续异常、强信号和预期内容匹配情况计算账号状态；次数、占比、权重、封顶和状态保底分都能热更新。
- **任务控制**：查看队列和 Worker，支持停止、重试、删除以及批量操作。
- **结果回看**：从账号、任务或样本详情里直接看指标和原始输出，长内容按需展开。
- **注册联动**：接收 [grok-register](https://github.com/kaibush/grok-register) 的 Webhook，账号导入后可保存 SSO、记录注册风险，并可选自动创建探针任务；检测完成后可向注册机发送回调通知。
- **SSO 报告**：仅 `bot=0` 记为正常，其他值记为风控标记；持久报告不保存 SSO、哈希或会话 ID。
- **密钥额度**：公开上游状态页可查询 Client Key 剩余额度，并按 24 小时到 90 天或自定义窗口汇总使用量；不会回显明文。
- **状态页 Linux.do 登录**：默认关闭时 `/status` 仍可公开访问。打开后，需通过 [Linux.do Connect](https://connect.linux.do/) OAuth2 登录才能查看看板。登录用户会出现在“页面访问”里，并可在该页的 Linux.do 用户页签管理。


## Linux.do Connect 状态页登录

`/status` 默认仍然公开。若要限制访客，在“系统设置 → 连接与凭据 → 状态页登录”打开开关，并填写 Linux.do Connect 的 Client ID、Client Secret。

回调地址默认是 `{站点 origin}/api/public/linuxdo/callback`，需要和 Linux.do Connect 应用里登记的 Redirect URI 一致。开关关闭后，状态页立即恢复公开访问，已保存的 OAuth 配置和登录过的用户记录仍会保留。

登录后，页面访问流水会带上用户名、头像和信任等级；“页面访问”页可切换到 Linux.do 用户页签查看注册登录过的账号。

## 风险因子怎么调

在“系统设置 → 风险与隔离”里直接改，保存后马上生效，已有账号也会按新公式重算。

- **状态条件**：重复异常次数、累计异常占比、高风险最少强信号数。
- **计分因子**：异常信号率、强信号、持续高速、标记缺失、连续信号。
- **分数控制**：每个因子的权重和封顶、总分上限，以及观察 / 疑似 / 高风险保底分。

这里用结构化字段，不接任意表达式。这样用户可以调敏感度，也不容易因为公式拼错把整套判定跑坏。“判定说明”页会同步展示当前运行中的真实公式。

## 微信测试公众号提醒

在“系统设置 → 通知推送”打开总开关，填 AppID、AppSecret、OpenID，再按场景各建一套模板。

先在微信测试公众号后台把运行监控后端的出口 IP 加到接口白名单，再填写下面的值。

| 设置 | 从哪里拿 |
| --- | --- |
| `AppID` | 微信测试公众号的 appID |
| `AppSecret` | 微信测试公众号的 appsecret |
| `OpenID` | 测试公众号用户列表里的 OpenID |
| `账号异常模板 ID` | 账号进入观察 / 疑似 / 高风险 / 隔离，或风险升级时使用 |
| `密钥正常率模板 ID` | 指定 Key 最近 1 小时正常率跌破阈值时使用 |
| `上游成功率模板 ID` | `/status` 最近 15 / 30 分钟成功率跌破阈值时使用 |

每种场景使用独立模板 ID。字段名必须和下面一致，保存后点对应模板的“保存并发送测试消息”确认联通。

账号异常：

```text
{{first.DATA}}
账号：{{account.DATA}}
状态：{{status.DATA}}
风险分：{{score.DATA}}
TPS：{{tps.DATA}}
原因：{{reason.DATA}}
时间：{{time.DATA}}
{{remark.DATA}}
```

密钥正常率：

```text
{{first.DATA}}
密钥：{{key.DATA}}
窗口：{{window.DATA}}
正常率：{{rate.DATA}}
阈值：{{threshold.DATA}}
请求量：{{requests.DATA}}
异常：{{abnormal.DATA}}
时间：{{time.DATA}}
{{remark.DATA}}
```

上游成功率：

```text
{{first.DATA}}
窗口：{{window.DATA}}
成功率：{{rate.DATA}}
阈值：{{threshold.DATA}}
请求量：{{requests.DATA}}
失败：{{failed.DATA}}
时间：{{time.DATA}}
{{remark.DATA}}
```

推送规则：

- **总开关**关闭时，自动推送和测试消息都不发送。
- **账号异常**仍跟总开关走：首次进入 `watch`、`suspect`、`high_risk` 或 `quarantined`，以及风险升级时推送；同一状态不重复刷屏。
- **密钥 1 小时正常率**：只对选中的 Key 计算请求审计正常率，`正常率 = 1 - (观察 + 高风险) / 全部请求`。默认低于 90%、窗口内至少 20 次请求才告；可给单个 Key 覆盖阈值。未记录 Key 不参与。同一 Key 默认 30 分钟冷却。
- **上游成功率**：盯的是 `/status` 同一套口径，`成功率 = 2xx 且无 error_code`。15 分钟默认 80% / 最少 10 次，30 分钟默认 80% / 最少 20 次，可分开开关。多个窗口同时跌破时各发一条。默认 15 分钟冷却。
- 请求不足时不告、也不自动消警。恢复线默认为阈值 +5%，恢复时不发消息。单轮最多发送 10 条，多出来的 Key 下一轮再发。

## 和 grok-register 联动

配套注册项目：[kaibush/grok-register](https://github.com/kaibush/grok-register)

```text
grok-register 注册完成
  -> grok_build 导入 Grok2API 成功
  -> Webhook 通知本项目
  -> 匹配 Grok2API 账号
  -> 降低 grok2api 优先级，避免未验证账号进入生产流量
  -> 保存可选 SSO / 记录注册风险 / 可选自动创建探针
  -> 注册探针通过后恢复原优先级
```

只有 `grok_build` 已被 Grok2API 接收后才会发送事件。注册成功但导入失败时不会提前触发 GrokIQ。

### 怎么接

1. 在本项目打开“系统设置 → 注册联动”。
2. 设置 `grok-register` 联动令牌，复制页面生成的完整 Webhook 地址。
3. 按需开启“注册后自动探针”，选择方案并为每个方案设置执行轮次。
4. 在 `grok-register` 打开“系统设置 → Grok2API”，开启 GrokIQ 联动。
5. 粘贴 Webhook 地址和同一个 Token，保存即可。

独立部署时，Webhook 地址必须能从 `grok-register` 进程或容器访问。统一 Compose 中使用内部地址：

```text
http://grokiq-backend:8090/api/integrations/grok-register/account-imported
```

请求使用 `x-grokiq-token`，两边填写的 Token 必须一致。

最小请求体只需要邮箱，GrokIQ 会从 Grok2API 按邮箱精确匹配账号：

```json
{
  "email": "user@example.com"
}
```

调用方存在自动重试时，推荐提供稳定的 `event_id`；同一次事件的每次重试必须使用相同值：

```json
{
  "event_id": "registration:123:grok2api-imported",
  "email": "user@example.com",
  "sso": "sso=..."
}
```

完整请求体还支持以下可选字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `event_id` | string | 幂等事件 ID；省略时按邮箱生成 |
| `event_type` | string | 事件类型，默认 `grok2api.account_imported` |
| `registration_id` | string | 调用方自己的注册记录 ID |
| `grok2api_account_id` | integer | 已知时可传；未知时按邮箱匹配 |
| `sso` | string | 原始 SSO；供账号页批量检测。支持裸 token、`sso=` 前缀或 `email----token` |
| `bot_risk` | boolean | 注册阶段是否发现风控，默认 `false` |
| `bfs` | string / integer | 注册阶段的 bfs 风控值。`bot_risk=true` 且 `bfs` 为 `1` 或 `2` 时视为确认降智，接入后立即永久停用，不再排队注册探针 |
| `occurred_at` | string | 事件发生时间，建议使用 ISO 8601 |

接口返回 HTTP `202` 表示事件已经持久接收，账号匹配、失败重试和探针执行由后台继续完成。探针方案、模式、轮次和出口均使用 GrokIQ 的默认策略，调用方不需要传入。

### 投递行为

- `grok-register` 先把事件写入本地 Outbox，再由后台线程投递；网络错误或非 `2xx` 会自动退避重试。
- 每个注册结果使用稳定的 `event_id`。本项目按事件 ID 去重，重复投递不会重复创建探针；若后续重试带上新的 `sso`，会更新已保存的 SSO。
- 事件列表和 SSO 报告都不回传原始 SSO。未提供 `sso` 的账号可以继续做探针，但不能从账号页发起 SSO 检测。
- Webhook 返回 `2xx` 只表示本项目已接收。后续账号匹配、排队和探针执行由本项目继续处理。
- 如果账号暂时还没出现在 Grok2API，本项目会继续重试匹配；关闭自动探针时仍会保留导入事件。
- 开启注册后探针时，匹配到账号会立即降低 grok2api 优先级；全部注册探针通过后恢复原值。恢复失败由联动后台定时重试，探针未通过则保持低优先级。
- `grok-register` 的账号详情会显示投递状态、尝试次数、接收时间和最近错误，方便查联动问题。
### 回调通知

类似支付异步通知。GrokIQ 检测完成后向注册机 `POST /api/integrations/grokiq/notify`，请求头仍是 `x-grokiq-token`。注册机返回 HTTP `2xx` 表示已接收。

统一 Compose 中的通知地址：

```text
http://grok-register:8787/api/integrations/grokiq/notify
```

1. 在本项目打开“系统设置 → 注册联动”，开启“回调通知”并填写通知地址。
2. 两边使用同一个联动 Token。
3. 注册机按 `registration_id` 匹配账号，找不到再按邮箱；读取 `degraded` 判断是否降智，不要自动删号。
4. 账号中心列表和详情会显示 GrokIQ 检测结果。

触发时机：

- 注册机确认降智（`bot_risk=true` 且 `bfs` 为 `1` 或 `2`）后立即通知。
- 否则等该导入事件的注册探针全部结束后再通知。
- 关闭注册后探针时，导入完成也会通知一次。
- 每个导入事件只通知一次终态；失败会写入 Outbox 并退避重试。

请求体示例：

```json
{
  "event_id": "registration:123:grok2api-imported",
  "event_type": "grokiq.notify",
  "registration_id": "123",
  "email": "user@example.com",
  "account_id": 17,
  "occurred_at": "2026-08-30T12:00:00Z",
  "verdict": "degraded",
  "degraded": true,
  "monitor_status": "quarantined",
  "risk_score": 85,
  "risk_reasons": ["grok-register 确认降智"],
  "isolated": true,
  "probe_outcome": "confirmed_degraded",
  "run_ids": [],
  "source": "grok-register"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `event_id` | string | 与导入 Webhook 相同的事件 ID，用于幂等 |
| `event_type` | string | 固定 `grokiq.notify` |
| `registration_id` | string | 注册机账号记录 ID，优先按此匹配 |
| `email` | string | 账号邮箱；ID 匹配失败时按邮箱匹配 |
| `account_id` | integer | GrokIQ / grok2api 账号 ID |
| `occurred_at` | string | 通知时间，ISO 8601 |
| `degraded` | boolean | 是否降智，注册机应以此为准 |
| `verdict` | string | `normal` / `degraded` / `suspect` / `high_risk` / `quarantined` / `insufficient_samples` / `probe_failed` / `imported` |
| `monitor_status` | string | GrokIQ 监控状态 |
| `risk_score` | number | 风险分 |
| `risk_reasons` | string[] | 风险原因 |
| `isolated` | boolean | 是否已隔离 |
| `probe_outcome` | string | `passed` / `failed` / `insufficient` / `empty` / `skipped` / `confirmed_degraded` |
| `run_ids` | string[] | 注册探针任务 ID |
| `source` | string | `register_probe` 或 `grok-register` |

页面“系统设置 → 注册联动 → 检测回调通知”里也可以打开同样的协议说明。

### 三个服务一起跑

`grok-register` 仓库已经提供 `compose.grokiq.yaml`，可以一起启动注册机、GrokIQ 后端和 GrokIQ 前端：

```bash
git clone https://github.com/kaibush/grok-register.git
cd grok-register
cp .env.example .env

# 编辑 .env，至少设置：
# GROKIQ_GROK2API_BASE_URL
# GROKIQ_GROK2API_ADMIN_USERNAME
# GROKIQ_GROK2API_ADMIN_PASSWORD
# GROKIQ_WEBHOOK_TOKEN

docker compose -f compose.yaml -f compose.grokiq.yaml pull
docker compose -f compose.yaml -f compose.grokiq.yaml up -d
```

默认端口：`grok-register` 使用 `8787`，本项目 Web 页面使用 `8091`。探针配置只在本项目维护；注册机负责导入成功后发送事件，也可接收 GrokIQ 的检测回调通知。

新账号首次探针默认等待 `15` 秒，可通过 `GROKIQ_REGISTER_PROBE_STABILIZATION_SECONDS` 或“注册联动”调整；设为 `0` 可关闭等待。

## grok2api 运行依赖

本项目需要连接到具备管理员权限的 grok2api 实例。无需在本项目中复制账号或出口数据，但目标实例应提供以下能力：

| 能力 | 用途 |
| --- | --- |
| 管理员鉴权 | 连接检查、读取运行状态，以及执行受控的管理操作。 |
| 账号查询与分页搜索 | 在账号探针、计划任务和批量操作中实时加载账号。 |
| 出口节点查询 | 选择测试出口，并记录测试实际使用的出口。 |
| 账号状态与路由设置 | 批量启停账号；测试期间临时调整账号的出口、优先级或并发设置，并在完成后恢复。 |
| 临时模型路由与 Client Key | 将一次完整对话测试限定到指定账号，任务结束后自动清理。 |
| 对话补全与流式响应 | 执行完整对话测试，采集首 Token、生成时长、输出 Token 和响应正文。 |
| 快速出口质量测试 | 对已启用、配置代理的出口进行快速筛查。 |
| 请求审计查询 | 依据请求标识核验实际命中的账号和代理节点，为样本保留稳定路由依据；动态出口 IP 不作为历史审计字段。 |

首次启动后，可在“系统设置 → 连接与凭据”中填写服务地址和管理员凭据并测试连接。若缺少某项能力，对应页面会提示连接或执行失败；建议使用支持以上能力的 grok2api 版本。

## 快速开始

### Docker Compose 部署

```bash
cp .env.example .env
docker compose pull
docker compose up -d
```

默认访问地址为 `http://127.0.0.1:8091`。

首次进入时创建管理员账号；随后前往“系统设置”完成连接与运行参数配置，即可开始创建探针任务。

### iOS 主屏幕

手机请用 Safari 打开已部署的 HTTPS 地址（不要用电脑上的 `127.0.0.1`），点底部分享按钮，选择「添加到主屏幕」。之后从桌面图标打开即为全屏工作台。

数据刷新仍走页面内接口轮询；切到后台会被 iOS 挂起，再次打开时会重新拉数。未启用 Service Worker，避免 iOS 把旧前端钉死在主屏幕应用里。

公网域名应提供生产构建，不要把 Vite 开发服务暴露给手机。本机发布：

```bash
./deploy/publish-frontend.sh
```

前端代码更新后需要重新发布，主屏幕应用才会拿到新资源。若图标或旧页面仍在，删除主屏幕图标后重新添加即可。

### 版本检查与更新

GrokIQ 启动后会立即读取 `kaibush/grok-iq` 的最新 GitHub Release，之后每 1 小时检查一次。
发现高于当前 `VERSION` 的版本时，已登录页面会显示可关闭的更新弹框；“系统设置 → 版本更新”也可查看
当前版本、最新版本、Release 说明和最近检查时间，或手动触发检查。

本地运行 `npm run dev` 时，“版本更新”页会额外显示“预览提醒”按钮，用于模拟完整弹框；该入口由
`import.meta.env.DEV` 编译条件控制，生产构建不会显示，也不会向后端写入模拟版本。

更新已发布的容器：

```bash
docker compose --profile "*" pull
docker compose --profile "*" up -d --force-recreate --remove-orphans
```

标签构建会把标签版本注入后端镜像，并在镜像发布完成后创建对应 GitHub Release。仅有普通分支镜像且没有
Release 时，不会被版本检查识别为新版本。

如需从当前源码构建镜像：

```bash
docker compose up -d --build
```

### 本地开发

后端：

```bash
python3 -m venv .venv
.venv/bin/pip install -e 'backend[dev]'
cd backend
../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8090 --reload --http h11
```

前端：

```bash
cd frontend
npm ci
npm run dev
```

## 日常使用流程

1. 在“系统设置”完成连接、队列和风险规则配置。
2. 打开“账号探针”，筛选并选择需要关注的账号。
3. 选择测试方案、轮次和目标后创建任务。
4. 在“任务中心”跟踪进度；必要时停止、删除或重测。
5. 在账号或任务详情中查看样本证据和风险原因，再决定后续操作。
6. 对稳定重复的巡检需求，使用“定时计划”自动执行。

## 数据保存与备份

Docker Compose 默认使用命名卷 `grokiq-data` 保存运行数据，包括任务、样本、设置、自动生成的密钥和轮转日志。迁移或备份时，请将该数据卷作为一个整体处理。

## 许可

本项目采用 [MIT License](LICENSE)。
