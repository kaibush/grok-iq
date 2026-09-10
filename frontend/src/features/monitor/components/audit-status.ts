const AUDIT_ERROR_LABELS: Record<string, string> = {
  upstream_stream_interrupted: '上游流中断',
  upstream_stream_idle_timeout: '上游流空闲超时',
  upstream_stream_error: '上游流错误',
  upstream_stream_incomplete: '上游流不完整',
  stream_interrupted: '流中断',
  upstream_model_cooling: '模型冷却',
  upstream_cooling: '上游冷却',
  upstream_quota_exhausted: '配额耗尽',
  upstream_rate_limited: '上游限流',
  upstream_rate_limited_subscription_free_usage_exhausted: '免费额度耗尽',
  upstream_rate_limited_resource_exhausted: '资源耗尽',
  upstream_rate_limited_someresourcehasbeenexhausted: '资源耗尽',
  upstream_network_error: '上游网络错误',
  upstream_saturated: '上游饱和',
  upstream_unavailable: '上游不可用',
  upstream_server_error_unavailable: '上游服务不可用',
  upstream_header_timeout: '上游头超时',
  upstream_error: '上游错误',
  upstream_forbidden_permission_denied: '上游拒绝访问',
  quality_degraded: '质量降级',
  thinking_standby_probe_degraded: '思考备选探针降级',
  thinking_standby_probe_error: '思考备选探针异常',
  request_canceled: '请求已取消',
  client_stream_interrupted: '客户端中断',
  client_key_account_scope_unavailable: 'Key 账号范围不可用',
}

export function auditErrorCode(row: { errorCode?: string | null }) {
  return row.errorCode?.trim() || ''
}

export function auditErrorLabel(code: string) {
  return AUDIT_ERROR_LABELS[code] || code
}

const INTERNAL_AUDIT_ERROR_CODES = new Set([
  'quality_degraded',
  'thinking_standby_probe_degraded',
  'thinking_standby_probe_error',
])

export function isInternalAuditError(code?: string | null) {
  return INTERNAL_AUDIT_ERROR_CODES.has((code || '').trim())
}

export function isSuccessfulAuditStatus(row: {
  statusCode?: number
  errorCode?: string | null
}) {
  return (
    row.statusCode != null &&
    row.statusCode >= 200 &&
    row.statusCode < 300 &&
    !auditErrorCode(row)
  )
}
