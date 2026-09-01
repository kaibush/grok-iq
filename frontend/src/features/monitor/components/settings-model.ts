import type {
  AutoIsolationMinStatus,
  EditableRuntimeSettings,
  ExecutionMode,
  ProbeTpsOverrideMode,
  ProxyTarget,
  RuntimeSettings,
  RuntimeSettingsUpdate,
  SecretSettingName,
} from '@/lib/api'

export type SettingsForm = {
  grok2apiBaseUrl: string
  grok2apiAdminUsername: string
  grok2apiAdminPassword: string
  grok2apiHttpImpersonate: string
  grokRegisterWebhookToken: string
  ssoProxy: string
  initialProbeOnRegister: boolean
  registerProbeStabilizationSeconds: number
  registerProbeProfileIds: string[]
  registerProbeExecutionMode: ExecutionMode
  registerProbeRounds: number
  registerProbeProfileRounds: Record<string, number>
  registerProbeProxyTargets: ProxyTarget[]
  registerProbeSwitchOnDegradation: boolean
  registerPriorityHoldEnabled: boolean
  registerPriorityHold: number
  registerCallbackEnabled: boolean
  registerCallbackUrl: string
  registerCallbackTimeoutSeconds: number
  wechatNotificationEnabled: boolean
  wechatAppId: string
  wechatAppSecret: string
  wechatOpenid: string
  wechatTemplateId: string
  probeWorkerConcurrency: number
  probeQueueLimit: number
  probeStepDelaySeconds: number
  probeCurrentEgressIntervalSeconds: number
  probeTransientRetryAttempts: number
  probeTransientRetryBaseSeconds: number
  probeTransientRetryMaxSeconds: number
  probeRoutePrefix: string
  probeDiagnosticPriority: number
  requestAuditEnabled: boolean
  requestAuditAutoScanEnabled: boolean
  requestAuditAdaptiveScanEnabled: boolean
  requestAuditScanIntervalMinutes: number
  requestAuditBusyScanIntervalSeconds: number
  requestAuditNormalScanIntervalSeconds: number
  requestAuditIdleScanIntervalSeconds: number
  requestAuditBusyRequestsPerMinute: number
  requestAuditLiveRefreshEnabled: boolean
  requestAuditLiveRefreshSeconds: number
  requestAuditRetentionDays: number
  requestAuditRiskEnabled: boolean
  requestAuditIsolationEnabled: boolean
  reasoningZeroRiskEnabled: boolean
  reasoningModelPolicies: EditableRuntimeSettings['reasoningModelPolicies']
  mediaInputObserveEnabled: boolean
  riskRuleOverrides: EditableRuntimeSettings['riskRuleOverrides']
  riskRules: EditableRuntimeSettings['riskRules']
  requestAuditTpsOnlyDeprioritizeEnabled: boolean
  requestAuditTpsOnlyPriority: number
  requestAuditTpsOnlyMinCount: number
  requestAuditTpsCooldownMinutes: number
  analysisWindowHours: number
  degradationTps: number
  strongDegradationTps: number
  probeTpsOverrideEnabled: boolean
  probeTpsOverrideMode: ProbeTpsOverrideMode
  probeTpsOverrideMinFirstTokenMs: number
  probeTpsOverrideMaxGenerationMs: number
  consecutiveAnomalies: number
  cumulativeAnomalyRate: number
  highRiskHardCount: number
  riskAnomalyRateWeight: number
  riskHardWeight: number
  riskHardCap: number
  riskFastWeight: number
  riskFastCap: number
  riskMarkerMissWeight: number
  riskMarkerMissCap: number
  riskStreakWeight: number
  riskStreakCap: number
  riskScoreCap: number
  riskWatchFloor: number
  riskSuspectFloor: number
  riskHighFloor: number
  bufferFirstTokenShare: number
  minGenerationMs: number
  minimumOutputTokens: number
  autoQuarantine: boolean
  autoQuarantineRecoveryEnabled: boolean
  autoIsolationEnabled: boolean
  autoIsolationMinStatus: AutoIsolationMinStatus
  qualityRetryIsolationEnabled: boolean
  qualityRetryIsolationIntervalSeconds: number
  quarantineMinutes: number
}

export const AUTO_ISOLATION_MIN_STATUS_OPTIONS: {
  value: AutoIsolationMinStatus
  label: string
  hint: string
}[] = [
  {
    value: 'watch',
    label: '观察',
    hint: '观察、疑似降智和高风险都会移入',
  },
  {
    value: 'suspect',
    label: '疑似降智',
    hint: '疑似降智和高风险都会移入',
  },
  {
    value: 'high_risk',
    label: '高风险',
    hint: '仅高风险会移入',
  },
]

export function autoIsolationMinStatusLabel(
  status: AutoIsolationMinStatus
): string {
  return (
    AUTO_ISOLATION_MIN_STATUS_OPTIONS.find((item) => item.value === status)
      ?.label ?? '高风险'
  )
}

export function normalizeProbeTpsOverrideMode(
  value: unknown,
  enabled?: boolean
): ProbeTpsOverrideMode {
  if (
    value === 'off' ||
    value === 'generation_window' ||
    value === 'missing_reasoning'
  ) {
    return value
  }
  if (enabled === true) return 'generation_window'
  if (enabled === false) return 'off'
  return 'missing_reasoning'
}

export type SettingsSetter = <K extends keyof SettingsForm>(
  key: K,
  value: SettingsForm[K]
) => void

export const secretMetadata: Record<
  SecretSettingName,
  { label: string; placeholder: string; configuredKey: keyof RuntimeSettings }
> = {
  grok2apiAdminPassword: {
    label: '管理员密码',
    placeholder: '留空保持当前密码',
    configuredKey: 'grok2apiAdminPasswordConfigured',
  },
  grokRegisterWebhookToken: {
    label: 'grok-register 联动令牌',
    placeholder: '留空保持当前令牌',
    configuredKey: 'grokRegisterWebhookTokenConfigured',
  },
  ssoProxy: {
    label: 'SSO 检测代理',
    placeholder: '留空保持当前代理',
    configuredKey: 'ssoProxyConfigured',
  },
  wechatAppSecret: {
    label: '微信 AppSecret',
    placeholder: '留空保持当前 AppSecret',
    configuredKey: 'wechatAppSecretConfigured',
  },
}

export const RECOMMENDED_RISK_SCORING = {
  riskAnomalyRateWeight: 30,
  riskHardWeight: 6,
  riskHardCap: 24,
  riskFastWeight: 12,
  riskFastCap: 30,
  riskMarkerMissWeight: 16,
  riskMarkerMissCap: 32,
  riskStreakWeight: 3,
  riskStreakCap: 15,
} as const

export const REGISTER_WEBHOOK_PATH =
  '/api/integrations/grok-register/account-imported'
export const GROK_REGISTER_REPOSITORY_URL =
  'https://github.com/kaibush/grok-register'
export const REGISTER_PROBE_EXECUTION_MODE: ExecutionMode = 'chat'
export const REGISTER_PROBE_ROUNDS = 3
export const REGISTER_PROBE_PROXY_TARGETS: ProxyTarget[] = [
  { kind: 'current', id: null },
]

export function moveOrderedId(
  ids: string[],
  id: string,
  offset: -1 | 1
): string[] {
  const next = Array.from(
    new Set(ids.map((value) => value.trim()).filter(Boolean))
  )
  const index = next.indexOf(id)
  const target = index + offset
  if (index < 0 || target < 0 || target >= next.length) {
    return next
  }
  const current = next[index]
  const other = next[target]
  if (current === undefined || other === undefined) {
    return next
  }
  next[index] = other
  next[target] = current
  return next
}

export function mergeEnabledProfileIds(
  selectedIds: string[],
  enabledIds: string[]
): string[] {
  const selected = Array.from(
    new Set(selectedIds.map((value) => value.trim()).filter(Boolean))
  )
  const enabledSet = new Set(enabledIds)
  const kept = selected.filter((value) => enabledSet.has(value))
  const keptSet = new Set(kept)
  return [...kept, ...enabledIds.filter((value) => !keptSet.has(value))]
}

export function syncRegisterProbeProfileRounds(
  profileIds: string[],
  current: Record<string, number> | null | undefined,
  fallback: number
): Record<string, number> {
  const source = current ?? {}
  const safeFallback =
    Number.isFinite(fallback) && fallback >= 1 && fallback <= 20
      ? Math.trunc(fallback)
      : REGISTER_PROBE_ROUNDS
  const next: Record<string, number> = {}
  for (const id of profileIds) {
    const value = source[id]
    next[id] =
      Number.isFinite(value) && value >= 1 && value <= 20
        ? Math.trunc(value)
        : safeFallback
  }
  return next
}

export const REGISTER_WEBHOOK_MINIMAL_BODY = `{
  "email": "user@example.com"
}`
export const REGISTER_WEBHOOK_RECOMMENDED_BODY = `{
  "event_id": "registration:123:grok2api-imported",
  "email": "user@example.com",
  "sso": "sso=..."
}`
export const REGISTER_CALLBACK_PLACEHOLDER_URL =
  'http://grok-register:8787/api/integrations/grokiq/notify'
export const REGISTER_CALLBACK_EXAMPLE_BODY = `{
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
}`
export const WECHAT_TEMPLATE_BODY = `{{first.DATA}}
账号：{{account.DATA}}
状态：{{status.DATA}}
风险分：{{score.DATA}}
TPS：{{tps.DATA}}
原因：{{reason.DATA}}
时间：{{time.DATA}}
{{remark.DATA}}`

export function registerWebhookUrl() {
  if (typeof window === 'undefined') return REGISTER_WEBHOOK_PATH
  return new URL(REGISTER_WEBHOOK_PATH, window.location.origin).toString()
}

export function toSettingsForm(
  settings: EditableRuntimeSettings
): SettingsForm {
  return {
    grok2apiBaseUrl: settings.grok2apiBaseUrl,
    grok2apiAdminUsername: settings.grok2apiAdminUsername,
    grok2apiAdminPassword: settings.grok2apiAdminPassword,
    grok2apiHttpImpersonate: settings.grok2apiHttpImpersonate,
    grokRegisterWebhookToken: settings.grokRegisterWebhookToken,
    ssoProxy: settings.ssoProxy ?? '',
    initialProbeOnRegister: settings.initialProbeOnRegister,
    registerProbeStabilizationSeconds:
      settings.registerProbeStabilizationSeconds ?? 15,
    registerProbeProfileIds: settings.registerProbeProfileIds,
    registerProbeExecutionMode: REGISTER_PROBE_EXECUTION_MODE,
    registerProbeRounds: settings.registerProbeRounds ?? REGISTER_PROBE_ROUNDS,
    registerProbeProfileRounds: syncRegisterProbeProfileRounds(
      settings.registerProbeProfileIds,
      settings.registerProbeProfileRounds,
      settings.registerProbeRounds ?? REGISTER_PROBE_ROUNDS
    ),
    registerProbeProxyTargets: REGISTER_PROBE_PROXY_TARGETS,
    registerProbeSwitchOnDegradation:
      settings.registerProbeSwitchOnDegradation ?? true,
    registerPriorityHoldEnabled: settings.registerPriorityHoldEnabled ?? true,
    registerPriorityHold: settings.registerPriorityHold ?? -1_000_000,
    registerCallbackEnabled: settings.registerCallbackEnabled ?? false,
    registerCallbackUrl: settings.registerCallbackUrl ?? '',
    registerCallbackTimeoutSeconds: settings.registerCallbackTimeoutSeconds ?? 10,
    wechatNotificationEnabled: settings.wechatNotificationEnabled,
    wechatAppId: settings.wechatAppId,
    wechatAppSecret: settings.wechatAppSecret,
    wechatOpenid: settings.wechatOpenid,
    wechatTemplateId: settings.wechatTemplateId,
    probeWorkerConcurrency: settings.probeWorkerConcurrency,
    probeQueueLimit: settings.probeQueueLimit,
    probeStepDelaySeconds: settings.probeStepDelaySeconds,
    probeCurrentEgressIntervalSeconds:
      settings.probeCurrentEgressIntervalSeconds ?? 10,
    probeTransientRetryAttempts: settings.probeTransientRetryAttempts ?? 2,
    probeTransientRetryBaseSeconds:
      settings.probeTransientRetryBaseSeconds ?? 5,
    probeTransientRetryMaxSeconds: settings.probeTransientRetryMaxSeconds ?? 30,
    probeRoutePrefix: settings.probeRoutePrefix,
    probeDiagnosticPriority: settings.probeDiagnosticPriority,
    requestAuditEnabled: settings.requestAuditEnabled ?? true,
    requestAuditAutoScanEnabled: settings.requestAuditAutoScanEnabled ?? true,
    requestAuditAdaptiveScanEnabled:
      settings.requestAuditAdaptiveScanEnabled ?? true,
    requestAuditScanIntervalMinutes:
      settings.requestAuditScanIntervalMinutes ?? 5,
    requestAuditBusyScanIntervalSeconds:
      settings.requestAuditBusyScanIntervalSeconds ?? 30,
    requestAuditNormalScanIntervalSeconds:
      settings.requestAuditNormalScanIntervalSeconds ?? 120,
    requestAuditIdleScanIntervalSeconds:
      settings.requestAuditIdleScanIntervalSeconds ?? 300,
    requestAuditBusyRequestsPerMinute:
      settings.requestAuditBusyRequestsPerMinute ?? 20,
    requestAuditLiveRefreshEnabled:
      settings.requestAuditLiveRefreshEnabled ?? true,
    requestAuditLiveRefreshSeconds:
      settings.requestAuditLiveRefreshSeconds ?? 30,
    requestAuditRetentionDays: settings.requestAuditRetentionDays ?? 90,
    requestAuditRiskEnabled: settings.requestAuditRiskEnabled ?? true,
    requestAuditIsolationEnabled:
      settings.requestAuditIsolationEnabled ?? true,
    reasoningZeroRiskEnabled: settings.reasoningZeroRiskEnabled ?? true,
    reasoningModelPolicies: (settings.reasoningModelPolicies ?? []).map(
      (policy) => ({
        ...policy,
        model: policy.model ?? '*',
        operation: policy.operation ?? '*',
        mode: policy.mode ?? 'observe',
        minimumOutputTokens: policy.minimumOutputTokens ?? 32,
        minCount: policy.minCount ?? 2,
        mediaInputMode: policy.mediaInputMode ?? 'inherit',
      })
    ),
    mediaInputObserveEnabled: settings.mediaInputObserveEnabled ?? true,
    riskRuleOverrides: settings.riskRuleOverrides ?? [],
    riskRules: settings.riskRules ?? [],
    requestAuditTpsOnlyDeprioritizeEnabled:
      settings.requestAuditTpsOnlyDeprioritizeEnabled ?? true,
    requestAuditTpsOnlyPriority:
      settings.requestAuditTpsOnlyPriority ?? -1_000_000,
    requestAuditTpsOnlyMinCount: settings.requestAuditTpsOnlyMinCount ?? 2,
    requestAuditTpsCooldownMinutes:
      settings.requestAuditTpsCooldownMinutes ?? 30,
    analysisWindowHours: settings.analysisWindowHours,
    degradationTps: settings.degradationTps,
    strongDegradationTps: settings.strongDegradationTps,
    probeTpsOverrideEnabled:
      normalizeProbeTpsOverrideMode(
        settings.probeTpsOverrideMode,
        settings.probeTpsOverrideEnabled
      ) !== 'off',
    probeTpsOverrideMode: normalizeProbeTpsOverrideMode(
      settings.probeTpsOverrideMode,
      settings.probeTpsOverrideEnabled
    ),
    probeTpsOverrideMinFirstTokenMs:
      settings.probeTpsOverrideMinFirstTokenMs ?? 5000,
    probeTpsOverrideMaxGenerationMs:
      settings.probeTpsOverrideMaxGenerationMs ?? 1000,
    consecutiveAnomalies: settings.consecutiveAnomalies,
    cumulativeAnomalyRate: settings.cumulativeAnomalyRate,
    highRiskHardCount: settings.highRiskHardCount,
    riskAnomalyRateWeight: settings.riskAnomalyRateWeight,
    riskHardWeight: settings.riskHardWeight,
    riskHardCap: settings.riskHardCap,
    riskFastWeight: settings.riskFastWeight,
    riskFastCap: settings.riskFastCap,
    riskMarkerMissWeight: settings.riskMarkerMissWeight,
    riskMarkerMissCap: settings.riskMarkerMissCap,
    riskStreakWeight: settings.riskStreakWeight,
    riskStreakCap: settings.riskStreakCap,
    riskScoreCap: settings.riskScoreCap,
    riskWatchFloor: settings.riskWatchFloor,
    riskSuspectFloor: settings.riskSuspectFloor,
    riskHighFloor: settings.riskHighFloor,
    bufferFirstTokenShare: settings.bufferFirstTokenShare,
    minGenerationMs: settings.minGenerationMs,
    minimumOutputTokens: settings.minimumOutputTokens,
    autoQuarantine: settings.autoQuarantine,
    autoQuarantineRecoveryEnabled:
      settings.autoQuarantineRecoveryEnabled ?? true,
    autoIsolationEnabled: settings.autoIsolationEnabled ?? false,
    autoIsolationMinStatus: settings.autoIsolationMinStatus ?? 'high_risk',
    qualityRetryIsolationEnabled:
      settings.qualityRetryIsolationEnabled ?? false,
    qualityRetryIsolationIntervalSeconds:
      settings.qualityRetryIsolationIntervalSeconds ?? 60,
    quarantineMinutes: settings.quarantineMinutes,
  }
}

export function buildSettingsPayload(
  form: SettingsForm,
  clearSecrets: SecretSettingName[],
  original: EditableRuntimeSettings
): RuntimeSettingsUpdate {
  const payload: RuntimeSettingsUpdate = {
    grok2apiBaseUrl: form.grok2apiBaseUrl.trim(),
    grok2apiAdminUsername: form.grok2apiAdminUsername.trim(),
    grok2apiHttpImpersonate: form.grok2apiHttpImpersonate.trim(),
    initialProbeOnRegister: form.initialProbeOnRegister,
    registerProbeStabilizationSeconds: form.registerProbeStabilizationSeconds,
    registerProbeProfileIds: form.registerProbeProfileIds,
    registerProbeExecutionMode: REGISTER_PROBE_EXECUTION_MODE,
    registerProbeRounds: form.registerProbeRounds,
    registerProbeProfileRounds: syncRegisterProbeProfileRounds(
      form.registerProbeProfileIds,
      form.registerProbeProfileRounds,
      form.registerProbeRounds
    ),
    registerProbeProxyTargets: REGISTER_PROBE_PROXY_TARGETS,
    registerProbeSwitchOnDegradation: form.registerProbeSwitchOnDegradation,
    registerPriorityHoldEnabled: form.registerPriorityHoldEnabled,
    registerPriorityHold: form.registerPriorityHold,
    registerCallbackEnabled: form.registerCallbackEnabled,
    registerCallbackUrl: form.registerCallbackUrl.trim(),
    registerCallbackTimeoutSeconds: form.registerCallbackTimeoutSeconds,
    wechatNotificationEnabled: form.wechatNotificationEnabled,
    wechatAppId: form.wechatAppId.trim(),
    wechatOpenid: form.wechatOpenid.trim(),
    wechatTemplateId: form.wechatTemplateId.trim(),
    probeWorkerConcurrency: form.probeWorkerConcurrency,
    probeQueueLimit: form.probeQueueLimit,
    probeStepDelaySeconds: form.probeStepDelaySeconds,
    probeCurrentEgressIntervalSeconds: form.probeCurrentEgressIntervalSeconds,
    probeTransientRetryAttempts: form.probeTransientRetryAttempts,
    probeTransientRetryBaseSeconds: form.probeTransientRetryBaseSeconds,
    probeTransientRetryMaxSeconds: form.probeTransientRetryMaxSeconds,
    probeRoutePrefix: form.probeRoutePrefix.trim(),
    probeDiagnosticPriority: form.probeDiagnosticPriority,
    requestAuditEnabled: form.requestAuditEnabled,
    requestAuditAutoScanEnabled: form.requestAuditAutoScanEnabled,
    requestAuditAdaptiveScanEnabled: form.requestAuditAdaptiveScanEnabled,
    requestAuditScanIntervalMinutes: form.requestAuditScanIntervalMinutes,
    requestAuditBusyScanIntervalSeconds:
      form.requestAuditBusyScanIntervalSeconds,
    requestAuditNormalScanIntervalSeconds:
      form.requestAuditNormalScanIntervalSeconds,
    requestAuditIdleScanIntervalSeconds:
      form.requestAuditIdleScanIntervalSeconds,
    requestAuditBusyRequestsPerMinute:
      form.requestAuditBusyRequestsPerMinute,
    requestAuditLiveRefreshEnabled: form.requestAuditLiveRefreshEnabled,
    requestAuditLiveRefreshSeconds: form.requestAuditLiveRefreshSeconds,
    requestAuditRetentionDays: form.requestAuditRetentionDays,
    requestAuditRiskEnabled: form.requestAuditRiskEnabled,
    requestAuditIsolationEnabled: form.requestAuditIsolationEnabled,
    reasoningZeroRiskEnabled: form.reasoningZeroRiskEnabled,
    reasoningModelPolicies: form.reasoningModelPolicies,
    mediaInputObserveEnabled: form.mediaInputObserveEnabled,
    riskRuleOverrides: form.riskRuleOverrides,
    requestAuditTpsOnlyDeprioritizeEnabled:
      form.requestAuditTpsOnlyDeprioritizeEnabled,
    requestAuditTpsOnlyPriority: form.requestAuditTpsOnlyPriority,
    requestAuditTpsOnlyMinCount: form.requestAuditTpsOnlyMinCount,
    requestAuditTpsCooldownMinutes: form.requestAuditTpsCooldownMinutes,
    analysisWindowHours: form.analysisWindowHours,
    degradationTps: form.degradationTps,
    strongDegradationTps: form.strongDegradationTps,
    probeTpsOverrideEnabled: form.probeTpsOverrideMode !== 'off',
    probeTpsOverrideMode: form.probeTpsOverrideMode,
    probeTpsOverrideMinFirstTokenMs: form.probeTpsOverrideMinFirstTokenMs,
    probeTpsOverrideMaxGenerationMs: form.probeTpsOverrideMaxGenerationMs,
    consecutiveAnomalies: form.consecutiveAnomalies,
    cumulativeAnomalyRate: form.cumulativeAnomalyRate,
    highRiskHardCount: form.highRiskHardCount,
    riskAnomalyRateWeight: form.riskAnomalyRateWeight,
    riskHardWeight: form.riskHardWeight,
    riskHardCap: form.riskHardCap,
    riskFastWeight: form.riskFastWeight,
    riskFastCap: form.riskFastCap,
    riskMarkerMissWeight: form.riskMarkerMissWeight,
    riskMarkerMissCap: form.riskMarkerMissCap,
    riskStreakWeight: form.riskStreakWeight,
    riskStreakCap: form.riskStreakCap,
    riskScoreCap: form.riskScoreCap,
    riskWatchFloor: form.riskWatchFloor,
    riskSuspectFloor: form.riskSuspectFloor,
    riskHighFloor: form.riskHighFloor,
    bufferFirstTokenShare: form.bufferFirstTokenShare,
    minGenerationMs: form.minGenerationMs,
    minimumOutputTokens: form.minimumOutputTokens,
    autoQuarantine: form.autoQuarantine,
    autoQuarantineRecoveryEnabled: form.autoQuarantineRecoveryEnabled,
    autoIsolationEnabled: form.autoIsolationEnabled,
    autoIsolationMinStatus: form.autoIsolationMinStatus,
    qualityRetryIsolationEnabled: form.qualityRetryIsolationEnabled,
    qualityRetryIsolationIntervalSeconds:
      form.qualityRetryIsolationIntervalSeconds,
    quarantineMinutes: form.quarantineMinutes,
    clearSecrets,
  }
  if (
    !clearSecrets.includes('grok2apiAdminPassword') &&
    form.grok2apiAdminPassword.trim() &&
    form.grok2apiAdminPassword !== original.grok2apiAdminPassword
  ) {
    payload.grok2apiAdminPassword = form.grok2apiAdminPassword
  }
  if (
    !clearSecrets.includes('grokRegisterWebhookToken') &&
    form.grokRegisterWebhookToken.trim() &&
    form.grokRegisterWebhookToken !== original.grokRegisterWebhookToken
  ) {
    payload.grokRegisterWebhookToken = form.grokRegisterWebhookToken
  }
  if (
    !clearSecrets.includes('ssoProxy') &&
    form.ssoProxy.trim() &&
    form.ssoProxy !== original.ssoProxy
  ) {
    payload.ssoProxy = form.ssoProxy
  }
  if (
    !clearSecrets.includes('wechatAppSecret') &&
    form.wechatAppSecret.trim() &&
    form.wechatAppSecret !== original.wechatAppSecret
  ) {
    payload.wechatAppSecret = form.wechatAppSecret
  }
  return payload
}

export function mergeEditableSettings(
  currentSettings: RuntimeSettings,
  form: SettingsForm,
  clearSecrets: SecretSettingName[]
): EditableRuntimeSettings {
  return {
    ...currentSettings,
    grok2apiAdminPassword: clearSecrets.includes('grok2apiAdminPassword')
      ? ''
      : form.grok2apiAdminPassword,
    grokRegisterWebhookToken: clearSecrets.includes('grokRegisterWebhookToken')
      ? ''
      : form.grokRegisterWebhookToken,
    ssoProxy: clearSecrets.includes('ssoProxy') ? '' : form.ssoProxy,
    wechatAppSecret: clearSecrets.includes('wechatAppSecret')
      ? ''
      : form.wechatAppSecret,
  }
}

export function setRiskRuleEnabled(
  form: SettingsForm,
  ruleId: string,
  enabled: boolean
) {
  const current = form.riskRuleOverrides.find((item) => item.id === ruleId)
  const next = {
    ...(current ?? { id: ruleId }),
    enabled,
  }
  return [...form.riskRuleOverrides.filter((item) => item.id !== ruleId), next]
}

export function setRiskRulePriority(
  form: SettingsForm,
  ruleId: string,
  priority: number
) {
  const current = form.riskRuleOverrides.find((item) => item.id === ruleId)
  const next = {
    ...(current ?? { id: ruleId }),
    priority,
  }
  return [...form.riskRuleOverrides.filter((item) => item.id !== ruleId), next]
}

export function validateSettings(form: SettingsForm) {
  if (
    form.requestAuditAdaptiveScanEnabled &&
    !(
      form.requestAuditBusyScanIntervalSeconds <=
        form.requestAuditNormalScanIntervalSeconds &&
      form.requestAuditNormalScanIntervalSeconds <=
        form.requestAuditIdleScanIntervalSeconds
    )
  ) {
    throw new Error('请求审计扫描间隔必须满足忙时 ≤ 常态 ≤ 闲时')
  }
  const policyKeys = new Set<string>()
  for (const policy of form.reasoningModelPolicies) {
    const model = policy.model.trim()
    if (!model) throw new Error('思考模型策略必须填写上游模型')
    const canonicalModel = model.toLowerCase().replace(/^build\//, '')
    const key = `${canonicalModel}::${policy.operation}`
    if (policyKeys.has(key)) {
      throw new Error(
        `思考模型策略重复或别名冲突：${model} / ${policy.operation}`
      )
    }
    policyKeys.add(key)
    if (policy.minimumOutputTokens < 1 || policy.minimumOutputTokens > 4096) {
      throw new Error('思考模型策略最低输出 Token 必须在 1–4096 之间')
    }
    if (policy.minCount < 2 || policy.minCount > 100) {
      throw new Error('思考模型策略连续命中次数必须在 2–100 之间')
    }
  }
  if (!policyKeys.has('*::*')) {
    throw new Error('思考模型策略必须保留 * / * 默认观察规则')
  }
  if (form.degradationTps >= form.strongDegradationTps) {
    throw new Error('降智信号 TPS 下限必须小于强降智信号 TPS 下限')
  }
  if (!(
    form.riskWatchFloor <= form.riskSuspectFloor &&
    form.riskSuspectFloor <= form.riskHighFloor &&
    form.riskHighFloor <= form.riskScoreCap
  )) {
    throw new Error('风险状态保底分必须满足观察 ≤ 疑似 ≤ 高风险 ≤ 总分上限')
  }
  const scoreFactors = [
    ['强信号', form.riskHardWeight, form.riskHardCap],
    ['持续高速', form.riskFastWeight, form.riskFastCap],
    ['标记缺失', form.riskMarkerMissWeight, form.riskMarkerMissCap],
    ['连续信号', form.riskStreakWeight, form.riskStreakCap],
  ] as const
  for (const [label, weight, cap] of scoreFactors) {
    if (weight > 0 && cap <= 0) {
      throw new Error(`${label}权重大于 0 时封顶分必须大于 0`)
    }
  }
  if (
    form.probeTransientRetryBaseSeconds > form.probeTransientRetryMaxSeconds
  ) {
    throw new Error('探针重试基础等待不能大于最大等待')
  }
  if (!form.grok2apiBaseUrl.trim()) {
    throw new Error('请填写 grok2api 服务地址')
  }
  if (
    form.wechatNotificationEnabled &&
    (!form.wechatAppId.trim() ||
      !form.wechatAppSecret.trim() ||
      !form.wechatOpenid.trim() ||
      !form.wechatTemplateId.trim())
  ) {
    throw new Error(
      '开启微信异常推送前请填写 AppID、AppSecret、OpenID 和模板 ID'
    )
  }
  if (form.initialProbeOnRegister && !form.registerProbeProfileIds.length) {
    throw new Error('注册后探针至少选择一个探针方案')
  }
  for (const profileId of form.registerProbeProfileIds) {
    const rounds = form.registerProbeProfileRounds[profileId]
    if (!Number.isFinite(rounds) || rounds < 1 || rounds > 20) {
      throw new Error(`探针方案 ${profileId} 的执行轮数需在 1–20 之间`)
    }
  }
  if (
    !Number.isFinite(form.registerProbeStabilizationSeconds) ||
    form.registerProbeStabilizationSeconds < 0 ||
    form.registerProbeStabilizationSeconds > 300
  ) {
    throw new Error('新账号稳定等待需在 0–300 秒之间')
  }
  if (
    !Number.isFinite(form.registerPriorityHold) ||
    form.registerPriorityHold < -2_000_000_000 ||
    form.registerPriorityHold > 0
  ) {
    throw new Error('注册账号临时优先级需在 -2000000000–0 之间')
  }
  if (form.registerCallbackEnabled) {
    const url = form.registerCallbackUrl.trim()
    if (!url) {
      throw new Error('开启回调通知前请填写通知地址')
    }
    let parsed: URL | undefined
    try {
      parsed = new URL(url)
    } catch {
      parsed = undefined
    }
    if (
      parsed == null ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    ) {
      throw new Error('回调通知地址必须是有效的 HTTP(S) URL')
    }
    if (
      !Number.isFinite(form.registerCallbackTimeoutSeconds) ||
      form.registerCallbackTimeoutSeconds < 1 ||
      form.registerCallbackTimeoutSeconds > 60
    ) {
      throw new Error('回调通知超时需在 1–60 秒之间')
    }
  }
}
