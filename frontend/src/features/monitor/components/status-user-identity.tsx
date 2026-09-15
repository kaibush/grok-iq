import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'

const LINUXDO_TRUST_LABELS: Record<number, string> = {
  0: '新用户',
  1: '基本用户',
  2: '成员',
  3: '常客',
  4: '领导者',
}

function linuxdoTrustLabel(level?: number | null) {
  if (level == null || Number.isNaN(Number(level))) return ''
  const value = Number(level)
  const name = LINUXDO_TRUST_LABELS[value]
  return name ? `TL${value} ${name}` : `TL${value}`
}

export function LinuxDoTrustCell({ level }: { level?: number | null }) {
  return <>{linuxdoTrustLabel(level) || '—'}</>
}

function identityInitials(name?: string, username?: string) {
  const source = (name || username || '').trim()
  return source ? source.slice(0, 1).toUpperCase() : '?'
}

export function LinuxDoIdentityCell({
  name,
  username,
  avatarUrl,
  trustLevel,
  showTrust = false,
  onSelectUsername,
}: {
  name?: string
  username?: string
  avatarUrl?: string
  trustLevel?: number | null
  showTrust?: boolean
  onSelectUsername?: (username: string) => void
}) {
  const displayName = name?.trim() || ''
  const handle = username?.trim() || ''
  const trust = showTrust ? linuxdoTrustLabel(trustLevel) : ''
  if (!displayName && !handle && !avatarUrl && !trust) {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <div className='flex min-w-0 items-center gap-2'>
      <Avatar className='size-7'>
        {avatarUrl ? (
          <AvatarImage src={avatarUrl} alt={displayName || handle} />
        ) : null}
        <AvatarFallback className='bg-primary/10 text-[10px] font-medium text-primary'>
          {identityInitials(displayName, handle)}
        </AvatarFallback>
      </Avatar>
      <div className='min-w-0'>
        <div
          className='truncate text-sm font-medium'
          title={displayName || handle}
        >
          {displayName || handle}
        </div>
        <div className='flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground'>
          {handle ? (
            onSelectUsername ? (
              <button
                type='button'
                className='truncate hover:underline'
                onClick={() => onSelectUsername(handle)}
              >
                @{handle}
              </button>
            ) : (
              <span className='truncate'>@{handle}</span>
            )
          ) : null}
          {trust ? (
            <Badge variant='outline' className='h-5 px-1.5 text-[10px]'>
              {trust}
            </Badge>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function LinuxDoStatusBadges({
  active,
  silenced,
}: {
  active?: boolean
  silenced?: boolean
}) {
  if (active !== true && active !== false && !silenced) {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <span className='inline-flex items-center gap-1.5'>
      {active === true ? (
        <Badge variant='success' className='h-5 px-1.5 text-[10px]'>
          正常
        </Badge>
      ) : null}
      {active === false ? (
        <Badge variant='outline' className='h-5 px-1.5 text-[10px]'>
          停用
        </Badge>
      ) : null}
      {silenced ? (
        <Badge variant='warning' className='h-5 px-1.5 text-[10px]'>
          禁言
        </Badge>
      ) : null}
    </span>
  )
}

export function StatusAccountIdentityCell({
  username,
  onSelectUsername,
}: {
  username?: string
  onSelectUsername?: (username: string) => void
}) {
  const handle = username?.trim() || ''
  if (!handle) {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <div className='flex min-w-0 items-center gap-2'>
      <Avatar className='size-7'>
        <AvatarFallback className='bg-amber-500/10 text-[10px] font-medium text-amber-700 dark:text-amber-400'>
          {identityInitials(handle)}
        </AvatarFallback>
      </Avatar>
      <div className='min-w-0'>
        {onSelectUsername ? (
          <button
            type='button'
            className='truncate text-sm font-medium hover:underline'
            title={handle}
            onClick={() => onSelectUsername(handle)}
          >
            {handle}
          </button>
        ) : (
          <div className='truncate text-sm font-medium' title={handle}>
            {handle}
          </div>
        )}
        <div className='text-xs text-muted-foreground'>邀请账号</div>
      </div>
    </div>
  )
}

export function VisitUserCell({
  linuxdoUserId,
  linuxdoName,
  linuxdoUsername,
  linuxdoAvatarUrl,
  linuxdoTrustLevel,
  statusAccountId,
  statusAccountUsername,
  onSelect,
}: {
  linuxdoUserId?: number | null
  linuxdoName?: string
  linuxdoUsername?: string
  linuxdoAvatarUrl?: string
  linuxdoTrustLevel?: number | null
  statusAccountId?: number | null
  statusAccountUsername?: string
  onSelect?: (value: string) => void
}) {
  const hasLinuxdo = Boolean(linuxdoUserId || linuxdoUsername?.trim())
  const hasAccount = Boolean(statusAccountId || statusAccountUsername?.trim())
  if (!hasLinuxdo && !hasAccount) {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <div className='flex min-w-0 flex-col gap-1.5'>
      {hasLinuxdo ? (
        <LinuxDoIdentityCell
          name={linuxdoName}
          username={linuxdoUsername}
          avatarUrl={linuxdoAvatarUrl}
          trustLevel={linuxdoTrustLevel}
          showTrust
          onSelectUsername={onSelect}
        />
      ) : null}
      {hasAccount ? (
        <StatusAccountIdentityCell
          username={statusAccountUsername}
          onSelectUsername={onSelect}
        />
      ) : null}
    </div>
  )
}
