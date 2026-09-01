import { useState, type ReactNode } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { type ProbeSample } from '@/lib/api'
import { StatusBadge } from '@/lib/status'
import { cn, formatDate, formatNumber } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FormattedContentPreviewButton } from '@/components/formatted-content'
import {
  getEgressNodeName,
  type EgressNodeNameMap,
} from '@/features/monitor/components/egress-node-names'
import { ReasoningPanel } from '@/features/monitor/components/reasoning-panel'
import {
  ModelBindWindowHint,
  isModelBindWindowIssue,
} from '@/features/monitor/components/model-bind-window-hint'
import { DualTpsValue, SampleTpsDetail } from '@/features/monitor/components/tps-display'

type AccountSampleExplorerProps = {
  samples: ProbeSample[]
  egressNodeNames: EgressNodeNameMap
  deletingSampleId?: string | null
  onDeleteSample?: (sample: ProbeSample) => void
  countLabel?: ReactNode
  className?: string
}

export function AccountSampleExplorer({
  samples,
  egressNodeNames,
  deletingSampleId = null,
  onDeleteSample,
  countLabel,
  className,
}: AccountSampleExplorerProps) {
  const [selectedId, setSelectedId] = useState(samples[0]?.id ?? '')
  const selected =
    samples.find((sample) => sample.id === selectedId) ?? samples[0]
  if (!selected) {
    return (
      <div className='rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground'>
        暂无探针样本
      </div>
    )
  }
  return (
    <div
      className={cn(
        'grid min-h-0 overflow-hidden rounded-xl border bg-muted/10 lg:grid-cols-[21rem_minmax(0,1fr)]',
        className
      )}
    >
      <div className='border-b bg-background lg:border-e lg:border-b-0'>
        <div className='flex items-center justify-between border-b px-3 py-2.5'>
          <span className='text-sm font-medium'>选择样本</span>
          <Badge variant='secondary'>
            {countLabel ?? `${samples.length} 条`}
          </Badge>
        </div>
        <div className='max-h-64 space-y-1 overflow-y-auto p-2 lg:max-h-[38rem]'>
          {samples.map((sample) => {
            const active = sample.id === selected.id
            const target = sampleTargetText(sample, egressNodeNames)
            return (
              <button
                key={sample.id}
                type='button'
                aria-pressed={active}
                className={cn(
                  'w-full rounded-lg border px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'border-primary/45 bg-primary/5'
                    : 'border-transparent hover:border-border hover:bg-muted/40'
                )}
                onClick={() => setSelectedId(sample.id)}
              >
                <div className='flex items-center justify-between gap-2'>
                  <StatusBadge value={sample.classification} />
                  <span className='shrink-0 text-xs text-muted-foreground'>
                    {formatDate(sample.created_at)}
                  </span>
                </div>
                <div
                  className='mt-2 truncate text-sm font-medium'
                  title={target}
                >
                  {target}
                </div>
                <div className='mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums'>
                  <SampleListMetric
                    label='TPS'
                    value={
                      <DualTpsValue
                        tps={sample.tps}
                        upstreamTps={sample.upstream_tps}
                        compact
                      />
                    }
                  />
                  <SampleListMetric
                    label='首 Token'
                    value={`${sample.first_token_ms} ms`}
                  />
                  <SampleListMetric
                    label='输出'
                    value={formatNumber(sample.output_tokens, 0)}
                  />
                </div>
                {sample.error_code && (
                  <div className='mt-2 truncate font-mono text-xs text-destructive'>
                    {sample.error_code}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
      <SampleDetail
        sample={selected}
        egressNodeNames={egressNodeNames}
        deleting={deletingSampleId === selected.id}
        onDelete={onDeleteSample ? () => onDeleteSample(selected) : undefined}
      />
    </div>
  )
}

function SampleDetail({
  sample,
  egressNodeNames,
  deleting,
  onDelete,
}: {
  sample: ProbeSample
  egressNodeNames: EgressNodeNameMap
  deleting: boolean
  onDelete?: () => void
}) {
  const responseText = sample.response_text || ''
  return (
    <div className='min-w-0 bg-background'>
      <div className='flex flex-wrap items-start gap-2 border-b px-4 py-3'>
        <div className='min-w-0 flex-1'>
          <div className='text-sm font-semibold break-all'>
            {sampleTargetText(sample, egressNodeNames)}
          </div>
          <div className='mt-1 text-xs text-muted-foreground'>
            第 {sample.round_number} 轮 · {formatDate(sample.created_at)}
          </div>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <StatusBadge value={sample.classification} />
          {sample.error_code && (
            <Badge variant='outline' className='font-mono'>
              {sample.error_code}
            </Badge>
          )}
          {onDelete && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type='button'
                  size='icon'
                  variant='ghost'
                  className='size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                  disabled={deleting}
                  onClick={onDelete}
                  aria-label='删除当前样本'
                >
                  {deleting ? <Loader2 className='animate-spin' /> : <Trash2 />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>删除样本</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className='space-y-4 p-4'>
        <div className='grid gap-2 sm:grid-cols-3 xl:grid-cols-6'>
          <SampleFact
            label='TPS'
            value={
              <SampleTpsDetail
                tps={sample.tps}
                upstreamTps={sample.upstream_tps}
                outputTokens={sample.output_tokens}
                generationMs={sample.generation_ms}
              />
            }
          />
          <SampleFact label='首 Token' value={`${sample.first_token_ms} ms`} />
          <SampleFact label='总耗时' value={`${sample.duration_ms} ms`} />
          <SampleFact label='生成窗口' value={`${sample.generation_ms} ms`} />
          <SampleFact label='输出 Token' value={sample.output_tokens} />
          <SampleFact
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
        <div className='grid gap-2 sm:grid-cols-2 xl:grid-cols-4'>
          <SampleEvidence label='HTTP' value={sample.status_code || '—'} />
          <SampleEvidence label='Request ID' value={sample.request_id} />
          <SampleEvidence label='响应哈希' value={sample.response_sha256} />
          <SampleEvidence label='核验账号' value={sample.verified_account_id} />
          <SampleEvidence
            label='目标出口'
            value={
              sample.egress_node_id
                ? getEgressNodeName(egressNodeNames, sample.egress_node_id) ||
                  `Node ${sample.egress_node_id}`
                : sample.target_kind === 'direct'
                  ? '上游调度（诊断）'
                  : sample.egress_name
            }
          />
          <SampleEvidence
            label='实际出口'
            value={
              sample.verified_egress_node_id
                ? getEgressNodeName(
                    egressNodeNames,
                    sample.verified_egress_node_id
                  ) || `Node ${sample.verified_egress_node_id}`
                : sample.target_kind === 'direct'
                  ? '本地出口'
                  : '未核验'
            }
          />
          <SampleEvidence label='审计 ID' value={sample.audit_id} />
          <SampleEvidence
            label='重试'
            value={sample.retry_count ? `${sample.retry_count} 次` : '0 次'}
          />
        </div>
        {sample.error && (
          <div className='space-y-2'>
            <div className='rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm break-words whitespace-pre-wrap text-destructive'>
              {sample.error}
            </div>
            {isModelBindWindowIssue(sample.error, sample.error_code) ? (
              <ModelBindWindowHint variant='error' />
            ) : null}
          </div>
        )}
        <ReasoningPanel content={sample.reasoning_text || ''} tokenCount={sample.reasoning_tokens} />
        {responseText ? (
          <div className='flex items-center justify-between gap-3 rounded-lg border bg-muted/15 px-3 py-2.5'>
            <div className='min-w-0'>
              <div className='text-sm font-medium'>响应内容</div>
              <div className='text-xs text-muted-foreground'>
                正文已收起 · {formatNumber(responseText.length, 0)} 个字符
              </div>
            </div>
            <FormattedContentPreviewButton
              content={responseText}
              label='预览响应'
              title={`样本响应 · 第 ${sample.round_number} 轮`}
              className='shrink-0'
            />
          </div>
        ) : (
          <div className='rounded-lg border border-dashed p-4 text-sm text-muted-foreground'>
            此样本未保存响应正文，可通过请求 ID、响应哈希和审计核验字段定位。
          </div>
        )}
      </div>
    </div>
  )
}

function SampleListMetric({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <div className='min-w-0'>
      <div className='truncate text-[10px] text-muted-foreground'>{label}</div>
      <div className='truncate font-medium'>{value}</div>
    </div>
  )
}

export function sampleTargetText(
  sample: ProbeSample,
  egressNodeNames: EgressNodeNameMap
): string {
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

function SampleFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className='rounded-md border bg-background px-2.5 py-2'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 text-sm font-semibold tabular-nums'>{value}</div>
    </div>
  )
}

function SampleEvidence({ label, value }: { label: string; value: ReactNode }) {
  const title =
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : undefined
  return (
    <div className='min-w-0 rounded-md border bg-background px-2.5 py-2 text-xs'>
      <div className='text-muted-foreground'>{label}</div>
      <div className='mt-1 truncate font-mono' title={title}>
        {value == null || value === '' ? '—' : value}
      </div>
    </div>
  )
}
