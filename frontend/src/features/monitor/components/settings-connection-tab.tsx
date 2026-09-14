import {
  BookOpen,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  KeyRound,
  Link2,
  LogIn,
  Network,
  Power,
  ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import type { RuntimeSettings, SecretSettingName } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Boundary,
  Field,
  SecretField,
  SettingList,
  SettingListItem,
  SettingsCard,
} from './settings-components'
import type { SettingsForm, SettingsSetter } from './settings-model'
import { SsoDirectConnectRiskNotice } from './sso-direct-connect-risk'

export function SettingsConnectionTab({
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
  const linuxdoOauthEnabled = form.statusLinuxdoOauthEnabled
  const linuxdoOauthConfigured = settings.linuxdoOauthConfigured
  const linuxdoCallbackUrl = new URL(
    '/api/public/linuxdo/callback',
    window.location.origin
  ).toString()

  return (
    <Tabs defaultValue='upstream' className='space-y-4'>
      <TabsList className='h-auto w-full justify-start overflow-x-auto sm:w-fit'>
        <TabsTrigger value='upstream'>
          <Network />
          上游连接
        </TabsTrigger>
        <TabsTrigger value='status-login'>
          <LogIn />
          状态页登录
        </TabsTrigger>
      </TabsList>

      <TabsContent value='upstream' className='mt-0 space-y-4'>
        <SettingsCard
          icon={Network}
          title='grok2api 连接'
          description='账号和出口始终实时读取上游；本项目仅持有访问上游所需的连接参数。'
        >
          <div className='grid gap-4 lg:grid-cols-2'>
            <Field label='服务地址' hint='包含协议与端口，不需要末尾斜杠'>
              <Input
                value={form.grok2apiBaseUrl}
                onChange={(event) => set('grok2apiBaseUrl', event.target.value)}
                placeholder='http://127.0.0.1:8000'
              />
            </Field>
            <Field label='HTTP 指纹' hint='curl_cffi impersonate 参数'>
              <Input
                value={form.grok2apiHttpImpersonate}
                onChange={(event) =>
                  set('grok2apiHttpImpersonate', event.target.value)
                }
                placeholder='chrome'
              />
            </Field>
            <Field label='管理员用户名'>
              <Input
                value={form.grok2apiAdminUsername}
                onChange={(event) =>
                  set('grok2apiAdminUsername', event.target.value)
                }
                autoComplete='username'
              />
            </Field>
            <SecretField
              name='grok2apiAdminPassword'
              value={form.grok2apiAdminPassword}
              settings={settings}
              clearing={clearSecrets.includes('grok2apiAdminPassword')}
              onChange={(value) => set('grok2apiAdminPassword', value)}
              onToggleClear={() => toggleSecretClear('grok2apiAdminPassword')}
            />
          </div>
        </SettingsCard>

        <SettingsCard
          icon={ShieldAlert}
          title='SSO 检测代理'
          description='用于 SSO 报告、账号检测和请求审计关联检查。支持代理池或单条代理，格式与新建 SSO 检测一致。检测任务仍可单独覆盖；未配置时将直连。'
        >
          <div className='space-y-4'>
            <SecretField
              name='ssoProxy'
              value={form.ssoProxy}
              settings={settings}
              clearing={clearSecrets.includes('ssoProxy')}
              onChange={(value) => set('ssoProxy', value)}
              onToggleClear={() => toggleSecretClear('ssoProxy')}
            />
            {!form.ssoProxy.trim() &&
            (clearSecrets.includes('ssoProxy') ||
              !settings.ssoProxyConfigured) ? (
              <SsoDirectConnectRiskNotice />
            ) : null}
          </div>
        </SettingsCard>

        <Card className='border-dashed bg-muted/20'>
          <CardContent className='grid gap-3 p-4 md:grid-cols-3'>
            <Boundary
              icon={Database}
              title='上游事实数据'
              text='账号、OAuth、额度、出口绑定和启停状态全部保留在 grok2api。'
            />
            <Boundary
              icon={CheckCircle2}
              title='本地监控数据'
              text='仅保存探针方案、任务、指标、完整回复、风险判断和操作记录。'
            />
            <Boundary
              icon={Link2}
              title='API-only 集成'
              text='不复制账号表或出口表，页面每次查询均通过 grok2api 管理 API。'
            />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value='status-login' className='mt-0 space-y-4'>
        <SettingsCard
          icon={LogIn}
          title='状态页 Linux.do 登录'
          description='默认关闭时 /status 仍可公开访问。打开后需先用 Linux.do Connect 登录才能查看看板。'
        >
          <div className='space-y-4'>
            <div className='flex flex-wrap items-center gap-2'>
              <Badge variant={linuxdoOauthEnabled ? 'success' : 'secondary'}>
                <Power />
                {linuxdoOauthEnabled ? '已启用登录' : '状态页公开'}
              </Badge>
              <Badge
                variant={
                  linuxdoOauthConfigured
                    ? 'success'
                    : linuxdoOauthEnabled
                      ? 'warning'
                      : 'secondary'
                }
              >
                <KeyRound />
                {linuxdoOauthConfigured ? '凭据已配置' : '凭据未配置'}
              </Badge>
            </div>

            <div className='grid gap-2 md:grid-cols-2'>
              <a
                href='https://connect.linux.do/'
                target='_blank'
                rel='noopener noreferrer'
                className='group flex min-w-0 items-center gap-3 rounded-xl border bg-muted/15 p-3.5 transition-colors hover:border-primary/30 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                aria-label='在新标签页打开 Linux.do Connect'
              >
                <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background'>
                  <LogIn className='size-4' />
                </div>
                <div className='min-w-0 flex-1'>
                  <div className='text-sm font-medium'>Linux.do Connect</div>
                  <div className='mt-0.5 truncate text-xs text-muted-foreground'>
                    connect.linux.do
                  </div>
                </div>
                <ExternalLink className='size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground' />
              </a>
              <a
                href='https://wiki.linux.do/Community/LinuxDoConnect'
                target='_blank'
                rel='noopener noreferrer'
                className='group flex min-w-0 items-center gap-3 rounded-xl border bg-muted/15 p-3.5 transition-colors hover:border-primary/30 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                aria-label='在新标签页打开 Linux.do Connect 接入文档'
              >
                <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background'>
                  <BookOpen className='size-4' />
                </div>
                <div className='min-w-0 flex-1'>
                  <div className='text-sm font-medium'>查看接入文档</div>
                  <div className='mt-0.5 truncate text-xs text-muted-foreground'>
                    wiki.linux.do/Community/LinuxDoConnect
                  </div>
                </div>
                <ExternalLink className='size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground' />
              </a>
            </div>

            <SettingList>
              <SettingListItem
                label='启用 Linux.do 登录'
                description='/status 默认公开。打开后必须先用 Linux.do Connect 登录才能查看。关闭后立即恢复公开访问。即使尚未填写 Client ID/Secret 也可以打开开关，但登录会失败直到配置完成。'
                checked={form.statusLinuxdoOauthEnabled}
                onCheckedChange={(value) =>
                  set('statusLinuxdoOauthEnabled', value)
                }
              />
            </SettingList>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={KeyRound}
          title='Connect 应用凭据'
          description='Client ID、Secret 和 Redirect URI 需与 Linux.do Connect 应用里的登记完全一致。'
        >
          <div className='space-y-4'>
            <div className='grid gap-4 lg:grid-cols-2'>
              <Field label='Client ID'>
                <Input
                  value={form.linuxdoOauthClientId}
                  autoComplete='off'
                  onChange={(event) =>
                    set('linuxdoOauthClientId', event.target.value)
                  }
                />
              </Field>
              <SecretField
                name='linuxdoOauthClientSecret'
                value={form.linuxdoOauthClientSecret}
                settings={settings}
                clearing={clearSecrets.includes('linuxdoOauthClientSecret')}
                onChange={(value) => set('linuxdoOauthClientSecret', value)}
                onToggleClear={() =>
                  toggleSecretClear('linuxdoOauthClientSecret')
                }
              />
            </div>
            <Field
              label='Redirect URI / 回调地址'
              hint='必须和 Linux.do Connect 应用里登记的 Redirect URI 完全一致。'
            >
              <div className='flex gap-2'>
                <Input
                  value={form.linuxdoOauthRedirectUri}
                  placeholder={linuxdoCallbackUrl}
                  autoComplete='off'
                  onChange={(event) =>
                    set('linuxdoOauthRedirectUri', event.target.value)
                  }
                />
                <Button
                  type='button'
                  variant='outline'
                  className='shrink-0'
                  onClick={() => {
                    const empty = !form.linuxdoOauthRedirectUri.trim()
                    const value = empty
                      ? linuxdoCallbackUrl
                      : form.linuxdoOauthRedirectUri.trim()
                    if (empty) {
                      set('linuxdoOauthRedirectUri', linuxdoCallbackUrl)
                    }
                    void copyText(value)
                      .then(() =>
                        toast.success(
                          empty
                            ? '已填入并复制默认回调地址'
                            : '已复制回调地址'
                        )
                      )
                      .catch((error) => toast.error(getErrorMessage(error)))
                  }}
                >
                  <Copy />
                  {form.linuxdoOauthRedirectUri.trim() ? '复制' : '填入默认'}
                </Button>
              </div>
            </Field>
          </div>
        </SettingsCard>
      </TabsContent>
    </Tabs>
  )
}
