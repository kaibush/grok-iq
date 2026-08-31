import { useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatAccountSecondaryLabel } from '@/lib/account-label'
import { api, type ProbeSample } from '@/lib/api'
import { StatusBadge } from '@/lib/status'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { CopyButton } from '@/components/copy-button'
import {
  HtmlPreviewButton,
  MarkdownView,
} from '@/components/formatted-content'
import { extractHtmlPreviews } from '@/lib/formatted-content'
import { LoadingState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  getEgressNodeName,
  type EgressNodeNameMap,
} from '@/features/monitor/components/egress-node-names'
import { ReasoningPanel } from '@/features/monitor/components/reasoning-panel'
import { DualTpsValue } from '@/features/monitor/components/tps-display'
import {
  ModelBindWindowError,
  ModelBindWindowHint,
  isModelBindWindowIssue,
} from '@/features/monitor/components/model-bind-window-hint'

const STACKED_Z = 'z-[70]'

export function ProbeRunDetailDialog({
  runId,
  open,
  onOpenChange,
  egressNodeNames,
  stacked = false,
}: {
  runId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  egressNodeNames: EgressNodeNameMap
  stacked?: boolean
}) {
  const detail = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.run(runId!),
    enabled: open && Boolean(runId),
  })
  const run = detail.data?.run
  const profile = detail.data?.profile
  const samples = detail.data?.samples ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size='wide'
        className={stacked ? `${STACKED_Z} overflow-hidden` : 'overflow-hidden'}
        overlayClassName={stacked ? STACKED_Z : undefined}
      >
        <DialogHeader className='shrink-0'>
          <DialogTitle>探针任务详情</DialogTitle>
          <DialogDescription className='flex items-center gap-1 font-mono'>
            <span className='min-w-0 break-all'>{runId}</span>
            {runId ? <CopyButton value={runId} className='size-6' /> : null}
          </DialogDescription>
        </DialogHeader>
        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1'>
          {detail.isLoading ? (
            <LoadingState />
          ) : detail.isError ? (
            <div className='p-6 text-sm text-destructive'>
              {getErrorMessage(detail.error)}
            </div>
          ) : run ? (
            <div className='space-y-5'>
              <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
                <DetailMetric
                  label='账号'
                  value={
                    <div className='min-w-0'>
                      <div className='flex items-start gap-1'>
                        <div className='min-w-0 break-all'>
                          {run.account_name || run.account_email || `账号 ${run.account_id}`}
                        </div>
                        <CopyButton
                          value={
                            run.account_email?.trim() || String(run.account_id)
                          }
                          className='size-6'
                        />
                      </div>
                      <div className='mt-1 text-xs font-normal text-muted-foreground'>
                        {formatAccountSecondaryLabel({
                          id: run.account_id,
                          email: run.account_email,
                          createdAt: run.account_created_at,
                          accountLabel:
                            run.account_name ||
                            run.account_email ||
                            `账号 ${run.account_id}`,
                        })}
                      </div>
                    </div>
                  }
                />
                <DetailMetric
                  label='任务状态'
                  value={<Badge variant='outline'>{run.status}</Badge>}
                />
                <DetailMetric
                  label='进度'
                  value={`${run.completed_steps} / ${run.total_steps}`}
                />
                <DetailMetric label='错误' value={run.error_count} />
              </div>
              {run.error ? <ModelBindWindowError message={run.error} /> : null}
              {profile ? (
                <div className='rounded-lg border bg-muted/20 p-4'>
                  <div className='text-sm font-medium'>{profile.name}</div>
                  <div className='mt-1 text-xs text-muted-foreground'>
                    {profile.model}
                    {profile.expected_text
                      ? ` · 自动校验标记 ${profile.expected_text}`
                      : ''}
                  </div>
                  {profile.prompt ? (
                    <div className='mt-3 text-sm whitespace-pre-wrap'>
                      {profile.prompt}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className='space-y-3'>
                {samples.map((sample) => (
                  <PreviewSampleCard
                    key={sample.id}
                    sample={sample}
                    expectedImageUrl={profile?.expected_image_url}
                    egressNodeNames={egressNodeNames}
                  />
                ))}
                {!samples.length ? (
                  <div className='rounded-lg border border-dashed p-6 text-sm text-muted-foreground'>
                    尚无样本
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PreviewSampleCard({
  sample,
  expectedImageUrl,
  egressNodeNames,
}: {
  sample: ProbeSample
  expectedImageUrl?: string
  egressNodeNames: EgressNodeNameMap
}) {
  const responseText = sample.response_text || ''
  const preview = useMemo(
    () => responseText.slice(0, 240).replace(/\s+/g, ' ').trim(),
    [responseText]
  )
  return (
    <div className='rounded-xl border bg-card'>
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-3'>
        <span className='text-sm font-semibold'>
          第 {sample.round_number || 1} 轮 ·{' '}
          {sampleTargetLabel(sample, egressNodeNames)}
        </span>
        <StatusBadge value={sample.classification} />
        <span className='ms-auto text-xs text-muted-foreground'>
          {formatDate(sample.created_at)}
        </span>
      </div>
      <div className='grid gap-3 border-b bg-muted/15 p-4 sm:grid-cols-3 lg:grid-cols-5'>
        <DetailMetric
          label='TPS'
          value={
            <DualTpsValue
              tps={sample.tps}
              upstreamTps={sample.upstream_tps}
              compact
            />
          }
        />
        <DetailMetric
          label='首 Token'
          value={`${formatNumber(sample.first_token_ms, 0)} ms`}
        />
        <DetailMetric
          label='总耗时'
          value={`${formatNumber(sample.duration_ms, 0)} ms`}
        />
        <DetailMetric
          label='输出 Token'
          value={formatNumber(sample.output_tokens, 0)}
        />
        <DetailMetric
          label='预期匹配'
          value={
            sample.expected_matched == null
              ? '—'
              : sample.expected_matched
                ? '是'
                : '否'
          }
        />
      </div>
      <div className='space-y-3 p-4'>
        {sample.error ? (
          <div className='space-y-2'>
            <div className='rounded-lg bg-destructive/10 p-3 text-sm break-words whitespace-pre-wrap text-destructive'>
              {sample.error}
            </div>
            {isModelBindWindowIssue(sample.error, sample.error_code) ? (
              <ModelBindWindowHint variant='error' />
            ) : null}
          </div>
        ) : null}
        <ReasoningPanel
          content={sample.reasoning_text || ''}
          tokenCount={sample.reasoning_tokens}
        />
        {extractHtmlPreviews(responseText).length > 0 ? (
          <div className='text-sm text-muted-foreground'>
            HTML 响应已折叠，可点预览查看效果
          </div>
        ) : responseText ? (
          <div className='max-h-64 overflow-auto rounded-lg border bg-muted/10 p-3'>
            <MarkdownView content={responseText} />
          </div>
        ) : preview ? (
          <div className='text-sm text-muted-foreground'>{preview}</div>
        ) : null}
        <HtmlPreviewButton
          content={responseText}
          expectedImageUrl={expectedImageUrl}
        />
      </div>
    </div>
  )
}


function sampleTargetLabel(
  sample: ProbeSample,
  egressNodeNames: EgressNodeNameMap
) {
  if (sample.target_kind === 'current') {
    const node =
      sample.verified_egress_node_id ?? sample.egress_node_id ?? undefined
    return `账号当前出口 · ${
      getEgressNodeName(egressNodeNames, node) || `Node ${node ?? '未核验'}`
    }`
  }
  if (sample.target_kind !== 'direct') {
    return sample.egress_name || `出口 ${sample.egress_node_id ?? '—'}`
  }
  if (!sample.verified_egress_node_id) return '上游调度诊断 · 本地出口'
  return `上游调度诊断 · ${
    getEgressNodeName(egressNodeNames, sample.verified_egress_node_id) ||
    `Node ${sample.verified_egress_node_id}`
  }`
}

function DetailMetric({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <div className='min-w-0'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 text-sm font-medium'>{value}</div>
    </div>
  )
}
