import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Check, Code2, Copy, ExternalLink, Eye, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { buildHtmlDocument, extractHtmlPreviews } from '@/lib/formatted-content'
import { cn, getErrorMessage } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function MarkdownView({
  content,
  className,
  codeBlockClassName,
}: {
  content: string
  className?: string
  codeBlockClassName?: string
}) {
  const preClassName = cn(
    'm-0 max-h-[28rem] overflow-auto overscroll-contain bg-transparent p-4 text-xs leading-5 text-foreground [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit',
    codeBlockClassName
  )

  return (
    <div className={cn('prose-monitor min-w-0 break-words', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => (
            <a {...props} target='_blank' rel='noreferrer' />
          ),
          code: ({ className: codeClass, children, ...props }) => (
            <code
              className={cn(
                'rounded bg-muted px-1 py-0.5 font-mono text-[.9em]',
                codeClass
              )}
              {...props}
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <MarkdownCodeBlock className={preClassName}>
              {children}
            </MarkdownCodeBlock>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

type MarkdownCodeElementProps = {
  className?: string
  children?: ReactNode
}

function MarkdownCodeBlock({
  children,
  className,
}: {
  children: ReactNode
  className: string
}) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | undefined>(undefined)
  const codeElement = Children.toArray(children).find((child) =>
    isValidElement<MarkdownCodeElementProps>(child)
  )
  const codeProps = isValidElement<MarkdownCodeElementProps>(codeElement)
    ? codeElement.props
    : undefined
  const languageMatch = codeProps?.className?.match(/language-([\w-]+)/i)
  const language = formatCodeLanguage(languageMatch?.[1])
  const code = stringifyMarkdownChildren(
    codeProps?.children ?? children
  ).replace(/\n$/, '')

  const handleCopy = () => {
    void copyText(code)
      .then(() => {
        setCopied(true)
        toast.success('代码内容已复制')
        if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current)
        resetTimerRef.current = window.setTimeout(() => {
          setCopied(false)
          resetTimerRef.current = undefined
        }, 1800)
      })
      .catch((error) => toast.error(getErrorMessage(error)))
  }

  return (
    <div className='my-3 overflow-hidden rounded-lg border border-border/70 bg-muted/20 shadow-sm'>
      <div className='flex items-center justify-between gap-2 border-b border-border/60 bg-muted/45 px-3 py-1.5'>
        <span className='min-w-0 truncate font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase'>
          {language}
        </span>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='h-7 shrink-0 gap-1.5 px-2 text-xs'
          onClick={handleCopy}
          disabled={!code}
          aria-label={`复制${language}代码`}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <pre className={className}>{codeElement ?? children}</pre>
    </div>
  )
}

function formatCodeLanguage(language?: string) {
  if (!language) return '代码'
  const normalized = language.toLowerCase()
  if (normalized === 'sh' || normalized === 'shell' || normalized === 'zsh') {
    return 'bash'
  }
  if (normalized === 'md') return 'markdown'
  if (normalized === 'yml') return 'yaml'
  return language
}

function stringifyMarkdownChildren(value: ReactNode): string {
  return Children.toArray(value)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') {
        return String(child)
      }
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return stringifyMarkdownChildren(child.props.children)
      }
      return ''
    })
    .join('')
}

export function SourceCodeView({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  return (
    <pre
      className={cn(
        'm-0 min-w-0 bg-zinc-950 p-4 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-zinc-100',
        className
      )}
    >
      <code className='bg-transparent p-0 text-inherit'>{content}</code>
    </pre>
  )
}

function SourceCopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | undefined>(undefined)
  const canCopy = Boolean(content)

  const handleCopy = () => {
    if (!canCopy) return
    void copyText(content)
      .then(() => {
        setCopied(true)
        toast.success('源码已复制')
        if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current)
        resetTimerRef.current = window.setTimeout(() => {
          setCopied(false)
          resetTimerRef.current = undefined
        }, 1800)
      })
      .catch((error) => toast.error(getErrorMessage(error)))
  }

  return (
    <Button
      type='button'
      size='sm'
      variant='secondary'
      className='h-8 gap-1.5 border border-white/10 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white'
      onClick={handleCopy}
      disabled={!canCopy}
      aria-label='复制源码'
    >
      {copied ? <Check /> : <Copy />}
      {copied ? '已复制' : '复制源码'}
    </Button>
  )
}

function openHtmlDocument(htmlDocument: string) {
  const escaped = htmlDocument
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // A blob document inherits this application's origin. Keep generated HTML
  // inside a sandboxed srcdoc iframe so a preview opened in a new tab cannot
  // read the administrator JWT or other browser-origin state.
  const previewShell = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>html,body,iframe{box-sizing:border-box;width:100%;height:100%;',
    'margin:0;border:0}body{overflow:hidden;background:#fff}</style>',
    '</head><body><iframe title="HTML preview" ',
    'sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock" ',
    `srcdoc="${escaped}"></iframe></body></html>`,
  ].join('')
  const url = URL.createObjectURL(
    new Blob([previewShell], { type: 'text/html;charset=utf-8' })
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function FormattedContentRenderer({
  content,
  className,
  emptyText = '尚未填写内容',
}: {
  content: string
  className?: string
  emptyText?: string
}) {
  const previews = useMemo(() => extractHtmlPreviews(content), [content])
  const html = previews[0]
  const htmlDocument = useMemo(
    () => (html ? buildHtmlDocument(html) : ''),
    [html]
  )

  return (
    <div
      className={cn(
        'min-h-72 overflow-hidden rounded-lg border bg-background',
        className
      )}
    >
      {html ? (
        <iframe
          title='HTML preview'
          sandbox='allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock'
          srcDoc={htmlDocument}
          className='size-full border-0 bg-white'
        />
      ) : content.trim() ? (
        <div className='size-full overflow-auto overscroll-contain p-5'>
          <MarkdownView content={content} />
        </div>
      ) : (
        <div className='flex size-full items-center justify-center p-6 text-sm text-muted-foreground'>
          {emptyText}
        </div>
      )}
    </div>
  )
}

type FormattedContentPreviewButtonProps = {
  content: string
  expectedImageUrl?: string
  label?: string
  title?: string
  iconOnly?: boolean
  showWhenEmpty?: boolean
  className?: string
  variant?: ComponentProps<typeof Button>['variant']
}

export function FormattedContentPreviewButton({
  content,
  expectedImageUrl,
  label = '预览内容',
  title = '内容预览',
  iconOnly = false,
  showWhenEmpty = false,
  className,
  variant = 'outline',
}: FormattedContentPreviewButtonProps) {
  const [open, setOpen] = useState(false)
  const hasContent = Boolean(content.trim())
  if (!hasContent && !showWhenEmpty) return null

  const trigger = (
    <Button
      type='button'
      size={iconOnly ? 'icon' : 'sm'}
      variant={variant}
      className={className}
      onClick={() => setOpen(true)}
      disabled={!hasContent}
      aria-label={label}
    >
      <Eye />
      {!iconOnly && label}
    </Button>
  )

  return (
    <>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      {open && (
        <FormattedContentPreviewDialog
          open
          onOpenChange={setOpen}
          content={content}
          expectedImageUrl={expectedImageUrl}
          title={title}
        />
      )}
    </>
  )
}

export function HtmlPreviewButton({
  content,
  expectedImageUrl,
}: {
  content: string
  expectedImageUrl?: string
}) {
  const previews = useMemo(() => extractHtmlPreviews(content), [content])
  if (!previews.length) return null
  return (
    <FormattedContentPreviewButton
      content={content}
      expectedImageUrl={expectedImageUrl}
      label='预览 HTML'
      title='HTML 预览'
    />
  )
}

export function ContentPreviewCanvas({
  content,
  expectedImageUrl,
  expectedContent,
  compareExpected = false,
  className,
}: {
  content: string
  expectedImageUrl?: string
  expectedContent?: string
  compareExpected?: boolean
  className?: string
}) {
  const previews = useMemo(() => extractHtmlPreviews(content), [content])
  const expectedPreviews = useMemo(
    () => (expectedContent ? extractHtmlPreviews(expectedContent) : []),
    [expectedContent]
  )
  const [index, setIndex] = useState(0)
  const isHtml = previews.length > 0
  const selectedIndex = Math.min(index, Math.max(previews.length - 1, 0))
  const source = isHtml ? (previews[selectedIndex] ?? '') : content
  const htmlDocument = useMemo(
    () => (isHtml ? buildHtmlDocument(source) : ''),
    [isHtml, source]
  )
  const expectedHtml = expectedPreviews[0] || ''
  const expectedDocument = useMemo(
    () => (expectedHtml ? buildHtmlDocument(expectedHtml) : ''),
    [expectedHtml]
  )
  const showExpected =
    compareExpected &&
    (Boolean(expectedImageUrl) ||
      Boolean(expectedDocument) ||
      Boolean(expectedContent?.trim()))

  return (
    <Tabs
      defaultValue='preview'
      className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden', className)}
    >
      <div className='flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2'>
        <TabsList>
          <TabsTrigger value='preview'>
            <Eye className='size-4' />
            {isHtml ? '预览' : '渲染'}
          </TabsTrigger>
          <TabsTrigger value='source'>
            <Code2 className='size-4' />
            源码
          </TabsTrigger>
        </TabsList>
        {previews.length > 1 && (
          <div className='flex gap-1'>
            {previews.map((_, item) => (
              <Button
                key={item}
                type='button'
                size='sm'
                variant={item === selectedIndex ? 'default' : 'outline'}
                onClick={() => setIndex(item)}
              >
                HTML {item + 1}
              </Button>
            ))}
          </div>
        )}
        {isHtml && (
          <Button
            className='ms-auto'
            type='button'
            size='sm'
            variant='outline'
            onClick={() => openHtmlDocument(htmlDocument)}
          >
            <ExternalLink />
            新窗口
          </Button>
        )}
      </div>
      <div
        className={cn(
          'grid min-h-0 min-w-0 flex-1 overflow-hidden',
          showExpected &&
            'grid-rows-[minmax(0,2fr)_minmax(10rem,1fr)] lg:grid-cols-2 lg:grid-rows-1'
        )}
      >
        <div className={cn('relative min-h-0 min-w-0 overflow-hidden', showExpected && 'border-r')}>
          <TabsContent value='preview' className='absolute inset-0 m-0'>
            {isHtml ? (
              <iframe
                title='HTML preview'
                sandbox='allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock'
                srcDoc={htmlDocument}
                className='size-full border-0 bg-white'
              />
            ) : content.trim() ? (
              <div className='size-full overflow-auto overscroll-contain bg-background p-6'>
                <MarkdownView content={content} />
              </div>
            ) : (
              <div className='flex size-full items-center justify-center p-6 text-sm text-muted-foreground'>
                没有可预览的响应
              </div>
            )}
          </TabsContent>
          <TabsContent
            value='source'
            className='absolute inset-0 m-0 overflow-auto bg-zinc-950'
          >
            <div className='sticky top-0 z-10 flex justify-end border-b border-white/10 bg-zinc-950/90 px-3 py-2 backdrop-blur-sm'>
              <SourceCopyButton content={source} />
            </div>
            <SourceCodeView content={source} className='min-h-full' />
          </TabsContent>
        </div>
        {showExpected && (
          <div className='min-h-0 overflow-auto bg-muted/30'>
            {expectedImageUrl ? (
              <div className='p-4'>
                <div className='mb-3 text-sm font-medium'>参考效果图</div>
                <img
                  src={expectedImageUrl}
                  alt='参考效果'
                  className='mx-auto max-h-[calc(100dvh-7rem)] rounded-lg border bg-white object-contain'
                />
              </div>
            ) : expectedDocument ? (
              <iframe
                title='Expected HTML preview'
                sandbox='allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock'
                srcDoc={expectedDocument}
                className='size-full min-h-64 border-0 bg-white'
              />
            ) : (
              <div className='size-full overflow-auto p-4'>
                <div className='mb-3 text-sm font-medium'>预期输出</div>
                <MarkdownView content={expectedContent || ''} />
              </div>
            )}
          </div>
        )}
      </div>
    </Tabs>
  )
}

function FormattedContentPreviewDialog({
  open,
  onOpenChange,
  content,
  expectedImageUrl,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  content: string
  expectedImageUrl?: string
  title: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className='top-0 left-0 h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-none sm:max-w-none sm:p-0'
      >
        <div className='flex h-full min-h-0 flex-col'>
          <div className='flex shrink-0 items-center gap-3 border-b px-4 py-3'>
            <div className='min-w-0 flex-1 font-medium'>{title}</div>
            <Button
              type='button'
              size='icon'
              variant='ghost'
              onClick={() => onOpenChange(false)}
              aria-label='关闭预览'
            >
              <X />
            </Button>
          </div>
          <ContentPreviewCanvas
            content={content}
            expectedImageUrl={expectedImageUrl}
            compareExpected={Boolean(expectedImageUrl)}
            className='min-h-0 flex-1'
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
