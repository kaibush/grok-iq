import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  CreditCard,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Users,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type ClientKeyPlanType,
  type ManagedClientKey,
} from '@/lib/api'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { CopyableText } from '@/components/copy-button'
import { NumericInput } from '@/components/numeric-input'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { ServerPagination } from '@/components/server-pagination'
import { StatCard } from '@/components/stat-card'
import { TablePanel } from '@/components/table-panel'

const PAGE_SIZE_OPTIONS = [20, 50, 100]
const PAID_OPTIONS = [
  { value: 'all', label: '全部用户' },
  { value: 'paid', label: '付费用户' },
  { value: 'unpaid', label: '未付费' },
] as const
const PLAN_OPTIONS = [
  { value: 'all', label: '全部卡种' },
  { value: 'day', label: '天卡' },
  { value: 'week', label: '周卡' },
  { value: 'month', label: '月卡' },
  { value: 'none', label: '未设卡种' },
] as const
const ENABLED_OPTIONS = [
  { value: 'all', label: '全部启停' },
  { value: 'true', label: '已启用' },
  { value: 'false', label: '已停用' },
] as const
const UPSTREAM_OPTIONS = [
  { value: 'all', label: '全部同步状态' },
  { value: 'present', label: '仍在 grok2api' },
  { value: 'missing', label: '上游已消失' },
] as const

const PLAN_LABELS: Record<ClientKeyPlanType, string> = {
  none: '未设卡种',
  day: '天卡',
  week: '周卡',
  month: '月卡',
}

type PaidFilter = (typeof PAID_OPTIONS)[number]['value']
type PlanFilter = (typeof PLAN_OPTIONS)[number]['value']
type EnabledFilter = (typeof ENABLED_OPTIONS)[number]['value']
type UpstreamFilter = (typeof UPSTREAM_OPTIONS)[number]['value']

type EditorState = {
  id: string
  name: string
  maskedKey: string
  paid: boolean
  planType: ClientKeyPlanType
  rechargeYuan: number
  note: string
}

export function ClientKeysPage() {
  const queryClient = useQueryClient()
  const [draftQuery, setDraftQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [paid, setPaid] = useState<PaidFilter>('all')
  const [planType, setPlanType] = useState<PlanFilter>('all')
  const [enabled, setEnabled] = useState<EnabledFilter>('all')
  const [upstream, setUpstream] = useState<UpstreamFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [editor, setEditor] = useState<EditorState | null>(null)

  const keysQuery = useQuery({
    queryKey: [
      'client-keys',
      appliedQuery,
      paid,
      planType,
      enabled,
      upstream,
      page,
      pageSize,
    ],
    queryFn: () =>
      api.clientKeys({
        q: appliedQuery,
        paid: paid === 'all' ? '' : paid,
        planType: planType === 'all' ? '' : planType,
        enabled: enabled === 'all' ? '' : enabled,
        upstream: upstream === 'all' ? '' : upstream,
        page,
        pageSize,
      }),
    placeholderData: (previous) => previous,
  })

  const syncMutation = useMutation({
    mutationFn: () => api.syncClientKeys(),
    onSuccess: async (result) => {
      const parts = [
        `已同步 ${formatNumber(result.fetched, 0)} 个密钥`,
        `新增 ${formatNumber(result.created, 0)}`,
        `更新 ${formatNumber(result.updated, 0)}`,
      ]
      if (result.skippedProbeKeys > 0) {
        parts.push(
          `跳过 ${formatNumber(result.skippedProbeKeys, 0)} 个探针密钥`
        )
      }
      if (result.skippedSystemKeys > 0) {
        parts.push(
          `跳过 ${formatNumber(result.skippedSystemKeys, 0)} 个系统密钥`
        )
      }
      if (result.missing > 0) {
        parts.push(`${formatNumber(result.missing, 0)} 个上游已消失`)
      }
      toast.success(parts.join('，'))
      await queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const updateMutation = useMutation({
    mutationFn: async (payload: EditorState) => {
      if (payload.paid && payload.planType === 'none') {
        throw new Error('付费用户需要选择天卡、周卡或月卡')
      }
      return api.updateClientKey(payload.id, {
        paid: payload.paid,
        planType: payload.paid ? payload.planType : 'none',
        rechargeYuan: payload.rechargeYuan.toFixed(2),
        note: payload.note,
      })
    },
    onSuccess: async (result) => {
      toast.success(`已保存 ${result.name || result.maskedKey}`)
      setEditor(null)
      await queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const ledger = keysQuery.data
  const rows = ledger?.items ?? []
  const summary = ledger?.summary
  const loading = keysQuery.isPending && !keysQuery.data
  const error = keysQuery.isError ? getErrorMessage(keysQuery.error) : ''
  const editorError = useMemo(() => {
    if (!editor) return ''
    if (editor.paid && editor.planType === 'none') {
      return '付费用户需要选择天卡、周卡或月卡'
    }
    if (editor.rechargeYuan < 0) return '累计充值不能为负数'
    if (editor.rechargeYuan > 100000000) return '累计充值不能超过 100000000 元'
    return ''
  }, [editor])

  const hasFilters =
    appliedQuery !== '' ||
    paid !== 'all' ||
    planType !== 'all' ||
    enabled !== 'all' ||
    upstream !== 'all'

  function submitSearch() {
    setAppliedQuery(draftQuery.trim())
    setPage(1)
  }

  function changeFilter<T extends string>(setter: (value: T) => void, value: T) {
    setter(value)
    setPage(1)
  }

  return (
    <Page>
      <PageHeader
        title='密钥管理'
        description='从 grok2api 同步 Client Key，本地标记付费用户、卡种和累计充值。不会回显密钥明文。'
        actions={
          <ActionToolbar label='密钥管理操作'>
            <ToolbarAction
              label='从 grok2api 同步'
              pending={syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
            >
              <RefreshCw />
            </ToolbarAction>
            <ToolbarAction
              label='刷新列表'
              pending={keysQuery.isFetching && !syncMutation.isPending}
              onClick={() => {
                void keysQuery.refetch()
              }}
            >
              <KeyRound />
            </ToolbarAction>
          </ActionToolbar>
        }
      />

      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard
          compact
          label='密钥'
          value={summary ? formatNumber(summary.total, 0) : '—'}
          detail={
            summary?.lastSyncedAt
              ? `最近同步 ${formatDate(summary.lastSyncedAt)}`
              : '尚未从 grok2api 同步'
          }
          icon={KeyRound}
          tone='sky'
          loading={loading}
          index={0}
        />
        <StatCard
          compact
          label='付费用户'
          value={summary ? formatNumber(summary.paid, 0) : '—'}
          detail={`未付费 ${summary ? formatNumber(summary.unpaid, 0) : '—'}`}
          icon={Users}
          tone='emerald'
          loading={loading}
          index={1}
        />
        <StatCard
          compact
          label='卡种'
          value={
            summary
              ? `${formatNumber(summary.day, 0)} / ${formatNumber(summary.week, 0)} / ${formatNumber(summary.month, 0)}`
              : '—'
          }
          detail='天卡 / 周卡 / 月卡'
          icon={CalendarDays}
          tone='amber'
          loading={loading}
          index={2}
        />
        <StatCard
          compact
          label='累计充值'
          value={summary ? formatYuan(summary.rechargeYuan) : '—'}
          detail={
            summary && summary.missing > 0
              ? `${formatNumber(summary.missing, 0)} 个上游已消失`
              : '按当前筛选合计'
          }
          icon={Wallet}
          tone='violet'
          loading={loading}
          index={3}
        />
      </div>

      <TablePanel
        toolbar={
          <form
            className='flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center'
            onSubmit={(event) => {
              event.preventDefault()
              submitSearch()
            }}
          >
            <div className='relative min-w-0 flex-1'>
              <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
              <Input
                value={draftQuery}
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder='搜索名称、前缀、ID 或备注，回车搜索'
                aria-label='搜索密钥'
                className='ps-9'
              />
            </div>
            <div className='flex min-w-0 flex-wrap items-center gap-2'>
              <Select
                value={paid}
                onValueChange={(value) =>
                  changeFilter(setPaid, value as PaidFilter)
                }
              >
                <SelectTrigger className='h-8 w-full sm:w-36' aria-label='付费筛选'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAID_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={planType}
                onValueChange={(value) =>
                  changeFilter(setPlanType, value as PlanFilter)
                }
              >
                <SelectTrigger className='h-8 w-full sm:w-36' aria-label='卡种筛选'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={enabled}
                onValueChange={(value) =>
                  changeFilter(setEnabled, value as EnabledFilter)
                }
              >
                <SelectTrigger className='h-8 w-full sm:w-36' aria-label='启停筛选'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENABLED_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={upstream}
                onValueChange={(value) =>
                  changeFilter(setUpstream, value as UpstreamFilter)
                }
              >
                <SelectTrigger className='h-8 w-full sm:w-44' aria-label='同步状态筛选'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UPSTREAM_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type='submit' variant='outline' size='sm'>
                搜索
              </Button>
              <Button
                type='button'
                size='sm'
                disabled={syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
              >
                {syncMutation.isPending ? (
                  <Loader2 className='animate-spin' />
                ) : (
                  <RefreshCw />
                )}
                同步密钥
              </Button>
            </div>
          </form>
        }
        footer={
          <ServerPagination
            page={page}
            pageSize={pageSize}
            total={ledger?.total ?? 0}
            disabled={loading}
            loading={keysQuery.isFetching}
            itemLabel='个密钥'
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
        }
      >
        {error ? (
          <p className='px-1 py-3 text-sm text-destructive'>
            密钥读取失败：{error}
          </p>
        ) : loading ? (
          <LoadingState label='正在加载密钥' />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={KeyRound}
            title={hasFilters ? '没有匹配的密钥' : '还没有同步密钥'}
            description={
              hasFilters
                ? '试试调整付费、卡种或搜索条件。'
                : '点击同步密钥，从 grok2api 拉取 Client Key。本地付费标记会在后续同步中保留。'
            }
            className='border-0 bg-transparent'
          />
        ) : (
          <div className='overflow-x-auto'>
            <Table>
              <TableHeader>
                <TableRow className='hover:bg-transparent'>
                  <TableHead>名称</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>卡种</TableHead>
                  <TableHead>累计充值</TableHead>
                  <TableHead>额度</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>截止日期</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className='hover:bg-transparent'>
                    <TableCell className='max-w-[12rem]'>
                      <div className='truncate font-medium' title={row.name}>
                        {row.name || '未命名'}
                      </div>
                      {row.note ? (
                        <div
                          className='mt-0.5 truncate text-xs text-muted-foreground'
                          title={row.note}
                        >
                          {row.note}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className='font-mono text-xs'>
                      <CopyableText value={row.maskedKey} />
                    </TableCell>
                    <TableCell>
                      <PaidBadge paid={row.paid} />
                    </TableCell>
                    <TableCell>
                      <PlanBadge planType={row.planType} />
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {formatYuan(row.rechargeYuan)}
                    </TableCell>
                    <TableCell className='whitespace-nowrap text-muted-foreground'>
                      {row.unlimited
                        ? '不限额'
                        : `${formatUsd(row.remainingUsd)} / ${formatUsd(row.billingLimitUsd)}`}
                    </TableCell>
                    <TableCell>
                      <div className='flex flex-wrap gap-1'>
                        <Badge variant={row.enabled ? 'success' : 'secondary'}>
                          {row.enabled ? '启用' : '停用'}
                        </Badge>
                        {row.expired ? (
                          <Badge variant='warning'>已过期</Badge>
                        ) : null}
                        {row.upstreamMissing ? (
                          <Badge variant='destructive'>上游消失</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell
                      className={
                        row.expired
                          ? 'whitespace-nowrap text-amber-600 dark:text-amber-400'
                          : 'whitespace-nowrap text-muted-foreground'
                      }
                    >
                      {formatDate(row.expiresAt)}
                    </TableCell>
                    <TableCell className='whitespace-nowrap text-muted-foreground'>
                      {formatDate(row.upstreamCreatedAt ?? row.createdAt)}
                    </TableCell>
                    <TableCell className='whitespace-nowrap text-muted-foreground'>
                      {formatDate(row.lastUsedAt)}
                    </TableCell>
                    <TableCell className='text-right'>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type='button'
                            size='icon'
                            variant='ghost'
                            className='size-7'
                            onClick={() => setEditor(toEditor(row))}
                            aria-label={`标记 ${row.name || row.maskedKey}`}
                          >
                            <Pencil />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>标记付费用户</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TablePanel>

      <ClientKeyEditorDialog
        editor={editor}
        pending={updateMutation.isPending}
        error={editorError}
        onOpenChange={(open) => {
          if (!open && !updateMutation.isPending) setEditor(null)
        }}
        onChange={setEditor}
        onSubmit={() => {
          if (!editor || editorError) return
          updateMutation.mutate(editor)
        }}
      />
    </Page>
  )
}

function ClientKeyEditorDialog({
  editor,
  pending,
  error,
  onOpenChange,
  onChange,
  onSubmit,
}: {
  editor: EditorState | null
  pending: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onChange: (editor: EditorState) => void
  onSubmit: () => void
}) {
  return (
    <Dialog open={editor != null} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>标记付费用户</DialogTitle>
          <DialogDescription>
            {editor
              ? `为 ${editor.name || editor.maskedKey} 记录卡种和累计充值。这些标记保存在 GrokIQ，不会写回 grok2api。`
              : '记录卡种和累计充值。'}
          </DialogDescription>
        </DialogHeader>
        {editor ? (
          <div className='space-y-4'>
            <div className='flex items-center justify-between rounded-lg border px-3 py-2'>
              <div>
                <Label htmlFor='client-key-paid'>付费用户</Label>
                <p className='text-xs text-muted-foreground'>
                  打开后需要选择天卡、周卡或月卡
                </p>
              </div>
              <Switch
                id='client-key-paid'
                checked={editor.paid}
                onCheckedChange={(paid) =>
                  onChange({
                    ...editor,
                    paid,
                    planType: paid
                      ? editor.planType === 'none'
                        ? 'month'
                        : editor.planType
                      : 'none',
                  })
                }
              />
            </div>
            <div className='space-y-1.5'>
              <Label>卡种</Label>
              <Select
                value={editor.planType}
                disabled={!editor.paid}
                onValueChange={(value) =>
                  onChange({
                    ...editor,
                    planType: value as ClientKeyPlanType,
                  })
                }
              >
                <SelectTrigger aria-label='选择卡种'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {editor.paid ? null : (
                    <SelectItem value='none'>未设卡种</SelectItem>
                  )}
                  <SelectItem value='day'>天卡</SelectItem>
                  <SelectItem value='week'>周卡</SelectItem>
                  <SelectItem value='month'>月卡</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='client-key-recharge'>累计充值（元）</Label>
              <NumericInput
                id='client-key-recharge'
                min={0}
                max={100000000}
                step={0.01}
                value={editor.rechargeYuan}
                onChange={(rechargeYuan) =>
                  onChange({ ...editor, rechargeYuan })
                }
              />
              <p className='text-xs text-muted-foreground'>
                按累计充值总额记录，取消付费标记时不会清零。
              </p>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='client-key-note'>备注</Label>
              <Textarea
                id='client-key-note'
                value={editor.note}
                maxLength={500}
                onChange={(event) =>
                  onChange({ ...editor, note: event.target.value })
                }
                placeholder='可选，例如用户来源或续费说明'
              />
            </div>
            {error ? <p className='text-sm text-destructive'>{error}</p> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type='button'
            disabled={pending || Boolean(error) || editor == null}
            onClick={onSubmit}
          >
            {pending ? <Loader2 className='animate-spin' /> : <CreditCard />}
            保存标记
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PaidBadge({ paid }: { paid: boolean }) {
  return (
    <Badge variant={paid ? 'success' : 'secondary'}>
      {paid ? '付费' : '未付费'}
    </Badge>
  )
}

function PlanBadge({ planType }: { planType: ClientKeyPlanType }) {
  if (planType === 'none') {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <Badge variant={planType === 'month' ? 'info' : 'outline'}>
      {PLAN_LABELS[planType]}
    </Badge>
  )
}

function toEditor(row: ManagedClientKey): EditorState {
  return {
    id: row.id,
    name: row.name,
    maskedKey: row.maskedKey,
    paid: row.paid,
    planType: row.planType,
    rechargeYuan: row.rechargeYuan,
    note: row.note,
  }
}

function formatYuan(value: number) {
  return `¥${formatNumber(value, 2)}`
}

function formatUsd(value: number) {
  return `$${formatNumber(value, 2)}`
}
