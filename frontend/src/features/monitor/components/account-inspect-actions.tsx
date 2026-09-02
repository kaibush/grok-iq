import type { ReactNode } from 'react'
import {
  Eye,
  Images,
  MoreHorizontal,
  Play,
  ScrollText,
  Server,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function AccountInspectActions({
  accountLabel,
  missingUpstream = false,
  extra,
  onOpenUpstream,
  onPreview,
  onProbe,
  onOpenSamples,
  onOpenLedger,
}: {
  accountLabel: string
  missingUpstream?: boolean
  extra?: ReactNode
  onOpenUpstream: () => void
  onPreview: () => void
  onProbe: () => void
  onOpenSamples: () => void
  onOpenLedger: () => void
}) {
  return (
    <div className='inline-flex items-center justify-end'>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size='icon'
            variant='ghost'
            onClick={onOpenUpstream}
            aria-label={`查看 ${accountLabel} 的上游信息`}
          >
            <Server />
          </Button>
        </TooltipTrigger>
        <TooltipContent>查看上游信息</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size='icon'
            variant='ghost'
            onClick={onPreview}
            aria-label={`预览 ${accountLabel} 的结果`}
          >
            <Images />
          </Button>
        </TooltipTrigger>
        <TooltipContent>预览结果</TooltipContent>
      </Tooltip>
      {extra}
      <DropdownMenu modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className='inline-flex'>
              <DropdownMenuTrigger asChild>
                <Button
                  size='icon'
                  variant='ghost'
                  aria-label={`${accountLabel} 的更多操作`}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent>更多</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align='end'>
          <DropdownMenuItem disabled={missingUpstream} onSelect={onProbe}>
            <Play />
            {missingUpstream ? '缺少上游，无法创建探针' : '创建探针任务'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenSamples}>
            <Eye />
            查看样本
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenLedger}>
            <ScrollText />
            查看请求流水
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
