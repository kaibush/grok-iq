import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export function isModelBindWindowIssue(
  text?: string | null,
  errorCode?: string | null
) {
  if (errorCode === 'modelBindWindow') return true
  return Boolean(text && text.includes('模型绑定窗口'))
}

export function ModelBindWindowHint({
  variant,
  className,
}: {
  variant: 'probe' | 'egress' | 'error'
  className?: string
}) {
  const title =
    variant === 'egress'
      ? '超出模型绑定窗口也能换出口'
      : '超出模型绑定窗口时怎么换出口'

  return (
    <div
      className={cn(
        'rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-5 text-muted-foreground',
        className
      )}
    >
      <div className='flex items-start gap-2 text-amber-700 dark:text-amber-300'>
        <TriangleAlert className='mt-0.5 size-3.5 shrink-0' />
        <span className='font-medium'>{title}</span>
      </div>
      <ul className='mt-2 list-disc space-y-1 ps-5'>
        {variant === 'egress' ? (
          <>
            <li>
              绑定出口走账号出口接口，不受 grok2api
              模型绑定窗口（最新约 1000 个账号）限制。
            </li>
            <li>超出窗口的老账号也可以在这里直接改固定出口。</li>
          </>
        ) : (
          <>
            <li>
              到「账号」页选中该账号，用「批量设置出口」绑定新节点。这条接口不依赖模型绑定。
            </li>
            <li>
              不要用「异常诊断 · 临时切换出口」验证老账号；官方 grok2api
              钉不住超出窗口的账号。
            </li>
            <li>
              若要钉住探测：在 grok2api 的 config.yaml 设置
              qualityGuard.enabled: true 后重启主程序。质量守护容器可以不启动。
            </li>
          </>
        )}
      </ul>
    </div>
  )
}

export function ModelBindWindowError({
  message,
  errorCode,
  className,
}: {
  message?: string | null
  errorCode?: string | null
  className?: string
}) {
  if (!message) return null
  return (
    <div className={cn('space-y-2', className)}>
      <div className='rounded-lg bg-destructive/10 p-3 text-sm break-words whitespace-pre-wrap text-destructive'>
        {message}
      </div>
      {isModelBindWindowIssue(message, errorCode) ? (
        <ModelBindWindowHint variant='error' />
      ) : null}
    </div>
  )
}
