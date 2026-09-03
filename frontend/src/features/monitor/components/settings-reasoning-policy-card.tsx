import { BrainCircuit, Plus, Trash2 } from 'lucide-react'
import type {
  ReasoningMediaInputMode,
  ReasoningModelPolicy,
  ReasoningPolicyMode,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/numeric-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  SettingList,
  SettingListItem,
  SettingsCard,
} from './settings-components'
import {
  setRiskRuleEnabled,
  type SettingsForm,
  type SettingsSetter,
} from './settings-model'

const operationLabels: Record<ReasoningModelPolicy['operation'], string> = {
  '*': '全部接口',
  chat: 'chat',
  responses: 'responses',
  messages: 'messages',
}

const modeLabels: Record<ReasoningPolicyMode, string> = {
  required: '必须有思考',
  observe: '仅观察',
  optional: '允许为 0',
  unsupported: '忽略指标',
}

const mediaModeLabels: Record<ReasoningMediaInputMode, string> = {
  inherit: '沿用策略',
  observe: '降为观察',
  ignore: '忽略指标',
}

function replacePolicy(
  policies: ReasoningModelPolicy[],
  index: number,
  patch: Partial<ReasoningModelPolicy>
) {
  return policies.map((policy, policyIndex) =>
    policyIndex === index ? { ...policy, ...patch } : policy
  )
}

export function SettingsReasoningPolicyCard({
  form,
  set,
}: {
  form: SettingsForm
  set: SettingsSetter
}) {
  const addPolicy = () => {
    set('reasoningModelPolicies', [
      ...form.reasoningModelPolicies,
      {
        model: 'Build/grok-',
        operation: 'chat',
        mode: 'observe',
        minimumOutputTokens: 32,
        minCount: 2,
        mediaInputMode: 'inherit',
      },
    ])
  }

  return (
    <SettingsCard
      icon={BrainCircuit}
      title='思考输出模型策略'
      description='按实际上游模型和请求类型判断思考 Token 是否应当出现。单次为 0 只形成观察信号，required 策略连续达到次数后才升级高风险。含 Media Input 的请求思考为 0 始终只观察，避免误判隔离或停用。'
      descriptionAsHint
    >
      <div className='space-y-4'>
        <SettingList>
          <SettingListItem
            label='请求审计风险识别'
            description='请求审计的风险总开关；关闭后仍保留采集和历史明细。'
            checked={form.requestAuditRiskEnabled}
            onCheckedChange={(value) => set('requestAuditRiskEnabled', value)}
          />
          <SettingListItem
            label='思考输出为 0'
            description='全局启用本策略表；关闭后探针与请求审计都不使用 reasoningTokens 参与判定。'
            checked={form.reasoningZeroRiskEnabled}
            onCheckedChange={(value) => {
              set('reasoningZeroRiskEnabled', value)
              set(
                'riskRuleOverrides',
                setRiskRuleEnabled(form, 'reasoning_zero', value)
              )
            }}
          />
          <SettingListItem
            label='Media Input 观察规则'
            description='含媒体输入的请求偏高 TPS 和思考为 0 都只观察，不作为隔离或停用依据。'
            checked={form.mediaInputObserveEnabled}
            disabled={!form.requestAuditRiskEnabled}
            onCheckedChange={(value) => {
              set('mediaInputObserveEnabled', value)
              set(
                'riskRuleOverrides',
                setRiskRuleEnabled(form, 'media_input_observe', value)
              )
            }}
          />
        </SettingList>

        <p className='text-xs leading-5 text-muted-foreground'>
          能力匹配优先读取 <code>modelUpstreamModel</code>；动态的{' '}
          <code>gam-probe-*</code> 不会被当作稳定能力模型。审计中的{' '}
          <code>Build/grok-*</code> 与探针方案中的 <code>grok-*</code>{' '}
          会归一到同一策略；未知组合由 <code>* / *</code> 兜底为观察。
        </p>

        <div className='overflow-x-auto rounded-xl border'>
          <table className='w-full min-w-[980px] text-sm'>
            <thead className='border-b bg-muted/35 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'>
              <tr>
                <th className='px-3 py-2.5'>上游模型 / 稳定别名</th>
                <th className='px-3 py-2.5'>请求类型</th>
                <th className='px-3 py-2.5'>思考能力</th>
                <th className='px-3 py-2.5'>最低输出</th>
                <th className='px-3 py-2.5'>连续命中</th>
                <th className='px-3 py-2.5'>Media Input</th>
                <th className='w-14 px-3 py-2.5 text-right'>操作</th>
              </tr>
            </thead>
            <tbody>
              {form.reasoningModelPolicies.map((policy, index) => {
                const fallback =
                  policy.model.trim() === '*' && policy.operation === '*'
                return (
                  <tr
                    key={index}
                    className='border-b last:border-b-0'
                  >
                    <td className='px-3 py-2.5'>
                      <Input
                        value={policy.model}
                        className='h-9 min-w-56 font-mono text-xs'
                        aria-label={`策略 ${index + 1} 上游模型`}
                        onChange={(event) =>
                          set(
                            'reasoningModelPolicies',
                            replacePolicy(form.reasoningModelPolicies, index, {
                              model: event.target.value,
                            })
                          )
                        }
                      />
                    </td>
                    <td className='px-3 py-2.5'>
                      <Select
                        value={policy.operation}
                        onValueChange={(value) =>
                          set(
                            'reasoningModelPolicies',
                            replacePolicy(form.reasoningModelPolicies, index, {
                              operation:
                                value as ReasoningModelPolicy['operation'],
                            })
                          )
                        }
                      >
                        <SelectTrigger className='h-9 w-36'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(operationLabels).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className='px-3 py-2.5'>
                      <Select
                        value={policy.mode}
                        onValueChange={(value) =>
                          set(
                            'reasoningModelPolicies',
                            replacePolicy(form.reasoningModelPolicies, index, {
                              mode: value as ReasoningPolicyMode,
                            })
                          )
                        }
                      >
                        <SelectTrigger className='h-9 w-36'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(modeLabels).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className='px-3 py-2.5'>
                      <NumericInput
                        min={1}
                        max={4096}
                        value={policy.minimumOutputTokens}
                        className='h-9 w-24 font-mono'
                        aria-label={`策略 ${index + 1} 最低输出 Token`}
                        onChange={(next) =>
                          set(
                            'reasoningModelPolicies',
                            replacePolicy(form.reasoningModelPolicies, index, {
                              minimumOutputTokens: next,
                            })
                          )
                        }
                      />
                    </td>
                    <td className='px-3 py-2.5'>
                      <NumericInput
                        min={2}
                        max={100}
                        value={policy.minCount}
                        className='h-9 w-20 font-mono'
                        aria-label={`策略 ${index + 1} 连续命中次数`}
                        onChange={(next) =>
                          set(
                            'reasoningModelPolicies',
                            replacePolicy(form.reasoningModelPolicies, index, {
                              minCount: next,
                            })
                          )
                        }
                      />
                    </td>
                    <td className='px-3 py-2.5'>
                      <Select
                        value={policy.mediaInputMode}
                        onValueChange={(value) =>
                          set(
                            'reasoningModelPolicies',
                            replacePolicy(form.reasoningModelPolicies, index, {
                              mediaInputMode: value as ReasoningMediaInputMode,
                            })
                          )
                        }
                      >
                        <SelectTrigger className='h-9 w-36'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(mediaModeLabels).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className='px-3 py-2.5 text-right'>
                      <Button
                        type='button'
                        size='icon'
                        variant='ghost'
                        disabled={fallback}
                        aria-label={
                          fallback
                            ? '默认兜底策略必须保留'
                            : `删除策略 ${policy.model}`
                        }
                        title={fallback ? '默认兜底策略必须保留' : '删除策略'}
                        onClick={() =>
                          set(
                            'reasoningModelPolicies',
                            form.reasoningModelPolicies.filter(
                              (_, policyIndex) => policyIndex !== index
                            )
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
          <p className='text-xs text-muted-foreground'>
            required：单次只观察，达到连续次数才升级；observe：始终只观察；optional / unsupported：不据此加风险。
          </p>
          <Button type='button' variant='outline' onClick={addPolicy}>
            <Plus />
            新增模型策略
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}
