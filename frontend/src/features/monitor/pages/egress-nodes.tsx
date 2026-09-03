import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  CircleHelp,
  FlaskConical,
  Loader2,
  Network,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, type EgressNode } from '@/lib/api'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
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
import { NumericInput } from '@/components/numeric-input'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EnabledBadge } from '@/components/enabled-badge'
import { InfoTooltip } from '@/components/info-tooltip'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { SelectionToolbar } from '@/components/selection-toolbar'
import { ServerPagination } from '@/components/server-pagination'
import { TablePanel } from '@/components/table-panel'
import { TitledCard } from '@/components/titled-card'

type NodeAction = {
  kind: 'enable' | 'disable' | 'delete'
  nodes: EgressNode[]
}

const emptyNodeForm = {
  name: '',
  proxyUrl: '',
  proxyPool: true,
  accountCapacity: 0,
  enabled: true,
}

export function EgressNodesPage() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [search, setSearch] = useState('')
  const [deferredSearch] = useDebouncedValue(search.trim())
  const [enabled, setEnabled] = useState('all')
  const [probe, setProbe] = useState('all')
  const [selected, setSelected] = useState<number[]>([])
  const [action, setAction] = useState<NodeAction | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingNode, setEditingNode] = useState<EgressNode | null>(null)
  const [nodeForm, setNodeForm] = useState(emptyNodeForm)
  const [distributionOpen, setDistributionOpen] = useState(false)
  const [accountsPerNode, setAccountsPerNode] = useState<number | null>(null)

  const query = useQuery({
    queryKey: ['egress-nodes', page, pageSize, deferredSearch, enabled, probe],
    queryFn: () =>
      api.egress({
        page,
        pageSize,
        search: deferredSearch,
        enabled:
          enabled === 'all' ? '' : enabled === 'true' ? 'enabled' : 'disabled',
        probe: probe === 'all' ? '' : probe,
      }),
    placeholderData: (previous) => previous,
  })
  const nodes = query.data?.items ?? []
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const selectedNodes = nodes.filter((node) => selectedSet.has(Number(node.id)))
  const allChecked =
    nodes.length > 0 && nodes.every((node) => selectedSet.has(Number(node.id)))
  const accountTotalQuery = useQuery({
    queryKey: ['accounts', 'egress-distribution-total'],
    queryFn: () => api.accounts({ page: 1, pageSize: 1 }),
    enabled: distributionOpen,
  })
  const totalAccounts = accountTotalQuery.data?.total ?? 0
  const recommendedAccountsPerNode = selectedNodes.length
    ? Math.ceil(totalAccounts / selectedNodes.length)
    : 0
  const effectiveAccountsPerNode =
    accountsPerNode ?? recommendedAccountsPerNode
  const unavailableSelectedNodes = selectedNodes.filter(
    (node) => !node.enabled || !node.proxyConfigured
  )

  const createMutation = useMutation({
    mutationFn: () =>
      api.createEgressNode({
        name: nodeForm.name.trim(),
        proxy_url: nodeForm.proxyUrl.trim(),
        proxy_pool: nodeForm.proxyPool,
        account_capacity: nodeForm.accountCapacity,
        enabled: nodeForm.enabled,
      }),
    onSuccess: (node) => {
      setEditorOpen(false)
      setEditingNode(null)
      setNodeForm(emptyNodeForm)
      toast.success(`已新增上游节点 ${node.name}`)
      void queryClient.invalidateQueries({ queryKey: ['egress-nodes'] })
      void queryClient.invalidateQueries({ queryKey: ['egress'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const editMutation = useMutation({
    mutationFn: () => {
      if (!editingNode) throw new Error('请选择要编辑的上游节点')
      return api.updateEgressNode(Number(editingNode.id), {
        name: nodeForm.name.trim(),
        proxy_url: nodeForm.proxyUrl.trim() || undefined,
        proxy_pool: nodeForm.proxyPool,
        account_capacity: nodeForm.accountCapacity,
      })
    },
    onSuccess: (node) => {
      setEditorOpen(false)
      setEditingNode(null)
      setNodeForm(emptyNodeForm)
      toast.success(`已更新上游节点 ${node.name}`)
      void queryClient.invalidateQueries({ queryKey: ['egress-nodes'] })
      void queryClient.invalidateQueries({ queryKey: ['egress'] })
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['request-audits'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const updateMutation = useMutation({
    mutationFn: ({ nodeIds, value }: { nodeIds: number[]; value: boolean }) =>
      api.updateEgressNodes(nodeIds, value),
    onSuccess: (result, variables) => {
      const skipped = result.skippedNodeIds ?? []
      setAction(null)
      setSelected(skipped)
      const verb = variables.value ? '启用' : '停用'
      if (skipped.length) {
        toast.warning(
          `已${verb} ${result.updated} 个节点；${skipped.length} 个被探针引用的节点已跳过并保留选择`
        )
      } else {
        toast.success(`已${verb} ${result.updated} 个上游节点`)
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['egress-nodes'] })
      void queryClient.invalidateQueries({ queryKey: ['egress'] })
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (nodeIds: number[]) => api.deleteEgressNodes(nodeIds),
    onSuccess: (result) => {
      const skipped = result.skippedNodeIds ?? []
      setAction(null)
      setSelected(skipped)
      if (page > 1 && result.deleted >= nodes.length) setPage(page - 1)
      if (skipped.length) {
        toast.warning(
          `已删除 ${result.deleted} 个节点；${skipped.length} 个被探针引用的节点已跳过并保留选择`
        )
      } else {
        toast.success(`已删除 ${result.deleted} 个上游节点`)
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['egress-nodes'] })
      void queryClient.invalidateQueries({ queryKey: ['egress'] })
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  const testMutation = useMutation({
    mutationFn: (node: EgressNode) =>
      api.testEgressNode(Number(node.id)).then((result) => ({ node, result })),
    onSuccess: ({ node, result }) => {
      if (result.status === 'healthy') {
        toast.success(
          `${node.name} 探测正常${result.latencyMs ? `，${result.latencyMs} ms` : ''}${result.exitIp ? `，出口 ${result.exitIp}` : ''}`
        )
      } else {
        toast.warning(
          `${node.name} 探测异常：${result.error || '未返回错误明细'}`
        )
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['egress-nodes'] })
      void queryClient.invalidateQueries({ queryKey: ['egress'] })
    },
  })

  const distributionMutation = useMutation({
    mutationFn: () =>
      api.distributeAccountsToEgress(
        selectedNodes.map((node) => Number(node.id)),
        effectiveAccountsPerNode
      ),
    onSuccess: (result) => {
      setDistributionOpen(false)
      setAccountsPerNode(null)
      setSelected([])
      const skipped = result.skippedAccountIds?.length ?? 0
      const failed = result.failedAccountIds?.length ?? 0
      if (skipped || failed) {
        toast.warning(
          `已绑定 ${result.updated}/${result.requested} 个账号；${skipped} 个探针锁定账号跳过，${failed} 个账号失败`
        )
      } else {
        toast.success(
          `已将 ${result.updated} 个账号平均绑定到 ${result.nodeIds.length} 个出口`
        )
      }
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['egress-nodes'] })
      void queryClient.invalidateQueries({ queryKey: ['egress'] })
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['request-audits'] })
    },
  })

  const actionPending =
    createMutation.isPending ||
    editMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    distributionMutation.isPending
  const assignedAccounts = action?.nodes.reduce(
    (total, node) => total + (node.assignedAccountCount ?? 0),
    0
  )
  const showTableLoading = query.isFetching

  return (
    <Page>
      <PageHeader
        title='上游节点'
        description='管理 grok2api 的 Grok Build 出口节点与网络探测状态。'
        descriptionAsHint
        actions={
          <ActionToolbar label='上游节点操作'>
            <ToolbarAction
              label='新增 Grok Build 节点'
              disabled={actionPending}
              onClick={() => {
                setEditingNode(null)
                setNodeForm(emptyNodeForm)
                setEditorOpen(true)
              }}
            >
              <Plus />
            </ToolbarAction>
            <ToolbarAction
              label='刷新上游节点'
              pending={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw />
            </ToolbarAction>
            <SelectionToolbar
              wrap={false}
              selectedCount={selected.length}
              entityLabel='节点'
              disabled={actionPending}
              onClear={() => setSelected([])}
            >
              <ToolbarAction
                label={`平均绑定全部账号到 ${selected.length} 个已选出口`}
                disabled={actionPending || selected.length < 2}
                onClick={() => {
                  setAccountsPerNode(null)
                  setDistributionOpen(true)
                }}
              >
                <Users />
              </ToolbarAction>
              <ToolbarAction
                label={`启用 ${selected.length} 个已选节点`}
                disabled={actionPending}
                onClick={() =>
                  setAction({ kind: 'enable', nodes: selectedNodes })
                }
              >
                <Power />
              </ToolbarAction>
              <ToolbarAction
                label={`停用 ${selected.length} 个已选节点`}
                disabled={actionPending}
                onClick={() =>
                  setAction({ kind: 'disable', nodes: selectedNodes })
                }
              >
                <PowerOff />
              </ToolbarAction>
              <ToolbarAction
                label={`删除 ${selected.length} 个已选节点`}
                destructive
                disabled={actionPending}
                onClick={() =>
                  setAction({ kind: 'delete', nodes: selectedNodes })
                }
              >
                <Trash2 />
              </ToolbarAction>
            </SelectionToolbar>
          </ActionToolbar>
        }
      />

      <TablePanel
        toolbar={
          <div className='space-y-2' aria-busy={showTableLoading}>
            <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
              <div className='relative min-w-0 flex-1'>
                <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    setPage(1)
                    setSelected([])
                  }}
                  placeholder='搜索节点名称或出口 IP'
                  className='h-8 pr-8 pl-8'
                />
                {showTableLoading && (
                  <Loader2 className='absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-primary' />
                )}
              </div>
              <Select
                value={enabled}
                onValueChange={(value) => {
                  setEnabled(value)
                  setPage(1)
                  setSelected([])
                }}
              >
                <SelectTrigger className='h-8 w-full sm:w-40'>
                  <Power className='size-4 text-muted-foreground' />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部启停状态</SelectItem>
                  <SelectItem value='true'>已启用</SelectItem>
                  <SelectItem value='false'>已停用</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={probe}
                onValueChange={(value) => {
                  setProbe(value)
                  setPage(1)
                  setSelected([])
                }}
              >
                <SelectTrigger className='h-8 w-full sm:w-40'>
                  <Activity className='size-4 text-muted-foreground' />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部探测状态</SelectItem>
                  <SelectItem value='healthy'>健康</SelectItem>
                  <SelectItem value='unhealthy'>异常</SelectItem>
                  <SelectItem value='unknown'>未探测</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        }
        footer={
          nodes.length ? (
            <ServerPagination
              page={page}
              pageSize={pageSize}
              total={query.data?.total ?? 0}
              disabled={query.isFetching}
              loading={query.isFetching}
              itemLabel='节点'
              onPageChange={(value) => {
                setPage(value)
                setSelected([])
              }}
              onPageSizeChange={(value) => {
                setPageSize(value)
                setPage(1)
                setSelected([])
              }}
            />
          ) : null
        }
      >
        {query.isLoading && !query.data ? (
          <LoadingState />
        ) : query.isError ? (
          <EmptyState
            title='节点读取失败'
            description={getErrorMessage(query.error)}
          />
        ) : nodes.length ? (
          <Table rememberRowKey='monitor-egress-nodes'>
            <TableHeader>
              <TableRow>
                <TableHead className='w-10'>
                  <Checkbox
                    checked={allChecked}
                    onCheckedChange={(value) =>
                      setSelected(
                        value === true
                          ? nodes.map((node) => Number(node.id))
                          : []
                      )
                    }
                    aria-label='选择当前页节点'
                  />
                </TableHead>
                <TableHead>节点</TableHead>
                <TableHead>启停</TableHead>
                <TableHead className='text-center'>健康</TableHead>
                <TableHead className='text-center'>探测</TableHead>
                <TableHead>出口 IP</TableHead>
                <TableHead>账号负载</TableHead>
                <TableHead className='text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.map((node) => {
                const id = Number(node.id)
                const testing =
                  testMutation.isPending &&
                  testMutation.variables?.id === node.id
                return (
                  <TableRow key={node.id} rowId={node.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedSet.has(id)}
                        onCheckedChange={(value) =>
                          setSelected((current) =>
                            value === true
                              ? Array.from(new Set([...current, id]))
                              : current.filter((item) => item !== id)
                          )
                        }
                        aria-label={`选择节点 ${node.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className='flex min-w-0 items-center gap-2'>
                        <span className='inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground'>
                          <Network className='size-4' />
                        </span>
                        <div className='min-w-0'>
                          <div className='truncate font-medium'>{node.name}</div>
                          <div className='mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground'>
                            <span>ID {node.id}</span>
                            {node.proxyPool && (
                              <Badge
                                variant='outline'
                                className='h-5 px-1.5 text-[11px] font-medium'
                              >
                                代理池
                              </Badge>
                            )}
                            {node.accountBoundProxy && (
                              <Badge
                                variant='outline'
                                className='h-5 px-1.5 text-[11px] font-medium'
                              >
                                账号粘性
                              </Badge>
                            )}
                            {node.sourceId && (
                              <Badge
                                variant='outline'
                                className='h-5 px-1.5 text-[11px] font-medium'
                              >
                                订阅
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <EnabledBadge enabled={node.enabled} />
                    </TableCell>
                    <TableCell className='text-center'>
                      <HealthIndicator node={node} />
                    </TableCell>
                    <TableCell className='text-center'>
                      <ProbeIndicator node={node} />
                    </TableCell>
                    <TableCell>
                      <div
                        className='max-w-56 truncate font-mono text-xs text-muted-foreground'
                        title={node.exitIp}
                      >
                        {node.exitIp || '—'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className='text-sm tabular-nums'>
                        {node.assignedAccountCount ?? 0}
                        <span className='text-muted-foreground'>
                          {' '}
                          / {node.accountCapacity || '不限'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className='text-right'>
                      <div className='inline-flex items-center gap-0.5'>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size='icon'
                              variant='ghost'
                              className='size-7'
                              disabled={actionPending}
                              onClick={() => {
                                setEditingNode(node)
                                setNodeForm({
                                  name: node.name,
                                  proxyUrl: '',
                                  proxyPool: node.proxyPool ?? false,
                                  accountCapacity: node.accountCapacity ?? 0,
                                  enabled: node.enabled,
                                })
                                setEditorOpen(true)
                              }}
                              aria-label={`编辑节点 ${node.name}`}
                            >
                              <Pencil />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>编辑节点</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size='icon'
                              variant='ghost'
                              className='size-7'
                              disabled={testing || actionPending}
                              onClick={() => testMutation.mutate(node)}
                              aria-label={`探测节点 ${node.name}`}
                            >
                              {testing ? (
                                <Loader2 className='animate-spin' />
                              ) : (
                                <FlaskConical />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>执行网络探测</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size='icon'
                              variant='ghost'
                              className='size-7'
                              disabled={actionPending}
                              onClick={() =>
                                setAction({
                                  kind: node.enabled ? 'disable' : 'enable',
                                  nodes: [node],
                                })
                              }
                              aria-label={`${node.enabled ? '停用' : '启用'}节点 ${node.name}`}
                            >
                              {node.enabled ? <PowerOff /> : <Power />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {node.enabled ? '停用节点' : '启用节点'}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size='icon'
                              variant='ghost'
                              className='size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                              disabled={actionPending}
                              onClick={() =>
                                setAction({ kind: 'delete', nodes: [node] })
                              }
                              aria-label={`删除节点 ${node.name}`}
                            >
                              <Trash2 />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>删除节点</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            title='未找到节点'
            description='请调整筛选条件或检查 grok2api 连接。'
          />
        )}
      </TablePanel>

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (createMutation.isPending || editMutation.isPending) return
          setEditorOpen(open)
          if (!open) setEditingNode(null)
        }}
      >
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>
              {editingNode ? '编辑 Grok Build 节点' : '新增 Grok Build 节点'}
            </DialogTitle>
            <DialogDescription>
              {editingNode
                ? '代理地址为只写字段，留空会保留当前配置。节点启停请使用列表中的独立操作。'
                : '代理凭据只发送给 grok2api，不在 GrokIQ 数据库保存或回显。'}
              {editingNode?.sourceId &&
                ' 该节点来自订阅，后续同步可能覆盖部分配置。'}
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            <div className='space-y-1.5'>
              <Label htmlFor='egress-node-name'>节点名称</Label>
              <Input
                id='egress-node-name'
                value={nodeForm.name}
                onChange={(event) =>
                  setNodeForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder='例如 Resin Pool A'
                maxLength={160}
              />
            </div>
            <div className='space-y-1.5'>
              <div className='flex min-h-5 items-center gap-1.5'>
                <Label htmlFor='egress-node-proxy'>代理地址</Label>
                <InfoTooltip
                  label='代理地址'
                  content={
                    <>
                      使用 <span className='font-mono'>{'{account}'}</span> 可让
                      grok2api 按账号生成稳定的 Resin 粘性身份。
                    </>
                  }
                />
              </div>
              <Input
                id='egress-node-proxy'
                type='password'
                autoComplete='new-password'
                value={nodeForm.proxyUrl}
                onChange={(event) =>
                  setNodeForm((current) => ({
                    ...current,
                    proxyUrl: event.target.value,
                  }))
                }
                placeholder={
                  editingNode && editingNode.proxyConfigured
                    ? '已配置，留空保持不变'
                    : 'socks5h://pool.{account}:token@resin:2260'
                }
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='egress-node-capacity'>账号容量</Label>
              <NumericInput
                id='egress-node-capacity'
                min={0}
                max={100000}
                value={nodeForm.accountCapacity}
                onChange={(next) =>
                  setNodeForm((current) => ({
                    ...current,
                    accountCapacity: next,
                  }))
                }
                placeholder='0 表示不限'
              />
            </div>
            <div className='divide-y overflow-hidden rounded-lg border'>
              <CreateSwitchRow
                label='代理池节点'
                description='同一逻辑节点可按账号映射到不同实际出口。'
                checked={nodeForm.proxyPool}
                onCheckedChange={(proxyPool) =>
                  setNodeForm((current) => ({ ...current, proxyPool }))
                }
              />
              {!editingNode && (
                <CreateSwitchRow
                  label='创建后立即启用'
                  description='启用后可参与新请求调度和账号绑定。'
                  checked={nodeForm.enabled}
                  onCheckedChange={(value) =>
                    setNodeForm((current) => ({ ...current, enabled: value }))
                  }
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={createMutation.isPending || editMutation.isPending}
              onClick={() => setEditorOpen(false)}
            >
              取消
            </Button>
            <Button
              type='button'
              disabled={
                createMutation.isPending ||
                editMutation.isPending ||
                !nodeForm.name.trim() ||
                (!editingNode && !nodeForm.proxyUrl.trim())
              }
              onClick={() =>
                editingNode ? editMutation.mutate() : createMutation.mutate()
              }
            >
              {createMutation.isPending || editMutation.isPending ? (
                <Loader2 className='animate-spin' />
              ) : editingNode ? (
                <Pencil />
              ) : (
                <Plus />
              )}
              {editingNode ? '保存修改' : '新增节点'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={distributionOpen}
        onOpenChange={(open) => {
          if (distributionMutation.isPending) return
          setDistributionOpen(open)
          if (!open) setAccountsPerNode(null)
        }}
      >
        <DialogContent className='sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>平均绑定全部账号</DialogTitle>
            <DialogDescription>
              将全部 Grok Build 账号重新平均分配到已选出口。运行中或排队探针锁定的账号会保留原绑定。
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-3'>
            <TitledCard
              title='分配概览'
              icon={<Users />}
              contentClassName='px-4 py-3'
            >
              <div className='grid grid-cols-3 gap-2'>
                <DistributionMetric
                  label='全部账号'
                  value={
                    accountTotalQuery.isFetching ? '读取中' : totalAccounts
                  }
                />
                <DistributionMetric
                  label='已选出口'
                  value={selectedNodes.length}
                />
                <DistributionMetric
                  label='推荐值'
                  value={
                    accountTotalQuery.isFetching
                      ? '计算中'
                      : `${recommendedAccountsPerNode}/出口`
                  }
                  emphasized
                />
              </div>
            </TitledCard>

            <div className='space-y-1.5'>
              <div className='flex items-center justify-between gap-3'>
                <Label htmlFor='egress-accounts-per-node'>单出口账号上限</Label>
                <span className='text-xs text-muted-foreground'>
                  推荐 {recommendedAccountsPerNode || '—'}
                </span>
              </div>
              <NumericInput
                id='egress-accounts-per-node'
                min={Math.max(1, recommendedAccountsPerNode)}
                max={100000}
                value={effectiveAccountsPerNode}
                onChange={setAccountsPerNode}
                disabled={accountTotalQuery.isFetching}
              />
              <p className='text-xs text-muted-foreground'>
                为确保覆盖全部账号，不能低于推荐值；实际分配会尽量保持每个出口数量相同。
              </p>
            </div>

            <div className='max-h-48 space-y-1 overflow-y-auto rounded-lg border p-1.5'>
              {selectedNodes.map((node) => (
                <div
                  key={node.id}
                  className='flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm'
                >
                  <span className='min-w-0 truncate font-medium'>
                    {node.name}
                  </span>
                  <span className='shrink-0 text-xs text-muted-foreground'>
                    当前 {node.assignedAccountCount ?? 0} 个
                  </span>
                </div>
              ))}
            </div>

            {accountTotalQuery.isError && (
              <p className='text-sm text-destructive'>
                账号总数读取失败：{getErrorMessage(accountTotalQuery.error)}
              </p>
            )}
            {unavailableSelectedNodes.length > 0 && (
              <p className='text-sm text-destructive'>
                {unavailableSelectedNodes.map((node) => node.name).join('、')}
                未启用或未配置代理，请调整节点后再绑定。
              </p>
            )}
            {!accountTotalQuery.isFetching &&
              totalAccounts > 0 &&
              effectiveAccountsPerNode < recommendedAccountsPerNode && (
                <p className='text-sm text-destructive'>
                  当前上限不足，至少需要设置为 {recommendedAccountsPerNode}。
                </p>
              )}
          </div>

          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={distributionMutation.isPending}
              onClick={() => setDistributionOpen(false)}
            >
              取消
            </Button>
            <Button
              type='button'
              disabled={
                distributionMutation.isPending ||
                accountTotalQuery.isFetching ||
                accountTotalQuery.isError ||
                totalAccounts <= 0 ||
                selectedNodes.length < 2 ||
                unavailableSelectedNodes.length > 0 ||
                effectiveAccountsPerNode < recommendedAccountsPerNode
              }
              onClick={() => distributionMutation.mutate()}
            >
              {distributionMutation.isPending ? (
                <Loader2 className='animate-spin' />
              ) : (
                <Users />
              )}
              {distributionMutation.isPending ? '正在绑定…' : '确认平均绑定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={action != null}
        onOpenChange={(open) => {
          if (!open && !actionPending) setAction(null)
        }}
        title={
          action?.kind === 'delete'
            ? `删除 ${action.nodes.length} 个上游节点？`
            : `${action?.kind === 'enable' ? '启用' : '停用'} ${action?.nodes.length ?? 0} 个上游节点？`
        }
        desc={
          action?.kind === 'delete' ? (
            <div className='space-y-2'>
              <p>删除后，grok2api 会解除这些节点上的账号绑定。</p>
              <p>
                当前共绑定 {assignedAccounts ?? 0}
                个账号；订阅导入的节点可能在后续同步时重新出现。
              </p>
              <p className='text-muted-foreground'>
                运行中或排队探针引用的节点会自动跳过。
              </p>
            </div>
          ) : (
            <div className='space-y-2'>
              <p>
                {action?.kind === 'enable'
                  ? '启用后，节点会重新参与 grok2api 调度。'
                  : '停用后，节点不再参与新请求调度，现有账号绑定会保留。'}
              </p>
              {action?.kind === 'disable' && (
                <p className='text-muted-foreground'>
                  运行中或排队探针引用的节点会自动跳过。
                </p>
              )}
            </div>
          )
        }
        confirmText={
          actionPending
            ? '正在处理…'
            : action?.kind === 'delete'
              ? '确认删除'
              : '确认设置'
        }
        handleConfirm={() => {
          if (!action) return
          const nodeIds = action.nodes.map((node) => Number(node.id))
          if (action.kind === 'delete') {
            deleteMutation.mutate(nodeIds)
          } else {
            updateMutation.mutate({ nodeIds, value: action.kind === 'enable' })
          }
        }}
      />
    </Page>
  )
}

function DistributionMetric({
  label,
  value,
  emphasized = false,
}: {
  label: string
  value: string | number
  emphasized?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-muted/20 px-3 py-2',
        emphasized && 'border-primary/30 bg-primary/5'
      )}
    >
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div className='mt-0.5 text-sm font-semibold tabular-nums'>{value}</div>
    </div>
  )
}

function CreateSwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between gap-4 px-3 py-2'>
      <div className='flex items-center gap-1.5 text-sm font-medium'>
        {label}
        <InfoTooltip label={label} content={description} />
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function HealthIndicator({ node }: { node: EgressNode }) {
  const unknown =
    (node.probeStatus || 'unknown') === 'unknown' &&
    !node.lastProbedAt &&
    !(node.failureCount ?? 0)
  const health = Math.max(0, Math.min(1, node.health ?? 0))
  const percent = health * 100
  const label = unknown
    ? '未评估'
    : percent >= 80
      ? '健康'
      : percent >= 50
        ? '一般'
        : '较差'
  const tone = unknown
    ? 'bg-muted/70 text-muted-foreground'
    : percent >= 80
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : percent >= 50
        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'bg-destructive/10 text-destructive'
  const Icon = unknown ? CircleHelp : Activity

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            tone
          )}
          tabIndex={0}
          aria-label={`健康度 ${label}`}
        >
          <Icon className='size-4' />
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-72 space-y-1'>
        {unknown ? (
          <div>尚未评估该节点健康度</div>
        ) : (
          <>
            <div>
              健康度 {formatNumber(percent, 0)}% · {label}
            </div>
            <div className='text-muted-foreground'>
              累计失败 {node.failureCount ?? 0} 次
            </div>
            {node.cooldownUntil && (
              <div className='text-muted-foreground'>
                冷却至 {formatDate(node.cooldownUntil)}
              </div>
            )}
            {node.lastError && (
              <div className='max-w-64 break-words'>{node.lastError}</div>
            )}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function ProbeIndicator({ node }: { node: EgressNode }) {
  const status = node.probeStatus || 'unknown'
  const label =
    status === 'healthy' ? '健康' : status === 'unhealthy' ? '异常' : '未探测'
  const tone =
    status === 'healthy'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : status === 'unhealthy'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted/70 text-muted-foreground'
  const Icon = status === 'unknown' ? CircleHelp : Activity

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            tone
          )}
          tabIndex={0}
          aria-label={`网络探测 ${label}`}
        >
          <Icon className='size-4' />
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-72 space-y-1'>
        <div>
          {node.lastProbedAt
            ? `探测于 ${formatDate(node.lastProbedAt)}`
            : '尚未执行网络探测'}
        </div>
        <div className='text-muted-foreground'>
          {label}
          {node.probeLatencyMs ? ` · ${node.probeLatencyMs} ms` : ''}
        </div>
        {node.probeProvider && (
          <div className='text-muted-foreground'>来源 {node.probeProvider}</div>
        )}
        {node.probeError && (
          <div className='max-w-64 break-words'>{node.probeError}</div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
