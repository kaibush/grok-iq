import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarClock,
  CircleHelp,
  Clock3,
  Copy,
  Edit3,
  Eye,
  History,
  Layers3,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UsersRound,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type PlanAccountScope,
  type ProbePlan,
  type ProbeProfile,
  type RuntimeSettings,
  type ScheduleExecution,
  type SchedulerJob,
} from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { cn, formatDate, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { NumericInput } from '@/components/numeric-input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { IconBadge } from '@/components/ui/icon-badge'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EnabledBadge } from '@/components/enabled-badge'
import { InfoTooltip } from '@/components/info-tooltip'
import { Page, PageHeader, LoadingState, EmptyState } from '@/components/page'
import { SelectionToolbar } from '@/components/selection-toolbar'
import { TablePanel } from '@/components/table-panel'
import { TitledCard } from '@/components/titled-card'
import { AccountMultiSelect } from '@/features/monitor/components/account-multi-select'
import { ProfileMultiSelect } from '@/features/monitor/components/profile-multi-select'

type CronView = 'plans' | 'system' | 'history'

type SchedulerSettingsForm = Pick<
  RuntimeSettings,
  | 'schedulerEnabled'
  | 'quarantineRecoveryEnabled'
  | 'schedulerTimezone'
  | 'schedulerMisfireGraceSeconds'
  | 'recoveryCron'
  | 'scheduledProbeRegisterCooldownMinutes'
>

export function PlansPage() {
  const client = useQueryClient()
  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: api.plans,
    refetchInterval: 10_000,
  })
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const scheduler = useQuery({
    queryKey: ['scheduler'],
    queryFn: api.scheduler,
    refetchInterval: 10_000,
  })
  const [activeView, setActiveView] = useState<CronView>('plans')
  const [editingPlan, setEditingPlan] = useState<ProbePlan | 'new' | null>(null)
  const [viewingPlan, setViewingPlan] = useState<ProbePlan | null>(null)
  const [deletingPlan, setDeletingPlan] = useState<ProbePlan | null>(null)
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([])
  const [selectedExecutionIds, setSelectedExecutionIds] = useState<string[]>([])
  const [schedulerForm, setSchedulerForm] =
    useState<SchedulerSettingsForm | null>(null)
  const [bulkRunOpen, setBulkRunOpen] = useState(false)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [bulkDeleteExecutionsOpen, setBulkDeleteExecutionsOpen] =
    useState(false)
  const planItems = useMemo(() => plans.data ?? [], [plans.data])
  const executions = useMemo(
    () => scheduler.data?.executions ?? [],
    [scheduler.data?.executions]
  )
  const systemJobs = scheduler.data?.systemJobs ?? []
  const planIdSet = useMemo(
    () => new Set(planItems.map((plan) => plan.id)),
    [planItems]
  )
  const planById = useMemo(
    () => new Map(planItems.map((plan) => [plan.id, plan])),
    [planItems]
  )
  const executionIdSet = useMemo(
    () => new Set(executions.map((execution) => execution.id)),
    [executions]
  )
  const selectedPlans = planItems.filter((plan) =>
    selectedPlanIds.includes(plan.id)
  )
  const allPlansSelected =
    planItems.length > 0 && selectedPlans.length === planItems.length
  const selectedExecutions = executions.filter((execution) =>
    selectedExecutionIds.includes(execution.id)
  )
  const allExecutionsSelected =
    executions.length > 0 && selectedExecutions.length === executions.length

  useEffect(() => {
    // Keep selection aligned with the latest server-side plan list.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedPlanIds((current) => {
      const next = current.filter((id) => planIdSet.has(id))
      return next.length === current.length ? current : next
    })
  }, [planIdSet])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedExecutionIds((current) => {
      const next = current.filter((id) => executionIdSet.has(id))
      return next.length === current.length ? current : next
    })
  }, [executionIdSet])

  useEffect(() => {
    if (!settings.data) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSchedulerForm(toSchedulerSettingsForm(settings.data))
  }, [settings.data])

  const mutation = useMutation({
    mutationFn: async ({
      action,
      id,
    }: {
      action: 'run' | 'delete'
      id: string
    }) => {
      if (action === 'run') return api.runPlan(id)
      await api.deletePlan(id)
      return undefined
    },
    onSuccess: (result, variables) => {
      if (variables.action === 'run') {
        const created = Number(result?.created ?? 0)
        const restoreBlocked = Array.isArray(result?.restoreBlockedAccountIds)
          ? result.restoreBlockedAccountIds.length
          : 0
        if (created > 0) {
          toast.success(
            restoreBlocked
              ? `已加入 ${created} 个任务，${restoreBlocked} 个账号等待原设置同步`
              : `已加入 ${created} 个任务`
          )
        } else {
          toast.warning(
            restoreBlocked
              ? `${restoreBlocked} 个账号等待原设置同步`
              : '本次未创建新任务'
          )
        }
      } else {
        toast.success('计划已删除')
        setDeletingPlan(null)
        setSelectedPlanIds((current) =>
          current.filter((id) => id !== variables.id)
        )
      }
      void client.invalidateQueries({ queryKey: ['plans'] })
      void client.invalidateQueries({ queryKey: ['runs'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const bulkRunMutation = useMutation({
    mutationFn: api.runPlans,
    onSuccess: (result) => {
      setBulkRunOpen(false)
      const message = [`已加入 ${result.created} 个任务`]
      if (result.failed) message.push(`${result.failed} 个计划执行失败`)
      if (result.restoreBlocked) {
        message.push(`${result.restoreBlocked} 个账号等待原设置同步`)
      }
      if (result.failed || result.restoreBlocked) {
        toast.warning(message.join('，'))
      } else {
        toast.success(message.join('，'))
      }
      void client.invalidateQueries({ queryKey: ['plans'] })
      void client.invalidateQueries({ queryKey: ['runs'] })
      void client.invalidateQueries({ queryKey: ['scheduler'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const bulkDeleteMutation = useMutation({
    mutationFn: api.deletePlans,
    onSuccess: (result) => {
      setBulkDeleteOpen(false)
      setSelectedPlanIds(result.activeIds ?? [])
      if (result.active) {
        toast.warning(
          `已删除 ${result.deleted} 个计划；${result.active} 个计划仍有排队或执行任务，已跳过并保留选择`
        )
      } else {
        toast.success(`已删除 ${result.deleted} 个计划`)
      }
      void client.invalidateQueries({ queryKey: ['plans'] })
      void client.invalidateQueries({ queryKey: ['scheduler'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const togglePlanMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setPlanEnabled(id, enabled),
    onMutate: async ({ id, enabled }) => {
      await client.cancelQueries({ queryKey: ['plans'] })
      const previous = client.getQueryData<ProbePlan[]>(['plans'])
      client.setQueryData<ProbePlan[]>(['plans'], (current) =>
        current?.map((plan) =>
          plan.id === id
            ? { ...plan, enabled, job: enabled ? plan.job : null }
            : plan
        )
      )
      return { previous }
    },
    onSuccess: (_result, { enabled }) => {
      toast.success(enabled ? '计划已启用' : '计划已停用')
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        client.setQueryData(['plans'], context.previous)
      }
      toast.error(getErrorMessage(error))
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['plans'] })
      void client.invalidateQueries({ queryKey: ['scheduler'] })
    },
  })
  const saveSchedulerMutation = useMutation({
    mutationFn: () => {
      if (!schedulerForm) throw new Error('Scheduler 设置尚未加载')
      if (!schedulerForm.schedulerTimezone.trim()) {
        throw new Error('请填写默认时区')
      }
      if (!schedulerForm.recoveryCron.trim()) {
        throw new Error('请填写隔离恢复 Cron')
      }
      if (
        !Number.isFinite(schedulerForm.schedulerMisfireGraceSeconds) ||
        schedulerForm.schedulerMisfireGraceSeconds < 1 ||
        schedulerForm.schedulerMisfireGraceSeconds > 86400
      ) {
        throw new Error('Misfire 宽限必须在 1 到 86400 秒之间')
      }
      if (
        !Number.isInteger(
          schedulerForm.scheduledProbeRegisterCooldownMinutes
        ) ||
        schedulerForm.scheduledProbeRegisterCooldownMinutes < 0 ||
        schedulerForm.scheduledProbeRegisterCooldownMinutes > 10080
      ) {
        throw new Error('首次探针冷却必须在 0 到 10080 分钟之间')
      }
      return api.updateSettings({
        ...schedulerForm,
        schedulerTimezone: schedulerForm.schedulerTimezone.trim(),
        recoveryCron: schedulerForm.recoveryCron.trim(),
      })
    },
    onSuccess: (value) => {
      client.setQueryData(['settings'], value)
      setSchedulerForm(toSchedulerSettingsForm(value))
      toast.success('Scheduler 设置已保存并热应用')
      void client.invalidateQueries({ queryKey: ['scheduler'] })
      void client.invalidateQueries({ queryKey: ['plans'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const deleteExecutionMutation = useMutation({
    mutationFn: api.deleteSchedulerExecution,
    onSuccess: (_value, executionId) => {
      toast.success('调用记录已删除')
      setSelectedExecutionIds((current) =>
        current.filter((id) => id !== executionId)
      )
      void client.invalidateQueries({ queryKey: ['scheduler'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const bulkDeleteExecutionsMutation = useMutation({
    mutationFn: api.deleteSchedulerExecutions,
    onSuccess: (result) => {
      setBulkDeleteExecutionsOpen(false)
      setSelectedExecutionIds(result.runningIds ?? [])
      if (result.running) {
        toast.warning(
          `已删除 ${result.deleted} 条记录；${result.running} 条仍在执行，已跳过并保留选择`
        )
      } else {
        toast.success(`已删除 ${result.deleted} 条调用记录`)
      }
      void client.invalidateQueries({ queryKey: ['scheduler'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  const bulkPending = bulkRunMutation.isPending || bulkDeleteMutation.isPending
  const executionBusy =
    deleteExecutionMutation.isPending || bulkDeleteExecutionsMutation.isPending

  const togglePlanSelection = (id: string, checked: boolean) => {
    setSelectedPlanIds((current) =>
      checked
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((value) => value !== id)
    )
  }

  const toggleExecutionSelection = (id: string, checked: boolean) => {
    setSelectedExecutionIds((current) =>
      checked
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((value) => value !== id)
    )
  }

  if (plans.isLoading || profiles.isLoading)
    return (
      <Page>
        <LoadingState />
      </Page>
    )
  return (
    <Page>
      <PageHeader
        title='Cron 调度'
        description='集中管理探针计划、系统 Cron 设置和每次调度调用记录。'
        descriptionAsHint
        actions={
          activeView === 'plans' ? (
            <>
              <ActionToolbar label='Cron 计划操作'>
                <ToolbarAction
                  label='刷新 Cron 计划'
                  pending={plans.isFetching}
                  onClick={() => void plans.refetch()}
                >
                  <RefreshCw />
                </ToolbarAction>
                <ToolbarAction
                  label={allPlansSelected ? '取消全选计划' : '全选全部计划'}
                  active={allPlansSelected}
                  disabled={planItems.length === 0 || bulkPending}
                  onClick={() =>
                    setSelectedPlanIds(
                      allPlansSelected ? [] : planItems.map((plan) => plan.id)
                    )
                  }
                >
                  <ListChecks />
                </ToolbarAction>
                <ToolbarAction
                  label='新建 Cron 计划'
                  disabled={bulkPending}
                  onClick={() => setEditingPlan('new')}
                >
                  <Plus />
                </ToolbarAction>
              </ActionToolbar>
              <SelectionToolbar
                selectedCount={selectedPlanIds.length}
                entityLabel='计划'
                disabled={bulkPending}
                onClear={() => setSelectedPlanIds([])}
              >
                <ToolbarAction
                  label={`立即运行 ${selectedPlanIds.length} 个计划`}
                  disabled={bulkPending}
                  pending={bulkRunMutation.isPending}
                  onClick={() => setBulkRunOpen(true)}
                >
                  <Play />
                </ToolbarAction>
                <ToolbarAction
                  label={`删除 ${selectedPlanIds.length} 个计划`}
                  destructive
                  disabled={bulkPending}
                  pending={bulkDeleteMutation.isPending}
                  onClick={() => setBulkDeleteOpen(true)}
                >
                  <Trash2 />
                </ToolbarAction>
              </SelectionToolbar>
            </>
          ) : activeView === 'system' ? (
            <ActionToolbar label='系统 Cron 操作'>
              <ToolbarAction
                label='刷新系统 Cron 状态'
                pending={settings.isFetching || scheduler.isFetching}
                onClick={() => {
                  void settings.refetch()
                  void scheduler.refetch()
                }}
              >
                <RefreshCw />
              </ToolbarAction>
              <ToolbarAction
                label='保存并热应用系统 Cron 设置'
                disabled={!schedulerForm}
                pending={saveSchedulerMutation.isPending}
                onClick={() => saveSchedulerMutation.mutate()}
              >
                <Save />
              </ToolbarAction>
            </ActionToolbar>
          ) : (
            <>
              <ActionToolbar label='调用记录操作'>
                <ToolbarAction
                  label='刷新调用记录'
                  pending={scheduler.isFetching}
                  onClick={() => void scheduler.refetch()}
                >
                  <RefreshCw />
                </ToolbarAction>
                <ToolbarAction
                  label={allExecutionsSelected ? '取消全选记录' : '全选记录'}
                  active={allExecutionsSelected}
                  disabled={executions.length === 0 || executionBusy}
                  onClick={() =>
                    setSelectedExecutionIds(
                      allExecutionsSelected
                        ? []
                        : executions.map((execution) => execution.id)
                    )
                  }
                >
                  <ListChecks />
                </ToolbarAction>
              </ActionToolbar>
              <SelectionToolbar
                selectedCount={selectedExecutionIds.length}
                entityLabel='调用记录'
                disabled={executionBusy}
                onClear={() => setSelectedExecutionIds([])}
              >
                <ToolbarAction
                  label={`删除 ${selectedExecutionIds.length} 条调用记录`}
                  destructive
                  disabled={executionBusy}
                  pending={bulkDeleteExecutionsMutation.isPending}
                  onClick={() => setBulkDeleteExecutionsOpen(true)}
                >
                  <Trash2 />
                </ToolbarAction>
              </SelectionToolbar>
            </>
          )
        }
      />
      <Tabs
        value={activeView}
        onValueChange={(value) => setActiveView(value as CronView)}
        className='gap-4'
      >
        <TabsList className='w-full justify-start overflow-x-auto sm:w-fit'>
          <TabsTrigger value='plans'>
            <CalendarClock />
            计划
            <Badge
              variant='secondary'
              className='h-5 min-w-5 border-0 px-1.5 text-[11px] tabular-nums'
            >
              {planItems.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value='system'>
            <Clock3 />
            系统 Cron
          </TabsTrigger>
          <TabsTrigger value='history'>
            <History />
            调用记录
            <Badge
              variant='secondary'
              className='h-5 min-w-5 border-0 px-1.5 text-[11px] tabular-nums'
            >
              {executions.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value='plans' className='mt-0'>
          <div className='grid gap-3 lg:grid-cols-2'>
            {plans.data?.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                profiles={profiles.data ?? []}
                selected={selectedPlanIds.includes(plan.id)}
                pending={
                  mutation.isPending ||
                  bulkPending ||
                  (togglePlanMutation.isPending &&
                    togglePlanMutation.variables?.id === plan.id)
                }
                onSelectedChange={(checked) =>
                  togglePlanSelection(plan.id, checked)
                }
                onView={() => setViewingPlan(plan)}
                onEdit={() => setEditingPlan(plan)}
                onEnabledChange={(enabled) =>
                  togglePlanMutation.mutate({ id: plan.id, enabled })
                }
                onRun={() => mutation.mutate({ action: 'run', id: plan.id })}
                onDelete={() => setDeletingPlan(plan)}
              />
            ))}
            {!plans.data?.length && (
              <div className='lg:col-span-2'>
                <EmptyState
                  title='暂无 Cron 计划'
                  description='创建正常定检计划，或为异常账号配置临时出口诊断。'
                />
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value='system' className='mt-0'>
          <SystemCronPanel
            form={schedulerForm}
            loading={settings.isLoading}
            error={settings.error}
            running={scheduler.data?.running === true}
            plansEnabled={
              scheduler.data?.plansEnabled ?? scheduler.data?.enabled ?? false
            }
            systemRecoveryEnabled={
              scheduler.data?.systemRecoveryEnabled ??
              settings.data?.quarantineRecoveryEnabled ??
              false
            }
            jobs={systemJobs}
            disabled={saveSchedulerMutation.isPending}
            onChange={setSchedulerForm}
          />
        </TabsContent>

        <TabsContent value='history' className='mt-0'>
          <ExecutionHistory
            executions={executions}
            planById={planById}
            selectedIds={selectedExecutionIds}
            busy={executionBusy}
            loading={scheduler.isLoading}
            error={scheduler.error}
            onSelectedChange={toggleExecutionSelection}
            onViewPlan={setViewingPlan}
            onDelete={(id) => deleteExecutionMutation.mutate(id)}
          />
        </TabsContent>
      </Tabs>
      {editingPlan && (
        <PlanDialog
          key={editingPlan === 'new' ? 'new' : editingPlan.id}
          open
          value={editingPlan}
          profiles={profiles.data ?? []}
          onOpenChange={(open) => !open && setEditingPlan(null)}
          onSaved={() => {
            setEditingPlan(null)
            void client.invalidateQueries({ queryKey: ['plans'] })
          }}
        />
      )}
      {viewingPlan && (
        <PlanDetailDialog
          open
          plan={viewingPlan}
          profiles={profiles.data ?? []}
          onOpenChange={(open) => !open && setViewingPlan(null)}
        />
      )}
      <ConfirmDialog
        open={deletingPlan != null}
        onOpenChange={(open) =>
          !mutation.isPending && !open && setDeletingPlan(null)
        }
        title='删除 Cron 计划？'
        desc={
          <>
            将删除「{deletingPlan?.name}
            」。历史任务和样本继续保留；仍有排队或执行任务时会保留计划。
          </>
        }
        confirmText={
          <>
            <Trash2 />
            删除计划
          </>
        }
        cancelBtnText='取消'
        destructive
        isLoading={mutation.isPending}
        disabled={!deletingPlan}
        handleConfirm={() => {
          if (deletingPlan) {
            mutation.mutate({ action: 'delete', id: deletingPlan.id })
          }
        }}
      />
      <ConfirmDialog
        open={bulkRunOpen}
        onOpenChange={(open) =>
          !bulkRunMutation.isPending && setBulkRunOpen(open)
        }
        title={`立即运行 ${selectedPlanIds.length} 个 Cron 计划？`}
        desc='每个计划会按自己的账号、方案、出口和重叠策略创建任务；超出队列容量或已有重叠任务时会自动跳过。'
        confirmText={
          <>
            <Play />
            立即运行
          </>
        }
        cancelBtnText='取消'
        isLoading={bulkRunMutation.isPending}
        disabled={selectedPlanIds.length === 0}
        handleConfirm={() => bulkRunMutation.mutate(selectedPlanIds)}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) =>
          !bulkDeleteMutation.isPending && setBulkDeleteOpen(open)
        }
        title={`删除 ${selectedPlanIds.length} 个 Cron 计划？`}
        desc='仅删除计划本身；历史任务和样本继续保留。仍有排队或执行任务的计划会自动跳过。'
        confirmText={
          <>
            <Trash2 />
            删除计划
          </>
        }
        cancelBtnText='取消'
        destructive
        isLoading={bulkDeleteMutation.isPending}
        disabled={selectedPlanIds.length === 0}
        handleConfirm={() => bulkDeleteMutation.mutate(selectedPlanIds)}
      />
      <ConfirmDialog
        open={bulkDeleteExecutionsOpen}
        onOpenChange={(open) =>
          !bulkDeleteExecutionsMutation.isPending &&
          setBulkDeleteExecutionsOpen(open)
        }
        title={`删除 ${selectedExecutionIds.length} 条调用记录？`}
        desc='调用记录只保存 Cron 触发和入队结果，不影响计划、探针任务或样本；仍在执行的记录会自动跳过。'
        confirmText={
          <>
            <Trash2 />
            删除记录
          </>
        }
        cancelBtnText='取消'
        destructive
        isLoading={bulkDeleteExecutionsMutation.isPending}
        disabled={selectedExecutionIds.length === 0}
        handleConfirm={() =>
          bulkDeleteExecutionsMutation.mutate(selectedExecutionIds)
        }
      />
    </Page>
  )
}

function SystemCronPanel({
  form,
  loading,
  error,
  running,
  plansEnabled,
  systemRecoveryEnabled,
  jobs,
  disabled,
  onChange,
}: {
  form: SchedulerSettingsForm | null
  loading: boolean
  error: Error | null
  running: boolean
  plansEnabled: boolean
  systemRecoveryEnabled: boolean
  jobs: SchedulerJob[]
  disabled: boolean
  onChange: (value: SchedulerSettingsForm) => void
}) {
  if (loading) return <LoadingState label='正在加载系统 Cron 设置' />
  if (error) {
    return (
      <EmptyState
        title='系统 Cron 设置加载失败'
        description={getErrorMessage(error)}
      />
    )
  }
  if (!form) return null

  const set = <K extends keyof SchedulerSettingsForm>(
    key: K,
    value: SchedulerSettingsForm[K]
  ) => onChange({ ...form, [key]: value })

  return (
    <div className='space-y-4'>
      <TitledCard
        icon={<Clock3 />}
        iconTone={running ? 'emerald' : 'rose'}
        title='Scheduler 运行状态'
        hint='周期计划与隔离恢复独立启停，共用当前调度器。'
        action={
          <Badge
            variant={running ? 'success' : 'destructive'}
            className='h-5 px-1.5 text-[11px]'
          >
            {running ? '运行中' : '未运行'}
          </Badge>
        }
        contentClassName='space-y-3'
      >
        <div className='grid gap-2 sm:grid-cols-3'>
          <Info
            label='周期计划'
            value={<EnabledBadge enabled={plansEnabled} />}
          />
          <Info label='默认时区' value={form.schedulerTimezone || '—'} />
          <Info
            label='隔离恢复'
            value={<EnabledBadge enabled={systemRecoveryEnabled} />}
          />
        </div>
        <div className='overflow-hidden rounded-lg border'>
          {jobs.length ? (
            jobs.map((job) => (
              <div
                key={job.id}
                className='flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2.5 text-sm last:border-b-0'
              >
                <div className='min-w-48 flex-1'>
                  <div className='font-medium'>{job.name}</div>
                  <div className='mt-0.5 font-mono text-[11px] text-muted-foreground'>
                    {job.id}
                  </div>
                </div>
                <div className='text-xs text-muted-foreground'>
                  下次执行 {formatDate(job.nextRunAt)}
                </div>
              </div>
            ))
          ) : (
            <div className='px-3 py-3 text-sm text-muted-foreground'>
              {systemRecoveryEnabled
                ? '隔离恢复检查尚未注册，请刷新状态或检查调度器运行情况。'
                : '隔离恢复检查已暂停，当前没有系统 Cron Job。'}
            </div>
          )}
        </div>
      </TitledCard>

      <TitledCard
        icon={<CalendarClock />}
        iconTone='sky'
        title='系统 Cron 设置'
        hint='隔离恢复仅处理到期的临时隔离账号，不会启用人工停用的账号。'
        contentClassName='space-y-4'
      >
        <div className='grid overflow-hidden rounded-lg border lg:grid-cols-2 lg:divide-x'>
          <div className='flex items-center justify-between gap-4 px-3 py-2.5'>
            <div className='flex min-w-0 items-center gap-1.5'>
              <div className='text-sm font-medium'>周期计划</div>
              <InfoTooltip
                label='周期计划'
                content='全局控制用户 Cron 计划。关闭后单个计划保留启用状态，但不会定时触发；手动运行不受影响。'
              />
            </div>
            <div className='flex items-center gap-2'>
              <EnabledBadge enabled={form.schedulerEnabled} />
              <Switch
                checked={form.schedulerEnabled}
                disabled={disabled}
                onCheckedChange={(value) => set('schedulerEnabled', value)}
                aria-label='启用周期探针计划'
              />
            </div>
          </div>
          <div className='flex items-center justify-between gap-4 border-t px-3 py-2.5 lg:border-t-0'>
            <div className='flex min-w-0 items-center gap-1.5'>
              <div className='text-sm font-medium'>隔离恢复</div>
              <InfoTooltip
                label='隔离恢复'
                content='自动启用隔离期已结束的账号，是临时隔离的恢复保护。关闭后，到期账号不会自动启用。'
              />
            </div>
            <div className='flex items-center gap-2'>
              <EnabledBadge enabled={form.quarantineRecoveryEnabled} />
              <Switch
                checked={form.quarantineRecoveryEnabled}
                disabled={disabled}
                onCheckedChange={(value) =>
                  set('quarantineRecoveryEnabled', value)
                }
                aria-label='启用隔离恢复检查'
              />
            </div>
          </div>
        </div>
        <div className='grid gap-4 sm:grid-cols-2'>
          <Field label='默认时区'>
            <Input
              value={form.schedulerTimezone}
              disabled={disabled}
              onChange={(event) =>
                set('schedulerTimezone', event.target.value)
              }
              placeholder='UTC'
            />
          </Field>
          <Field label='Misfire 宽限（秒）'>
            <NumericInput
              min={1}
              max={86400}
              value={form.schedulerMisfireGraceSeconds}
              disabled={disabled}
              onChange={(next) => set('schedulerMisfireGraceSeconds', next)}
            />
          </Field>
          <Field
            label='隔离恢复 Cron'
            hint='标准五段 Cron，例如 */5 * * * *'
            className='sm:col-span-2'
            action={
              <CronExpressionHelp
                onSelect={(value) => set('recoveryCron', value)}
              />
            }
          >
            <Input
              value={form.recoveryCron}
              disabled={disabled}
              onChange={(event) => set('recoveryCron', event.target.value)}
              className='font-mono'
            />
          </Field>
          <Field
            label='首次探针冷却（分钟）'
            hint='新账号首次探针完成后，周期计划在此时间内不会重复入队；0 表示关闭冷却。'
            className='sm:col-span-2'
          >
            <NumericInput
              min={0}
              max={10080}
              value={form.scheduledProbeRegisterCooldownMinutes}
              disabled={disabled}
              onChange={(next) =>
                set('scheduledProbeRegisterCooldownMinutes', next)
              }
            />
          </Field>
        </div>
      </TitledCard>
    </div>
  )
}

function ExecutionHistory({
  executions,
  planById,
  selectedIds,
  busy,
  loading,
  error,
  onSelectedChange,
  onViewPlan,
  onDelete,
}: {
  executions: ScheduleExecution[]
  planById: Map<string, ProbePlan>
  selectedIds: string[]
  busy: boolean
  loading: boolean
  error: Error | null
  onSelectedChange: (id: string, checked: boolean) => void
  onViewPlan: (plan: ProbePlan) => void
  onDelete: (id: string) => void
}) {
  if (loading) return <LoadingState label='正在加载 Cron 调用记录' />
  if (error) {
    return (
      <EmptyState
        title='调用记录加载失败'
        description={getErrorMessage(error)}
      />
    )
  }
  if (!executions.length) {
    return (
      <EmptyState
        title='暂无调用记录'
        description='Cron 计划或系统任务首次触发后，会在这里显示入队、跳过、恢复或错误结果。'
      />
    )
  }

  return (
    <TablePanel
      toolbar={
        <div className='flex items-start gap-3'>
          <IconBadge tone='violet'>
            <History />
          </IconBadge>
          <div className='min-w-0'>
            <div className='text-sm font-semibold'>最近 100 次调用</div>
            <p className='mt-0.5 text-xs leading-5 text-muted-foreground'>
              计划调用可直接打开对应计划详情；计划被删除后仍保留原始调度键和历史结果。
            </p>
          </div>
        </div>
      }
    >
      <Table rememberRowKey='cron-executions'>
        <TableHeader>
          <TableRow>
            <TableHead className='w-10' />
            <TableHead>状态</TableHead>
            <TableHead>调用</TableHead>
            <TableHead>结果</TableHead>
            <TableHead>时间</TableHead>
            <TableHead className='text-right'>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {executions.map((item) => {
            const plan = getExecutionPlan(item, planById)
            const title = plan?.name || scheduleName(item.schedule_key)
            return (
              <TableRow
                key={item.id}
                rowId={item.id}
                className={cn(
                  selectedIds.includes(item.id) && 'bg-primary/[0.035]'
                )}
              >
                <TableCell>
                  <Checkbox
                    checked={selectedIds.includes(item.id)}
                    disabled={busy}
                    onCheckedChange={(value) =>
                      onSelectedChange(item.id, value === true)
                    }
                    aria-label={`选择调用记录 ${item.schedule_key}`}
                  />
                </TableCell>
                <TableCell>
                  <Badge
                    variant={executionVariant(item.status)}
                    className='h-5 px-1.5 text-[11px]'
                  >
                    {executionLabel(item.status)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className='font-medium'>{title}</div>
                  <div className='mt-0.5 font-mono text-[11px] text-muted-foreground'>
                    {item.schedule_key}
                  </div>
                </TableCell>
                <TableCell className='max-w-md whitespace-normal text-muted-foreground'>
                  <div className='truncate' title={item.message}>
                    {item.message || '—'}
                  </div>
                  <div className='mt-0.5 text-[11px]'>
                    {executionDetailSummary(item.detail)}
                  </div>
                </TableCell>
                <TableCell className='text-xs text-muted-foreground'>
                  <div>{formatDate(item.started_at)}</div>
                  <div className='mt-0.5'>
                    完成 {formatDate(item.completed_at)}
                  </div>
                </TableCell>
                <TableCell className='text-right'>
                  <ActionToolbar label={`${title} 调用记录操作`}>
                    {plan && (
                      <ToolbarAction
                        label='查看关联计划详情'
                        disabled={busy}
                        onClick={() => onViewPlan(plan)}
                      >
                        <Eye />
                      </ToolbarAction>
                    )}
                    <ToolbarAction
                      label='删除调用记录'
                      destructive
                      disabled={busy || item.status === 'running'}
                      onClick={() => onDelete(item.id)}
                    >
                      <Trash2 />
                    </ToolbarAction>
                  </ActionToolbar>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TablePanel>
  )
}

function PlanDetailDialog({
  open,
  plan,
  profiles,
  onOpenChange,
}: {
  open: boolean
  plan: ProbePlan
  profiles: ProbeProfile[]
  onOpenChange: (open: boolean) => void
}) {
  const profileIds = getPlanProfileIds(plan)
  const accountPreview = plan.account_ids.slice(0, 500)
  const remainingAccounts = plan.account_ids.length - accountPreview.length
  const profileNames = profileIds.map(
    (id) => profiles.find((profile) => profile.id === id)?.name || id
  )
  const copy = (value: string, label: string) => {
    void copyText(value)
      .then(() => toast.success(`${label}已复制`))
      .catch((error) => toast.error(getErrorMessage(error)))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[88vh] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{plan.name}</DialogTitle>
          <DialogDescription>
            {plan.description || '未填写计划说明'}
          </DialogDescription>
        </DialogHeader>

        <div className='flex flex-wrap gap-1.5'>
          <EnabledBadge enabled={plan.enabled} />
          <Badge variant='outline' className='h-5 px-1.5 text-[11px]'>
            {plan.overlap_policy === 'skip' ? '跳过重叠' : '补足空位'}
          </Badge>
          <Badge
            variant={
              plan.execution_mode === 'quality_test' ? 'info' : 'outline'
            }
            className='h-5 px-1.5 text-[11px]'
          >
            {plan.execution_mode === 'quality_test' ? '快速质量' : '完整对话'}
          </Badge>
        </div>

        <section className='space-y-3'>
          <h3 className='text-sm font-semibold'>调度与任务</h3>
          <div className='grid gap-x-6 gap-y-3 sm:grid-cols-2'>
            <PlanDetailRow
              label='Cron 表达式'
              value={plan.cron_expression}
              mono
            />
            <PlanDetailRow label='时区' value={plan.timezone} />
            <PlanDetailRow
              label='下次执行'
              value={formatDate(plan.job?.nextRunAt)}
            />
            <PlanDetailRow label='每账号轮数' value={`${plan.rounds} 轮`} />
            <PlanDetailRow label='任务优先级' value={String(plan.priority)} />
            <PlanDetailRow label='账号范围' value={accountScopeLabel(plan)} />
            <PlanDetailRow
              label='单次任务数'
              value={
                plan.account_scope === 'fixed'
                  ? `${plan.account_ids.length * profileIds.length} 个`
                  : '运行时按命中账号计算'
              }
            />
          </div>
        </section>

        <section className='space-y-3 border-t pt-4'>
          <h3 className='text-sm font-semibold'>探针方案与出口</h3>
          <PlanDetailRow
            label={`探针方案（${profileIds.length}）`}
            value={profileNames.join('、') || '—'}
          />
          <PlanDetailRow
            label={`出口目标（${plan.proxy_targets.length}）`}
            value={plan.proxy_targets.map(proxyTargetLabel).join('、') || '—'}
          />
        </section>

        <section className='space-y-3 border-t pt-4'>
          <div className='flex items-center justify-between gap-3'>
            <h3 className='text-sm font-semibold'>账号范围</h3>
            {plan.account_scope === 'fixed' && (
              <ToolbarAction
                label='复制全部账号 ID'
                disabled={!plan.account_ids.length}
                onClick={() => copy(plan.account_ids.join('\n'), '账号 ID')}
              >
                <Copy />
              </ToolbarAction>
            )}
          </div>
          {plan.account_scope === 'fixed' ? (
            <div className='max-h-40 overflow-y-auto rounded-lg border bg-muted/20 p-3 font-mono text-xs leading-5 break-all'>
              {accountPreview.join(', ') || '—'}
              {remainingAccounts > 0 && (
                <div className='mt-2 font-sans text-muted-foreground'>
                  还有 {remainingAccounts}{' '}
                  个账号未在预览中展开，可使用复制按钮取得全部 ID。
                </div>
              )}
            </div>
          ) : (
            <div className='rounded-lg border bg-muted/20 p-3 text-sm'>
              {accountScopeDescription(plan)}
            </div>
          )}
        </section>

        <section className='grid gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-2'>
          <PlanDetailRow label='计划 ID' value={plan.id} mono />
          <PlanDetailRow label='创建时间' value={formatDate(plan.created_at)} />
          <PlanDetailRow label='更新时间' value={formatDate(plan.updated_at)} />
        </section>
      </DialogContent>
    </Dialog>
  )
}

function PlanCard({
  plan,
  profiles,
  selected,
  pending,
  onSelectedChange,
  onView,
  onEdit,
  onEnabledChange,
  onRun,
  onDelete,
}: {
  plan: ProbePlan
  profiles: ProbeProfile[]
  selected: boolean
  pending: boolean
  onSelectedChange: (checked: boolean) => void
  onView: () => void
  onEdit: () => void
  onEnabledChange: (enabled: boolean) => void
  onRun: () => void
  onDelete: () => void
}) {
  const selectedProfileIds = getPlanProfileIds(plan)
  const selectedProfiles = selectedProfileIds.map(
    (id) => profiles.find((profile) => profile.id === id)?.name || id
  )
  return (
    <Card
      className={cn(
        'gap-3 py-3 transition-colors',
        selected && 'border-primary/40 bg-primary/[0.025]'
      )}
    >
      <CardHeader className='px-4'>
        <div className='flex items-start gap-3'>
          <Checkbox
            checked={selected}
            disabled={pending}
            onCheckedChange={(value) => onSelectedChange(value === true)}
            aria-label={`选择计划 ${plan.name}`}
            className='mt-2'
          />
          <IconBadge tone={plan.enabled ? 'sky' : 'muted'}>
            <CalendarClock />
          </IconBadge>
          <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-center gap-1.5'>
              <CardTitle className='text-sm'>{plan.name}</CardTitle>
              <EnabledBadge enabled={plan.enabled} />
              <Badge variant='outline' className='h-5 px-1.5 text-[11px]'>
                {plan.overlap_policy === 'skip' ? '跳过重叠' : '补足空位'}
              </Badge>
              <Badge
                variant={
                  plan.execution_mode === 'quality_test' ? 'info' : 'outline'
                }
                className='h-5 px-1.5 text-[11px]'
              >
                {plan.execution_mode === 'quality_test'
                  ? '快速质量'
                  : '完整对话'}
              </Badge>
            </div>
            <CardDescription className='mt-1 line-clamp-1 text-xs'>
              {plan.description || '未填写说明'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-3 px-4'>
        <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
          <Info label='账号范围' value={accountScopeLabel(plan)} />
          <Info label='出口' value={`${plan.proxy_targets.length} 个`} />
          <Info label='轮数' value={`${plan.rounds} 轮`} />
          <Info label='优先级' value={plan.priority} />
        </div>
        <div className='rounded-lg border bg-muted/20 px-3 py-2'>
          <div className='flex items-center gap-2 font-mono text-xs'>
            <Clock3 className='size-3.5 text-primary' />
            {plan.cron_expression}
          </div>
          <div className='mt-1 text-[11px] text-muted-foreground'>
            {plan.timezone} · 下次执行 {formatDate(plan.job?.nextRunAt)}
          </div>
        </div>
        <div className='flex items-start gap-2 text-xs text-muted-foreground'>
          <Layers3 className='mt-0.5 size-3.5 shrink-0' />
          <span className='min-w-0'>
            {selectedProfiles.join('、')} ·{' '}
            {plan.account_scope === 'fixed'
              ? `每次最多创建 ${plan.account_ids.length * selectedProfileIds.length} 个任务`
              : '每次触发实时解析账号范围'}
          </span>
        </div>
        <div className='flex justify-end border-t border-border/60 pt-2'>
          <ActionToolbar label={`${plan.name} 操作`}>
            <div className='flex h-7 shrink-0 items-center px-1'>
              <Switch
                checked={plan.enabled}
                disabled={pending}
                onCheckedChange={onEnabledChange}
                aria-label={`${plan.enabled ? '停用' : '启用'}计划 ${plan.name}`}
              />
            </div>
            <ToolbarAction
              label='查看计划详情'
              disabled={pending}
              onClick={onView}
            >
              <Eye />
            </ToolbarAction>
            <ToolbarAction
              label='删除计划'
              destructive
              disabled={pending}
              onClick={onDelete}
            >
              <Trash2 />
            </ToolbarAction>
            <ToolbarAction label='编辑计划' disabled={pending} onClick={onEdit}>
              <Edit3 />
            </ToolbarAction>
            <ToolbarAction
              label={plan.enabled ? '立即运行计划' : '计划已停用'}
              disabled={pending || !plan.enabled}
              onClick={onRun}
            >
              <Play />
            </ToolbarAction>
          </ActionToolbar>
        </div>
      </CardContent>
    </Card>
  )
}

function PlanDialog({
  open,
  value,
  profiles,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  value: ProbePlan | 'new'
  profiles: ProbeProfile[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const initial = value === 'new' ? null : value
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [profileIds, setProfileIds] = useState<string[]>(() => {
    if (initial) return getPlanProfileIds(initial)
    const fallback =
      profiles.find(
        (profile) => profile.id === 'quality-marker' && profile.enabled
      ) ?? profiles.find((profile) => profile.enabled)
    return fallback ? [fallback.id] : []
  })
  const [accountIds, setAccountIds] = useState<number[]>(
    initial?.account_ids ?? []
  )
  const [accountScope, setAccountScope] = useState<PlanAccountScope>(
    initial?.account_scope ?? 'fixed'
  )
  const [rounds, setRounds] = useState(initial?.rounds ?? 1)
  const [cron, setCron] = useState(initial?.cron_expression ?? '15 */6 * * *')
  const [timezone, setTimezone] = useState(initial?.timezone ?? 'UTC')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [overlap, setOverlap] = useState<'skip' | 'fill'>(
    initial?.overlap_policy ?? 'skip'
  )
  const profileIdSet = new Set(profiles.map((profile) => profile.id))
  const selectedProfileIds = profileIds.filter((id) => profileIdSet.has(id))
  const mutation = useMutation({
    mutationFn: () => {
      const ids = Array.from(new Set(accountIds.filter((id) => id > 0)))
      const body = {
        name,
        description,
        profile_id: selectedProfileIds[0],
        profile_ids: selectedProfileIds,
        account_scope: accountScope,
        account_ids: accountScope === 'fixed' ? ids : [],
        proxy_targets: [{ kind: 'current', id: null }],
        execution_mode: 'chat',
        rounds,
        cron_expression: cron,
        timezone,
        enabled,
        overlap_policy: overlap,
        priority: 200,
      }
      if (
        !name.trim() ||
        !selectedProfileIds.length ||
        (accountScope === 'fixed' && !ids.length)
      ) {
        throw new Error('名称、探针方案和账号范围均为必填')
      }
      return initial ? api.updatePlan(initial.id, body) : api.createPlan(body)
    },
    onSuccess: () => {
      toast.success(initial ? '计划已更新' : '计划已创建')
      onSaved()
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size='wide'>
        <DialogHeader>
          <DialogTitle>
            {initial ? '编辑 Cron 计划' : '新建 Cron 计划'}
          </DialogTitle>
          <DialogDescription>
            短周期触发时，计划重叠策略和全局队列容量会阻止任务无限累积。
            <span className='mt-1 block'>
              带 <span className='font-medium text-destructive'>*</span>{' '}
              的字段为必填项。
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className='grid max-h-[65dvh] min-h-0 gap-4 overflow-auto py-2 sm:grid-cols-2'>
          <Field label='计划名称' required>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label='探针方案' required>
            <ProfileMultiSelect
              profiles={profiles}
              value={selectedProfileIds}
              onChange={setProfileIds}
              invalid={!selectedProfileIds.length}
            />
          </Field>
          <Field
            label='Cron 表达式'
            required
            action={<CronExpressionHelp onSelect={setCron} />}
          >
            <Input
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              className='font-mono'
              placeholder='例如：0 */6 * * *'
            />
          </Field>
          <Field label='时区' required>
            <Input
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder='UTC'
            />
          </Field>
          <Field label='账号范围' required className='sm:col-span-2'>
            <Select
              value={accountScope}
              onValueChange={(scope: PlanAccountScope) =>
                setAccountScope(scope)
              }
            >
              <SelectTrigger aria-label='选择计划账号范围'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='fixed'>固定账号</SelectItem>
                <SelectItem value='all_enabled'>全部启用账号</SelectItem>
                <SelectItem value='risky_enabled'>风险账号</SelectItem>
              </SelectContent>
            </Select>
            <p className='text-xs leading-5 text-muted-foreground'>
              {accountScope === 'fixed'
                ? '仅巡检保存时选定的账号。'
                : accountScope === 'all_enabled'
                  ? '每次触发实时读取 grok2api 中全部启用账号，新账号会自动加入。'
                  : '每次触发实时读取本地状态为观察、可疑或高风险且上游仍启用的账号。'}
            </p>
          </Field>
          {accountScope === 'fixed' && (
            <Field label='固定账号' required className='sm:col-span-2'>
              <AccountMultiSelect
                value={accountIds}
                onChange={setAccountIds}
                invalid={!accountIds.length}
              />
              <p className='text-xs leading-5 text-muted-foreground'>
                列表按页实时读取
                grok2api；仅已启用且绑定固定出口的账号会执行周期巡检。
              </p>
            </Field>
          )}
          <Field label='说明' className='sm:col-span-2'>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label='轮数' required>
            <NumericInput
              min={1}
              max={20}
              value={rounds}
              onChange={setRounds}
            />
          </Field>
          <Field label='重叠策略'>
            <Select
              value={overlap}
              onValueChange={(value: 'skip' | 'fill') => setOverlap(value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='skip'>前批未结束则跳过</SelectItem>
                <SelectItem value='fill'>仅补充无活动任务账号</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label='执行策略' className='sm:col-span-2'>
            <div className='flex items-start gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3'>
              <UsersRound className='mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
              <p className='text-xs leading-5 text-muted-foreground'>
                周期计划固定使用完整对话和账号当前出口，不修改账号绑定。多出口与快速质量诊断请在手动探针中触发。
              </p>
            </div>
          </Field>
          <label className='flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm sm:col-span-2'>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <span className='min-w-0'>
              <EnabledBadge enabled={enabled} />
              <span className='mt-1 block text-xs text-muted-foreground'>
                保存后立即注册或移除 APScheduler Job
              </span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={
              mutation.isPending ||
              !selectedProfileIds.length ||
              (accountScope === 'fixed' && !accountIds.length)
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? '保存中…' : '保存计划'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  required = false,
  action,
  hint,
  children,
  className = '',
}: {
  label: string
  required?: boolean
  action?: React.ReactNode
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`grid gap-2 ${className}`}>
      <div className='flex items-center gap-2'>
        <label className='text-sm font-medium'>
          {label}
          {required && (
            <span className='ms-1 text-destructive' aria-hidden='true'>
              *
            </span>
          )}
        </label>
        {action}
      </div>
      {hint && (
        <p className='text-xs leading-5 text-muted-foreground'>{hint}</p>
      )}
      {children}
    </div>
  )
}

function CronExpressionHelp({
  onSelect,
}: {
  onSelect: (expression: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type='button'
          size='icon'
          variant='ghost'
          className='size-6 rounded-full text-muted-foreground'
          aria-label='查看 Cron 表达式填写说明'
        >
          <CircleHelp className='size-3.5' />
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[min(30rem,calc(100vw-2rem))]'>
        <div className='space-y-3'>
          <div>
            <div className='text-sm font-semibold'>Cron 五段格式</div>
            <code className='mt-1 block rounded-md bg-muted px-3 py-2 text-xs'>
              分钟 小时 日期 月份 星期
            </code>
          </div>
          <div className='grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-xs'>
            <span className='font-medium'>分钟</span>
            <span className='text-muted-foreground'>0–59</span>
            <span className='font-medium'>小时</span>
            <span className='text-muted-foreground'>0–23</span>
            <span className='font-medium'>日期</span>
            <span className='text-muted-foreground'>1–31</span>
            <span className='font-medium'>月份</span>
            <span className='text-muted-foreground'>1–12</span>
            <span className='font-medium'>星期</span>
            <span className='text-muted-foreground'>0–7，周日为 0 或 7</span>
          </div>
          <div className='space-y-2 border-t pt-3 text-xs'>
            <CronExample
              expression='*/15 * * * *'
              description='每 15 分钟'
              onSelect={onSelect}
            />
            <CronExample
              expression='0 */6 * * *'
              description='每 6 小时整点'
              onSelect={onSelect}
            />
            <CronExample
              expression='0 9 * * 1-5'
              description='工作日 09:00'
              onSelect={onSelect}
            />
            <CronExample
              expression='30 2 * * *'
              description='每天 02:30'
              onSelect={onSelect}
            />
          </div>
          <p className='text-xs leading-5 text-muted-foreground'>
            <code>*</code> 表示任意值，<code>*/n</code> 表示每隔 n 个单位，
            <code>1-5</code> 表示范围，<code>1,3,5</code> 表示多个值。
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function CronExample({
  expression,
  description,
  onSelect,
}: {
  expression: string
  description: string
  onSelect: (expression: string) => void
}) {
  return (
    <button
      type='button'
      className='grid w-full grid-cols-[8rem_1fr] items-center gap-3 rounded-md p-1 text-left hover:bg-accent'
      onClick={() => onSelect(expression)}
    >
      <code className='rounded bg-muted px-2 py-1'>{expression}</code>
      <span className='text-muted-foreground'>{description}</span>
    </button>
  )
}

function getPlanProfileIds(plan: ProbePlan): string[] {
  const values = plan.profile_ids?.length ? plan.profile_ids : [plan.profile_id]
  return Array.from(new Set(values.map((id) => id.trim()).filter(Boolean)))
}

function accountScopeLabel(plan: ProbePlan) {
  if (plan.account_scope === 'all_enabled') return '全部启用账号'
  if (plan.account_scope === 'risky_enabled') return '风险账号'
  return `固定 ${plan.account_ids.length} 个`
}

function accountScopeDescription(plan: ProbePlan) {
  if (plan.account_scope === 'all_enabled') {
    return '每次触发实时读取 grok2api 中全部启用账号，新导入账号会自动进入后续巡检。'
  }
  if (plan.account_scope === 'risky_enabled') {
    return '每次触发实时选择本地状态为观察、可疑或高风险且 grok2api 仍启用的账号。'
  }
  return `固定选择 ${plan.account_ids.length} 个账号。`
}

function toSchedulerSettingsForm(
  settings: RuntimeSettings
): SchedulerSettingsForm {
  return {
    schedulerEnabled: settings.schedulerEnabled,
    quarantineRecoveryEnabled: settings.quarantineRecoveryEnabled,
    schedulerTimezone: settings.schedulerTimezone,
    schedulerMisfireGraceSeconds: settings.schedulerMisfireGraceSeconds,
    recoveryCron: settings.recoveryCron,
    scheduledProbeRegisterCooldownMinutes:
      settings.scheduledProbeRegisterCooldownMinutes,
  }
}

function getExecutionPlan(
  execution: ScheduleExecution,
  planById: Map<string, ProbePlan>
) {
  if (!execution.schedule_key.startsWith('plan:')) return undefined
  return planById.get(execution.schedule_key.slice('plan:'.length))
}

function scheduleName(scheduleKey: string) {
  if (scheduleKey === 'system:quarantine-recovery') return '隔离恢复检查'
  if (scheduleKey.startsWith('plan:')) return '已删除的计划'
  return scheduleKey
}

function executionDetailSummary(detail: Record<string, unknown>) {
  const labels: Record<string, string> = {
    created: '创建任务',
    skipped: '跳过任务',
    resolvedAccountCount: '命中账号',
    restored: '恢复账号',
    guarded: '保护账号',
  }
  const values = Object.entries(labels).flatMap(([key, label]) => {
    const value = detail[key]
    return typeof value === 'number' ? [`${label} ${value}`] : []
  })
  const failed = detail.failed
  if (Array.isArray(failed) && failed.length)
    values.push(`失败 ${failed.length}`)
  return values.join(' · ') || '无附加明细'
}

function executionVariant(status: string) {
  if (status === 'succeeded') return 'success' as const
  if (status === 'skipped') return 'warning' as const
  if (status === 'running') return 'info' as const
  return 'destructive' as const
}

function executionLabel(status: string) {
  if (status === 'succeeded') return '成功'
  if (status === 'skipped') return '已跳过'
  if (status === 'running') return '执行中'
  if (status === 'failed') return '失败'
  return status || '错误'
}

function proxyTargetLabel(target: ProbePlan['proxy_targets'][number]) {
  if (target.kind === 'current') return '账号当前出口'
  if (target.kind === 'direct') return '上游调度（诊断）'
  return target.name || `出口 #${target.id}`
}

function PlanDetailRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className='min-w-0'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div
        className={cn(
          'mt-1 text-sm leading-5 break-words',
          mono && 'font-mono text-xs'
        )}
      >
        {value}
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='rounded-lg bg-muted/40 px-3 py-2'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div className='mt-0.5 truncate text-sm font-semibold'>{value}</div>
    </div>
  )
}
