import { useEffect, useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  CircleCheckBig,
  CircleHelp,
  Layers3,
  ListChecks,
  Play,
  RefreshCw,
  Route,
  ShieldAlert,
  TriangleAlert,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type EgressNode,
  type ExecutionMode,
  type ProbeProfile,
  type ProbeRunBatchResult,
} from '@/lib/api'
import { getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ModelBindWindowHint } from '@/features/monitor/components/model-bind-window-hint'
import { ProfileMultiSelect } from '@/features/monitor/components/profile-multi-select'

type ProbeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountIds: number[]
  disabledAccountCount?: number
  sourceTaskCount?: number
  sourceAuditCount?: number
  profiles: ProbeProfile[]
  profilesLoading?: boolean
  profilesError?: string
  onRefreshProfiles?: () => void
  egress: EgressNode[]
  egressLoading: boolean
  egressError: string
  onRefreshEgress: () => void
  onCreated: () => void
}

export function ProbeDialog({
  open,
  onOpenChange,
  accountIds,
  disabledAccountCount = 0,
  sourceTaskCount = 0,
  sourceAuditCount = 0,
  profiles,
  profilesLoading = false,
  profilesError = '',
  onRefreshProfiles,
  egress,
  egressLoading,
  egressError,
  onRefreshEgress,
  onCreated,
}: ProbeDialogProps) {
  const [profileIds, setProfileIds] = useState<string[]>(['quality-marker'])
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('chat')
  const [rounds, setRounds] = useState(1)
  const [targetMode, setTargetMode] = useState<'current' | 'diagnostic'>(
    'current'
  )
  const [direct, setDirect] = useState(false)
  const [nodes, setNodes] = useState<number[]>([])
  const [batchResult, setBatchResult] = useState<ProbeRunBatchResult | null>(
    null
  )
  const selectableEgress = egress.filter(
    (node) => node.enabled && node.proxyConfigured
  )
  const selectableNodeIds = new Set(
    selectableEgress.map((node) => Number(node.id))
  )
  const selectedNodes = nodes.filter((id) => selectableNodeIds.has(id))
  const enabledProfiles = profiles.filter((profile) => profile.enabled)
  const enabledProfileIdSet = new Set(
    enabledProfiles.map((profile) => profile.id)
  )
  const selectedProfileIds = profileIds.filter((id) =>
    enabledProfileIdSet.has(id)
  )
  const quickProfile =
    enabledProfiles.find((profile) => profile.id === 'quality-marker') ??
    enabledProfiles[0]
  const effectiveProfileIds =
    executionMode === 'quality_test'
      ? quickProfile
        ? [quickProfile.id]
        : []
      : selectedProfileIds
  const qualityTestAvailable =
    selectableEgress.length > 0 && quickProfile != null

  useEffect(() => {
    if (!open) return
    const availableProfiles = profiles.filter((profile) => profile.enabled)
    const availableProfileIdSet = new Set(
      availableProfiles.map((profile) => profile.id)
    )
    // Opening the dialog reconciles the draft against the latest profile query.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProfileIds((current) => {
      const valid = current.filter((id) => availableProfileIdSet.has(id))
      if (valid.length) return valid
      const fallback =
        availableProfiles.find((profile) => profile.id === 'quality-marker') ??
        availableProfiles[0]
      return fallback ? [fallback.id] : []
    })
  }, [open, profiles])

  useEffect(() => {
    if (!open) return
    // Every manual invocation starts in the non-mutating normal-check mode.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTargetMode('current')
    setDirect(false)
    setNodes([])
    setRounds(1)
    setExecutionMode('chat')
    setBatchResult(null)
  }, [open])

  const mutation = useMutation({
    mutationFn: async () => {
      const proxyTargets = [
        ...(executionMode === 'chat' && targetMode === 'current'
          ? [{ kind: 'current', id: null }]
          : []),
        ...(executionMode === 'chat' && targetMode === 'diagnostic' && direct
          ? [{ kind: 'direct', id: null }]
          : []),
        ...(targetMode === 'diagnostic'
          ? selectedNodes.map((id) => ({ kind: 'egress', id }))
          : []),
      ]
      if (!proxyTargets.length) {
        throw new Error(
          executionMode === 'quality_test'
            ? '快速出口质量探针至少选择一个出口节点'
            : '异常诊断至少选择一个上游调度或固定出口'
        )
      }
      if (!effectiveProfileIds.length) {
        throw new Error(
          executionMode === 'quality_test'
            ? '当前没有已启用的快速质量基线'
            : '至少选择一个已启用的探针方案'
        )
      }
      return api.createRunsBatch({
        account_ids: accountIds,
        profile_id: effectiveProfileIds[0],
        profile_ids: effectiveProfileIds,
        execution_mode: executionMode,
        rounds,
        proxy_targets: proxyTargets,
      })
    },
    onSuccess: (result) => {
      setBatchResult(result)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const targetCount =
    executionMode === 'chat' && targetMode === 'current'
      ? 1
      : (executionMode === 'chat' && direct ? 1 : 0) + selectedNodes.length

  const closeDialog = () => {
    if (batchResult?.created) onCreated()
    onOpenChange(false)
  }

  if (batchResult) {
    return (
      <ProbeBatchResultDialog
        open={open}
        result={batchResult}
        onBack={() => setBatchResult(null)}
        onClose={closeDialog}
      />
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size='wide'
        className='flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden'
      >
        <DialogHeader className='shrink-0'>
          <DialogTitle>创建账号探针</DialogTitle>
          <DialogDescription>
            每个“账号 ×
            方案”生成一个持久任务；正常定检不修改账号设置，异常诊断的临时修改会自动恢复。
          </DialogDescription>
        </DialogHeader>
        <div className='grid min-h-0 gap-5 overflow-y-auto py-2 pr-1'>
          <div className='grid gap-2'>
            <label className='text-sm font-medium'>执行模式</label>
            <Select
              value={executionMode}
              onValueChange={(value: ExecutionMode) => {
                setExecutionMode(value)
                if (value === 'chat') {
                  setTargetMode('current')
                } else {
                  setTargetMode('diagnostic')
                  if (!selectedNodes.length) {
                    setNodes(selectableEgress.map((node) => Number(node.id)))
                  }
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='chat'>完整对话探针</SelectItem>
                <SelectItem
                  value='quality_test'
                  disabled={!qualityTestAvailable}
                >
                  快速出口质量探针
                  {!qualityTestAvailable ? '（缺少出口或内置基线）' : ''}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className='text-xs leading-5 text-muted-foreground'>
              {executionMode === 'chat'
                ? '固定目标账号并调用 /v1/responses；正常定检保持账号现有出口绑定不变。'
                : '通过 grok2api 出口 quality-test 接口获取哈希和指标，并使用审计记录核验实际账号与出口。'}
            </p>
          </div>
          {executionMode === 'chat' ? (
            <div className='grid gap-2'>
              <label className='text-sm font-medium'>
                探针方案
                <span className='ms-1 text-destructive' aria-hidden='true'>
                  *
                </span>
              </label>
              <ProfileMultiSelect
                profiles={profiles}
                value={selectedProfileIds}
                onChange={setProfileIds}
                disabled={profilesLoading}
                enabledOnly
                invalid={!selectedProfileIds.length}
                placeholder={
                  profilesLoading ? '正在读取探针方案…' : '选择探针方案'
                }
              />
              {profilesError && (
                <div className='flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive'>
                  <TriangleAlert className='mt-0.5 size-4 shrink-0' />
                  <span className='min-w-0 flex-1'>
                    探针方案读取异常：{profilesError}
                  </span>
                  {onRefreshProfiles && (
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-7 shrink-0 px-2 text-xs'
                      disabled={profilesLoading}
                      onClick={onRefreshProfiles}
                    >
                      <RefreshCw
                        className={profilesLoading ? 'animate-spin' : undefined}
                      />
                      重试
                    </Button>
                  )}
                </div>
              )}
              <p className='text-xs leading-5 text-muted-foreground'>
                多选后按账号与方案组合拆分为独立任务，检测结果仍分别归属到具体方案。
              </p>
            </div>
          ) : (
            <div className='flex items-start gap-3 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3'>
              <Layers3 className='mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400' />
              <div className='min-w-0'>
                <div className='text-sm font-medium'>自动使用快速质量基线</div>
                <p className='mt-1 text-xs leading-5 text-muted-foreground'>
                  {quickProfile
                    ? `${quickProfile.name} · ${quickProfile.model}`
                    : '当前没有已启用的内置质量基线'}
                </p>
              </div>
            </div>
          )}
          <div className='grid gap-2'>
            <label className='text-sm font-medium'>轮数</label>
            <Input
              type='number'
              min={1}
              max={20}
              value={rounds}
              onChange={(event) =>
                setRounds(Math.max(1, Math.min(20, Number(event.target.value))))
              }
            />
          </div>
          <div className='grid gap-2'>
            <div className='flex items-center justify-between gap-2'>
              <div className='flex items-center gap-2'>
                <label className='text-sm font-medium'>出口目标</label>
                {!egressLoading && (
                  <span className='text-xs text-muted-foreground'>
                    {selectableEgress.length} 个可用
                  </span>
                )}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type='button'
                    size='icon'
                    variant='ghost'
                    className='size-7'
                    disabled={egressLoading}
                    onClick={onRefreshEgress}
                    aria-label='刷新出口节点'
                  >
                    <RefreshCw
                      className={egressLoading ? 'animate-spin' : undefined}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>刷新 grok2api 出口节点</TooltipContent>
              </Tooltip>
            </div>
            {egressError && (
              <div className='flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive'>
                <TriangleAlert className='mt-0.5 size-4 shrink-0' />
                <span>{egressError}</span>
              </div>
            )}
            {executionMode === 'chat' ? (
              <div className='grid gap-2'>
                <Select
                  value={targetMode}
                  onValueChange={(value: 'current' | 'diagnostic') =>
                    setTargetMode(value)
                  }
                >
                  <SelectTrigger aria-label='探针用途'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='current'>
                      正常定检 · 账号当前出口
                    </SelectItem>
                    <SelectItem value='diagnostic'>
                      异常诊断 · 临时切换出口
                    </SelectItem>
                  </SelectContent>
                </Select>
                {targetMode === 'current' ? (
                  <div className='rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs leading-5 text-muted-foreground'>
                    只检测已启用且已绑定固定出口的账号；不会解除、切换或重新写入账号出口。请求前后均使用审计核验实际节点。
                  </div>
                ) : (
                  <label className='flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm'>
                    <Checkbox
                      checked={direct}
                      onCheckedChange={(value) => setDirect(value === true)}
                    />
                    <Route className='size-4 text-muted-foreground' />
                    <span className='font-medium'>上游调度</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className='inline-flex size-6 cursor-help items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground'
                          tabIndex={0}
                          aria-label='上游调度说明'
                        >
                          <CircleHelp className='size-3.5' />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className='max-w-80'>
                        仅用于人工异常诊断：临时解除固定出口绑定，由 grok2api
                        选择节点，并在任务结束后恢复原绑定。
                      </TooltipContent>
                    </Tooltip>
                  </label>
                )}
              </div>
            ) : (
              <div className='rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 text-xs leading-5 text-muted-foreground'>
                快速模式由 grok2api 的出口节点接口执行，仅支持已配置代理的
                grok_build 出口，不包含上游调度目标。
              </div>
            )}
            {(targetMode === 'diagnostic' ||
              executionMode === 'quality_test') && (
              <ModelBindWindowHint variant='probe' />
            )}
            {targetMode === 'diagnostic' && selectableEgress.length ? (
              <div className='grid max-h-56 gap-2 overflow-auto sm:grid-cols-2'>
                {selectableEgress.map((node) => {
                  const id = Number(node.id)
                  return (
                    <label
                      key={node.id}
                      className='flex items-center gap-2 rounded-lg border p-3 text-sm'
                    >
                      <Checkbox
                        checked={nodes.includes(id)}
                        onCheckedChange={(value) =>
                          setNodes((current) =>
                            value
                              ? [...current, id]
                              : current.filter((item) => item !== id)
                          )
                        }
                      />
                      <span className='min-w-0 flex-1 truncate'>
                        {node.name}
                      </span>
                      <span className='text-xs text-muted-foreground'>
                        {node.exitIp || `#${id}`}
                      </span>
                    </label>
                  )
                })}
              </div>
            ) : targetMode === 'diagnostic' ? (
              <div className='flex items-start gap-3 rounded-lg border border-dashed p-3'>
                {egressLoading ? (
                  <RefreshCw className='mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground' />
                ) : (
                  <TriangleAlert className='mt-0.5 size-4 shrink-0 text-amber-500' />
                )}
                <div className='min-w-0 flex-1'>
                  <div className='text-sm font-medium'>
                    {egressLoading ? '正在读取出口节点' : '暂无可选固定出口'}
                  </div>
                  <p className='mt-1 text-xs leading-5 text-muted-foreground'>
                    {egressLoading
                      ? '正在从 grok2api 同步最新的出口节点配置。'
                      : 'grok2api 当前没有已启用且已配置代理的 grok_build 出口节点。正常定检仍可使用账号当前绑定。'}
                  </p>
                  {executionMode === 'quality_test' && (
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='mt-2'
                      onClick={() => {
                        setExecutionMode('chat')
                        setTargetMode('current')
                      }}
                    >
                      <Route />
                      使用账号当前出口
                    </Button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <div className='flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 p-3'>
            {sourceTaskCount > 0 && (
              <ProbeSummaryFact
                icon={ListChecks}
                value={sourceTaskCount}
                tooltip='已选任务数；其中重复账号已按账号 ID 合并'
              />
            )}
            {sourceAuditCount > 0 && (
              <ProbeSummaryFact
                icon={ListChecks}
                value={sourceAuditCount}
                tooltip='来源请求审计记录数；其中重复账号已按账号 ID 合并'
              />
            )}
            <ProbeSummaryFact
              icon={UsersRound}
              value={accountIds.length}
              tooltip='去重后的账号数'
            />
            {executionMode === 'chat' && (
              <ProbeSummaryFact
                icon={Layers3}
                value={selectedProfileIds.length}
                tooltip='每个账号使用的探针方案数'
              />
            )}
            <ProbeSummaryFact
              icon={RefreshCw}
              value={rounds}
              tooltip='每个账号的测试轮数'
            />
            <ProbeSummaryFact
              icon={Route}
              value={targetCount}
              tooltip='每轮出口目标数'
            />
            <ProbeSummaryFact
              icon={Play}
              value={
                accountIds.length *
                effectiveProfileIds.length *
                rounds *
                targetCount
              }
              tooltip={
                executionMode === 'chat'
                  ? '/v1/responses 请求总数'
                  : '出口质量请求总数'
              }
            />
            {disabledAccountCount > 0 && (
              <ProbeSummaryFact
                icon={ShieldAlert}
                value={disabledAccountCount}
                tooltip='停用账号数；请求前使用负优先级和单并发短时激活，请求后恢复原设置'
                warning
              />
            )}
          </div>
          {accountIds.length === 1 &&
            (effectiveProfileIds.length > 1 || targetCount > 1) && (
              <div className='flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3'>
                <TriangleAlert className='mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400' />
                <div className='min-w-0 text-xs leading-5 text-muted-foreground'>
                  <div className='font-medium text-foreground'>
                    单账号任务按顺序执行
                  </div>
                  多个方案会拆成 {effectiveProfileIds.length}{' '}
                  个任务。诊断模式中的出口按轮次依次切换；账号出口和原设置属于共享状态，因此即使配置多个
                  Worker，也不会同时接管同一个账号；选择多个账号后才会并行。
                </div>
              </div>
            )}
        </div>
        <DialogFooter className='shrink-0'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={
              mutation.isPending ||
              profilesLoading ||
              !accountIds.length ||
              !effectiveProfileIds.length ||
              targetCount === 0
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? '创建中…' : '加入队列'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProbeBatchResultDialog({
  open,
  result,
  onBack,
  onClose,
}: {
  open: boolean
  result: ProbeRunBatchResult
  onBack: () => void
  onClose: () => void
}) {
  const skippedAccounts = getSkippedAccounts(result)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>探针任务创建结果</DialogTitle>
          <DialogDescription>
            {skippedAccounts.length
              ? '已完成本次创建请求，未创建的账号和原因如下。'
              : '所选账号的探针任务均已创建。'}
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4'>
          <div className='flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4'>
            <CircleCheckBig className='size-5 shrink-0 text-emerald-600 dark:text-emerald-400' />
            <div>
              <div className='text-2xl font-semibold tabular-nums'>
                {result.created}
              </div>
              <div className='text-xs text-muted-foreground'>已创建任务</div>
            </div>
          </div>
          {skippedAccounts.length > 0 && (
            <div className='grid gap-2'>
              <div className='flex items-center gap-2 text-sm font-medium'>
                <TriangleAlert className='size-4 text-amber-500' />
                {skippedAccounts.length} 个账号未创建
              </div>
              <div className='max-h-72 overflow-y-auto rounded-lg border'>
                {skippedAccounts.map((account) => (
                  <div
                    key={account.id}
                    className='grid gap-1 border-b px-4 py-3 last:border-b-0'
                  >
                    <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium'>
                      <span>{account.name || `账号 ${account.id}`}</span>
                      <Badge variant='outline'>ID {account.id}</Badge>
                      {account.email && (
                        <span className='text-xs font-normal text-muted-foreground'>
                          {account.email}
                        </span>
                      )}
                    </div>
                    <p className='text-xs leading-5 text-muted-foreground'>
                      {account.reason}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          {!result.created && (
            <Button variant='outline' onClick={onBack}>
              返回调整
            </Button>
          )}
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function getSkippedAccounts(result: ProbeRunBatchResult) {
  if (result.skippedAccounts?.length) return result.skippedAccounts
  const invalid = result.invalidAccounts.map((account) => ({
    ...account,
    name: '',
    email: '',
    code: 'invalid' as const,
  }))
  return [
    ...invalid,
    ...result.restoreBlockedAccountIds.map((id) => ({
      id,
      name: '',
      email: '',
      code: 'restore_blocked' as const,
      reason: `账号 ${id} 存在未完成的原设置恢复，请先在历史任务中同步`,
    })),
    ...result.activeAccountIds.map((id) => ({
      id,
      name: '',
      email: '',
      code: 'active_run' as const,
      reason: `账号 ${id} 已有排队或执行中的探针任务，请等待其结束`,
    })),
    ...result.missingAccountIds.map((id) => ({
      id,
      name: '',
      email: '',
      code: 'missing' as const,
      reason: `账号 ${id} 已不在 grok2api 账号列表中`,
    })),
  ].filter(
    (account, index, accounts) =>
      accounts.findIndex((item) => item.id === account.id) === index
  )
}

function ProbeSummaryFact({
  icon: Icon,
  value,
  tooltip,
  warning = false,
}: {
  icon: LucideIcon
  value: ReactNode
  tooltip: string
  warning?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium tabular-nums ${warning ? 'border-amber-500/30 text-amber-700 dark:text-amber-300' : ''}`}
          tabIndex={0}
        >
          <Icon className='size-3.5' />
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-72'>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
