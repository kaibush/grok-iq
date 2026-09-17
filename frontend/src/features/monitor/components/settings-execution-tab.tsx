import { Wallet, Workflow } from 'lucide-react'
import {
  NumberField,
  SettingsCard,
  SwitchRow,
} from './settings-components'
import type { SettingsForm, SettingsSetter } from './settings-model'

export function SettingsExecutionTab({
  form,
  set,
}: {
  form: SettingsForm
  set: SettingsSetter
}) {
  return (
    <div className='space-y-4'>
      <SettingsCard
        icon={Workflow}
        title='持久任务队列'
        description='短周期 Cron 只创建受容量限制的持久任务，由固定 Worker 拉取；同账号始终串行。'
      >
        <div className='grid gap-4 sm:grid-cols-2'>
          <NumberField
            label='Worker 并发数'
            hint='表示可同时处理的不同账号数；同一账号的任务保持串行'
            value={form.probeWorkerConcurrency}
            min={1}
            max={32}
            onChange={(value) => set('probeWorkerConcurrency', value)}
          />
          <NumberField
            label='全局队列上限'
            hint='批量入队超过剩余容量时整批保持不变'
            value={form.probeQueueLimit}
            min={1}
            max={100000}
            onChange={(value) => set('probeQueueLimit', value)}
          />
          <NumberField
            label='步骤间隔（秒）'
            value={form.probeStepDelaySeconds}
            min={0}
            max={60}
            step={0.1}
            onChange={(value) => set('probeStepDelaySeconds', value)}
          />
          <NumberField
            label='正常定检启动间隔（秒）'
            hint='跨全部 Worker 生效；只限制账号当前出口 Chat，0 表示关闭'
            value={form.probeCurrentEgressIntervalSeconds}
            min={0}
            max={300}
            step={0.5}
            onChange={(value) => set('probeCurrentEgressIntervalSeconds', value)}
          />
          <NumberField
            label='暂时不可调度重试次数'
            hint='仅对冷却、网络和容量类错误重试；不把它们算作降智'
            value={form.probeTransientRetryAttempts}
            min={0}
            max={5}
            onChange={(value) => set('probeTransientRetryAttempts', value)}
          />
          <NumberField
            label='重试基础等待（秒）'
            value={form.probeTransientRetryBaseSeconds}
            min={0.1}
            max={60}
            step={0.1}
            onChange={(value) => set('probeTransientRetryBaseSeconds', value)}
          />
          <NumberField
            label='本地重试最大等待（秒）'
            hint='限制无上游提示时的指数退避；有效 Retry-After 或账号冷却时间优先'
            value={form.probeTransientRetryMaxSeconds}
            min={0.1}
            max={300}
            step={0.1}
            onChange={(value) => set('probeTransientRetryMaxSeconds', value)}
          />
          <NumberField
            label='诊断优先级'
            hint='停用账号短时激活时使用；保持低于普通账号'
            value={form.probeDiagnosticPriority}
            min={-2000000000}
            max={0}
            onChange={(value) => set('probeDiagnosticPriority', value)}
          />
        </div>
        <div className='mt-4 rounded-lg border bg-muted/25 p-3 text-xs leading-5 text-muted-foreground'>
          账号级并发固定为 1。正常定检启动间隔在所有 Worker
          之间共享，用于降低短时间账号扩散；GrokIQ 无法获知 Resin 最终物理
          IP，因此该间隔不等同于每 IP 精确限流。
        </div>
      </SettingsCard>

      <SettingsCard
        icon={Wallet}
        title='付费密钥自动加额'
        description='仅处理仍在有效期内、本地标记付费、且 grok2api 仍存在的有限额密钥；低于阈值时把 billingLimit 增加设定金额。'
      >
        <div className='space-y-4'>
          <SwitchRow
            label='启用自动加额'
            description='后台定时扫描付费密钥剩余额度。关闭后不会注册系统任务，也不再自动增加额度。'
            checked={form.paidKeyAutoTopupEnabled}
            onCheckedChange={(value) => set('paidKeyAutoTopupEnabled', value)}
          />
          <div className='grid gap-4 sm:grid-cols-3'>
            <NumberField
              label='剩余额度低于（%）'
              hint='剩余额度百分比低于该阈值时才会加额，范围 1–100'
              value={form.paidKeyAutoTopupThresholdPercent}
              min={1}
              max={100}
              disabled={!form.paidKeyAutoTopupEnabled}
              onChange={(value) =>
                set('paidKeyAutoTopupThresholdPercent', value)
              }
            />
            <NumberField
              label='每次增加额度（USD）'
              hint='加到 grok2api 的 billingLimit，必须大于 0'
              value={form.paidKeyAutoTopupAmountUsd}
              min={0.01}
              max={100000}
              step={0.01}
              disabled={!form.paidKeyAutoTopupEnabled}
              onChange={(value) => set('paidKeyAutoTopupAmountUsd', value)}
            />
            <NumberField
              label='检查间隔（秒）'
              hint='独立于周期计划开关，范围 15–3600'
              value={form.paidKeyAutoTopupIntervalSeconds}
              min={15}
              max={3600}
              disabled={!form.paidKeyAutoTopupEnabled}
              onChange={(value) =>
                set('paidKeyAutoTopupIntervalSeconds', value)
              }
            />
          </div>
        </div>
      </SettingsCard>
    </div>
  )
}
