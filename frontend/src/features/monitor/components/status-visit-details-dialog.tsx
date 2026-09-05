import type { ReactNode } from 'react'
import type {
  AdminVisitDetails,
  PublicVisitDevice,
  PublicVisitRecent,
  PublicVisitReferrerStat,
} from '@/lib/api'
import { formatDate, formatNumber } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState, LoadingState } from '@/components/page'

const DEVICE_LABELS: Record<PublicVisitDevice['id'], string> = {
  desktop: '桌面',
  mobile: '手机',
  tablet: '平板',
  bot: '爬虫',
  other: '其他',
}

export function visitDeviceLabel(
  device: PublicVisitDevice | PublicVisitDevice['id']
) {
  if (typeof device === 'string') return DEVICE_LABELS[device] ?? device
  return device.label || DEVICE_LABELS[device.id] || device.id
}

export function StatusVisitDetailsDialog({
  open,
  onOpenChange,
  data,
  loading,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data?: AdminVisitDetails
  loading: boolean
  error?: string
}) {
  const referrers = data?.referrers ?? []
  const paths = data?.paths ?? []
  const devices = data?.devices ?? []
  const recent = data?.recent ?? []
  const showPaths = paths.length > 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size='wide'>
        <DialogHeader>
          <DialogTitle>访问明细</DialogTitle>
          <DialogDescription>
            当前时间窗口的来源、设备和最近访问。不含 IP 与访客编号；管理员刷新单独列出。
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Card className='border-destructive/30 bg-destructive/5'>
            <CardContent className='p-4 text-sm text-destructive'>
              访问明细读取失败：{error}
            </CardContent>
          </Card>
        ) : null}
        {loading && !data ? (
          <LoadingState label='正在加载访问明细' />
        ) : data ? (
          <div className='space-y-6'>
            {data.audience ? (
              <div className='grid gap-3 sm:grid-cols-2'>
                <AudienceTile
                  label='公开访客'
                  pv={data.audience.public.pv}
                  uv={data.audience.public.uv}
                />
                <AudienceTile
                  label='管理员自刷新'
                  pv={data.audience.admin.pv}
                  uv={data.audience.admin.uv}
                />
              </div>
            ) : null}
            <div className='grid gap-6 md:grid-cols-2'>
              <DetailSection title='来源'>
                <VisitStatTable
                  nameHeader='来源'
                  empty='暂无来源数据'
                  rows={referrers.map((item) => ({
                    key: item.host || item.label || 'direct',
                    name: referrerLabel(item),
                    pv: item.pv,
                    uv: item.uv,
                  }))}
                />
              </DetailSection>
              {showPaths ? (
                <DetailSection title='路径'>
                  <VisitStatTable
                    nameHeader='路径'
                    empty='暂无路径数据'
                    rows={paths.map((item) => ({
                      key: item.path,
                      name: item.path || '/',
                      pv: item.pv,
                      uv: item.uv,
                    }))}
                  />
                </DetailSection>
              ) : (
                <DetailSection title='设备'>
                  <DevicePanel devices={devices} />
                </DetailSection>
              )}
            </div>
            {showPaths ? (
              <DetailSection title='设备'>
                <DevicePanel devices={devices} />
              </DetailSection>
            ) : null}
            <DetailSection title='最近访问'>
              <RecentVisits rows={recent} />
            </DetailSection>
          </div>
        ) : error ? null : (
          <EmptyState
            compact
            title='还没有访问记录'
            description='这个时间窗口还没有可展开的访问明细。'
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className='min-w-0 space-y-2'>
      <h3 className='text-sm font-medium'>{title}</h3>
      {children}
    </section>
  )
}

function VisitStatTable({
  nameHeader,
  empty,
  rows,
}: {
  nameHeader: string
  empty: string
  rows: Array<{ key: string; name: string; pv: number; uv: number }>
}) {
  if (rows.length === 0) {
    return <p className='text-sm text-muted-foreground'>{empty}</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className='hover:bg-transparent'>
          <TableHead>{nameHeader}</TableHead>
          <TableHead className='w-16 text-right'>PV</TableHead>
          <TableHead className='w-16 text-right'>UV</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key} className='hover:bg-transparent'>
            <TableCell className='max-w-[18rem] truncate' title={row.name}>
              {row.name}
            </TableCell>
            <TableCell className='text-right text-xs text-sky-600 tabular-nums dark:text-sky-400'>
              {formatNumber(row.pv, 0)}
            </TableCell>
            <TableCell className='text-right text-xs text-emerald-600 tabular-nums dark:text-emerald-400'>
              {formatNumber(row.uv, 0)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function DevicePanel({ devices }: { devices: PublicVisitDevice[] }) {
  const visible = devices.filter((device) => device.pv > 0)
  if (visible.length === 0) {
    return <p className='text-sm text-muted-foreground'>暂无设备数据</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className='hover:bg-transparent'>
          <TableHead>设备</TableHead>
          <TableHead className='w-16 text-right'>PV</TableHead>
          <TableHead className='w-16 text-right'>UV</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map((device) => (
          <TableRow key={device.id} className='hover:bg-transparent'>
            <TableCell>{visitDeviceLabel(device)}</TableCell>
            <TableCell className='text-right text-xs text-sky-600 tabular-nums dark:text-sky-400'>
              {formatNumber(device.pv, 0)}
            </TableCell>
            <TableCell className='text-right text-xs text-emerald-600 tabular-nums dark:text-emerald-400'>
              {formatNumber(device.uv, 0)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function RecentVisits({ rows }: { rows: PublicVisitRecent[] }) {
  if (rows.length === 0) {
    return <p className='text-sm text-muted-foreground'>暂无最近访问</p>
  }
  return (
    <div className='max-h-80 overflow-auto'>
      <Table>
        <TableHeader>
          <TableRow className='hover:bg-transparent'>
            <TableHead>时间</TableHead>
            <TableHead>路径</TableHead>
            <TableHead>来源</TableHead>
            <TableHead>设备</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => {
            const referrer = row.referrerHost || '直接访问'
            return (
              <TableRow
                key={`${row.visitedAt}:${row.path}:${index}`}
                className='hover:bg-transparent'
              >
                <TableCell className='whitespace-nowrap text-muted-foreground'>
                  {formatDate(row.visitedAt)}
                </TableCell>
                <TableCell className='max-w-[16rem] truncate' title={row.path}>
                  {row.path || '/'}
                </TableCell>
                <TableCell className='max-w-[12rem] truncate' title={referrer}>
                  {referrer}
                </TableCell>
                <TableCell>
                  <span className='inline-flex items-center gap-1.5'>
                    {visitDeviceLabel(row.device)}
                    {row.isAdmin ? (
                      <Badge
                        variant='outline'
                        className='h-5 px-1.5 text-[10px]'
                      >
                        管理员
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function AudienceTile({
  label,
  pv,
  uv,
}: {
  label: string
  pv: number
  uv: number
}) {
  return (
    <div className='rounded-xl border bg-muted/30 px-3 py-2.5'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 flex items-baseline gap-3 text-sm tabular-nums'>
        <span>
          浏览{' '}
          <span className='font-medium text-sky-600 dark:text-sky-400'>
            {formatNumber(pv, 0)}
          </span>
        </span>
        <span>
          访客{' '}
          <span className='font-medium text-emerald-600 dark:text-emerald-400'>
            {formatNumber(uv, 0)}
          </span>
        </span>
      </div>
    </div>
  )
}

function referrerLabel(item: PublicVisitReferrerStat) {
  return item.label || item.host || '直接访问'
}
