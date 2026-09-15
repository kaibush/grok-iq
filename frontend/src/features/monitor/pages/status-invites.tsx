import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Ticket,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type StatusAccountPublicUser,
  type StatusInviteCode,
  type StatusInvitedUser,
} from '@/lib/api'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyableText } from '@/components/copy-button'
import { NumericInput } from '@/components/numeric-input'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { ServerPagination } from '@/components/server-pagination'
import { StatCard } from '@/components/stat-card'
import { TablePanel } from '@/components/table-panel'
import {
  LinuxDoIdentityCell,
  LinuxDoStatusBadges,
  LinuxDoTrustCell,
} from '@/features/monitor/components/status-user-identity'

const PAGE_SIZE_OPTIONS = [20, 50, 100]
const MIN_MAX_USES = 1
const MAX_MAX_USES = 1000

export function StatusInvitesPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'invites' | 'accounts' | 'linuxdo'>('invites')
  const [draftQuery, setDraftQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [draftAccountsQuery, setDraftAccountsQuery] = useState('')
  const [appliedAccountsQuery, setAppliedAccountsQuery] = useState('')
  const [accountsPage, setAccountsPage] = useState(1)
  const [accountsPageSize, setAccountsPageSize] = useState(50)
  const [editor, setEditor] = useState<InviteEditorState | null>(null)
  const [toggleTarget, setToggleTarget] = useState<StatusInviteCode | null>(
    null
  )
  const [invitedCode, setInvitedCode] = useState<StatusInviteCode | null>(null)
  const [draftLinuxdoQuery, setDraftLinuxdoQuery] = useState('')
  const [appliedLinuxdoQuery, setAppliedLinuxdoQuery] = useState('')
  const [linuxdoPage, setLinuxdoPage] = useState(1)
  const [linuxdoPageSize, setLinuxdoPageSize] = useState(50)

  const codesQuery = useQuery({
    queryKey: ['status-invite-codes', appliedQuery, page, pageSize],
    queryFn: () =>
      api.statusInviteCodes({
        q: appliedQuery,
        page,
        pageSize,
      }),
    placeholderData: (previous) => previous,
  })
  const accountsQuery = useQuery({
    queryKey: [
      'status-accounts',
      appliedAccountsQuery,
      accountsPage,
      accountsPageSize,
    ],
    queryFn: () =>
      api.statusAccounts({
        q: appliedAccountsQuery,
        page: accountsPage,
        pageSize: accountsPageSize,
      }),
    placeholderData: (previous) => previous,
  })
  const invitedQuery = useQuery({
    queryKey: ['status-invite-codes', invitedCode?.id],
    queryFn: () => api.statusInviteCode(invitedCode!.id),
    enabled: invitedCode != null,
  })
  const linuxdoUsersQuery = useQuery({
    queryKey: [
      'linuxdo-users',
      appliedLinuxdoQuery,
      linuxdoPage,
      linuxdoPageSize,
    ],
    queryFn: () =>
      api.linuxdoUsers({
        q: appliedLinuxdoQuery,
        page: linuxdoPage,
        pageSize: linuxdoPageSize,
      }),
    placeholderData: (previous) => previous,
  })

  const codes = codesQuery.data
  const codeRows = codes?.items ?? []
  const accounts = accountsQuery.data
  const accountRows = accounts?.items ?? []
  const remainingTotal = codeRows.reduce(
    (sum, item) => sum + inviteRemaining(item),
    0
  )
  const codesError = codesQuery.isError ? getErrorMessage(codesQuery.error) : ''
  const accountsError = accountsQuery.isError
    ? getErrorMessage(accountsQuery.error)
    : ''
  const codesLoading = codesQuery.isPending && !codesQuery.data
  const accountsLoading = accountsQuery.isPending && !accountsQuery.data
  const linuxdoUsers = linuxdoUsersQuery.data
  const linuxdoRows = linuxdoUsers?.items ?? []
  const linuxdoError = linuxdoUsersQuery.isError
    ? getErrorMessage(linuxdoUsersQuery.error)
    : ''
  const linuxdoLoading = linuxdoUsersQuery.isPending && !linuxdoUsersQuery.data
  const invitedUsers =
    invitedQuery.data?.invitedUsers ?? invitedCode?.invitedUsers ?? []

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!editor) throw new Error('没有待保存的邀请码')
      const maxUsesError = validateMaxUses(
        editor.maxUses,
        editor.mode === 'edit' ? editor.usedCount : 0
      )
      if (maxUsesError) throw new Error(maxUsesError)
      const note = editor.note.trim()
      if (editor.mode === 'create') {
        return api.createStatusInviteCode({
          maxUses: editor.maxUses,
          ...(note ? { note } : {}),
        })
      }
      return api.updateStatusInviteCode(editor.id, {
        note,
        maxUses: editor.maxUses,
      })
    },
    onSuccess: async (item) => {
      toast.success(
        editor?.mode === 'create'
          ? `已生成邀请码 ${item.code}`
          : `已更新邀请码 ${item.code}`
      )
      setEditor(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['status-invite-codes'] }),
        queryClient.invalidateQueries({ queryKey: ['status-accounts'] }),
      ])
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  const toggleMutation = useMutation({
    mutationFn: async (item: StatusInviteCode) =>
      api.updateStatusInviteCode(item.id, { enabled: !item.enabled }),
    onSuccess: async (item) => {
      toast.success(
        item.enabled ? `已启用 ${item.code}` : `已停用 ${item.code}`
      )
      setToggleTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['status-invite-codes'] })
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  function submitCodesSearch() {
    setAppliedQuery(draftQuery.trim())
    setPage(1)
  }

  function submitAccountsSearch() {
    setAppliedAccountsQuery(draftAccountsQuery.trim())
    setAccountsPage(1)
  }

  function submitLinuxdoSearch() {
    setAppliedLinuxdoQuery(draftLinuxdoQuery.trim())
    setLinuxdoPage(1)
  }

  return (
    <Page>
      <PageHeader
        title='用户管理'
        description='统一管理 /status 的邀请码、本地账号和 Linux.do 用户。账号登录有效期 7 天。'
        actions={
          <ActionToolbar label='用户管理操作'>
            <ToolbarAction
              label='生成邀请码'
              onClick={() =>
                setEditor({
                  mode: 'create',
                  note: '',
                  maxUses: 1,
                })
              }
            >
              <Plus />
            </ToolbarAction>
            <ToolbarAction
              label='刷新用户管理'
              pending={
                codesQuery.isFetching ||
                accountsQuery.isFetching ||
                linuxdoUsersQuery.isFetching
              }
              onClick={() => {
                void codesQuery.refetch()
                void accountsQuery.refetch()
                void linuxdoUsersQuery.refetch()
              }}
            >
              <RefreshCw />
            </ToolbarAction>
          </ActionToolbar>
        }
      />

      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard
          compact
          label='邀请码'
          value={codes ? formatNumber(codes.total, 0) : '—'}
          detail='已生成邀请码'
          icon={Ticket}
          tone='sky'
          loading={codesLoading}
          index={0}
        />
        <StatCard
          compact
          label='剩余次数'
          value={codes ? formatNumber(remainingTotal, 0) : '—'}
          detail={
            (codes?.total ?? 0) > codeRows.length
              ? '当前页剩余可邀请次数'
              : '剩余可邀请次数'
          }
          icon={KeyRound}
          tone='emerald'
          loading={codesLoading}
          index={1}
        />
        <StatCard
          compact
          label='注册账号'
          value={accounts ? formatNumber(accounts.total, 0) : '—'}
          detail='邀请码注册的本地账号'
          icon={Users}
          tone='amber'
          loading={accountsLoading}
          index={2}
        />
        <StatCard
          compact
          label='Linux.do 用户'
          value={linuxdoUsers ? formatNumber(linuxdoUsers.total, 0) : '—'}
          detail='状态页 Linux.do 登录用户'
          icon={Users}
          tone='violet'
          loading={linuxdoLoading}
          index={3}
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (
            value === 'invites' ||
            value === 'accounts' ||
            value === 'linuxdo'
          ) {
            setTab(value)
          }
        }}
        className='gap-4'
      >
        <TabsList className='h-8 w-full justify-start overflow-x-auto sm:w-fit'>
          <TabsTrigger value='invites'>邀请码</TabsTrigger>
          <TabsTrigger value='accounts'>注册账号</TabsTrigger>
          <TabsTrigger value='linuxdo'>Linux.do 用户</TabsTrigger>
        </TabsList>

        <TabsContent value='invites' className='mt-0'>
          <TablePanel
            toolbar={
              <form
                className='flex min-w-0 items-center gap-2'
                onSubmit={(event) => {
                  event.preventDefault()
                  submitCodesSearch()
                }}
              >
                <div className='relative min-w-0 flex-1'>
                  <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    value={draftQuery}
                    onChange={(event) => setDraftQuery(event.target.value)}
                    placeholder='邀请码、备注或被邀请人，回车搜索'
                    aria-label='搜索邀请码'
                    className='ps-9'
                  />
                </div>
                <Button type='submit' variant='outline' size='sm'>
                  搜索
                </Button>
                <Button
                  type='button'
                  size='sm'
                  onClick={() =>
                    setEditor({
                      mode: 'create',
                      note: '',
                      maxUses: 1,
                    })
                  }
                >
                  <Plus />
                  生成邀请码
                </Button>
              </form>
            }
            footer={
              <ServerPagination
                page={page}
                pageSize={pageSize}
                total={codes?.total ?? 0}
                disabled={codesLoading}
                loading={codesQuery.isFetching}
                itemLabel='个邀请码'
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size)
                  setPage(1)
                }}
              />
            }
          >
            {codesError ? (
              <p className='px-1 py-3 text-sm text-destructive'>
                邀请码读取失败：{codesError}
              </p>
            ) : codesLoading ? (
              <LoadingState label='正在加载邀请码' />
            ) : codeRows.length === 0 ? (
              <EmptyState
                compact
                icon={Ticket}
                title='还没有邀请码'
                description='生成邀请码后，用户才能在 /status 注册本地账号。'
                className='border-0 bg-transparent'
              />
            ) : (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow className='hover:bg-transparent'>
                      <TableHead>邀请码</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead>已用 / 上限</TableHead>
                      <TableHead>剩余</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>创建时间</TableHead>
                      <TableHead>被邀请人</TableHead>
                      <TableHead className='text-right'>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {codeRows.map((row) => (
                      <TableRow key={row.id} className='hover:bg-transparent'>
                        <TableCell className='font-mono text-xs'>
                          <CopyableText value={row.code} />
                        </TableCell>
                        <TableCell
                          className='max-w-[12rem] truncate'
                          title={row.note?.trim() || undefined}
                        >
                          {row.note?.trim() || '—'}
                        </TableCell>
                        <TableCell className='tabular-nums'>
                          {formatNumber(row.usedCount, 0)} /{' '}
                          {formatNumber(row.maxUses, 0)}
                        </TableCell>
                        <TableCell className='tabular-nums'>
                          {formatNumber(inviteRemaining(row), 0)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={row.enabled ? 'success' : 'secondary'}
                          >
                            {row.enabled ? '启用' : '停用'}
                          </Badge>
                        </TableCell>
                        <TableCell className='whitespace-nowrap text-muted-foreground'>
                          {formatDate(row.createdAt)}
                        </TableCell>
                        <TableCell>
                          <InvitedUsersCell
                            users={row.invitedUsers ?? []}
                            onOpen={() => setInvitedCode(row)}
                          />
                        </TableCell>
                        <TableCell>
                          <div className='flex justify-end gap-1'>
                            <Button
                              type='button'
                              size='sm'
                              variant='ghost'
                              onClick={() =>
                                setEditor({
                                  mode: 'edit',
                                  id: row.id,
                                  code: row.code,
                                  note: row.note ?? '',
                                  maxUses: row.maxUses,
                                  usedCount: row.usedCount,
                                })
                              }
                            >
                              <Pencil />
                              编辑
                            </Button>
                            <Button
                              type='button'
                              size='sm'
                              variant='ghost'
                              onClick={() => setToggleTarget(row)}
                            >
                              {row.enabled ? <PowerOff /> : <Power />}
                              {row.enabled ? '停用' : '启用'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TablePanel>
        </TabsContent>

        <TabsContent value='accounts' className='mt-0'>
          <TablePanel
            toolbar={
              <form
                className='flex min-w-0 items-center gap-2'
                onSubmit={(event) => {
                  event.preventDefault()
                  submitAccountsSearch()
                }}
              >
                <div className='relative min-w-0 flex-1'>
                  <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    value={draftAccountsQuery}
                    onChange={(event) =>
                      setDraftAccountsQuery(event.target.value)
                    }
                    placeholder='用户名或邀请码，回车搜索'
                    aria-label='搜索注册账号'
                    className='ps-9'
                  />
                </div>
                <Button type='submit' variant='outline' size='sm'>
                  搜索
                </Button>
              </form>
            }
            footer={
              <ServerPagination
                page={accountsPage}
                pageSize={accountsPageSize}
                total={accounts?.total ?? 0}
                disabled={accountsLoading}
                loading={accountsQuery.isFetching}
                itemLabel='个账号'
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageChange={setAccountsPage}
                onPageSizeChange={(size) => {
                  setAccountsPageSize(size)
                  setAccountsPage(1)
                }}
              />
            }
          >
            {accountsError ? (
              <p className='px-1 py-3 text-sm text-destructive'>
                注册账号读取失败：{accountsError}
              </p>
            ) : accountsLoading ? (
              <LoadingState label='正在加载注册账号' />
            ) : accountRows.length === 0 ? (
              <EmptyState
                compact
                icon={Users}
                title='还没有注册账号'
                description='用户使用邀请码在 /status 注册后会出现在这里。'
                className='border-0 bg-transparent'
              />
            ) : (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow className='hover:bg-transparent'>
                      <TableHead>用户名</TableHead>
                      <TableHead>邀请码</TableHead>
                      <TableHead>注册时间</TableHead>
                      <TableHead>最近登录</TableHead>
                      <TableHead>最近访问</TableHead>
                      <TableHead>状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accountRows.map((row) => (
                      <TableRow key={row.id} className='hover:bg-transparent'>
                        <TableCell className='font-medium'>
                          {row.username}
                        </TableCell>
                        <TableCell className='font-mono text-xs'>
                          {row.inviteCode ? (
                            <CopyableText value={row.inviteCode} />
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className='whitespace-nowrap text-muted-foreground'>
                          {formatDate(row.createdAt)}
                        </TableCell>
                        <TableCell className='whitespace-nowrap text-muted-foreground'>
                          {formatDate(row.lastLoginAt)}
                        </TableCell>
                        <TableCell className='whitespace-nowrap text-muted-foreground'>
                          {formatDate(row.lastSeenAt)}
                        </TableCell>
                        <TableCell>
                          <AccountStatusBadge account={row} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TablePanel>
        </TabsContent>
        <TabsContent value='linuxdo' className='mt-0'>
          <TablePanel
            toolbar={
              <form
                className='flex min-w-0 items-center gap-2'
                onSubmit={(event) => {
                  event.preventDefault()
                  submitLinuxdoSearch()
                }}
              >
                <div className='relative min-w-0 flex-1'>
                  <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    value={draftLinuxdoQuery}
                    onChange={(event) =>
                      setDraftLinuxdoQuery(event.target.value)
                    }
                    placeholder='用户名、昵称、邮箱或 ID，回车搜索'
                    aria-label='搜索 Linux.do 用户'
                    className='ps-9'
                  />
                </div>
                <Button type='submit' variant='outline' size='sm'>
                  搜索
                </Button>
              </form>
            }
            footer={
              <ServerPagination
                page={linuxdoPage}
                pageSize={linuxdoPageSize}
                total={linuxdoUsers?.total ?? 0}
                disabled={linuxdoLoading}
                loading={linuxdoUsersQuery.isFetching}
                itemLabel='位用户'
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageChange={setLinuxdoPage}
                onPageSizeChange={(size) => {
                  setLinuxdoPageSize(size)
                  setLinuxdoPage(1)
                }}
              />
            }
          >
            {linuxdoError ? (
              <p className='px-1 py-3 text-sm text-destructive'>
                Linux.do 用户读取失败：{linuxdoError}
              </p>
            ) : linuxdoLoading ? (
              <LoadingState label='正在加载 Linux.do 用户' />
            ) : linuxdoRows.length === 0 ? (
              <EmptyState
                compact
                icon={Users}
                title='没有匹配的用户'
                description='还没有 Linux.do 登录记录，或搜索词没有命中。'
                className='border-0 bg-transparent'
              />
            ) : (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow className='hover:bg-transparent'>
                      <TableHead>用户</TableHead>
                      <TableHead>信任等级</TableHead>
                      <TableHead>邮箱</TableHead>
                      <TableHead>登录次数</TableHead>
                      <TableHead>最近登录</TableHead>
                      <TableHead>最近访问</TableHead>
                      <TableHead>状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {linuxdoRows.map((user) => (
                      <TableRow key={user.id} className='hover:bg-transparent'>
                        <TableCell>
                          <LinuxDoIdentityCell
                            name={user.name}
                            username={user.username}
                            avatarUrl={user.avatarUrl}
                          />
                        </TableCell>
                        <TableCell className='whitespace-nowrap'>
                          <LinuxDoTrustCell level={user.trustLevel} />
                        </TableCell>
                        <TableCell
                          className='max-w-[16rem] truncate'
                          title={user.email}
                        >
                          {user.email?.trim() || '—'}
                        </TableCell>
                        <TableCell className='tabular-nums'>
                          {user.loginCount == null
                            ? '—'
                            : formatNumber(user.loginCount, 0)}
                        </TableCell>
                        <TableCell className='whitespace-nowrap text-muted-foreground'>
                          {formatDate(user.lastLoginAt)}
                        </TableCell>
                        <TableCell className='whitespace-nowrap text-muted-foreground'>
                          {formatDate(user.lastSeenAt)}
                        </TableCell>
                        <TableCell>
                          <LinuxDoStatusBadges
                            active={user.active}
                            silenced={user.silenced}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TablePanel>
        </TabsContent>
      </Tabs>

      <InviteEditorDialog
        editor={editor}
        pending={saveMutation.isPending}
        onOpenChange={(open) => {
          if (!open && !saveMutation.isPending) setEditor(null)
        }}
        onChange={setEditor}
        onSubmit={() => saveMutation.mutate()}
      />

      <ConfirmDialog
        open={toggleTarget != null}
        onOpenChange={(open) => {
          if (!open && !toggleMutation.isPending) setToggleTarget(null)
        }}
        title={
          toggleTarget?.enabled
            ? `停用邀请码 ${toggleTarget.code}？`
            : `启用邀请码 ${toggleTarget?.code ?? ''}？`
        }
        desc={
          toggleTarget?.enabled
            ? '停用后该邀请码不能再用于注册，已注册账号不受影响。'
            : '启用后该邀请码可继续用于注册，直到次数用尽。'
        }
        cancelBtnText='取消'
        confirmText={
          toggleMutation.isPending ? (
            <>
              <Loader2 className='animate-spin' />
              {toggleTarget?.enabled ? '停用中…' : '启用中…'}
            </>
          ) : toggleTarget?.enabled ? (
            '确认停用'
          ) : (
            '确认启用'
          )
        }
        destructive={Boolean(toggleTarget?.enabled)}
        isLoading={toggleMutation.isPending}
        handleConfirm={() => {
          if (!toggleTarget) return
          toggleMutation.mutate(toggleTarget)
        }}
      />

      <Dialog
        open={invitedCode != null}
        onOpenChange={(open) => {
          if (!open) setInvitedCode(null)
        }}
      >
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>被邀请人</DialogTitle>
            <DialogDescription>
              {invitedCode
                ? `邀请码 ${invitedCode.code} 已邀请 ${formatNumber(invitedUsers.length, 0)} 个账号。`
                : '查看该邀请码注册的账号。'}
            </DialogDescription>
          </DialogHeader>
          {invitedQuery.isError ? (
            <Card className='border-destructive/30 bg-destructive/5'>
              <CardContent className='p-3 text-sm text-destructive'>
                被邀请人读取失败：{getErrorMessage(invitedQuery.error)}
              </CardContent>
            </Card>
          ) : invitedQuery.isPending &&
            invitedCode != null &&
            !invitedQuery.data ? (
            <LoadingState label='正在加载被邀请人' />
          ) : invitedUsers.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              还没有人使用这个邀请码。
            </p>
          ) : (
            <div className='overflow-x-auto'>
              <Table>
                <TableHeader>
                  <TableRow className='hover:bg-transparent'>
                    <TableHead>用户名</TableHead>
                    <TableHead>注册时间</TableHead>
                    <TableHead>最近登录</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitedUsers.map((user) => (
                    <TableRow key={user.id} className='hover:bg-transparent'>
                      <TableCell className='font-medium'>
                        {user.username}
                      </TableCell>
                      <TableCell className='whitespace-nowrap text-muted-foreground'>
                        {formatDate(user.createdAt)}
                      </TableCell>
                      <TableCell className='whitespace-nowrap text-muted-foreground'>
                        {formatDate(user.lastLoginAt)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            user.enabled === false ? 'secondary' : 'success'
                          }
                        >
                          {user.enabled === false ? '停用' : '启用'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Page>
  )
}

type InviteEditorState =
  | {
      mode: 'create'
      note: string
      maxUses: number
    }
  | {
      mode: 'edit'
      id: number
      code: string
      note: string
      maxUses: number
      usedCount: number
    }

function InviteEditorDialog({
  editor,
  pending,
  onOpenChange,
  onChange,
  onSubmit,
}: {
  editor: InviteEditorState | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onChange: (editor: InviteEditorState) => void
  onSubmit: () => void
}) {
  const usedCount = editor?.mode === 'edit' ? editor.usedCount : 0
  const maxUsesError = editor ? validateMaxUses(editor.maxUses, usedCount) : ''
  return (
    <Dialog open={editor != null} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>
            {editor?.mode === 'edit' ? '编辑邀请码' : '生成邀请码'}
          </DialogTitle>
          <DialogDescription>
            {editor?.mode === 'edit'
              ? `修改 ${editor.code} 的备注和可用次数。上限不能小于已使用次数。`
              : '生成后即可把邀请码发给用户。每个邀请码可设置最多邀请人数。'}
          </DialogDescription>
        </DialogHeader>
        {editor ? (
          <div className='space-y-3'>
            <div className='space-y-1.5'>
              <Label htmlFor='status-invite-note'>备注</Label>
              <Input
                id='status-invite-note'
                value={editor.note}
                maxLength={200}
                onChange={(event) =>
                  onChange({ ...editor, note: event.target.value })
                }
                placeholder='可选，例如给哪一批人用'
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='status-invite-max-uses'>可邀请人数</Label>
              <NumericInput
                id='status-invite-max-uses'
                min={Math.max(MIN_MAX_USES, usedCount)}
                max={MAX_MAX_USES}
                step={1}
                value={editor.maxUses}
                onChange={(maxUses) => onChange({ ...editor, maxUses })}
              />
              <p className='text-xs text-muted-foreground'>
                范围 {Math.max(MIN_MAX_USES, usedCount)}–{MAX_MAX_USES}
                {usedCount > 0 ? `，已使用 ${usedCount} 次` : ''}
              </p>
              {maxUsesError ? (
                <p className='text-sm text-destructive'>{maxUsesError}</p>
              ) : null}
            </div>
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
            disabled={pending || Boolean(maxUsesError) || editor == null}
            onClick={onSubmit}
          >
            {pending ? (
              <Loader2 className='animate-spin' />
            ) : editor?.mode === 'edit' ? (
              <Pencil />
            ) : (
              <Plus />
            )}
            {editor?.mode === 'edit' ? '保存修改' : '生成邀请码'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InvitedUsersCell({
  users,
  onOpen,
}: {
  users: StatusInvitedUser[]
  onOpen: () => void
}) {
  if (users.length === 0) {
    return <span className='text-muted-foreground'>—</span>
  }
  const preview = users
    .slice(0, 3)
    .map((user) => user.username)
    .join('、')
  return (
    <button
      type='button'
      className='max-w-[14rem] truncate text-left text-sm text-primary hover:underline'
      title={users.map((user) => user.username).join('、')}
      onClick={onOpen}
    >
      {preview}
      {users.length > 3 ? ` 等 ${users.length} 人` : ''}
    </button>
  )
}

function AccountStatusBadge({ account }: { account: StatusAccountPublicUser }) {
  if (account.enabled === false) {
    return <Badge variant='secondary'>停用</Badge>
  }
  return <Badge variant='success'>启用</Badge>
}

function inviteRemaining(item: StatusInviteCode) {
  if (typeof item.remaining === 'number' && Number.isFinite(item.remaining)) {
    return Math.max(0, item.remaining)
  }
  return Math.max(0, item.maxUses - item.usedCount)
}

function validateMaxUses(maxUses: number, usedCount: number) {
  if (
    !Number.isInteger(maxUses) ||
    maxUses < MIN_MAX_USES ||
    maxUses > MAX_MAX_USES
  ) {
    return `可邀请人数需为 ${MIN_MAX_USES}–${MAX_MAX_USES} 的整数`
  }
  if (maxUses < usedCount) {
    return `可邀请人数不能小于已使用次数 ${usedCount}`
  }
  return ''
}
