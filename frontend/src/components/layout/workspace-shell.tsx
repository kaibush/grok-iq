import { lazy, Suspense, useLayoutEffect, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Activity,
  Loader2,
  ShieldAlert,
  ShieldBan,
  Timer,
  UsersRound,
  X,
} from 'lucide-react'
import { useWorkspaceTabsStore } from '@/stores/workspace-tabs-store'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  isWorkspaceTabPath,
  matchWorkspaceTabId,
  workspaceTabLink,
  WORKSPACE_TAB_IDS,
  WORKSPACE_TAB_SHORT_TITLES,
  WORKSPACE_TAB_TITLES,
  type WorkspaceTabId,
} from './workspace-tabs'

const workspacePages = {
  accounts: lazy(() =>
    import('@/features/monitor/pages/accounts').then((mod) => ({
      default: mod.AccountsPage,
    }))
  ),
  quarantine: lazy(() =>
    import('@/features/monitor/pages/quarantine').then((mod) => ({
      default: mod.QuarantinePage,
    }))
  ),
  cooldown: lazy(() =>
    import('@/features/monitor/pages/cooldown').then((mod) => ({
      default: mod.CooldownPage,
    }))
  ),
  runs: lazy(() =>
    import('@/features/monitor/pages/runs').then((mod) => ({
      default: mod.RunsPage,
    }))
  ),
  'request-audits': lazy(() =>
    import('@/features/monitor/pages/request-audits').then((mod) => ({
      default: mod.RequestAuditsPage,
    }))
  ),
} as const

const workspaceIcons = {
  accounts: UsersRound,
  quarantine: ShieldBan,
  cooldown: Timer,
  runs: Activity,
  'request-audits': ShieldAlert,
} as const

const workspaceAccents: Record<WorkspaceTabId, string> = {
  accounts: 'text-sky-600 dark:text-sky-400',
  quarantine: 'text-rose-600 dark:text-rose-400',
  cooldown: 'text-orange-600 dark:text-orange-400',
  runs: 'text-violet-600 dark:text-violet-400',
  'request-audits': 'text-amber-600 dark:text-amber-400',
}

const workspaceActive: Record<WorkspaceTabId, string> = {
  accounts:
    'bg-sky-500/15 text-sky-800 ring-1 ring-sky-500/30 dark:bg-sky-500/20 dark:text-sky-50 dark:ring-sky-400/30',
  quarantine:
    'bg-rose-500/15 text-rose-800 ring-1 ring-rose-500/30 dark:bg-rose-500/20 dark:text-rose-50 dark:ring-rose-400/30',
  cooldown:
    'bg-orange-500/15 text-orange-800 ring-1 ring-orange-500/30 dark:bg-orange-500/20 dark:text-orange-50 dark:ring-orange-400/30',
  runs: 'bg-violet-500/15 text-violet-800 ring-1 ring-violet-500/30 dark:bg-violet-500/20 dark:text-violet-50 dark:ring-violet-400/30',
  'request-audits':
    'bg-amber-500/15 text-amber-900 ring-1 ring-amber-500/30 dark:bg-amber-500/20 dark:text-amber-50 dark:ring-amber-400/30',
}

function shouldDropWorkspaceQuery(
  id: WorkspaceTabId,
  queryKey: readonly unknown[]
) {
  const root = queryKey[0]
  const second = queryKey[1]
  if (id === 'request-audits') {
    return root === 'request-audits' || root === 'account-samples'
  }
  if (id === 'runs') {
    return (
      root === 'runs' ||
      root === 'run' ||
      root === 'run-preview' ||
      root === 'run-preview-samples'
    )
  }
  if (id === 'quarantine') {
    return (
      (root === 'accounts' &&
        (second === 'quarantine' || second === 'quarantine-stats')) ||
      root === 'account-samples' ||
      root === 'run-preview' ||
      root === 'run-preview-samples'
    )
  }
  if (id === 'cooldown') {
    return (
      root === 'accounts' &&
      (second === 'cooldowns' || second === 'cooldown-stats')
    )
  }
  if (id === 'accounts') {
    return (
      root === 'accounts' &&
      second !== 'quarantine' &&
      second !== 'quarantine-stats' &&
      second !== 'cooldowns' &&
      second !== 'cooldown-stats'
    )
  }
  return false
}

function shouldDropHeavyWorkspaceQuery(
  id: WorkspaceTabId,
  queryKey: readonly unknown[]
) {
  const root = queryKey[0]
  if (id === 'request-audits') {
    return root === 'request-audits' || root === 'account-samples'
  }
  if (id === 'runs' || id === 'quarantine') {
    return (
      root === 'run' ||
      root === 'run-preview' ||
      root === 'run-preview-samples' ||
      root === 'account-samples'
    )
  }
  return false
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname })
  const showRouteOutlet = !isWorkspaceTabPath(pathname)

  return (
    <div className='relative min-h-0 flex-1 overflow-hidden'>
      <WorkspaceKeepAlive />
      {showRouteOutlet ? (
        <div className='h-full min-h-0 pb-[calc(4.75rem+env(safe-area-inset-bottom))]'>{children}</div>
      ) : null}
      <WorkspaceDock />
    </div>
  )
}

function WorkspaceKeepAlive() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const search = useLocation({ select: (location) => location.search })
  const currentId = matchWorkspaceTabId(pathname)
  const visit = useWorkspaceTabsStore((state) => state.visit)

  useLayoutEffect(() => {
    if (!currentId) return
    visit(currentId, {
      pathname,
      search: (search ?? {}) as Record<string, unknown>,
    })
  }, [currentId, pathname, search, visit])

  if (!currentId) return null

  const Page = workspacePages[currentId]
  return (
    <WorkspacePageFrame key={currentId} id={currentId}>
      <Suspense fallback={<WorkspacePageFallback />}>
        <Page />
      </Suspense>
    </WorkspacePageFrame>
  )
}

function WorkspacePageFrame({
  id,
  children,
}: {
  id: WorkspaceTabId
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  useLayoutEffect(() => {
    window.dispatchEvent(new Event('resize'))
    return () => {
      queryClient.removeQueries({
        predicate: (query) => shouldDropHeavyWorkspaceQuery(id, query.queryKey),
      })
    }
  }, [id, queryClient])

  return (
    <div
      data-workspace-tab={id}
      data-active='true'
      className='absolute inset-0 z-10 min-h-0 overflow-hidden pb-[calc(4.75rem+env(safe-area-inset-bottom))]'
    >
      {children}
    </div>
  )
}

function WorkspacePageFallback() {
  return (
    <div className='flex h-full items-center justify-center gap-2 text-sm text-muted-foreground'>
      <Loader2 className='size-4 animate-spin' />
      正在打开工作区
    </div>
  )
}

function WorkspaceDock() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const currentId = matchWorkspaceTabId(pathname)
  const mounted = useWorkspaceTabsStore((state) => state.mounted)

  const closeTab = async (id: WorkspaceTabId) => {
    const state = useWorkspaceTabsStore.getState()
    const remaining = state.mounted.filter((item) => item !== id)
    if (currentId === id) {
      const nextId = remaining[remaining.length - 1]
      if (nextId) {
        const link = workspaceTabLink(nextId, state.lastLocations[nextId])
        await navigate({
          to: link.to,
          search: link.search,
        } as never)
      } else {
        await navigate({ to: '/' })
      }
    }
    queryClient.removeQueries({
      predicate: (query) => shouldDropWorkspaceQuery(id, query.queryKey),
    })
    state.close(id)
  }

  return (
    <nav
      aria-label='工作区页面'
      className='pointer-events-none absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-20 flex justify-center px-3'
    >
      <div className='pointer-events-auto no-scrollbar inline-flex max-w-full items-end gap-0.5 overflow-x-auto rounded-[1.6rem] border bg-muted/80 p-1 shadow-lg ring-1 shadow-black/10 ring-black/5 backdrop-blur-md dark:bg-background/80 dark:shadow-black/40 dark:ring-white/10'>
        {WORKSPACE_TAB_IDS.map((id) => (
          <WorkspaceDockItem
            key={id}
            id={id}
            active={id === currentId}
            mounted={mounted.includes(id)}
            onClose={() => void closeTab(id)}
          />
        ))}
      </div>
    </nav>
  )
}

function WorkspaceDockItem({
  id,
  active,
  mounted,
  onClose,
}: {
  id: WorkspaceTabId
  active: boolean
  mounted: boolean
  onClose: () => void
}) {
  const title = WORKSPACE_TAB_TITLES[id]
  const shortTitle = WORKSPACE_TAB_SHORT_TITLES[id]
  const Icon = workspaceIcons[id]
  const lastLocation = useWorkspaceTabsStore((state) => state.lastLocations[id])
  const link = workspaceTabLink(id, lastLocation)
  const tooltip = active
    ? `${title}（当前页）`
    : mounted
      ? `${title}（已打开，切换时保留筛选）`
      : `打开${title}`

  return (
    <div className='group/dock-item relative shrink-0'>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={link.to}
            search={link.search as never}
            aria-label={tooltip}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-2xl transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
              active && cn('shadow-sm', workspaceActive[id]),
              !active &&
                mounted &&
                'text-foreground/75 hover:bg-background/70 hover:text-foreground',
              !active &&
                !mounted &&
                'text-muted-foreground hover:bg-background/70 hover:text-foreground'
            )}
          >
            <Icon
              className={cn(
                'size-5 shrink-0',
                active || mounted
                  ? workspaceAccents[id]
                  : 'text-muted-foreground'
              )}
              strokeWidth={active ? 2.25 : 1.75}
            />
            <span className='text-[10px] leading-none font-medium tracking-wide'>
              {shortTitle}
            </span>
            <span className='sr-only'>{title}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side='top'>{tooltip}</TooltipContent>
      </Tooltip>
      {mounted && (
        <div className='absolute -top-0.5 -right-0.5 size-4'>
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 items-center justify-center',
              active
                ? 'hidden'
                : 'flex md:group-focus-within/dock-item:hidden md:group-hover/dock-item:hidden'
            )}
          >
            <span className='size-1.5 rounded-full bg-emerald-500' />
          </span>
          <button
            type='button'
            aria-label={`关闭${title}并重置页面状态`}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }}
            className={cn(
              'absolute inset-0 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:bg-muted hover:text-foreground',
              active
                ? 'flex'
                : 'hidden md:group-focus-within/dock-item:flex md:group-hover/dock-item:flex'
            )}
          >
            <X className='size-2.5' />
          </button>
        </div>
      )}
    </div>
  )
}
