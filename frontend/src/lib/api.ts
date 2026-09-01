import { useAuthStore, type AuthUser } from '@/stores/auth-store'

const API_BASE = String(import.meta.env.VITE_API_BASE_URL ?? '/api').replace(
  /\/$/,
  ''
)

export type ExecutionMode = 'chat' | 'quality_test'

export type AuthStatus = {
  setupRequired: boolean
  authenticated: boolean
  user: AuthUser | null
}

export type PublicUpstreamProvider = 'grok_build' | 'grok_web' | 'grok_console'

export type PublicUpstreamProviderCounts = {
  capacity?: number
  total?: number
  available?: number
}

export type PublicUpstreamAccountSummary = {
  reachable: boolean
  updatedAt: string | null
  providers: Record<PublicUpstreamProvider, PublicUpstreamProviderCounts>
  total?: number
  risk?: number
  available?: number
  recovering?: number
  attention?: number
  recovery?: {
    cooldown: number
    waitingReset: number
    probing: number
  }
  issues?: {
    disabled: number
    reauthRequired: number
  }
}

export type PublicClientKeyQuota = {
  found: true
  name: string
  prefix: string
  enabled: boolean
  expired: boolean
  expiresAt: string | null
  lastUsedAt: string | null
  unlimited: boolean
  billingLimitUsd: number
  billedUsageUsd: number
  remainingUsd: number
  usagePercent: number
}

export type PublicClientKeyQuotaLookup =
  | { found: false }
  | PublicClientKeyQuota

export type ClientKeyUsagePeriod = '24h' | '7d' | '30d' | '90d' | 'custom'

export type ClientKeyUsageTotals = {
  requests: number
  successfulRequests: number
  failedRequests: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  durationMs: number
  estimatedCostInUsdTicks: number
  averageDurationMs: number
  successRate: number
  cacheHitRate: number
}

export type PublicUpstreamUsagePeriod = '24h' | '7d' | '30d' | '90d'

export type PublicUpstreamUsageTotals = {
  requests: number
  successfulRequests: number
  failedRequests: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  tokens: number
  billedCostUsdTicks: number
  successRate: number
  cacheHitRate: number
  averageFirstTokenMs: number
  outputTokensPerSecond: number
  firstTokenSamples: number
  throughputSamples: number
}

export type PublicUpstreamUsageSeriesPoint = {
  start: string
  end: string
  requests: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  tokens: number
  billedCostUsdTicks: number
}

export type PublicUpstreamUsageActivityPoint = {
  start: string
  requests: number
}

export type PublicUpstreamUsageModel = {
  model: string
  requests: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  tokens: number
  billedCostUsdTicks: number
}

export type PublicUpstreamUsageProviderStat = {
  provider: string
  requests: number
  successfulRequests: number
  tokens: number
}

export type PublicUpstreamUsageOverview = {
  reachable: boolean
  period: PublicUpstreamUsagePeriod
  generatedAt: string | null
  range: { start: string | null; end: string | null }
  usage: PublicUpstreamUsageTotals
  series: PublicUpstreamUsageSeriesPoint[]
  activity: PublicUpstreamUsageActivityPoint[]
  topModels: PublicUpstreamUsageModel[]
  providers: PublicUpstreamUsageProviderStat[]
}

export type PublicClientKeyUsage = {
  found: true
  period: string
  sourcePeriod: string
  range: { start: string; end: string }
  truncated: boolean
  usage: ClientKeyUsageTotals
}

export type PublicClientKeyUsageLookup =
  | { found: false }
  | PublicClientKeyUsage

export type AuthSession = {
  accessToken: string
  tokenType: 'bearer'
  expiresAt: string
  user: AuthUser
}

export type OnboardingState = {
  completed: boolean
  ready: boolean
  requirements: {
    grok2apiBaseUrl: boolean
    grok2apiAdminUsername: boolean
    grok2apiAdminPassword: boolean
  }
}

export type OnboardingCompleteResult = OnboardingState & {
  settings: RuntimeSettings
  connection: {
    ok: true
    baseUrl: string
    grokBuild: Record<string, unknown>
  }
}

export type SystemVersionStatus =
  | 'idle'
  | 'checking'
  | 'no_release'
  | 'up_to_date'
  | 'update_available'
  | 'error'

export type SystemVersionInfo = {
  status: SystemVersionStatus
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string
  releaseNotes: string
  publishedAt: string
  checkedAt: string
  error: string
}

export type SsoReportStatus = 'queued' | 'running' | 'completed' | 'failed'

export type RegisterWebhookEventStatus =
  'pending' | 'processing' | 'completed' | 'failed'

export type RegisterPriorityHoldStatus =
  | 'none'
  | 'held'
  | 'restored'
  | 'restore_failed'
  | 'kept'

export type RegisterWebhookEvent = {
  event_id: string
  event_type: string
  registration_id: string
  email: string
  grok2api_account_id: number | null
  bot_risk: boolean
  bfs: string
  occurred_at: string
  status: RegisterWebhookEventStatus
  attempts: number
  last_error: string
  resolved_account_id: number | null
  run_ids: string[]
  next_attempt_at: string
  created_at: string
  updated_at: string
  completed_at: string | null
  original_priority?: number | null
  held_priority?: number | null
  priority_hold_status?: RegisterPriorityHoldStatus
  priority_hold_error?: string
  priority_held_at?: string | null
  priority_restored_at?: string | null
}

export type RegisterWebhookEventsResponse = Page<RegisterWebhookEvent> & {
  statusCounts: Record<RegisterWebhookEventStatus, number>
  dueCount: number
  retryingCount: number
}

type SsoReportSummary = {
  total: number
  valid: number
  clean: number
  flagged: number
  mismatched: number
  invalid: number
  errors: number
  valid_rate: number
  flagged_rate: number
  verdict_distribution: Record<string, number>
  bot_flag_distribution: Record<string, number>
  region_distribution: Record<string, number>
  median_response_ms: number
}

export type SsoReportItem = {
  id: string
  name: string
  status: SsoReportStatus
  total: number
  completed_count: number
  progress_percent: number
  queue_position: number | null
  valid: number
  clean: number
  flagged: number
  mismatched: number
  invalid: number
  errors: number
  elapsed_seconds: number
  summary: Partial<SsoReportSummary>
  proxy_used: boolean
  concurrency: number
  request_timeout_seconds: number
  error: string
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export type SsoCheckResult = {
  account_id?: number | null
  label: string
  expected_email: string
  checked_at: string
  jwt_valid: boolean
  status_code: number
  final_url: string
  valid_session: boolean
  email_match: boolean | null
  verdict: string
  account: {
    email?: string
    user_id?: string
    given_name?: string
    family_name?: string
    display_name?: string
    email_confirmed?: boolean | null
    session_tier_id?: string
    x_subscription_type?: string
    country_code?: string
    region?: string
    region_code?: string
    organization_id?: string
    organization_type?: number | null
    create_time?: number | null
  }
  bot_flag: {
    found: boolean
    source: number | null
    details: string
    policy: string
    risk: number | null
    event: string
    denied: boolean
    flagged: boolean
  }
  error: string
  response_ms: number
  account_action?: {
    status: string
    error?: string
  }
}

export type SsoReportDetail = SsoReportItem & {
  results: SsoCheckResult[]
}

export type AccountSsoReportResult = SsoReportDetail & {
  requested: number
  included: number
  missingAccountIds: number[]
}

export type AuthenticationRequiredCode =
  'authentication_required' | 'setup_required'
export const AUTH_REQUIRED_EVENT = 'grokiq-auth-required'
const AUTH_REQUIRED_CODES = new Set<AuthenticationRequiredCode>([
  'authentication_required',
  'setup_required',
])

export class ApiError extends Error {
  status: number
  code?: string
  setupRequired?: boolean

  constructor(
    message: string,
    status: number,
    options: { code?: string; setupRequired?: boolean } = {}
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = options.code
    this.setupRequired = options.setupRequired
  }
}

export function authorizationHeaders(): Record<string, string> {
  const token = useAuthStore.getState().auth.accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function notifyAuthenticationRequired(setupRequired = false) {
  useAuthStore.getState().auth.reset()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { setupRequired } })
    )
  }
}

export function isAuthenticationRequiredCode(
  value: unknown
): value is AuthenticationRequiredCode {
  return (
    typeof value === 'string' &&
    AUTH_REQUIRED_CODES.has(value as AuthenticationRequiredCode)
  )
}

export type OperatorNote = {
  id: string
  content: string
  created_at: string
  updated_at?: string | null
}

export type AccountDisposition = {
  source: string
  sourceLabel: string
  origin?: string
  originLabel?: string
  action: string
  actionLabel: string
  reason: string
  at?: string | null
  evidence?: string[]
}

export type IsolationStatsSourceCount = {
  source: string
  label: string
  count: number
}

export type IsolationStatsResponse = {
  range: { from?: string | null; to?: string | null }
  zone: {
    total: number
    isolatedInRange: number
    bySource: IsolationStatsSourceCount[]
  }
  registered: {
    total: number
    completed: number
    failed: number
    pending: number
    isolated: number
    isolatedInRange: number
    isolationRate: number
  }
  timing: {
    sampleCount: number
    avgHours: number | null
    medianHours: number | null
  }
  isolated: {
    total: number
    bySource: IsolationStatsSourceCount[]
  }
  trend: Array<{
    day: string
    registered: number
    isolated: number
    registeredIsolated: number
  }>
  generatedAt?: string | null
}

type Assessment = {
  account_id: number
  monitor_status: string
  risk_score: number
  sample_count: number
  anomaly_count: number
  hard_anomaly_count?: number
  distinct_egress_count?: number
  avg_tps?: number
  max_tps?: number
  latest_tps?: number
  avg_upstream_tps?: number
  max_upstream_tps?: number
  latest_upstream_tps?: number
  latest_classification?: string
  latest_sample_at?: string | null
  updated_at?: string | null
  risk_reasons: string[]
  quarantine_until?: string | null
  recovery_guarded?: boolean
  operator_note?: string
  operator_notes?: OperatorNote[]
  disposition?: AccountDisposition | null
}

export type UpstreamQuota = {
  type: 'free' | 'paid' | 'unknown'
  source:
    | 'unknown'
    | 'upstreamBilling'
    | 'upstreamExhaustion'
    | 'responseModel'
    | 'billingProfile'
    | 'buildSuperEntitlement'
  confidence: 'estimated' | 'observed' | 'confirmed' | ''
  status: 'active' | 'waitingReset' | 'probing'
  unit?: 'tokens' | 'credits' | 'percent'
  used: number
  limit: number
  remaining: number
  usagePercent: number
  limitKnown: boolean
  windowHours?: number
  observed: boolean
  confirmed: boolean
  periodStart?: string
  periodEnd?: string
  exhaustedAt?: string
  nextProbeAt?: string
  lastConfirmedAt?: string
}

export type UpstreamAccount = {
  id: string
  name: string
  email?: string
  provider: string
  enabled: boolean
  authStatus?: string
  priority?: number
  maxConcurrent?: number
  failureCount?: number
  lastUsedAt?: string | null
  createdAt?: string | null
  egressNodeId?: string | null
  egressAssignmentMode?: string
  buildBotFlagged?: boolean
  ssoAvailable: boolean
  ssoRiskStatus?:
    | 'missing'
    | 'unverified'
    | 'pending'
    | 'clean'
    | 'flagged'
    | 'failed'
    | string
  ssoRiskCheckedAt?: string | null
  ssoBotFlagged?: boolean
  ssoBotSource?: number | null
  ssoPreDisableAction?: string
  missingUpstream?: boolean
  egressRecommendation?: EgressRecommendation | null
  quota?: UpstreamQuota
  assessment: Assessment
}

export type EgressRecommendation = {
  type: 'change_egress' | 'none' | string
  label: string
  reason: string
  highRiskCount?: number
  maxTps?: number
  ssoVerdict?: string
  checkedAt?: string | null
  priorityAction?: string
  priority?: number | null
  egressNodeIds?: number[]
}

export type AccountOption = {
  id: string
  name: string
  email?: string
  enabled: boolean
  authStatus?: string
  egressNodeId?: string | null
  egressAssignmentMode?: string
  ssoRiskStatus?: string
  ssoRiskCheckedAt?: string | null
  ssoBotFlagged?: boolean
  ssoPreDisableAction?: string
  egressRecommendation?: EgressRecommendation | null
}

type AccountTargetSummary = {
  target_key: string
  target_kind: string
  egress_node_id?: number | null
  egress_name: string
  samples: number
  anomalies?: number | null
  avg_tps?: number | null
  max_tps?: number | null
  avg_upstream_tps?: number | null
  max_upstream_tps?: number | null
}

export type AccountDetailResponse = {
  account: UpstreamAccount
  history: {
    samples: ProbeSample[]
    runs: ProbeRun[]
    byTarget: AccountTargetSummary[]
  }
}

export type TimelineItemType =
  | 'sample'
  | 'audit'
  | 'isolate'
  | 'restore'
  | 'note'

export type TimelineItemHref =
  | '/runs'
  | '/request-audits'
  | '/request-audits/ledger'
  | '/request-audits/workspace'
  | '/request-audits/schedule'
  | '/quarantine'

export type TimelineItemSearch = {
  account?: string
  run?: string
  view?: 'accounts' | 'nodes'
}

export type TimelineItem = {
  id: string
  type: TimelineItemType
  at: string
  title: string
  detail: string
  href: TimelineItemHref | null
  search?: TimelineItemSearch
  meta?: Record<string, unknown>
}

export type AccountTimelineResponse = {
  accountId: number
  items: TimelineItem[]
  limit: number
  hasMore: boolean
}

export type EgressNode = {
  id: string
  name: string
  enabled: boolean
  proxyConfigured: boolean
  proxyPool?: boolean
  accountBoundProxy?: boolean
  sourceId?: string
  health?: number
  failureCount?: number
  cooldownUntil?: string
  lastError?: string
  probeStatus?: string
  lastProbedAt?: string
  probeLatencyMs?: number
  probeError?: string
  probeProvider?: string
  exitIp?: string
  accountCapacity?: number
  assignedAccountCount?: number
}

export type EgressNodeUpdateResult = {
  requested: number
  eligible: number
  updated: number
  enabled: boolean
  skippedNodeIds: number[]
}

export type EgressNodeDeleteResult = {
  requested: number
  eligible: number
  deleted: number
  skippedNodeIds: number[]
}

export type EgressNodeProbeResult = {
  status: 'unknown' | 'healthy' | 'unhealthy'
  testedAt: string
  latencyMs: number
  exitIp?: string
  error?: string
  probeProvider?: string
}

export type EgressAccountDistributionResult = {
  requested: number
  updated: number
  accountsPerNode: number
  recommendedAccountsPerNode?: number
  nodeIds: number[]
  assignments: {
    nodeId: number
    requested: number
    updated: number
  }[]
  skippedAccountIds: number[]
  failedAccountIds: number[]
  failures: { id: number; error: string }[]
}

export type RequestAuditRiskLevel = 'normal' | 'watch' | 'high'
export type RequestAuditWindowPreset =
  'today' | '1h' | '3h' | '6h' | '24h' | '7d' | '30d' | 'custom'

export type RequestAuditWindow = {
  preset: RequestAuditWindowPreset
  label: string
  startAt: string
  endAt: string
  isToday: boolean
}

export type RequestAuditRecord = {
  id: string
  requestId: string
  provider: 'grok_build' | string
  operation: string
  modelPublicId: string
  modelUpstreamModel: string
  accountId: number | null
  accountName: string
  clientKeyId: string
  clientKeyName: string
  upstreamAccountFound: boolean
  upstreamEnabled: boolean | null
  upstreamAuthStatus: string
  egressNodeId: number | null
  egressNodeName: string
  egressMode: string
  egressScope: string
  statusCode: number
  errorCode?: string
  streaming: boolean
  inputTokens: number
  mediaInputImages: number
  hasMediaInput: boolean
  outputTokens: number
  reasoningTokens: number
  reasoningTokensReported: boolean
  totalTokens: number
  firstTokenMs: number | null
  durationMs: number
  tps: number | null
  riskLevel: RequestAuditRiskLevel
  riskReasons: string[]
  riskRuleId: string
  riskRuleIds: string[]
  reasoningZeroRisk: boolean
  reasoningZeroStreak: number
  reasoningZeroMinCount: number
  preDisableCheck: RequestAuditPreDisableCheck | null
  probeSampleCount: number
  probeSamples: RequestAuditProbeContext[]
  createdAt: string | null
}

export type RequestAuditProbeSample = Omit<ProbeSample, 'response_text'> & {
  response_text?: string
  responseLength?: number
  responsePreview?: string
}

export type RequestAuditProbeContext = {
  sample: RequestAuditProbeSample
  run: {
    id: string
    status: string
    trigger: string
    automatic: boolean
    planId?: string | null
    planName?: string
    profileId: string
    profileName: string
    executionMode: string
    rounds: number
    createdAt: string | null
    startedAt?: string | null
    completedAt?: string | null
  }
}

export type RequestAuditPreDisableCheck = {
  auditId: string
  auditCreatedAt: string | null
  auditTps: number
  status:
    | 'pending'
    | 'checking'
    | 'flagged'
    | 'session_confirmed'
    | 'clean'
    | 'missing_sso'
    | 'proxy_required'
    | 'invalid_session'
    | 'email_mismatch'
    | 'check_failed'
    | 'isolation_disabled'
    | 'sso_skipped'
    | string
  ssoVerdict: string
  proxyUsed: boolean
  validSession: boolean | null
  emailMatch: boolean | null
  statusCode: number
  responseMs: number
  checkError: string
  botFlag: {
    found: boolean
    source: number | null
    details: string
    policy: string
    risk: number | null
    event: string
    denied: boolean
    flagged: boolean
  }
  actionStatus:
    | 'pending'
    | 'disabled'
    | 'already_disabled'
    | 'already_quarantined'
    | 'task_protected'
    | 'auto_quarantine_disabled'
    | 'action_failed'
    | 'deprioritized'
    | 'already_deprioritized'
    | 'deprioritize_disabled'
    | 'deprioritize_failed'
    | 'not_required'
    | string
  actionError: string
  egressRecommendation?: EgressRecommendation | null
  previousPriority?: number | null
  appliedPriority?: number | null
  checkedAt: string | null
  updatedAt: string | null
}

export type RequestAuditAccountRisk = {
  accountId: number | null
  accountName: string
  requests: number
  measuredRequests: number
  outputTokens: number
  averageTps: number
  p95Tps: number
  maxTps: number
  latestTps: number | null
  watchCount: number
  highRiskCount: number
  riskLevel: RequestAuditRiskLevel
  riskReasons: string[]
  reasoningZeroCount: number
  reasoningZeroStreak: number
  reasoningZeroMinCount: number
  mediaInputCount: number
  mediaInputImages: number
  probeReasoningZeroCount: number
  egressNodeIds: number[]
  egressNodes: string[]
  monitorStatus: string
  quarantined: boolean
  quarantineUntil: string | null
  disposition?: AccountDisposition | null
  probeSampleCount: number
  probeAnomalyCount: number
  latestProbeSampleAt: string | null
  upstreamAccountFound: boolean
  upstreamEnabled: boolean | null
  upstreamAuthStatus: string
  lastSeenAt: string | null
  preDisableCheck: RequestAuditPreDisableCheck | null
  egressRecommendation?: EgressRecommendation | null
  priorityAction?: string
}

export type RequestAuditNodeRisk = {
  key: string
  egressNodeId: number | null
  egressNodeName: string
  mapped: boolean
  latestProbeIp: string
  proxyPool: boolean | null
  enabled: boolean | null
  requests: number
  measuredRequests: number
  outputTokens: number
  averageTps: number
  p95Tps: number
  maxTps: number
  watchCount: number
  highRiskCount: number
  riskLevel: RequestAuditRiskLevel
  riskReasons: string[]
  reasoningZeroCount: number
  reasoningZeroStreak: number
  reasoningZeroMinCount: number
  mediaInputCount: number
  mediaInputImages: number
  accountCount: number
  riskAccountCount: number
  accounts: RequestAuditAccountRisk[]
  lastSeenAt: string | null
  egressRecommendation?: EgressRecommendation | null
  egressRecommendationCount?: number
}

export type RequestAuditSummary = {
  requests: number
  measuredRequests: number
  outputTokens: number
  averageTps: number
  p95Tps: number
  maxTps: number
  reasoningZeroRequests: number
  watchAccounts: number
  highRiskAccounts: number
  accountCount: number
  lastSeenAt: string | null
  day: string
  window: RequestAuditWindow
}

export type RequestAuditThresholds = {
  watch: number
  high: number
}

export type RequestAuditRule = RiskRuleDefinition

export type RequestAuditScanState = {
  day: string
  initialComplete: boolean
  initialResumePending: boolean
  newestAuditId: string
  newestCreatedAt: string | null
  lastScanAt: string | null
  lastSuccessAt: string | null
  lastError: string
  lastPages: number
  lastNewRecords: number
  lastSeenRecords: number
  window?: RequestAuditWindow
}

export type RequestAuditActivityLevel = 'busy' | 'normal' | 'idle'

export type RequestAuditActivity = {
  level: RequestAuditActivityLevel
  label: string
  requests: number
  requestsPerMinute: number
  maxTps: number
  sampleMinutes: number
  reasons: string[]
  recommendedIntervalSeconds: number
}

export type RequestAuditConfig = {
  enabled: boolean
  autoScanEnabled: boolean
  adaptiveScanEnabled: boolean
  fixedScanIntervalMinutes: number
  busyScanIntervalSeconds: number
  normalScanIntervalSeconds: number
  idleScanIntervalSeconds: number
  busyRequestsPerMinute: number
  liveRefreshEnabled: boolean
  liveRefreshSeconds: number
  riskEnabled: boolean
  reasoningZeroRiskEnabled: boolean
  mediaInputObserveEnabled: boolean
  rules: RiskRuleDefinition[]
  tpsOnlyDeprioritizeEnabled: boolean
  tpsOnlyPriority: number
  tpsOnlyMinCount: number
  isolationEnabled: boolean
  ssoRecheckEnabled?: boolean
  retentionDays: number
}

export type RequestAuditStatus = {
  day: string
  provider: string
  thresholds: RequestAuditThresholds
  configured: boolean
  config: RequestAuditConfig
  scan: RequestAuditScanState
  activity: RequestAuditActivity
  localRecords: number
  availableRange: {
    startAt: string | null
    endAt: string | null
    records: number
  }
  schedule: {
    enabled: boolean
    adaptive: boolean
    fixedIntervalMinutes: number
    busyIntervalSeconds: number
    normalIntervalSeconds: number
    idleIntervalSeconds: number
  }
}

export type RequestAuditWindowInput = {
  window: RequestAuditWindowPreset
  startAt?: string
  endAt?: string
}

export type RequestAuditScanResult = {
  ok: boolean
  trigger: string
  day: string
  window?: RequestAuditWindow
  mode?: 'initial' | 'initial_resume' | 'incremental'
  pages?: number
  newRecords?: number
  seenRecords?: number
  error?: string
  state?: RequestAuditScanState
  skipped?: boolean
  activity?: RequestAuditActivity
  recommendedIntervalSeconds?: number
  preDisableChecks?: {
    requested: number
    flagged: number
    clean: number
    skipped: number
    disabled: number
    deprioritized: number
    failed: number
  }
}

export type RequestAuditClientKeyOption = {
  id: string
  name: string
}

export type RequestAuditPage = {
  day: string
  provider: string
  window: RequestAuditWindow
  upstreamAccountSnapshotAt: string | null
  items: RequestAuditRecord[]
  total: number
  page: number
  pageSize: number
  clientKeys: RequestAuditClientKeyOption[]
  thresholds: RequestAuditThresholds
}

export type RequestAuditSummaryResponse = {
  day: string
  provider: string
  window: RequestAuditWindow
  upstreamAccountSnapshotAt: string | null
  thresholds: RequestAuditThresholds
  summary: RequestAuditSummary
  accounts: RequestAuditAccountRisk[]
  nodes: RequestAuditNodeRisk[]
  trend: Array<{
    index: number
    label: string
    bucketStart: string
    bucketEnd: string
    granularity: 'hour' | '6hour' | 'day' | 'week'
    requests: number
    measuredRequests: number
    averageTps: number
    maxTps: number
    watch: number
    high: number
  }>
  scan: RequestAuditScanState
}

export type RequestAuditProbeContextResponse = {
  requestId: string
  auditId: number | null
  samples: RequestAuditProbeContext[]
}

export type EgressNodeCreateInput = {
  name: string
  proxy_url: string
  proxy_pool: boolean
  account_capacity: number
  enabled: boolean
}

export type EgressNodeUpdateInput = {
  name: string
  proxy_url?: string
  proxy_pool: boolean
  account_capacity: number
}

export type ProbeProfile = {
  id: string
  built_in: boolean
  name: string
  description: string
  model: string
  system_prompt: string
  prompt: string
  expected_text: string
  expected_output: string
  expected_image_url: string
  max_output_tokens: number
  temperature: number | null
  extra_body: Record<string, unknown>
  enabled: boolean
  created_at: string
  updated_at: string
}

export type ProxyTarget = {
  kind: 'current' | 'direct' | 'egress'
  id: number | null
  name?: string
}

export type PlanAccountScope = 'fixed' | 'all_enabled' | 'risky_enabled'

export type ProbePlan = {
  id: string
  name: string
  description: string
  profile_id: string
  profile_ids: string[]
  account_scope: PlanAccountScope
  account_ids: number[]
  proxy_targets: ProxyTarget[]
  execution_mode: ExecutionMode
  rounds: number
  cron_expression: string
  timezone: string
  enabled: boolean
  overlap_policy: 'skip' | 'fill'
  priority: number
  created_at: string
  updated_at: string
  job?: { id: string; name: string; nextRunAt?: string | null } | null
}

export type BulkDeleteResult = {
  requested: number
  deleted: number
  skipped: number
  protected?: number
  active?: number
  running?: number
  missing: number
  protectedIds?: string[]
  activeIds?: string[]
  runningIds?: string[]
  missingIds: string[]
}

export type PlanBulkRunResult = {
  requested: number
  processed: number
  created: number
  skipped: number
  failed: number
  restoreBlocked: number
  failures: { id: string; message: string }[]
}

export type ProbeRun = {
  id: string
  account_id: number
  account_name: string
  account_email: string
  account_created_at?: string | null
  profile_id: string
  plan_id?: string | null
  status: string
  trigger: string
  execution_mode: ExecutionMode
  rounds: number
  proxy_targets: ProxyTarget[]
  total_steps: number
  completed_steps: number
  error_count: number
  current_round?: number | null
  current_target_key?: string | null
  queue_blocked_reason?: string
  worker_id?: string | null
  summary: Record<string, unknown>
  error: string
  original_egress_node_id?: number | null
  original_egress_assignment_mode?: string
  original_account_enabled?: boolean | null
  original_account_priority?: number | null
  original_account_max_concurrent?: number | null
  account_settings_snapshot_at?: string | null
  diagnostic_priority?: number | null
  diagnostic_max_concurrent?: number | null
  diagnostic_activation_active?: boolean
  account_restore_status?: string
  account_restore_source?: string
  account_restore_attempts?: number
  account_restore_error?: string
  account_restore_attempted_at?: string | null
  account_restored_at?: string | null
  created_at: string
  started_at?: string | null
  heartbeat_at?: string | null
  completed_at?: string | null
  duration_estimate?: ProbeDurationEstimate | null
}

type ProbeDurationEstimate = {
  average_sample_ms: number
  estimated_total_ms: number
  estimated_remaining_ms: number
  sample_count: number
  updated_at: string
}

type ProbeWorkerCurrentRun = {
  id: string
  accountId: number | null
  accountName: string
  profileId: string
  profileName: string
  executionMode: ExecutionMode | string
  round?: number | null
  targetKey: string
  startedAt?: string | null
  elapsedSeconds: number
}

export type ProbeWorker = {
  id: string
  index: number
  status: string
  desired: boolean
  taskAlive: boolean
  startedAt: string
  stateChangedAt: string
  lastHeartbeatAt: string
  completedRuns: number
  failedRuns: number
  lastError: string
  currentRun?: ProbeWorkerCurrentRun | null
}

export type ProbeWorkersResponse = {
  process: {
    pid: number
    hostname: string
    startedAt: string
    uptimeSeconds: number
    model: string
    resources: {
      cpuPercent: number | null
      rssBytes: number | null
      threads: number | null
      openFiles: number | null
      eventLoopLagMs: number | null
    }
  }
  started: boolean
  stopping: boolean
  configuredConcurrency: number
  desiredConcurrency: number
  liveWorkers: number
  busyWorkers: number
  idleWorkers: number
  queue: {
    queued: number
    running: number
    eligible: number
    blockedSameAccount: number
    blockedRestore: number
  }
  activity: {
    windowSeconds: number
    completed: number
    failed: number
    failureRate: number
    averageDurationSeconds: number
    oldestQueueWaitSeconds: number
    activeCalls: number
  }
  workers: ProbeWorker[]
  policy: {
    sameAccountSerial: boolean
    reason: string
  }
  log: {
    fileName: string
    retentionDays: number
    sizeBytes: number
  }
}

export type ProbeWorkerLogsResponse = {
  items: string[]
  limit: number
  fileName: string
  retentionDays: number
  sizeBytes: number
}

export type ProbeRunPreviewSample = {
  id: string
  run_id: string
  round_number: number
  egress_name: string
  classification: string
  created_at: string
}

export type ProbeSample = {
  id: string
  run_id: string
  account_id: number
  round_number: number
  target_key: string
  target_kind: string
  egress_node_id?: number | null
  egress_name: string
  request_id: string
  audit_id?: number | null
  verified_account_id?: number | null
  verified_egress_node_id?: number | null
  status: string
  status_code: number
  error_code?: string
  retry_count?: number
  retry_after_seconds?: number
  output_tokens: number
  reasoning_tokens: number
  reasoning_tokens_reported?: boolean
  visible_tokens?: number
  chunk_count?: number
  first_token_ms: number
  duration_ms: number
  generation_ms: number
  first_token_share: number
  tps: number
  upstream_tps?: number | null
  expected_matched?: boolean | null
  response_sha256?: string
  response_text: string
  reasoning_text?: string
  classification: string
  risk_rule_id?: string
  risk_rule_ids?: string[]
  risk_reasons?: string[]
  error: string
  created_at: string
}

export type RiskRuleDefinition = {
  id: string
  label: string
  description: string
  scopes: string[]
  priority: number
  enabled: boolean
  configurable: boolean
  defaultEnabled: boolean
  classification: string
  anomalous: boolean
  hard: boolean
  auditActionMode: string
  auditMinCount: number
}

export type RiskRuleOverride = {
  id: string
  enabled?: boolean
  priority?: number
  [key: string]: string | number | boolean | null | undefined
}

export type ReasoningPolicyMode =
  | 'required'
  | 'observe'
  | 'optional'
  | 'unsupported'

export type ReasoningMediaInputMode = 'inherit' | 'observe' | 'ignore'

export type ReasoningModelPolicy = {
  model: string
  operation: '*' | 'chat' | 'responses' | 'messages'
  mode: ReasoningPolicyMode
  minimumOutputTokens: number
  minCount: number
  mediaInputMode: ReasoningMediaInputMode
}

export type AutoIsolationMinStatus = 'watch' | 'suspect' | 'high_risk'
export type ProbeTpsOverrideMode =
  | 'off'
  | 'generation_window'
  | 'missing_reasoning'

export type RuntimeSettings = {
  grok2apiBaseUrl: string
  grok2apiAdminUsername: string
  grok2apiAdminPasswordConfigured: boolean
  grok2apiHttpImpersonate: string
  grokRegisterWebhookTokenConfigured: boolean
  ssoProxyConfigured: boolean
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
  wechatAppSecretConfigured: boolean
  wechatOpenid: string
  wechatTemplateId: string
  schedulerEnabled: boolean
  quarantineRecoveryEnabled: boolean
  schedulerTimezone: string
  schedulerMisfireGraceSeconds: number
  recoveryCron: string
  scheduledProbeRegisterCooldownMinutes: number
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
  requestAuditRiskEnabled: boolean
  reasoningZeroRiskEnabled: boolean
  reasoningModelPolicies: ReasoningModelPolicy[]
  mediaInputObserveEnabled: boolean
  riskRuleOverrides: RiskRuleOverride[]
  riskRules: RiskRuleDefinition[]
  requestAuditTpsOnlyDeprioritizeEnabled: boolean
  requestAuditTpsOnlyPriority: number
  requestAuditTpsOnlyMinCount: number
  requestAuditIsolationEnabled: boolean
  requestAuditRetentionDays: number
  probeWorkerConcurrency: number
  probeQueueLimit: number
  probeStepDelaySeconds: number
  probeCurrentEgressIntervalSeconds: number
  probeTransientRetryAttempts: number
  probeTransientRetryBaseSeconds: number
  probeTransientRetryMaxSeconds: number
  probeRoutePrefix: string
  probeDiagnosticPriority: number
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
  bootstrap: {
    host: string
    port: number
    databasePath: string
    corsOrigins: string[]
  }
  changed?: string[]
}

export type EditableRuntimeSettings = RuntimeSettings & {
  grok2apiAdminPassword: string
  grokRegisterWebhookToken: string
  ssoProxy: string
  wechatAppSecret: string
}

export type SecretSettingName =
  | 'grok2apiAdminPassword'
  | 'grokRegisterWebhookToken'
  | 'ssoProxy'
  | 'wechatAppSecret'

export type RuntimeSettingsUpdate = Partial<
  Pick<
    RuntimeSettings,
    | 'grok2apiBaseUrl'
    | 'grok2apiAdminUsername'
    | 'grok2apiHttpImpersonate'
    | 'initialProbeOnRegister'
    | 'registerProbeStabilizationSeconds'
    | 'registerProbeProfileIds'
    | 'registerProbeExecutionMode'
    | 'registerProbeRounds'
    | 'registerProbeProfileRounds'
    | 'registerProbeProxyTargets'
    | 'registerProbeSwitchOnDegradation'
    | 'registerPriorityHoldEnabled'
    | 'registerPriorityHold'
    | 'registerCallbackEnabled'
    | 'registerCallbackUrl'
    | 'registerCallbackTimeoutSeconds'
    | 'wechatNotificationEnabled'
    | 'wechatAppId'
    | 'wechatOpenid'
    | 'wechatTemplateId'
    | 'schedulerEnabled'
    | 'quarantineRecoveryEnabled'
    | 'schedulerTimezone'
    | 'schedulerMisfireGraceSeconds'
    | 'recoveryCron'
    | 'scheduledProbeRegisterCooldownMinutes'
    | 'requestAuditEnabled'
    | 'requestAuditAutoScanEnabled'
    | 'requestAuditAdaptiveScanEnabled'
    | 'requestAuditScanIntervalMinutes'
    | 'requestAuditBusyScanIntervalSeconds'
    | 'requestAuditNormalScanIntervalSeconds'
    | 'requestAuditIdleScanIntervalSeconds'
    | 'requestAuditBusyRequestsPerMinute'
    | 'requestAuditLiveRefreshEnabled'
    | 'requestAuditLiveRefreshSeconds'
    | 'requestAuditRiskEnabled'
    | 'reasoningZeroRiskEnabled'
    | 'reasoningModelPolicies'
    | 'mediaInputObserveEnabled'
    | 'riskRuleOverrides'
    | 'requestAuditTpsOnlyDeprioritizeEnabled'
    | 'requestAuditTpsOnlyPriority'
    | 'requestAuditTpsOnlyMinCount'
    | 'requestAuditIsolationEnabled'
    | 'requestAuditRetentionDays'
    | 'probeWorkerConcurrency'
    | 'probeQueueLimit'
    | 'probeStepDelaySeconds'
    | 'probeCurrentEgressIntervalSeconds'
    | 'probeTransientRetryAttempts'
    | 'probeTransientRetryBaseSeconds'
    | 'probeTransientRetryMaxSeconds'
    | 'probeRoutePrefix'
    | 'probeDiagnosticPriority'
    | 'analysisWindowHours'
    | 'degradationTps'
    | 'strongDegradationTps'
    | 'probeTpsOverrideEnabled'
    | 'probeTpsOverrideMode'
    | 'probeTpsOverrideMinFirstTokenMs'
    | 'probeTpsOverrideMaxGenerationMs'
    | 'consecutiveAnomalies'
    | 'cumulativeAnomalyRate'
    | 'highRiskHardCount'
    | 'riskAnomalyRateWeight'
    | 'riskHardWeight'
    | 'riskHardCap'
    | 'riskFastWeight'
    | 'riskFastCap'
    | 'riskMarkerMissWeight'
    | 'riskMarkerMissCap'
    | 'riskStreakWeight'
    | 'riskStreakCap'
    | 'riskScoreCap'
    | 'riskWatchFloor'
    | 'riskSuspectFloor'
    | 'riskHighFloor'
    | 'bufferFirstTokenShare'
    | 'minGenerationMs'
    | 'minimumOutputTokens'
    | 'autoQuarantine'
    | 'autoQuarantineRecoveryEnabled'
    | 'autoIsolationEnabled'
    | 'autoIsolationMinStatus'
    | 'qualityRetryIsolationEnabled'
    | 'qualityRetryIsolationIntervalSeconds'
    | 'quarantineMinutes'
  >
> & {
  grok2apiAdminPassword?: string
  grokRegisterWebhookToken?: string
  ssoProxy?: string
  wechatAppSecret?: string
  clearSecrets?: SecretSettingName[]
}

type RuntimeSettingsWire = Omit<
  RuntimeSettings,
  | 'degradationTps'
  | 'strongDegradationTps'
  | 'probeTpsOverrideEnabled'
  | 'probeTpsOverrideMode'
  | 'probeTpsOverrideMinFirstTokenMs'
  | 'probeTpsOverrideMaxGenerationMs'
  | 'cumulativeAnomalyRate'
  | 'highRiskHardCount'
  | 'riskAnomalyRateWeight'
  | 'riskHardWeight'
  | 'riskHardCap'
  | 'riskFastWeight'
  | 'riskFastCap'
  | 'riskMarkerMissWeight'
  | 'riskMarkerMissCap'
  | 'riskStreakWeight'
  | 'riskStreakCap'
  | 'riskScoreCap'
  | 'riskWatchFloor'
  | 'riskSuspectFloor'
  | 'riskHighFloor'
  | 'probeCurrentEgressIntervalSeconds'
  | 'wechatNotificationEnabled'
  | 'wechatAppId'
  | 'wechatAppSecretConfigured'
  | 'wechatOpenid'
  | 'wechatTemplateId'
  | 'quarantineRecoveryEnabled'
  | 'scheduledProbeRegisterCooldownMinutes'
  | 'registerProbeStabilizationSeconds'
  | 'registerProbeSwitchOnDegradation'
  | 'registerPriorityHoldEnabled'
  | 'registerPriorityHold'
  | 'registerCallbackEnabled'
  | 'registerCallbackUrl'
  | 'registerCallbackTimeoutSeconds'
  | 'ssoProxyConfigured'
  | 'autoQuarantineRecoveryEnabled'
  | 'autoIsolationEnabled'
  | 'autoIsolationMinStatus'
  | 'qualityRetryIsolationEnabled'
  | 'qualityRetryIsolationIntervalSeconds'
  | 'requestAuditEnabled'
  | 'requestAuditAutoScanEnabled'
  | 'requestAuditAdaptiveScanEnabled'
  | 'requestAuditScanIntervalMinutes'
  | 'requestAuditBusyScanIntervalSeconds'
  | 'requestAuditNormalScanIntervalSeconds'
  | 'requestAuditIdleScanIntervalSeconds'
  | 'requestAuditBusyRequestsPerMinute'
  | 'requestAuditLiveRefreshEnabled'
  | 'requestAuditLiveRefreshSeconds'
  | 'requestAuditRiskEnabled'
  | 'reasoningZeroRiskEnabled'
  | 'reasoningModelPolicies'
  | 'mediaInputObserveEnabled'
  | 'riskRuleOverrides'
  | 'riskRules'
  | 'requestAuditTpsOnlyDeprioritizeEnabled'
  | 'requestAuditTpsOnlyPriority'
  | 'requestAuditTpsOnlyMinCount'
  | 'requestAuditIsolationEnabled'
  | 'requestAuditRetentionDays'
> & {
  degradationTps?: number
  strongDegradationTps?: number
  probeTpsOverrideEnabled?: boolean
  probeTpsOverrideMode?: ProbeTpsOverrideMode
  probeTpsOverrideMinFirstTokenMs?: number
  probeTpsOverrideMaxGenerationMs?: number
  cumulativeAnomalyRate?: number
  highRiskHardCount?: number
  riskAnomalyRateWeight?: number
  riskHardWeight?: number
  riskHardCap?: number
  riskFastWeight?: number
  riskFastCap?: number
  riskMarkerMissWeight?: number
  riskMarkerMissCap?: number
  riskStreakWeight?: number
  riskStreakCap?: number
  riskScoreCap?: number
  riskWatchFloor?: number
  riskSuspectFloor?: number
  riskHighFloor?: number
  softTps?: number
  hardTps?: number
  probeCurrentEgressIntervalSeconds?: number
  wechatNotificationEnabled?: boolean
  wechatAppId?: string
  wechatAppSecretConfigured?: boolean
  wechatOpenid?: string
  wechatTemplateId?: string
  quarantineRecoveryEnabled?: boolean
  scheduledProbeRegisterCooldownMinutes?: number
  registerProbeStabilizationSeconds?: number
  registerProbeSwitchOnDegradation?: boolean
  registerPriorityHoldEnabled?: boolean
  registerPriorityHold?: number
  registerCallbackEnabled?: boolean
  registerCallbackUrl?: string
  registerCallbackTimeoutSeconds?: number
  ssoProxyConfigured?: boolean
  autoQuarantineRecoveryEnabled?: boolean
  autoIsolationEnabled?: boolean
  autoIsolationMinStatus?: AutoIsolationMinStatus
  qualityRetryIsolationEnabled?: boolean
  qualityRetryIsolationIntervalSeconds?: number
  requestAuditEnabled?: boolean
  requestAuditAutoScanEnabled?: boolean
  requestAuditAdaptiveScanEnabled?: boolean
  requestAuditScanIntervalMinutes?: number
  requestAuditBusyScanIntervalSeconds?: number
  requestAuditNormalScanIntervalSeconds?: number
  requestAuditIdleScanIntervalSeconds?: number
  requestAuditBusyRequestsPerMinute?: number
  requestAuditLiveRefreshEnabled?: boolean
  requestAuditLiveRefreshSeconds?: number
  requestAuditRiskEnabled?: boolean
  reasoningZeroRiskEnabled?: boolean
  reasoningModelPolicies?: ReasoningModelPolicy[]
  mediaInputObserveEnabled?: boolean
  riskRuleOverrides?: RiskRuleOverride[]
  riskRules?: RiskRuleDefinition[]
  requestAuditTpsOnlyDeprioritizeEnabled?: boolean
  requestAuditTpsOnlyPriority?: number
  requestAuditTpsOnlyMinCount?: number
  requestAuditIsolationEnabled?: boolean
  requestAuditRetentionDays?: number
}


function normalizeAutoIsolationMinStatus(
  value: unknown
): AutoIsolationMinStatus {
  return value === 'watch' || value === 'suspect' || value === 'high_risk'
    ? value
    : 'high_risk'
}

function normalizeProbeTpsOverrideMode(
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

function normalizeRuntimeSettings(value: RuntimeSettingsWire): RuntimeSettings {
  const defaultReasoningModelPolicies: ReasoningModelPolicy[] = [
    {
      model: 'Build/grok-4.5',
      operation: 'chat',
      mode: 'required',
      minimumOutputTokens: 32,
      minCount: 2,
      mediaInputMode: 'inherit',
    },
    {
      model: 'Build/grok-4.5',
      operation: 'responses',
      mode: 'required',
      minimumOutputTokens: 32,
      minCount: 2,
      mediaInputMode: 'inherit',
    },
    {
      model: 'Build/grok-4.6',
      operation: 'chat',
      mode: 'required',
      minimumOutputTokens: 32,
      minCount: 2,
      mediaInputMode: 'inherit',
    },
    {
      model: 'Build/grok-4.6',
      operation: 'responses',
      mode: 'required',
      minimumOutputTokens: 32,
      minCount: 2,
      mediaInputMode: 'inherit',
    },
    {
      model: 'Build/grok-4.6',
      operation: 'messages',
      mode: 'required',
      minimumOutputTokens: 32,
      minCount: 2,
      mediaInputMode: 'observe',
    },
    {
      model: 'Build/grok-composer-2.5-fast',
      operation: '*',
      mode: 'observe',
      minimumOutputTokens: 32,
      minCount: 2,
      mediaInputMode: 'inherit',
    },
    {
      model: '*',
      operation: '*',
      mode: 'observe',
      minimumOutputTokens: 32,
      minCount: 2,
      mediaInputMode: 'inherit',
    },
  ]
  return {
    ...value,
    registerProbeProfileIds: value.registerProbeProfileIds ?? [
      'quality-marker',
    ],
    registerProbeExecutionMode: value.registerProbeExecutionMode ?? 'chat',
    registerProbeRounds: value.registerProbeRounds ?? 3,
    registerProbeProfileRounds: value.registerProbeProfileRounds ?? {},
    registerProbeStabilizationSeconds:
      value.registerProbeStabilizationSeconds ?? 15,
    registerProbeProxyTargets: value.registerProbeProxyTargets ?? [
      { kind: 'current', id: null },
    ],
    registerProbeSwitchOnDegradation:
      value.registerProbeSwitchOnDegradation ?? true,
    registerPriorityHoldEnabled: value.registerPriorityHoldEnabled ?? true,
    registerPriorityHold: value.registerPriorityHold ?? -1_000_000,
    registerCallbackEnabled: value.registerCallbackEnabled ?? false,
    registerCallbackUrl: value.registerCallbackUrl ?? '',
    registerCallbackTimeoutSeconds: value.registerCallbackTimeoutSeconds ?? 10,
    probeCurrentEgressIntervalSeconds:
      value.probeCurrentEgressIntervalSeconds ?? 10,
    quarantineRecoveryEnabled: value.quarantineRecoveryEnabled ?? true,
    autoQuarantineRecoveryEnabled: value.autoQuarantineRecoveryEnabled ?? true,
    autoIsolationEnabled: value.autoIsolationEnabled ?? false,
    autoIsolationMinStatus: normalizeAutoIsolationMinStatus(
      value.autoIsolationMinStatus
    ),
    qualityRetryIsolationEnabled: value.qualityRetryIsolationEnabled ?? false,
    qualityRetryIsolationIntervalSeconds:
      value.qualityRetryIsolationIntervalSeconds ?? 60,
    scheduledProbeRegisterCooldownMinutes:
      value.scheduledProbeRegisterCooldownMinutes ?? 360,
    requestAuditEnabled: value.requestAuditEnabled ?? true,
    requestAuditAutoScanEnabled: value.requestAuditAutoScanEnabled ?? true,
    requestAuditAdaptiveScanEnabled:
      value.requestAuditAdaptiveScanEnabled ?? true,
    requestAuditScanIntervalMinutes: value.requestAuditScanIntervalMinutes ?? 5,
    requestAuditBusyScanIntervalSeconds:
      value.requestAuditBusyScanIntervalSeconds ?? 30,
    requestAuditNormalScanIntervalSeconds:
      value.requestAuditNormalScanIntervalSeconds ?? 120,
    requestAuditIdleScanIntervalSeconds:
      value.requestAuditIdleScanIntervalSeconds ?? 300,
    requestAuditBusyRequestsPerMinute:
      value.requestAuditBusyRequestsPerMinute ?? 20,
    requestAuditLiveRefreshEnabled:
      value.requestAuditLiveRefreshEnabled ?? true,
    requestAuditLiveRefreshSeconds: value.requestAuditLiveRefreshSeconds ?? 30,
    requestAuditRiskEnabled: value.requestAuditRiskEnabled ?? true,
    reasoningZeroRiskEnabled: value.reasoningZeroRiskEnabled ?? true,
    reasoningModelPolicies:
      value.reasoningModelPolicies ?? defaultReasoningModelPolicies,
    mediaInputObserveEnabled: value.mediaInputObserveEnabled ?? true,
    riskRuleOverrides: value.riskRuleOverrides ?? [],
    riskRules: value.riskRules ?? [],
    requestAuditTpsOnlyDeprioritizeEnabled:
      value.requestAuditTpsOnlyDeprioritizeEnabled ?? true,
    requestAuditTpsOnlyPriority: value.requestAuditTpsOnlyPriority ?? -1000000,
    requestAuditTpsOnlyMinCount: value.requestAuditTpsOnlyMinCount ?? 2,
    requestAuditIsolationEnabled: value.requestAuditIsolationEnabled ?? true,
    requestAuditRetentionDays: value.requestAuditRetentionDays ?? 90,
    wechatNotificationEnabled: value.wechatNotificationEnabled ?? false,
    wechatAppId: value.wechatAppId ?? '',
    wechatAppSecretConfigured: value.wechatAppSecretConfigured ?? false,
    ssoProxyConfigured: value.ssoProxyConfigured ?? false,
    wechatOpenid: value.wechatOpenid ?? '',
    wechatTemplateId: value.wechatTemplateId ?? '',
    degradationTps: value.degradationTps ?? value.softTps ?? 150,
    strongDegradationTps: value.strongDegradationTps ?? value.hardTps ?? 500,
    probeTpsOverrideMode: normalizeProbeTpsOverrideMode(
      value.probeTpsOverrideMode,
      value.probeTpsOverrideEnabled
    ),
    probeTpsOverrideEnabled:
      normalizeProbeTpsOverrideMode(
        value.probeTpsOverrideMode,
        value.probeTpsOverrideEnabled
      ) !== 'off',
    probeTpsOverrideMinFirstTokenMs:
      value.probeTpsOverrideMinFirstTokenMs ?? 5000,
    probeTpsOverrideMaxGenerationMs:
      value.probeTpsOverrideMaxGenerationMs ?? 1000,
    cumulativeAnomalyRate: value.cumulativeAnomalyRate ?? 0.5,
    highRiskHardCount: value.highRiskHardCount ?? 2,
    riskAnomalyRateWeight: value.riskAnomalyRateWeight ?? 30,
    riskHardWeight: value.riskHardWeight ?? 6,
    riskHardCap: value.riskHardCap ?? 24,
    riskFastWeight: value.riskFastWeight ?? 12,
    riskFastCap: value.riskFastCap ?? 30,
    riskMarkerMissWeight: value.riskMarkerMissWeight ?? 16,
    riskMarkerMissCap: value.riskMarkerMissCap ?? 32,
    riskStreakWeight: value.riskStreakWeight ?? 3,
    riskStreakCap: value.riskStreakCap ?? 15,
    riskScoreCap: value.riskScoreCap ?? 100,
    riskWatchFloor: value.riskWatchFloor ?? 15,
    riskSuspectFloor: value.riskSuspectFloor ?? 50,
    riskHighFloor: value.riskHighFloor ?? 75,
  }
}

async function loadEditableRuntimeSettings(): Promise<EditableRuntimeSettings> {
  const settings = normalizeRuntimeSettings(
    await request<RuntimeSettingsWire>('/settings')
  )
  const [adminPassword, registerToken, ssoProxy, wechatAppSecret] =
    await Promise.all([
      settings.grok2apiAdminPasswordConfigured
        ? request<{ value: string }>(
            '/settings/secrets/grok2apiAdminPassword',
            {
              cache: 'no-store',
            }
          )
        : Promise.resolve({ value: '' }),
      settings.grokRegisterWebhookTokenConfigured
        ? request<{ value: string }>(
            '/settings/secrets/grokRegisterWebhookToken',
            { cache: 'no-store' }
          )
        : Promise.resolve({ value: '' }),
      settings.ssoProxyConfigured
        ? request<{ value: string }>('/settings/secrets/ssoProxy', {
            cache: 'no-store',
          })
        : Promise.resolve({ value: '' }),
      settings.wechatAppSecretConfigured
        ? request<{ value: string }>('/settings/secrets/wechatAppSecret', {
            cache: 'no-store',
          })
        : Promise.resolve({ value: '' }),
    ])
  return {
    ...settings,
    grok2apiAdminPassword: adminPassword.value,
    grokRegisterWebhookToken: registerToken.value,
    ssoProxy: ssoProxy.value,
    wechatAppSecret: wechatAppSecret.value,
  }
}

export type Page<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  activeCount?: number
}

export type AccountSelection = {
  accountIds: number[]
  disabledAccountIds: number[]
  matched: number
  selectable: number
  excluded: number
}

type AccountBatchUpdateResult = {
  requested: number
  eligible: number
  updated: number
  enabled: boolean
  skippedAccountIds: number[]
  failedAccountIds: number[]
  failures: { id: number; error: string }[]
}

export type AccountActionName = 'isolate' | 'restore' | 'quarantine'

export type AccountBatchActionResult = {
  requested: number
  eligible: number
  updated: number
  action: AccountActionName
  skippedAccountIds: number[]
  alreadyQuarantinedAccountIds: number[]
  alreadyIsolatedAccountIds: number[]
  failedAccountIds: number[]
  failures: { id: number; error: string }[]
}

export type AccountQuarantineLocalDeleteResult = {
  requested: number
  eligible: number
  deleted: number
  skippedAccountIds: number[]
  failedAccountIds: number[]
  failures: { id: number; error: string }[]
  skippedNotQuarantinedAccountIds?: number[]
}

type AccountBatchEgressResult = {
  requested: number
  eligible: number
  updated: number
  egressNodeId: number | null
  assignmentMode: 'manual' | ''
  skippedAccountIds: number[]
  failedAccountIds: number[]
  failures: { id: number; error: string }[]
}

type AccountBatchDeleteResult = {
  requested: number
  eligible: number
  deleted: number
  skippedAccountIds: number[]
  failedAccountIds: number[]
  failures: { id: number; error: string }[]
}

export type RunSelectionAction = 'cancel' | 'delete' | 'restore'

export type RunSelectionItem = {
  id: string
  accountId: number
  action: RunSelectionAction
}

export type RunSelection = {
  items: RunSelectionItem[]
  matched: number
  selectable: number
  excluded: number
}

type RunBatchDeleteResult = {
  requested: number
  deleted: number
  skippedRunIds: string[]
}

type RunBatchRestoreResult = {
  requested: number
  restored: number
  failed: number
  failedRunIds: string[]
  failures: { id: string; error: string }[]
}

export type ProbeRunBatchResult = {
  requested: number
  requestedTasks?: number
  profileIds?: string[]
  created: number
  skipped: number
  missingAccountIds: number[]
  invalidAccounts: { id: number; reason: string }[]
  activeAccountIds: number[]
  restoreBlockedAccountIds: number[]
  diagnosticAccountIds: number[]
  skippedAccounts?: {
    id: number
    name: string
    email?: string
    code: 'missing' | 'invalid' | 'active_run' | 'restore_blocked'
    reason: string
  }[]
  runIds: string[]
}

export type DashboardResponse = {
  window?: { hours?: number; from?: string; to?: string }
  upstream?: { total?: number; available?: number }
  assessments?: {
    total?: number
    risky?: number
    quarantined?: number
    avgRisk?: number
  }
  samples?: {
    total?: number
    anomalies?: number
    maxTps?: number
    avgTps?: number
    maxUpstreamTps?: number
    avgUpstreamTps?: number
  }
  registered?: {
    total?: number
    completed?: number
    failed?: number
    pending?: number
  }
  isolated?: { zoneTotal?: number; inRange?: number }
  probeRuns?: {
    completed?: number
    failed?: number
    completedWithErrors?: number
    successRate?: number
  }
  workers?: {
    queued?: number
    running?: number
    stale?: number
    oldestQueueWaitSeconds?: number
    eligible?: number
    blockedSameAccount?: number
    blockedRestore?: number
  }
  queue?: { queued?: number; running?: number }
  trend?: Record<string, string | number | null>[]
  riskyAccounts?: UpstreamAccount[]
  recentRuns?: ProbeRun[]
}

export type HealthResponse = {
  upstream?: Record<string, unknown>
  integration?: Record<string, unknown>
  [key: string]: unknown
}

export type SchedulerJob = {
  id: string
  name: string
  nextRunAt?: string | null
}

export type ScheduleExecution = {
  id: string
  schedule_key: string
  status: string
  message: string
  detail: Record<string, unknown>
  started_at: string
  completed_at?: string | null
}

export type SchedulerResponse = {
  enabled: boolean
  plansEnabled?: boolean
  systemRecoveryEnabled?: boolean
  running: boolean
  plans: ProbePlan[]
  systemJobs: SchedulerJob[]
  executions: ScheduleExecution[]
}

export type ChatModel = {
  id?: string
  name?: string
  owned_by?: string
  [key: string]: unknown
}

export type ChatProvider = {
  id: string
  name: string
  baseUrl: string
  models: string[]
  enabled: boolean
  isDefault: boolean
  apiKeyConfigured: boolean
  createdAt: string
  updatedAt: string
}

export type ChatProviderInput = {
  name: string
  baseUrl: string
  apiKey?: string
  clearApiKey?: boolean
  models: string[]
  enabled: boolean
  isDefault: boolean
}

function parseContentDispositionFilename(header: string | null) {
  if (!header) return ''
  const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1].trim().replace(/^"(.*)"$/, '$1'))
    } catch {
      return utfMatch[1]
    }
  }
  const basicMatch = header.match(/filename="?([^"]+)"?/i)
  return basicMatch?.[1]?.trim() ?? ''
}

async function downloadExport(path: string): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: authorizationHeaders(),
  })
  if (!response.ok) {
    const text = await response.text()
    let payload: {
      detail?: unknown
      error?: { message?: unknown } | unknown
      code?: string
      setupRequired?: boolean
    } = {}
    try {
      payload = JSON.parse(text) as typeof payload
    } catch {
      payload = {}
    }
    const detail =
      payload.detail ??
      (typeof payload.error === 'object' && payload.error
        ? (payload.error as { message?: unknown }).message
        : payload.error)
    const message =
      typeof detail === 'string'
        ? detail
        : detail == null
          ? text || `HTTP ${response.status}`
          : JSON.stringify(detail)
    if (response.status === 401 && isAuthenticationRequiredCode(payload.code)) {
      notifyAuthenticationRequired(Boolean(payload.setupRequired))
    }
    throw new ApiError(message, response.status, {
      code: payload.code,
      setupRequired: payload.setupRequired,
    })
  }
  const blob = await response.blob()
  const filename =
    parseContentDispositionFilename(
      response.headers.get('content-disposition')
    ) || 'grokiq-export'
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}

async function request<T>(
  path: string,
  init?: RequestInit & { skipAuth?: boolean }
): Promise<T> {
  const { skipAuth = false, ...requestInit } = init ?? {}
  const response = await fetch(`${API_BASE}${path}`, {
    ...requestInit,
    headers: {
      ...(requestInit.body ? { 'Content-Type': 'application/json' } : {}),
      ...requestInit.headers,
      ...(skipAuth ? {} : authorizationHeaders()),
    },
  })
  if (!response.ok) {
    const text = await response.text()
    let payload: {
      detail?: unknown
      error?: { message?: unknown } | unknown
      code?: string
      setupRequired?: boolean
    } = {}
    try {
      payload = JSON.parse(text) as typeof payload
    } catch {
      payload = {}
    }
    const detail =
      payload.detail ??
      (typeof payload.error === 'object' && payload.error
        ? (payload.error as { message?: unknown }).message
        : payload.error)
    const message =
      typeof detail === 'string'
        ? detail
        : detail == null
          ? text || `HTTP ${response.status}`
          : JSON.stringify(detail)
    const isAuthEndpoint = path.startsWith('/auth/')
    if (
      response.status === 401 &&
      !skipAuth &&
      !isAuthEndpoint &&
      isAuthenticationRequiredCode(payload.code)
    ) {
      notifyAuthenticationRequired(Boolean(payload.setupRequired))
    }
    throw new ApiError(message, response.status, {
      code: payload.code,
      setupRequired: payload.setupRequired,
    })
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const ACCOUNT_BATCH_REQUEST_SIZE = 100
const ACCOUNT_BATCH_NETWORK_ATTEMPTS = 3
const ACCOUNT_BATCH_RETRYABLE_STATUSES = new Set([502, 503, 504])

async function updateAccountsEnabled(
  accountIds: number[],
  enabled: boolean
): Promise<AccountBatchUpdateResult> {
  const uniqueIds = Array.from(
    new Set(
      accountIds.filter(
        (accountId) => Number.isSafeInteger(accountId) && accountId > 0
      )
    )
  )
  const result: AccountBatchUpdateResult = {
    requested: 0,
    eligible: 0,
    updated: 0,
    enabled,
    skippedAccountIds: [],
    failedAccountIds: [],
    failures: [],
  }

  for (
    let start = 0;
    start < uniqueIds.length;
    start += ACCOUNT_BATCH_REQUEST_SIZE
  ) {
    const accountBatch = uniqueIds.slice(
      start,
      start + ACCOUNT_BATCH_REQUEST_SIZE
    )
    const batchResult = await requestAccountBatchWithRetry(
      accountBatch,
      enabled
    )
    result.requested += batchResult.requested
    result.eligible += batchResult.eligible
    result.updated += batchResult.updated
    result.skippedAccountIds.push(...(batchResult.skippedAccountIds ?? []))
    result.failedAccountIds.push(...(batchResult.failedAccountIds ?? []))
    result.failures.push(...(batchResult.failures ?? []))
  }

  result.skippedAccountIds = Array.from(new Set(result.skippedAccountIds))
  result.failedAccountIds = Array.from(new Set(result.failedAccountIds))
  return result
}

async function requestAccountBatchWithRetry(
  accountIds: number[],
  enabled: boolean
): Promise<AccountBatchUpdateResult> {
  for (
    let attempt = 1;
    attempt <= ACCOUNT_BATCH_NETWORK_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await request<AccountBatchUpdateResult>('/accounts/batch', {
        method: 'PUT',
        body: JSON.stringify({ account_ids: accountIds, enabled }),
      })
    } catch (error) {
      const retrying =
        isRetryableAccountBatchError(error) &&
        attempt < ACCOUNT_BATCH_NETWORK_ATTEMPTS
      if (!retrying) throw error
      await new Promise<void>((resolve) =>
        globalThis.setTimeout(resolve, attempt * 250)
      )
    }
  }
  throw new Error('批量更新请求异常结束')
}

async function updateAccountsEgress(
  accountIds: number[],
  egressNodeId: number | null
): Promise<AccountBatchEgressResult> {
  const uniqueIds = Array.from(
    new Set(
      accountIds.filter(
        (accountId) => Number.isSafeInteger(accountId) && accountId > 0
      )
    )
  )
  const result: AccountBatchEgressResult = {
    requested: 0,
    eligible: 0,
    updated: 0,
    egressNodeId,
    assignmentMode: egressNodeId == null ? '' : 'manual',
    skippedAccountIds: [],
    failedAccountIds: [],
    failures: [],
  }

  for (
    let start = 0;
    start < uniqueIds.length;
    start += ACCOUNT_BATCH_REQUEST_SIZE
  ) {
    const accountBatch = uniqueIds.slice(
      start,
      start + ACCOUNT_BATCH_REQUEST_SIZE
    )
    let batchResult: AccountBatchEgressResult | undefined
    for (
      let attempt = 1;
      attempt <= ACCOUNT_BATCH_NETWORK_ATTEMPTS;
      attempt += 1
    ) {
      try {
        batchResult = await request<AccountBatchEgressResult>(
          '/accounts/batch/egress',
          {
            method: 'PUT',
            body: JSON.stringify({
              account_ids: accountBatch,
              egress_node_id: egressNodeId,
            }),
          }
        )
        break
      } catch (error) {
        const retrying =
          isRetryableAccountBatchError(error) &&
          attempt < ACCOUNT_BATCH_NETWORK_ATTEMPTS
        if (!retrying) throw error
        await new Promise<void>((resolve) =>
          globalThis.setTimeout(resolve, attempt * 250)
        )
      }
    }
    if (!batchResult) throw new Error('批量出口绑定请求异常结束')
    result.requested += batchResult.requested
    result.eligible += batchResult.eligible
    result.updated += batchResult.updated
    result.skippedAccountIds.push(...(batchResult.skippedAccountIds ?? []))
    result.failedAccountIds.push(...(batchResult.failedAccountIds ?? []))
    result.failures.push(...(batchResult.failures ?? []))
  }

  result.skippedAccountIds = Array.from(new Set(result.skippedAccountIds))
  result.failedAccountIds = Array.from(new Set(result.failedAccountIds))
  return result
}

function isRetryableAccountBatchError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError &&
      ACCOUNT_BATCH_RETRYABLE_STATUSES.has(error.status))
  )
}

async function accountBatchAction(body: {
  account_ids: number[]
  action: AccountActionName
  note?: string
  propagate?: boolean
  quarantine_minutes?: number
  priority?: number | null
}): Promise<AccountBatchActionResult> {
  const uniqueIds = Array.from(
    new Set(
      body.account_ids.filter(
        (accountId) => Number.isSafeInteger(accountId) && accountId > 0
      )
    )
  )
  const result: AccountBatchActionResult = {
    requested: 0,
    eligible: 0,
    updated: 0,
    action: body.action,
    skippedAccountIds: [],
    alreadyQuarantinedAccountIds: [],
    alreadyIsolatedAccountIds: [],
    failedAccountIds: [],
    failures: [],
  }

  for (
    let start = 0;
    start < uniqueIds.length;
    start += ACCOUNT_BATCH_REQUEST_SIZE
  ) {
    const accountBatch = uniqueIds.slice(
      start,
      start + ACCOUNT_BATCH_REQUEST_SIZE
    )
    let batchResult: AccountBatchActionResult | undefined
    for (
      let attempt = 1;
      attempt <= ACCOUNT_BATCH_NETWORK_ATTEMPTS;
      attempt += 1
    ) {
      try {
        batchResult = await request<AccountBatchActionResult>(
          '/accounts/batch/action',
          {
            method: 'POST',
            body: JSON.stringify({
              account_ids: accountBatch,
              action: body.action,
              ...(body.note ? { note: body.note } : {}),
              ...(body.propagate != null
                ? { propagate: body.propagate }
                : {}),
              ...(body.quarantine_minutes != null
                ? { quarantine_minutes: body.quarantine_minutes }
                : {}),
              ...(body.priority != null ? { priority: body.priority } : {}),
            }),
          }
        )
        break
      } catch (error) {
        const retrying =
          isRetryableAccountBatchError(error) &&
          attempt < ACCOUNT_BATCH_NETWORK_ATTEMPTS
        if (!retrying) throw error
        await new Promise<void>((resolve) =>
          globalThis.setTimeout(resolve, attempt * 250)
        )
      }
    }
    if (!batchResult) throw new Error('批量账号操作请求异常结束')
    result.requested += batchResult.requested ?? accountBatch.length
    result.eligible += batchResult.eligible ?? 0
    result.updated += batchResult.updated ?? 0
    result.skippedAccountIds.push(...(batchResult.skippedAccountIds ?? []))
    result.alreadyQuarantinedAccountIds.push(
      ...(batchResult.alreadyQuarantinedAccountIds ?? [])
    )
    result.alreadyIsolatedAccountIds.push(
      ...(batchResult.alreadyIsolatedAccountIds ?? [])
    )
    result.failedAccountIds.push(...(batchResult.failedAccountIds ?? []))
    result.failures.push(...(batchResult.failures ?? []))
  }

  result.skippedAccountIds = Array.from(new Set(result.skippedAccountIds))
  result.alreadyQuarantinedAccountIds = Array.from(
    new Set(result.alreadyQuarantinedAccountIds)
  )
  result.alreadyIsolatedAccountIds = Array.from(
    new Set(result.alreadyIsolatedAccountIds)
  )
  result.failedAccountIds = Array.from(new Set(result.failedAccountIds))
  return result
}

async function deleteQuarantineLocal(
  accountIds: number[]
): Promise<AccountQuarantineLocalDeleteResult> {
  const uniqueIds = Array.from(
    new Set(
      accountIds.filter(
        (accountId) => Number.isSafeInteger(accountId) && accountId > 0
      )
    )
  )
  const result: AccountQuarantineLocalDeleteResult = {
    requested: 0,
    eligible: 0,
    deleted: 0,
    skippedAccountIds: [],
    failedAccountIds: [],
    failures: [],
  }

  for (
    let start = 0;
    start < uniqueIds.length;
    start += ACCOUNT_BATCH_REQUEST_SIZE
  ) {
    const accountBatch = uniqueIds.slice(
      start,
      start + ACCOUNT_BATCH_REQUEST_SIZE
    )
    let batchResult: AccountQuarantineLocalDeleteResult | undefined
    for (
      let attempt = 1;
      attempt <= ACCOUNT_BATCH_NETWORK_ATTEMPTS;
      attempt += 1
    ) {
      try {
        batchResult = await request<AccountQuarantineLocalDeleteResult>(
          '/accounts/quarantine/local',
          {
            method: 'DELETE',
            body: JSON.stringify({ account_ids: accountBatch }),
          }
        )
        break
      } catch (error) {
        const retrying =
          isRetryableAccountBatchError(error) &&
          attempt < ACCOUNT_BATCH_NETWORK_ATTEMPTS
        if (!retrying) throw error
        await new Promise<void>((resolve) =>
          globalThis.setTimeout(resolve, attempt * 250)
        )
      }
    }
    if (!batchResult) throw new Error('删除隔离区本地记录请求异常结束')
    result.requested += batchResult.requested ?? accountBatch.length
    result.eligible += batchResult.eligible ?? 0
    result.deleted += batchResult.deleted ?? 0
    result.skippedAccountIds.push(...(batchResult.skippedAccountIds ?? []))
    result.failedAccountIds.push(...(batchResult.failedAccountIds ?? []))
    result.failures.push(...(batchResult.failures ?? []))
  }

  result.skippedAccountIds = Array.from(new Set(result.skippedAccountIds))
  result.failedAccountIds = Array.from(new Set(result.failedAccountIds))
  return result
}

async function deleteQuarantineUpstream(
  accountIds: number[]
): Promise<AccountQuarantineLocalDeleteResult> {
  const uniqueIds = Array.from(
    new Set(
      accountIds.filter(
        (accountId) => Number.isSafeInteger(accountId) && accountId > 0
      )
    )
  )
  const skippedNotQuarantinedAccountIds: number[] = []
  const result: AccountQuarantineLocalDeleteResult = {
    requested: 0,
    eligible: 0,
    deleted: 0,
    skippedAccountIds: [],
    failedAccountIds: [],
    failures: [],
  }

  for (
    let start = 0;
    start < uniqueIds.length;
    start += ACCOUNT_BATCH_REQUEST_SIZE
  ) {
    const accountBatch = uniqueIds.slice(
      start,
      start + ACCOUNT_BATCH_REQUEST_SIZE
    )
    let batchResult: AccountQuarantineLocalDeleteResult | undefined
    for (
      let attempt = 1;
      attempt <= ACCOUNT_BATCH_NETWORK_ATTEMPTS;
      attempt += 1
    ) {
      try {
        batchResult = await request<AccountQuarantineLocalDeleteResult>(
          '/accounts/quarantine/upstream',
          {
            method: 'DELETE',
            body: JSON.stringify({ account_ids: accountBatch }),
          }
        )
        break
      } catch (error) {
        const retrying =
          isRetryableAccountBatchError(error) &&
          attempt < ACCOUNT_BATCH_NETWORK_ATTEMPTS
        if (!retrying) throw error
        await new Promise<void>((resolve) =>
          globalThis.setTimeout(resolve, attempt * 250)
        )
      }
    }
    if (!batchResult) throw new Error('删除隔离区上游账号请求异常结束')
    result.requested += batchResult.requested ?? accountBatch.length
    result.eligible += batchResult.eligible ?? 0
    result.deleted += batchResult.deleted ?? 0
    result.skippedAccountIds.push(...(batchResult.skippedAccountIds ?? []))
    result.failedAccountIds.push(...(batchResult.failedAccountIds ?? []))
    result.failures.push(...(batchResult.failures ?? []))
    skippedNotQuarantinedAccountIds.push(
      ...(batchResult.skippedNotQuarantinedAccountIds ?? [])
    )
  }

  result.skippedAccountIds = Array.from(new Set(result.skippedAccountIds))
  result.failedAccountIds = Array.from(new Set(result.failedAccountIds))
  result.skippedNotQuarantinedAccountIds = Array.from(
    new Set(skippedNotQuarantinedAccountIds)
  )
  return result
}

async function deleteAccounts(
  accountIds: number[]
): Promise<AccountBatchDeleteResult> {
  const uniqueIds = Array.from(
    new Set(
      accountIds.filter(
        (accountId) => Number.isSafeInteger(accountId) && accountId > 0
      )
    )
  )
  const result: AccountBatchDeleteResult = {
    requested: 0,
    eligible: 0,
    deleted: 0,
    skippedAccountIds: [],
    failedAccountIds: [],
    failures: [],
  }

  for (
    let start = 0;
    start < uniqueIds.length;
    start += ACCOUNT_BATCH_REQUEST_SIZE
  ) {
    const accountBatch = uniqueIds.slice(
      start,
      start + ACCOUNT_BATCH_REQUEST_SIZE
    )
    const batchResult = await requestAccountBatchDeleteWithRetry(accountBatch)
    result.requested += batchResult.requested
    result.eligible += batchResult.eligible
    result.deleted += batchResult.deleted
    result.skippedAccountIds.push(...(batchResult.skippedAccountIds ?? []))
    result.failedAccountIds.push(...(batchResult.failedAccountIds ?? []))
    result.failures.push(...(batchResult.failures ?? []))
  }

  result.skippedAccountIds = Array.from(new Set(result.skippedAccountIds))
  result.failedAccountIds = Array.from(new Set(result.failedAccountIds))
  return result
}

async function requestAccountBatchDeleteWithRetry(
  accountIds: number[]
): Promise<AccountBatchDeleteResult> {
  for (
    let attempt = 1;
    attempt <= ACCOUNT_BATCH_NETWORK_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await request<AccountBatchDeleteResult>('/accounts/batch', {
        method: 'DELETE',
        body: JSON.stringify({ account_ids: accountIds }),
      })
    } catch (error) {
      const retrying =
        isRetryableAccountBatchError(error) &&
        attempt < ACCOUNT_BATCH_NETWORK_ATTEMPTS
      if (!retrying) throw error
      await new Promise<void>((resolve) =>
        globalThis.setTimeout(resolve, attempt * 250)
      )
    }
  }
  throw new Error('批量删除请求异常结束')
}

const RUN_DELETE_REQUEST_SIZE = 200
const RUN_RESTORE_REQUEST_SIZE = 20

async function deleteRuns(runIds: string[]): Promise<RunBatchDeleteResult> {
  const uniqueIds = Array.from(new Set(runIds.filter(Boolean)))
  const result: RunBatchDeleteResult = {
    requested: 0,
    deleted: 0,
    skippedRunIds: [],
  }
  for (
    let start = 0;
    start < uniqueIds.length;
    start += RUN_DELETE_REQUEST_SIZE
  ) {
    const batch = uniqueIds.slice(start, start + RUN_DELETE_REQUEST_SIZE)
    const batchResult = await request<RunBatchDeleteResult>('/probe-runs', {
      method: 'DELETE',
      body: JSON.stringify({ ids: batch }),
    })
    result.requested += batchResult.requested ?? batch.length
    result.deleted += batchResult.deleted ?? 0
    result.skippedRunIds.push(...(batchResult.skippedRunIds ?? []))
  }
  return result
}

async function restoreRunsAccountSettings(
  runIds: string[]
): Promise<RunBatchRestoreResult> {
  const uniqueIds = Array.from(new Set(runIds.filter(Boolean)))
  const result: RunBatchRestoreResult = {
    requested: 0,
    restored: 0,
    failed: 0,
    failedRunIds: [],
    failures: [],
  }
  for (
    let start = 0;
    start < uniqueIds.length;
    start += RUN_RESTORE_REQUEST_SIZE
  ) {
    const batch = uniqueIds.slice(start, start + RUN_RESTORE_REQUEST_SIZE)
    const batchResult = await request<RunBatchRestoreResult>(
      '/probe-runs/batch/restore-account-settings',
      { method: 'POST', body: JSON.stringify({ ids: batch }) }
    )
    result.requested += batchResult.requested ?? batch.length
    result.restored += batchResult.restored ?? 0
    result.failed += batchResult.failed ?? 0
    result.failedRunIds.push(...(batchResult.failedRunIds ?? []))
    result.failures.push(...(batchResult.failures ?? []))
  }
  return result
}

function query(
  params: Record<string, string | number | boolean | null | undefined>
) {
  const value = new URLSearchParams()
  for (const [key, item] of Object.entries(params)) {
    if (item !== '' && item != null) value.set(key, String(item))
  }
  const suffix = value.toString()
  return suffix ? `?${suffix}` : ''
}

export const api = {
  authStatus: () => request<AuthStatus>('/auth/status'),
  authSetup: (body: {
    username: string
    password: string
    confirm_password: string
  }) =>
    request<AuthSession>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  authLogin: (body: { username: string; password: string }) =>
    request<AuthSession>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  authMe: () => request<{ user: AuthUser }>('/auth/me'),
  authLogout: () =>
    request<{ loggedOut: boolean }>('/auth/logout', { method: 'POST' }),
  onboarding: () => request<OnboardingState>('/onboarding'),
  completeOnboarding: (body: RuntimeSettingsUpdate) =>
    request<OnboardingCompleteResult>('/onboarding/complete', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  health: () => request<HealthResponse>('/health'),
  publicUpstreamAccounts: () =>
    request<PublicUpstreamAccountSummary>('/public/upstream-accounts', {
      skipAuth: !authorizationHeaders().Authorization,
    }),
  publicUpstreamUsage: (params?: {
    period?: PublicUpstreamUsagePeriod
    timezone?: string
    refresh?: boolean
  }) => {
    const query = new URLSearchParams()
    if (params?.period) query.set('period', params.period)
    if (params?.timezone) query.set('timezone', params.timezone)
    if (params?.refresh) query.set('refresh', '1')
    const suffix = query.toString() ? `?${query.toString()}` : ''
    return request<PublicUpstreamUsageOverview>(
      `/public/upstream-usage${suffix}`,
      { skipAuth: true }
    )
  },
  lookupPublicClientKeyQuota: (apiKey: string) =>
    request<PublicClientKeyQuotaLookup>('/public/client-key-quota', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ apiKey }),
    }),
  lookupPublicClientKeyUsage: (params: {
    apiKey: string
    period: ClientKeyUsagePeriod
    start?: string
    end?: string
  }) =>
    request<PublicClientKeyUsageLookup>('/public/client-key-usage', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({
        apiKey: params.apiKey,
        period: params.period,
        start: params.start,
        end: params.end,
      }),
    }),
  systemVersion: () =>
    request<SystemVersionInfo>('/system/version', { cache: 'no-store' }),
  checkSystemUpdate: () =>
    request<SystemVersionInfo>('/system/update/check', {
      method: 'POST',
      cache: 'no-store',
    }),
  dashboard: (hours = 168) =>
    request<DashboardResponse>(`/dashboard?hours=${hours}`),
  ssoReports: () => request<SsoReportItem[]>('/sso-reports'),
  ssoReport: (id: string) => request<SsoReportDetail>(`/sso-reports/${id}`),
  createSsoReport: (body: {
    name: string
    ssoContent: string
    proxy: string
    concurrency: number
    requestTimeoutSeconds: number
  }) =>
    request<SsoReportDetail>('/sso-reports', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createAccountSsoReport: (accountIds: number[], name = '') =>
    request<AccountSsoReportResult>('/sso-reports/accounts', {
      method: 'POST',
      body: JSON.stringify({ account_ids: accountIds, name }),
    }),
  deleteSsoReports: (ids: string[]) =>
    request<{
      requested: number
      deleted: number
      missing: number
      skipped: number
      skipped_ids: string[]
    }>('/sso-reports', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  accounts: (
    params: Record<string, string | number | undefined>,
    signal?: AbortSignal
  ) => request<Page<UpstreamAccount>>(`/accounts${query(params)}`, { signal }),
  accountSelection: (
    params: Record<string, string | number | undefined> = {}
  ) => request<AccountSelection>(`/accounts/selection${query(params)}`),
  accountOptions: (
    params: Record<string, string | number | undefined> = {},
    signal?: AbortSignal
  ) =>
    request<Page<AccountOption>>(`/accounts/options${query(params)}`, {
      signal,
    }),
  account: (id: number, limit = 30) =>
    request<AccountDetailResponse>(`/accounts/${id}${query({ limit })}`),
  accountSamples: (
    id: number,
    params: { page?: number; pageSize?: number } = {}
  ) => request<Page<ProbeSample>>(`/accounts/${id}/samples${query(params)}`),
  accountTimeline: (id: number, limit = 50) =>
    request<AccountTimelineResponse>(
      `/accounts/${id}/timeline${query({ limit })}`
    ),
  accountUpstream: (id: number) =>
    request<{
      accountId: number
      missingUpstream: boolean
      account: Record<string, unknown> | null
    }>(`/accounts/${id}/upstream`),
  addAccountOperatorNote: (id: number, note: string) =>
    request<{
      accountId: number
      notes: OperatorNote[]
      operatorNote: string
      assessment: Assessment
    }>(`/accounts/${id}/operator-notes`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  updateAccountOperatorNote: (id: number, noteId: string, note: string) =>
    request<{
      accountId: number
      notes: OperatorNote[]
      operatorNote: string
      assessment: Assessment
    }>(`/accounts/${id}/operator-notes/${noteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    }),
  deleteAccountOperatorNote: (id: number, noteId: string) =>
    request<{
      accountId: number
      notes: OperatorNote[]
      operatorNote: string
      assessment: Assessment
    }>(`/accounts/${id}/operator-notes/${noteId}`, {
      method: 'DELETE',
    }),
  accountAction: (
    id: number,
    body: {
      action: AccountActionName
      note?: string
      propagate?: boolean
      quarantine_minutes?: number
      priority?: number | null
    }
  ) =>
    request<Record<string, unknown>>(`/accounts/${id}/action`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  accountBatchAction,
  quarantineAccounts: (
    params: Record<string, string | number | undefined> = {},
    signal?: AbortSignal
  ) =>
    request<Page<UpstreamAccount>>(`/accounts/quarantine${query(params)}`, {
      signal,
    }),
  quarantineStats: (
    params: { from?: string; to?: string } = {},
    signal?: AbortSignal
  ) =>
    request<IsolationStatsResponse>(
      `/accounts/quarantine/stats${query(params)}`,
      { signal }
    ),
  deleteQuarantineLocal,
  deleteQuarantineUpstream,
  updateAccountsEnabled,
  updateAccountsEgress,
  deleteAccounts,
  deleteAccount: (id: number) =>
    request<{ deleted: boolean; accountId: number }>(`/accounts/${id}`, {
      method: 'DELETE',
    }),
  egress: (params: Record<string, string | number | undefined> = {}) =>
    request<Page<EgressNode>>(`/egress-nodes${query(params)}`),
  requestAudits: (params: Record<string, string | number | undefined> = {}) =>
    request<RequestAuditPage>(`/request-audits${query(params)}`),
  requestAuditSummary: (
    params: Record<string, string | number | undefined> = {}
  ) =>
    request<RequestAuditSummaryResponse>(
      `/request-audits/summary${query(params)}`
    ),
  requestAuditStatus: () =>
    request<RequestAuditStatus>('/request-audits/status'),
  requestAuditProbeContext: (
    params: { requestId?: string; auditId?: string | number } = {}
  ) =>
    request<RequestAuditProbeContextResponse>(
      `/request-audits/probe-context${query(params)}`
    ),
  scanRequestAudits: (body: RequestAuditWindowInput = { window: 'today' }) =>
    request<RequestAuditScanResult>('/request-audits/scan', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createEgressNode: (body: EgressNodeCreateInput) =>
    request<EgressNode>('/egress-nodes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateEgressNode: (nodeId: number, body: EgressNodeUpdateInput) =>
    request<EgressNode>(`/egress-nodes/${nodeId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  updateEgressNodes: (nodeIds: number[], enabled: boolean) =>
    request<EgressNodeUpdateResult>('/egress-nodes/batch', {
      method: 'PATCH',
      body: JSON.stringify({ node_ids: nodeIds, enabled }),
    }),
  deleteEgressNodes: (nodeIds: number[]) =>
    request<EgressNodeDeleteResult>('/egress-nodes', {
      method: 'DELETE',
      body: JSON.stringify({ node_ids: nodeIds }),
    }),
  testEgressNode: (nodeId: number) =>
    request<EgressNodeProbeResult>(`/egress-nodes/${nodeId}/test`, {
      method: 'POST',
    }),
  distributeAccountsToEgress: (
    nodeIds: number[],
    accountsPerNode: number
  ) =>
    request<EgressAccountDistributionResult>(
      '/egress-nodes/bind-accounts',
      {
        method: 'POST',
        body: JSON.stringify({
          node_ids: nodeIds,
          accountsPerNode,
        }),
      }
    ),
  profiles: () => request<ProbeProfile[]>('/probe-profiles'),
  createProfile: (body: Record<string, unknown>) =>
    request<{ id: string }>('/probe-profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProfile: (id: string, body: Record<string, unknown>) =>
    request<ProbeProfile>(`/probe-profiles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteProfile: (id: string) =>
    request<void>(`/probe-profiles/${id}`, { method: 'DELETE' }),
  deleteProfiles: (ids: string[]) =>
    request<BulkDeleteResult>('/probe-profiles', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
  plans: () => request<ProbePlan[]>('/probe-plans'),
  createPlan: (body: Record<string, unknown>) =>
    request<{ id: string }>('/probe-plans', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePlan: (id: string, body: Record<string, unknown>) =>
    request<ProbePlan>(`/probe-plans/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  setPlanEnabled: (id: string, enabled: boolean) =>
    request<ProbePlan>(`/probe-plans/${id}/enabled`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  deletePlan: (id: string) =>
    request<void>(`/probe-plans/${id}`, { method: 'DELETE' }),
  runPlan: (id: string) =>
    request<Record<string, unknown>>(`/probe-plans/${id}/run`, {
      method: 'POST',
    }),
  runPlans: (ids: string[]) =>
    request<PlanBulkRunResult>('/probe-plans/batch/run', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  deletePlans: (ids: string[]) =>
    request<BulkDeleteResult>('/probe-plans', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
  createRun: (body: Record<string, unknown>) =>
    request<{ id: string; status: string }>('/probe-runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createRunsBatch: (body: Record<string, unknown>) =>
    request<ProbeRunBatchResult>('/probe-runs/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  runs: (
    params: Record<string, string | number | undefined> = {},
    signal?: AbortSignal
  ) => request<Page<ProbeRun>>(`/probe-runs${query(params)}`, { signal }),
  runSelection: (params: Record<string, string | number | undefined> = {}) =>
    request<RunSelection>(`/probe-runs/selection${query(params)}`),
  probeWorkers: () => request<ProbeWorkersResponse>('/probe-workers'),
  probeWorkerLogs: (limit = 300) =>
    request<ProbeWorkerLogsResponse>(
      `/probe-workers/logs${query({ limit: Math.min(1500, limit) })}`
    ),
  registerWebhookEvents: (
    params: Record<string, string | number | undefined> = {},
    signal?: AbortSignal
  ) =>
    request<RegisterWebhookEventsResponse>(
      `/register-webhook-events${query(params)}`,
      { signal }
    ),
  run: (id: string) =>
    request<{
      run: ProbeRun
      profile: ProbeProfile
      samples: ProbeSample[]
    }>(`/probe-runs/${id}`),
  runPreviewSamples: (ids: string[]) =>
    request<{ items: ProbeRunPreviewSample[] }>('/probe-runs/preview-samples', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  cancelRun: (id: string) =>
    request<Record<string, unknown>>(`/probe-runs/${id}/cancel`, {
      method: 'POST',
    }),
  cancelRuns: (ids: string[]) =>
    request<{
      requested: number
      cancelled: number
      cancelRequested: number
      alreadyStopping: number
      skipped: number
    }>('/probe-runs/batch/cancel', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  retryRun: (id: string) =>
    request<Record<string, unknown>>(`/probe-runs/${id}/retry`, {
      method: 'POST',
    }),
  restoreRunAccountSettings: (id: string) =>
    request<ProbeRun>(`/probe-runs/${id}/restore-account-settings`, {
      method: 'POST',
    }),
  deleteRun: (id: string) =>
    request<void>(`/probe-runs/${id}`, { method: 'DELETE' }),
  deleteSample: (id: string) =>
    request<void>(`/probe-samples/${id}`, { method: 'DELETE' }),
  deleteRuns,
  restoreRunsAccountSettings,
  scheduler: () => request<SchedulerResponse>('/scheduler'),
  deleteSchedulerExecution: (id: string) =>
    request<void>(`/scheduler/executions/${id}`, { method: 'DELETE' }),
  deleteSchedulerExecutions: (ids: string[]) =>
    request<BulkDeleteResult>('/scheduler/executions', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
  settings: () =>
    request<RuntimeSettingsWire>('/settings').then(normalizeRuntimeSettings),
  editableSettings: loadEditableRuntimeSettings,
  revealSettingSecret: (name: SecretSettingName) =>
    request<{ value: string }>(`/settings/secrets/${name}`, {
      cache: 'no-store',
    }),
  updateSettings: (body: RuntimeSettingsUpdate) =>
    request<RuntimeSettingsWire>('/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }).then(normalizeRuntimeSettings),
  testGrok2api: () =>
    request<{
      ok: boolean
      baseUrl: string
      grokBuild: Record<string, unknown>
    }>('/settings/test-grok2api', { method: 'POST' }),
  testWechat: () =>
    request<{
      ok: boolean
      sent: number
      templateId: string
      messages: { openId: string; messageId: string }[]
    }>('/settings/test-wechat', { method: 'POST' }),
  chatProviders: () => request<ChatProvider[]>('/chat/providers'),
  revealChatProviderApiKey: (id: string) =>
    request<{ value: string }>(`/chat/providers/${id}/api-key`),
  createChatProvider: (body: ChatProviderInput) =>
    request<ChatProvider>('/chat/providers', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateChatProvider: (id: string, body: Partial<ChatProviderInput>) =>
    request<ChatProvider>(`/chat/providers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteChatProvider: (id: string) =>
    request<void>(`/chat/providers/${id}`, { method: 'DELETE' }),
  syncChatProviderModels: (id: string) =>
    request<ChatProvider>(`/chat/providers/${id}/sync-models`, {
      method: 'POST',
    }),
  chatModels: (providerId = '') =>
    request<ChatModel[]>(`/chat/models${query({ providerId })}`),
  exportQuarantine: (format: 'csv' | 'json' = 'csv') =>
    downloadExport(`/exports/quarantine${query({ format })}`),
  exportHighRisk: (format: 'csv' | 'json' = 'csv') =>
    downloadExport(`/exports/high-risk${query({ format })}`),
  exportRequestAudits: (
    params: {
      format?: 'csv' | 'json'
      account?: string
      accountId?: number
      risk?: string
      clientKey?: string
      egressNodeId?: number
      window?: string
      startAt?: string
      endAt?: string
    } = {}
  ) => downloadExport(`/exports/request-audits${query(params)}`),
  exportProbeSamples: (
    params: { format?: 'csv' | 'json'; accountId?: number } = {}
  ) => downloadExport(`/exports/probe-samples${query(params)}`),
  chatUrl: `${API_BASE}/responses`,
}
