import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Loader2,
  Network,
  ShieldAlert,
  ShieldBan,
  Trash2,
  Undo2,
  UsersRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatAccountSecondaryLabel } from '@/lib/account-label'
import {
  api,
  type AccountActionName,
  type AccountDetailResponse,
  type ProbeSample,
  type UpstreamAccount,
} from '@/lib/api'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { EnabledBadge } from '@/components/enabled-badge'
import { MonitorStatusBadge } from '@/components/monitor-status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { InfoTooltip } from '@/components/info-tooltip'
import { LoadingState } from '@/components/page'
import {
  AccountSampleExplorer,
  sampleTargetText,
} from '@/features/monitor/components/account-sample-explorer'
import {
  AuthStatusIndicator,
  EgressBindingIndicator,
} from '@/features/monitor/components/account-state-indicators'
import {
  AccountTimeline,
  timelineRangeLabel,
} from '@/features/monitor/components/account-timeline'
import { DispositionBanner } from '@/features/monitor/components/disposition-summary'
import {
  getEgressNodeName,
  type EgressNodeNameMap,
} from '@/features/monitor/components/egress-node-names'
import { DualTpsValue } from '@/features/monitor/components/tps-display'

export function AccountProbeDetailDialog({
  accountId,
  open,
  onOpenChange,
  egressNodeNames,
  stacked = false,
  onNavigateAway,
}: {
  accountId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  egressNodeNames: EgressNodeNameMap
  stacked?: boolean
  onNavigateAway?: () => void
}) {
  const client = useQueryClient()
  const [isolateOpen, setIsolateOpen] = useState(false)
  const [sampleToDelete, setSampleToDelete] = useState<ProbeSample | null>(null)
  const detail = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => api.account(accountId!),
    enabled: open && accountId != null,
  })
  const account = detail.data?.account
  const invalidate = (id: number) => {
    void client.invalidateQueries({ queryKey: ['account', id] })
    void client.invalidateQueries({ queryKey: ['accounts'] })
    void client.invalidateQueries({ queryKey: ['runs'] })
    void client.invalidateQueries({ queryKey: ['dashboard'] })
  }
  const actionMutation = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: number
      action: AccountActionName
    }) => api.accountAction(id, { action, propagate: true }),
    onSuccess: () => {
      toast.success('账号状态已更新')
      if (accountId != null) invalidate(accountId)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const isolateMutation = useMutation({
    mutationFn: (id: number) =>
      api.accountAction(id, {
        action: 'isolate',
        note: '账号探针人工移入隔离区',
        propagate: true,
      }),
    onSuccess: () => {
      setIsolateOpen(false)
      toast.success('已移入隔离区')
      if (accountId != null) invalidate(accountId)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const deleteSampleMutation = useMutation({
    mutationFn: (sample: ProbeSample) => api.deleteSample(sample.id),
    onSuccess: (_result, sample) => {
      setSampleToDelete(null)
      toast.success('样本已删除，相关判定和统计已重新计算')
      invalidate(sample.account_id)
      void client.invalidateQueries({ queryKey: ['run', sample.run_id] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const alreadyIsolated =
    account?.assessment.monitor_status === 'quarantined' &&
    !account.assessment.quarantine_until
  const pending = actionMutation.isPending || isolateMutation.isPending

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          size='wide'
          className={stacked ? 'z-[70] overflow-hidden' : 'overflow-hidden'}
          overlayClassName={stacked ? 'z-[70]' : undefined}
        >
          <DialogHeader className='shrink-0'>
            <DialogTitle className='flex items-center gap-2'>
              <UsersRound className='size-5 text-primary' />
              <span className='min-w-0 truncate'>
                {account?.name || `账号 ${accountId ?? ''}`}
              </span>
              {account ? (
                <CopyButton
                  value={account.email?.trim() || String(account.id)}
                  className='size-6'
                />
              ) : null}
            </DialogTitle>
            <DialogDescription>
              {account
                ? formatAccountSecondaryLabel({
                    id: account.id,
                    email: account.email,
                    createdAt: account.createdAt,
                    accountLabel:
                      account.name ||
                      account.email ||
                      `账号 ${accountId ?? ''}`,
                  })
                : '账号探针详情'}
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1'>
            {detail.isLoading ? (
              <LoadingState />
            ) : (
              detail.data && (
                <AccountProbeDetail
                  key={detail.data.account.id}
                  data={detail.data}
                  egressNodeNames={egressNodeNames}
                  deletingSampleId={
                    deleteSampleMutation.isPending
                      ? (sampleToDelete?.id ?? null)
                      : null
                  }
                  onDeleteSample={setSampleToDelete}
                  onNavigate={() => {
                    onOpenChange(false)
                    onNavigateAway?.()
                  }}
                />
              )
            )}
          </div>
          <div className='shrink-0 border-t pt-3'>
            <p className='text-xs leading-5 text-muted-foreground'>
              “暂时停用”使用系统设置中的停用时长，到期后可自动恢复；“移入隔离区”是长期隔离并停用上游，不会自动到期恢复，也不删除 grok2api 账号。
            </p>
            <DialogFooter className='mt-3'>
              <Button
                variant='outline'
                disabled={pending || accountId == null}
                onClick={() =>
                  accountId &&
                  actionMutation.mutate({ id: accountId, action: 'restore' })
                }
              >
                <Undo2 />
                立即恢复
              </Button>
              <Button
                variant='destructive'
                disabled={pending || accountId == null}
                onClick={() =>
                  accountId &&
                  actionMutation.mutate({
                    id: accountId,
                    action: 'quarantine',
                  })
                }
              >
                <ShieldAlert />
                暂时停用
              </Button>
              <Button
                variant='outline'
                disabled={pending || accountId == null || alreadyIsolated}
                onClick={() => setIsolateOpen(true)}
              >
                <ShieldBan />
                移入隔离区
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        className={stacked ? 'z-[80]' : undefined}
        overlayClassName={stacked ? 'z-[80]' : undefined}
        open={isolateOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isolateMutation.isPending) setIsolateOpen(false)
        }}
        title='将账号移入隔离区？'
        desc={
          <div className='space-y-2'>
            <p>将停用上游并把账号移入隔离区，不会删除账号。</p>
            <p className='font-medium text-foreground'>
              隔离区是长期隔离（不自动到期恢复）并停用上游；暂时停用仍走原来的停用时长逻辑。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          isolateMutation.isPending ? (
            <>
              <Loader2 className='animate-spin' />
              移入中…
            </>
          ) : (
            <>
              <ShieldBan />
              确认移入隔离区
            </>
          )
        }
        isLoading={isolateMutation.isPending}
        disabled={accountId == null}
        handleConfirm={() => {
          if (accountId != null) isolateMutation.mutate(accountId)
        }}
      />
      <ConfirmDialog
        className={stacked ? 'z-[80]' : undefined}
        overlayClassName={stacked ? 'z-[80]' : undefined}
        open={sampleToDelete != null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleteSampleMutation.isPending) {
            setSampleToDelete(null)
          }
        }}
        title='删除这条探针样本？'
        desc={
          <div className='space-y-2'>
            {sampleToDelete && (
              <div className='rounded-md border bg-muted/40 px-3 py-2 text-foreground'>
                <div className='font-medium break-all'>
                  {sampleTargetText(sampleToDelete, egressNodeNames)}
                </div>
                <div className='mt-1 text-xs text-muted-foreground'>
                  第 {sampleToDelete.round_number} 轮 ·{' '}
                  {formatDate(sampleToDelete.created_at)}
                </div>
              </div>
            )}
            <p>该样本会被永久删除，并重新计算账号判定与所属任务的样本统计。</p>
            <p className='text-muted-foreground'>
              此操作只删除本地监控证据，不会修改上游账号。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          deleteSampleMutation.isPending ? (
            <>
              <Loader2 className='animate-spin' />
              删除中…
            </>
          ) : (
            <>
              <Trash2 />
              删除样本
            </>
          )
        }
        destructive
        isLoading={deleteSampleMutation.isPending}
        handleConfirm={() => {
          if (sampleToDelete) deleteSampleMutation.mutate(sampleToDelete)
        }}
      />
    </>
  )
}

function AccountProbeDetail({
  data,
  egressNodeNames,
  deletingSampleId,
  onDeleteSample,
  onNavigate,
}: {
  data: AccountDetailResponse
  egressNodeNames: EgressNodeNameMap
  deletingSampleId: string | null
  onDeleteSample: (sample: ProbeSample) => void
  onNavigate?: () => void
}) {
  const account = data.account
  const assessment = account.assessment
  const history = data.history
  const reasons: string[] = assessment.risk_reasons ?? []
  const byTarget = history.byTarget ?? []
  const [timelineLimit, setTimelineLimit] = useState(50)
  const timelineQuery = useQuery({
    queryKey: ['account-timeline', account.id, timelineLimit],
    queryFn: () => api.accountTimeline(Number(account.id), timelineLimit),
  })
  const timelineItems = timelineQuery.data?.items ?? []
  const timelineRange = timelineRangeLabel(timelineItems)
  return (
    <div className='space-y-5'>
      <div className='grid gap-3 sm:grid-cols-3 lg:grid-cols-6'>
        <Metric label='上游' value={<EnabledBadge enabled={account.enabled} />} />
        <Metric
          label='鉴权'
          value={<AuthStatusIndicator status={account.authStatus} />}
        />
        <Metric
          label='出口绑定'
          value={
            <EgressBindingIndicator
              nodeId={account.egressNodeId}
              nodeName={getEgressNodeName(
                egressNodeNames,
                account.egressNodeId
              )}
              assignmentMode={account.egressAssignmentMode}
              compact
            />
          }
        />
        <Metric
          label='判定'
          value={<MonitorStatusBadge status={assessment.monitor_status} />}
        />
        <Metric
          label='SSO 风控'
          value={<AccountSsoRiskBadge account={account} />}
        />
        <Metric
          label='恢复保护'
          value={assessment.recovery_guarded ? '已标记' : '未标记'}
        />
        <Metric label='风险分' value={formatNumber(assessment.risk_score)} />
        <Metric
          label='周期样本 / 信号'
          value={`${assessment.sample_count ?? 0} / ${assessment.anomaly_count ?? 0}`}
        />
        <Metric
          label='最后样本'
          value={formatDate(assessment.latest_sample_at)}
        />
      </div>
      {account.egressRecommendation?.type === 'change_egress' && (
        <div className='rounded-lg border border-amber-500/30 bg-amber-500/8 p-3'>
          <div className='flex flex-wrap items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300'>
            <Network className='size-4' />
            {account.egressRecommendation.label || '建议更换出口节点'}
          </div>
          <p className='mt-1 text-xs leading-5 text-muted-foreground'>
            {account.egressRecommendation.reason}
            {account.egressRecommendation.priority != null
              ? `；账号已降至优先级 ${account.egressRecommendation.priority}`
              : ''}
          </p>
        </div>
      )}
      <DispositionBanner
        disposition={assessment.disposition}
        sampleReasons={reasons}
      />
      <div>
        <h3 className='mb-2 text-sm font-semibold'>出口对比</h3>
        <div className='grid gap-2 sm:grid-cols-2'>
          {byTarget.map((item) => (
            <div key={item.target_key} className='rounded-lg border p-3'>
              <div className='grid min-w-0 gap-1.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start'>
                <span
                  className='min-w-0 leading-5 font-medium break-all'
                  title={
                    item.target_kind === 'current'
                      ? '账号当前出口'
                      : item.target_kind === 'direct'
                        ? '上游调度（诊断）'
                        : item.egress_name
                  }
                >
                  {item.target_kind === 'current'
                    ? '账号当前出口'
                    : item.target_kind === 'direct'
                      ? '上游调度（诊断）'
                      : item.egress_name}
                </span>
                <span className='inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums sm:text-right'>
                  <DualTpsValue
                    tps={item.max_tps ?? 0}
                    upstreamTps={item.max_upstream_tps}
                    compact
                  />
                  <span className='text-xs font-normal text-muted-foreground'>
                    max
                  </span>
                </span>
              </div>
              <div className='mt-1 text-xs text-muted-foreground'>
                {item.samples} 个样本 · {item.anomalies ?? 0} 个降智信号 · 平均{' '}
                <DualTpsValue
                  tps={item.avg_tps ?? 0}
                  upstreamTps={item.avg_upstream_tps}
                  compact
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className='mb-1 flex items-center gap-1.5 text-sm font-semibold'>
          账号时间线
          <InfoTooltip
            label='账号时间线'
            content='按事件时间倒序，不是按自然日窗口。默认最近 50 条，混合探针样本、请求审计、隔离/恢复和备注。请求一多只保留最新的；点审计或任务中心会按该账号自动过滤对应页面。'
          />
        </h3>
        <p className='mb-2 text-xs leading-5 text-muted-foreground'>
          最近 {timelineItems.length} 条
          {timelineRange ? `（${timelineRange}）` : ''}
          {timelineQuery.data?.hasMore ? '，还有更早事件' : ''}
          。不是按自然日窗口；点「查看请求审计」或「查看任务中心」会关掉这个弹框，并按该账号自动过滤对应页面。
        </p>
        <AccountTimeline
          items={timelineItems}
          isLoading={timelineQuery.isLoading}
          isError={timelineQuery.isError}
          errorMessage={getErrorMessage(timelineQuery.error)}
          onNavigate={onNavigate}
        />
        {timelineQuery.data?.hasMore && timelineLimit < 200 ? (
          <Button
            type='button'
            variant='outline'
            className='mt-2 h-8'
            disabled={timelineQuery.isFetching}
            onClick={() =>
              setTimelineLimit((current) => Math.min(200, current + 50))
            }
          >
            再显示 50 条
          </Button>
        ) : null}
      </div>
      <div>
        <h3 className='mb-2 text-sm font-semibold'>最近样本</h3>
        <AccountSampleExplorer
          samples={history.samples}
          egressNodeNames={egressNodeNames}
          deletingSampleId={deletingSampleId}
          onDeleteSample={onDeleteSample}
        />
      </div>
    </div>
  )
}

function AccountSsoRiskBadge({ account }: { account: UpstreamAccount }) {
  const status =
    account.ssoRiskStatus || (account.ssoAvailable ? 'unverified' : 'missing')
  const recommendation = account.egressRecommendation
  if (recommendation?.type === 'change_egress') {
    return (
      <Badge
        variant='warning'
        className='gap-1'
        title={`${recommendation.reason}${recommendation.priority != null ? `；当前降级优先级 ${recommendation.priority}` : ''}`}
      >
        <Network className='size-3' />
        换出口
      </Badge>
    )
  }
  const meta =
    status === 'flagged'
      ? { label: 'SSO 已标记', variant: 'destructive' as const }
      : status === 'clean'
        ? {
            label:
              account.ssoPreDisableAction === 'deprioritize_disabled'
                ? 'SSO 正常 · 待降级'
                : 'SSO 正常',
            variant: 'success' as const,
          }
        : status === 'pending'
          ? { label: 'SSO 复检中', variant: 'secondary' as const }
          : status === 'failed'
            ? { label: 'SSO 复检失败', variant: 'warning' as const }
            : status === 'missing'
              ? { label: '缺少 SSO', variant: 'outline' as const }
              : status === 'skipped'
                ? { label: '已跳过 SSO 复检', variant: 'outline' as const }
                : { label: 'SSO 未复检', variant: 'outline' as const }
  return (
    <Badge
      variant={meta.variant}
      title={
        account.ssoRiskCheckedAt
          ? `${meta.label} · ${formatDate(account.ssoRiskCheckedAt)}`
          : meta.label
      }
    >
      {meta.label}
    </Badge>
  )
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className='rounded-lg border p-3'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 text-sm font-semibold'>{value}</div>
    </div>
  )
}
