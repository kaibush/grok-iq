import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { formatAccountSecondaryLabel } from '@/lib/account-label'
import { api, type OperatorNote, type UpstreamAccount } from '@/lib/api'
import { formatDate, getErrorMessage } from '@/lib/utils'
import { MonitorStatusCell } from '@/components/monitor-status-badge'
import { EnabledBadge } from '@/components/enabled-badge'
import { CopyButton } from '@/components/copy-button'
import { EmptyState, LoadingState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AccountSampleExplorer } from '@/features/monitor/components/account-sample-explorer'
import { DispositionBanner } from '@/features/monitor/components/disposition-summary'
import { buildEgressNodeNameMap } from '@/features/monitor/components/egress-node-names'
import type { AccountIdentity } from '@/features/monitor/components/account-upstream-dialog'

function accountOperatorNotes(account: UpstreamAccount | null): OperatorNote[] {
  if (!account) return []
  const notes = account.assessment?.operator_notes
  if (Array.isArray(notes) && notes.length > 0) {
    return notes.filter((note) => String(note.content || '').trim())
  }
  const legacy = String(account.assessment?.operator_note ?? '').trim()
  if (!legacy) return []
  return [{ id: 'legacy', content: legacy, created_at: '', updated_at: null }]
}

export function AccountSamplesDialog({
  open,
  accountId,
  account,
  onOpenChange,
}: {
  open: boolean
  accountId: number | null
  account?: AccountIdentity | null
  onOpenChange: (open: boolean) => void
}) {
  const detailQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => api.account(accountId!),
    enabled: open && accountId != null,
  })
  const samplesQuery = useQuery({
    queryKey: ['account-samples', accountId],
    queryFn: () => api.accountSamples(accountId!, { page: 1, pageSize: 50 }),
    enabled: open && accountId != null,
  })
  const egressQuery = useQuery({
    queryKey: ['egress'],
    queryFn: () => api.egress({ pageSize: 500 }),
    enabled: open,
    staleTime: 60_000,
  })
  const detailAccount = detailQuery.data?.account ?? null
  const samples = samplesQuery.data?.items ?? detailQuery.data?.history.samples ?? []
  const egressNodeNames = useMemo(
    () => buildEgressNodeNameMap(egressQuery.data?.items),
    [egressQuery.data?.items]
  )
  const accountLabel =
    detailAccount?.name ||
    detailAccount?.email ||
    account?.name ||
    account?.email ||
    (accountId != null ? `账号 ${accountId}` : '账号样本')
  const notes = accountOperatorNotes(detailAccount)
  const loading =
    (detailQuery.isLoading && !detailQuery.data) ||
    (samplesQuery.isLoading && !samplesQuery.data)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size='wide' className='overflow-hidden'>
        <DialogHeader className='shrink-0'>
          <DialogTitle className='flex items-center gap-2'>
            <Eye className='size-5 text-primary' />
            <span className='min-w-0 truncate'>{accountLabel}</span>
            {detailAccount || account ? (
              <CopyButton
                value={
                  (detailAccount?.email || account?.email)?.trim() ||
                  String(detailAccount?.id ?? account?.id ?? accountId ?? '')
                }
                className='size-6'
              />
            ) : null}
          </DialogTitle>
          <DialogDescription>
            {detailAccount || account
              ? formatAccountSecondaryLabel({
                  id: detailAccount?.id ?? account?.id ?? accountId ?? '',
                  email: detailAccount?.email || account?.email,
                  createdAt: detailAccount?.createdAt,
                  accountLabel,
                })
              : '查看该账号的探针样本'}
          </DialogDescription>
        </DialogHeader>
        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1'>
          {loading ? (
            <LoadingState />
          ) : detailQuery.isError && !detailQuery.data ? (
            <EmptyState
              icon={Eye}
              title='无法加载账号样本'
              description={getErrorMessage(detailQuery.error)}
              compact
            />
          ) : (
            <div className='space-y-4'>
              {detailAccount ? (
                <div className='flex flex-wrap items-center gap-2'>
                  <MonitorStatusCell
                    status={detailAccount.assessment?.monitor_status}
                    score={detailAccount.assessment?.risk_score}
                  />
                  {detailAccount.missingUpstream ? (
                    <Badge variant='outline'>上游缺失</Badge>
                  ) : (
                    <EnabledBadge enabled={detailAccount.enabled} prefix='上游' />
                  )}
                  <span className='text-xs text-muted-foreground'>
                    {detailAccount.assessment?.sample_count ?? samples.length} 条样本
                  </span>
                </div>
              ) : null}
              {notes.length > 0 ? (
                <div className='rounded-lg border bg-muted/30 p-3'>
                  <div className='text-sm font-medium'>备注</div>
                  <ul className='mt-2 space-y-2'>
                    {notes.map((note) => (
                      <li key={note.id} className='text-sm leading-6'>
                        <div className='text-[11px] text-muted-foreground tabular-nums'>
                          {note.updated_at || note.created_at
                            ? formatDate(note.updated_at || note.created_at)
                            : '时间未知'}
                          {note.updated_at ? ' · 已修改' : ''}
                        </div>
                        <p className='whitespace-pre-wrap text-muted-foreground'>
                          {note.content}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <DispositionBanner
                disposition={detailAccount?.assessment?.disposition}
                sampleReasons={detailAccount?.assessment?.risk_reasons ?? []}
              />
              <AccountSampleExplorer
                key={String(detailAccount?.id ?? accountId ?? 'samples')}
                samples={samples}
                egressNodeNames={egressNodeNames}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
