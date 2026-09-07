import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BellRing,
  Copy,
  KeyRound,
  Send,
  ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type RequestAuditClientKeyOption,
  type RuntimeSettings,
  type SecretSettingName,
  type WechatTestScenario,
} from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { cn, formatNumber, getErrorMessage } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Field,
  NumberField,
  SecretField,
  SettingsCard,
  SwitchRow,
} from './settings-components'
import {
  WECHAT_KEY_QUALITY_TEMPLATE_BODY,
  WECHAT_TEMPLATE_BODY,
  WECHAT_UPSTREAM_HEALTH_TEMPLATE_BODY,
  toggleWechatAlertKey,
  type SettingsForm,
  type SettingsSetter,
} from './settings-model'

function copyTemplate(label: string, body: string) {
  void copyText(body)
    .then(() => toast.success(`已复制${label}模板内容`))
    .catch((error) => toast.error(getErrorMessage(error)))
}

function clientKeyLabel(item: { id: string; name?: string }) {
  const name = item.name?.trim() || ''
  const id = item.id.trim()
  if (name && id && name !== id) return `${name} · ${id}`
  return name || id
}

export function SettingsNotificationsTab({
  form,
  settings,
  clearSecrets,
  busy,
  testPending,
  set,
  toggleSecretClear,
  onTest,
}: {
  form: SettingsForm
  settings: RuntimeSettings
  clearSecrets: SecretSettingName[]
  busy: boolean
  testPending: boolean
  set: SettingsSetter
  toggleSecretClear: (name: SecretSettingName) => void
  onTest: (scenario: WechatTestScenario) => void
}) {
  const channelOn = form.wechatNotificationEnabled
  const keyQualityOn = channelOn && form.wechatKeyQualityEnabled
  const upstreamOn =
    channelOn &&
    (form.wechatUpstreamHealth15mEnabled || form.wechatUpstreamHealth30mEnabled)

  return (
    <Tabs defaultValue='channel' className='space-y-4'>
      <TabsList className='h-auto w-full justify-start overflow-x-auto rounded-md sm:w-fit'>
        <TabsTrigger value='channel'>
          <BellRing />
          微信通道
        </TabsTrigger>
        <TabsTrigger value='account'>
          <ShieldAlert />
          账号异常
        </TabsTrigger>
        <TabsTrigger value='keyQuality'>
          <KeyRound />
          密钥正常率
        </TabsTrigger>
        <TabsTrigger value='upstream'>
          <Activity />
          上游成功率
        </TabsTrigger>
      </TabsList>

      <TabsContent value='channel' className='mt-0 space-y-4'>
        <ChannelPanel
          form={form}
          settings={settings}
          clearSecrets={clearSecrets}
          set={set}
          toggleSecretClear={toggleSecretClear}
        />
      </TabsContent>

      <TabsContent value='account' className='mt-0 space-y-4'>
        <AccountAlertPanel
          form={form}
          busy={busy}
          testPending={testPending}
          set={set}
          onTest={onTest}
        />
      </TabsContent>

      <TabsContent value='keyQuality' className='mt-0 space-y-4'>
        <KeyQualityPanel
          form={form}
          busy={busy}
          testPending={testPending}
          enabled={keyQualityOn}
          set={set}
          onTest={onTest}
        />
      </TabsContent>

      <TabsContent value='upstream' className='mt-0 space-y-4'>
        <UpstreamHealthPanel
          form={form}
          busy={busy}
          testPending={testPending}
          enabled={upstreamOn}
          set={set}
          onTest={onTest}
        />
      </TabsContent>
    </Tabs>
  )
}

function ChannelPanel({
  form,
  settings,
  clearSecrets,
  set,
  toggleSecretClear,
}: {
  form: SettingsForm
  settings: RuntimeSettings
  clearSecrets: SecretSettingName[]
  set: SettingsSetter
  toggleSecretClear: (name: SecretSettingName) => void
}) {
  return (
    <SettingsCard
      icon={BellRing}
      title='微信通道'
      description='一套凭据给所有场景用。关闭总开关后，账号异常、密钥正常率和上游成功率都不会发，测试按钮也不发。'
    >
      <div className='space-y-5'>
        <SwitchRow
          label='开启微信推送'
          description='账号异常仍按状态升级推送；密钥正常率和上游成功率要在各自选项卡里单独打开。'
          checked={form.wechatNotificationEnabled}
          onCheckedChange={(value) => set('wechatNotificationEnabled', value)}
        />
        <div className='grid gap-4 lg:grid-cols-2'>
          <Field label='测试公众号 AppID' hint='微信测试公众号后台的 appID'>
            <Input
              value={form.wechatAppId}
              onChange={(event) => set('wechatAppId', event.target.value)}
              placeholder='wxxxxxxxxxxxxxxxxxxxxxxxx'
              autoComplete='off'
            />
          </Field>
          <SecretField
            name='wechatAppSecret'
            value={form.wechatAppSecret}
            settings={settings}
            clearing={clearSecrets.includes('wechatAppSecret')}
            onChange={(value) => set('wechatAppSecret', value)}
            onToggleClear={() => toggleSecretClear('wechatAppSecret')}
          />
          <Field label='接收人 OpenID' hint='微信测试公众号用户列表中的 OpenID'>
            <Input
              value={form.wechatOpenid}
              onChange={(event) => set('wechatOpenid', event.target.value)}
              placeholder='oAxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
              autoComplete='off'
            />
          </Field>
        </div>
      </div>
    </SettingsCard>
  )
}

function AccountAlertPanel({
  form,
  busy,
  testPending,
  set,
  onTest,
}: {
  form: SettingsForm
  busy: boolean
  testPending: boolean
  set: SettingsSetter
  onTest: (scenario: WechatTestScenario) => void
}) {
  return (
    <>
      <SettingsCard
        icon={ShieldAlert}
        title='账号异常'
        description='账号首次进入观察、疑似、高风险或隔离，以及风险升级时推送。同一状态不会重复刷屏。'
      >
        <p className='text-sm leading-6 text-muted-foreground'>
          这套规则跟总开关走，没有单独的启用项。先在“微信通道”打开推送，再填模板 ID。
        </p>
      </SettingsCard>
      <TemplateCard
        title='账号异常模板'
        hint='账号进入观察、疑似、高风险或隔离，以及风险升级时填充这些字段。'
        templateId={form.wechatTemplateId}
        onTemplateIdChange={(value) => set('wechatTemplateId', value)}
        body={WECHAT_TEMPLATE_BODY}
        fields='first、account、status、score、tps、reason、time、remark'
        disabled={
          busy || !form.wechatNotificationEnabled || !form.wechatTemplateId.trim()
        }
        testPending={testPending}
        onCopy={() => copyTemplate('账号异常', WECHAT_TEMPLATE_BODY)}
        onTest={() => onTest('account')}
      />
    </>
  )
}

function KeyQualityPanel({
  form,
  busy,
  testPending,
  enabled,
  set,
  onTest,
}: {
  form: SettingsForm
  busy: boolean
  testPending: boolean
  enabled: boolean
  set: SettingsSetter
  onTest: (scenario: WechatTestScenario) => void
}) {
  const [keyQuery, setKeyQuery] = useState('')
  const keysQuery = useQuery({
    queryKey: ['request-audits', 'client-keys', '7d'],
    queryFn: () => api.requestAuditClientKeys({ window: '7d' }),
  })
  const availableKeys = keysQuery.data?.clientKeys ?? []
  const selectedIds = useMemo(
    () => new Set(form.wechatKeyQualityKeys.map((item) => item.id)),
    [form.wechatKeyQualityKeys]
  )
  const visibleKeys = useMemo(() => {
    const needle = keyQuery.trim().toLowerCase()
    const known = new Map<string, RequestAuditClientKeyOption>()
    for (const item of availableKeys) known.set(item.id, item)
    const merged: Array<
      RequestAuditClientKeyOption | { id: string; name: string }
    > = [...availableKeys]
    for (const selected of form.wechatKeyQualityKeys) {
      if (!known.has(selected.id)) merged.push(selected)
    }
    if (!needle) return merged
    return merged.filter((item) => {
      const label = clientKeyLabel(item).toLowerCase()
      return label.includes(needle) || item.id.toLowerCase().includes(needle)
    })
  }, [availableKeys, form.wechatKeyQualityKeys, keyQuery])

  return (
    <>
      <SettingsCard
        icon={KeyRound}
        title='密钥 1 小时正常率'
        description='只对选中的 Key 计算请求审计 1 小时正常率。正常率 = 1 - (观察 + 高风险) / 全部请求。不选 Key 就不会告。'
      >
        <div className='space-y-4'>
          <SwitchRow
            label='开启这套规则'
            description={
              enabled
                ? '总开关和本规则都已打开，跌破阈值后会推送。'
                : '先打开微信通道，再打开本规则。'
            }
            checked={form.wechatKeyQualityEnabled}
            onCheckedChange={(value) => set('wechatKeyQualityEnabled', value)}
          />
          <div className='grid gap-4 sm:grid-cols-3'>
            <NumberField
              label='默认阈值（%）'
              value={form.wechatKeyQualityThreshold}
              min={1}
              max={100}
              step={0.1}
              onChange={(value) => set('wechatKeyQualityThreshold', value)}
              hint='低于该正常率才告警，恢复线为阈值 +5%。'
            />
            <NumberField
              label='最少请求数'
              value={form.wechatKeyQualityMinRequests}
              min={1}
              max={10000}
              onChange={(value) => set('wechatKeyQualityMinRequests', value)}
              hint='窗口内请求不足时不告、也不自动消警。'
            />
            <NumberField
              label='冷却（分钟）'
              value={form.wechatKeyQualityCooldownMinutes}
              min={1}
              max={1440}
              onChange={(value) => set('wechatKeyQualityCooldownMinutes', value)}
              hint='同一 Key 重复告警的最短间隔。'
            />
          </div>
          <Field
            label='监控的 Key'
            hint='列表来自最近 7 天请求审计。保存的是 Key ID；可给单个 Key 覆盖阈值。'
          >
            <Input
              value={keyQuery}
              onChange={(event) => setKeyQuery(event.target.value)}
              placeholder='搜索 Key 名称或 ID'
              autoComplete='off'
            />
            <div className='mt-2 rounded-lg border'>
              {keysQuery.isError ? (
                <div className='p-3 text-xs text-destructive'>
                  密钥列表读取失败：{getErrorMessage(keysQuery.error)}
                </div>
              ) : visibleKeys.length === 0 ? (
                <div className='p-3 text-xs text-muted-foreground'>
                  {keysQuery.isPending
                    ? '正在读取最近 7 天出现过的 Key…'
                    : '最近 7 天没有可选择的 Key。'}
                </div>
              ) : (
                <ScrollArea className='h-56'>
                  <div className='divide-y'>
                    {visibleKeys.map((item) => {
                      const checked = selectedIds.has(item.id)
                      return (
                        <label
                          key={item.id}
                          className='flex cursor-pointer items-start gap-3 px-3 py-2.5'
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() =>
                              set(
                                'wechatKeyQualityKeys',
                                toggleWechatAlertKey(
                                  form.wechatKeyQualityKeys,
                                  item
                                )
                              )
                            }
                            className='mt-0.5'
                          />
                          <span className='min-w-0 flex-1'>
                            <span className='block truncate text-sm'>
                              {clientKeyLabel(item)}
                            </span>
                            {'requestCount' in item &&
                            item.requestCount != null ? (
                              <span className='text-[11px] text-muted-foreground'>
                                7 天请求 {formatNumber(item.requestCount, 0)}
                              </span>
                            ) : (
                              <span className='text-[11px] text-muted-foreground'>
                                已保存，最近 7 天未见请求
                              </span>
                            )}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          </Field>
          {form.wechatKeyQualityKeys.length > 0 ? (
            <div className='space-y-2'>
              <div className='text-xs font-medium text-muted-foreground'>
                已选 {form.wechatKeyQualityKeys.length} 个 Key，可覆盖默认阈值
              </div>
              <div className='space-y-2'>
                {form.wechatKeyQualityKeys.map((item) => (
                  <div
                    key={item.id}
                    className='grid gap-2 rounded-lg border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_8rem]'
                  >
                    <div className='min-w-0'>
                      <div className='truncate text-sm'>
                        {clientKeyLabel(item)}
                      </div>
                      <div className='truncate text-[11px] text-muted-foreground'>
                        {item.id}
                      </div>
                    </div>
                    <NumberField
                      label='阈值 %'
                      value={item.threshold ?? form.wechatKeyQualityThreshold}
                      min={1}
                      max={100}
                      step={0.1}
                      onChange={(value) =>
                        set(
                          'wechatKeyQualityKeys',
                          form.wechatKeyQualityKeys.map((key) =>
                            key.id === item.id
                              ? { ...key, threshold: value }
                              : key
                          )
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsCard>
      <TemplateCard
        title='密钥正常率模板'
        hint='指定 Key 在最近 1 小时正常率跌破阈值时填充这些字段。'
        templateId={form.wechatKeyQualityTemplateId}
        onTemplateIdChange={(value) => set('wechatKeyQualityTemplateId', value)}
        body={WECHAT_KEY_QUALITY_TEMPLATE_BODY}
        fields='first、key、window、rate、threshold、requests、abnormal、time、remark'
        disabled={
          busy ||
          !form.wechatNotificationEnabled ||
          !form.wechatKeyQualityTemplateId.trim()
        }
        testPending={testPending}
        onCopy={() =>
          copyTemplate('密钥正常率', WECHAT_KEY_QUALITY_TEMPLATE_BODY)
        }
        onTest={() => onTest('keyQuality')}
      />
    </>
  )
}

function UpstreamHealthPanel({
  form,
  busy,
  testPending,
  enabled,
  set,
  onTest,
}: {
  form: SettingsForm
  busy: boolean
  testPending: boolean
  enabled: boolean
  set: SettingsSetter
  onTest: (scenario: WechatTestScenario) => void
}) {
  return (
    <>
      <SettingsCard
        icon={Activity}
        title='上游成功率'
        description='使用 /status 同一套口径：成功率 = 2xx 且无 error_code 的请求占比。15 分钟和 30 分钟分开开关。'
      >
        <div className='space-y-4'>
          <p className='text-sm leading-6 text-muted-foreground'>
            {enabled
              ? '总开关已打开，当前至少有一个时间窗口在监控。'
              : '先打开微信通道，再打开 15 分钟或 30 分钟窗口。'}
          </p>
          <SwitchRow
            label='最近 15 分钟'
            description='默认阈值 80%，最少 10 次请求。'
            checked={form.wechatUpstreamHealth15mEnabled}
            onCheckedChange={(value) =>
              set('wechatUpstreamHealth15mEnabled', value)
            }
          />
          <div className='grid gap-4 sm:grid-cols-2'>
            <NumberField
              label='15 分钟阈值（%）'
              value={form.wechatUpstreamHealth15mThreshold}
              min={1}
              max={100}
              step={0.1}
              onChange={(value) =>
                set('wechatUpstreamHealth15mThreshold', value)
              }
            />
            <NumberField
              label='15 分钟最少请求'
              value={form.wechatUpstreamHealth15mMinRequests}
              min={1}
              max={10000}
              onChange={(value) =>
                set('wechatUpstreamHealth15mMinRequests', value)
              }
            />
          </div>
          <SwitchRow
            label='最近 30 分钟'
            description='默认阈值 80%，最少 20 次请求。'
            checked={form.wechatUpstreamHealth30mEnabled}
            onCheckedChange={(value) =>
              set('wechatUpstreamHealth30mEnabled', value)
            }
          />
          <div className='grid gap-4 sm:grid-cols-2'>
            <NumberField
              label='30 分钟阈值（%）'
              value={form.wechatUpstreamHealth30mThreshold}
              min={1}
              max={100}
              step={0.1}
              onChange={(value) =>
                set('wechatUpstreamHealth30mThreshold', value)
              }
            />
            <NumberField
              label='30 分钟最少请求'
              value={form.wechatUpstreamHealth30mMinRequests}
              min={1}
              max={10000}
              onChange={(value) =>
                set('wechatUpstreamHealth30mMinRequests', value)
              }
            />
          </div>
          <NumberField
            label='冷却（分钟）'
            value={form.wechatUpstreamHealthCooldownMinutes}
            min={1}
            max={1440}
            onChange={(value) =>
              set('wechatUpstreamHealthCooldownMinutes', value)
            }
            hint='15 分钟和 30 分钟各自独立冷却。'
          />
        </div>
      </SettingsCard>
      <TemplateCard
        title='上游成功率模板'
        hint='/status 最近 15 / 30 分钟成功率跌破阈值时填充这些字段。'
        templateId={form.wechatUpstreamHealthTemplateId}
        onTemplateIdChange={(value) =>
          set('wechatUpstreamHealthTemplateId', value)
        }
        body={WECHAT_UPSTREAM_HEALTH_TEMPLATE_BODY}
        fields='first、window、rate、threshold、requests、failed、time、remark'
        disabled={
          busy ||
          !form.wechatNotificationEnabled ||
          !form.wechatUpstreamHealthTemplateId.trim()
        }
        testPending={testPending}
        onCopy={() =>
          copyTemplate('上游成功率', WECHAT_UPSTREAM_HEALTH_TEMPLATE_BODY)
        }
        onTest={() => onTest('upstreamHealth')}
      />
    </>
  )
}

function TemplateCard({
  title,
  hint,
  templateId,
  onTemplateIdChange,
  body,
  fields,
  disabled,
  testPending,
  onCopy,
  onTest,
}: {
  title: string
  hint: string
  templateId: string
  onTemplateIdChange: (value: string) => void
  body: string
  fields: string
  disabled: boolean
  testPending: boolean
  onCopy: () => void
  onTest: () => void
}) {
  return (
    <SettingsCard icon={Send} title={title} description={hint}>
      <div className='grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,0.85fr)]'>
        <div>
          <Field label='模板 ID' hint='在测试公众号“模板消息”里新建模板后复制 ID'>
            <Input
              value={templateId}
              onChange={(event) => onTemplateIdChange(event.target.value)}
              placeholder='模板 ID'
              autoComplete='off'
            />
          </Field>
          <pre className='mt-3 overflow-x-auto rounded-lg border bg-background p-3 font-mono text-xs leading-6 whitespace-pre-wrap'>
            {body}
          </pre>
          <div className='mt-3 flex flex-wrap gap-2'>
            <Button type='button' size='sm' variant='outline' onClick={onCopy}>
              <Copy />
              复制
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={disabled}
              onClick={onTest}
            >
              <Send />
              {testPending ? '正在发送…' : '保存并发送测试消息'}
            </Button>
          </div>
        </div>
        <div className='rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-xs leading-5 text-muted-foreground'>
          <div className='font-medium text-foreground'>字段说明</div>
          <p className='mt-1'>{fields} 会由系统自动填充。</p>
          <p className={cn('mt-3', disabled && 'text-muted-foreground')}>
            先开启推送开关并保存，系统才会发送测试消息。
          </p>
        </div>
      </div>
    </SettingsCard>
  )
}
