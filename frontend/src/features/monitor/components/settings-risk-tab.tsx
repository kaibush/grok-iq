import type { ReactNode } from 'react'
import {
  Activity,
  BrainCircuit,
  Calculator,
  ListTree,
  Power,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  Timer,
} from 'lucide-react'
import type { AutoIsolationMinStatus } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { InfoTooltip } from '@/components/info-tooltip'
import {
  Field,
  NumberField,
  RiskFactorRow,
  RiskFieldGroup,
  RiskScoreField,
  RiskStatusRule,
  SettingList,
  SettingListItem,
  SettingsCard,
} from './settings-components'
import {
  formatFactorLimit,
  formatNumber,
  formatPercent,
} from './settings-format'
import {
  AUTO_ISOLATION_MIN_STATUS_OPTIONS,
  setRiskRuleEnabled,
  setRiskRulePriority,
  type SettingsForm,
  type SettingsSetter,
} from './settings-model'
import { SettingsReasoningPolicyCard } from './settings-reasoning-policy-card'

export function SettingsRiskTab({
  form,
  set,
  restoreRecommendedRiskScoring,
}: {
  form: SettingsForm
  set: SettingsSetter
  restoreRecommendedRiskScoring: () => void
}) {
  return (
    <Tabs defaultValue='probe' className='space-y-4'>
      <TabsList className='h-auto w-full justify-start overflow-x-auto rounded-md sm:w-fit'>
        <TabsTrigger value='probe'>
          <Activity />
          探针判定
        </TabsTrigger>
        <TabsTrigger value='audit'>
          <ShieldCheck />
          请求审计
        </TabsTrigger>
        <TabsTrigger value='isolation'>
          <ShieldBan />
          隔离处置
        </TabsTrigger>
      </TabsList>

      <TabsContent value='probe' className='mt-0'>
        <SettingsSplitTabs
          defaultValue='samples'
          items={[
            {
              value: 'samples',
              label: '样本规则',
              description: '窗口、TPS 与缓冲',
              icon: Activity,
              content: <ProbeSamplesPanel form={form} set={set} />,
            },
            {
              value: 'status',
              label: '账号状态',
              description: '观察 / 疑似 / 高风险',
              icon: ShieldAlert,
              content: <ProbeStatusPanel form={form} set={set} />,
            },
            {
              value: 'scoring',
              label: '风险评分',
              description: '加分、上限和保底',
              icon: Calculator,
              content: (
                <ProbeScoringPanel
                  form={form}
                  set={set}
                  restoreRecommendedRiskScoring={restoreRecommendedRiskScoring}
                />
              ),
            },
          ]}
        />
      </TabsContent>

      <TabsContent value='audit' className='mt-0'>
        <SettingsSplitTabs
          defaultValue='policy'
          items={[
            {
              value: 'policy',
              label: '思考策略',
              description: '模型与连续次数',
              icon: BrainCircuit,
              content: <SettingsReasoningPolicyCard form={form} set={set} />,
            },
            {
              value: 'rules',
              label: '规则目录',
              description: '执行顺序和开关',
              icon: ListTree,
              content: <AuditRulesPanel form={form} set={set} />,
            },
            {
              value: 'action',
              label: '自动隔离',
              description: '达次数后永久停用',
              icon: Power,
              content: <AuditIsolationPanel form={form} set={set} />,
            },
          ]}
        />
      </TabsContent>

      <TabsContent value='isolation' className='mt-0'>
        <SettingsSplitTabs
          defaultValue='zone'
          items={[
            {
              value: 'zone',
              label: '隔离区',
              description: '按探针判定长期隔离',
              icon: ShieldBan,
              content: <IsolationZonePanel form={form} set={set} />,
            },
            {
              value: 'quarantine',
              label: '到期停用',
              description: '可恢复的暂时停用',
              icon: Timer,
              content: <ProbeQuarantinePanel form={form} set={set} />,
            },
          ]}
        />
      </TabsContent>
    </Tabs>
  )
}

function SettingsSplitTabs({
  defaultValue,
  items,
}: {
  defaultValue: string
  items: Array<{
    value: string
    label: string
    description: string
    icon: typeof Activity
    content: ReactNode
  }>
}) {
  return (
    <Tabs
      defaultValue={defaultValue}
      orientation='vertical'
      className='gap-4 lg:flex-row lg:items-start'
    >
      <TabsList className='h-auto w-full justify-start overflow-x-auto rounded-md bg-muted p-[3px] lg:w-52 lg:flex-col lg:items-stretch'>
        {items.map((item) => {
          const Icon = item.icon
          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              className='h-auto flex-none justify-start gap-2 rounded-sm px-3 py-2 text-left lg:w-full lg:whitespace-normal'
            >
              <Icon className='size-4 shrink-0' />
              <span className='min-w-0'>
                <span className='block'>{item.label}</span>
                <span className='mt-0.5 hidden text-[11px] font-normal text-muted-foreground lg:block'>
                  {item.description}
                </span>
              </span>
            </TabsTrigger>
          )
        })}
      </TabsList>
      {items.map((item) => (
        <TabsContent
          key={item.value}
          value={item.value}
          className='mt-0 min-w-0 flex-1 space-y-4'
        >
          {item.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}

function ProbeSamplesPanel({
  form,
  set,
}: {
  form: SettingsForm
  set: SettingsSetter
}) {
  return (
    <SettingsCard
      icon={Activity}
      title='样本判定规则'
      description='配置探针样本的统计范围、TPS 阈值和缓冲特征。样本判定结果用于账号风险分析。'
    >
      <div className='space-y-5'>
        <RiskFieldGroup
          title='样本范围'
          hint='仅分析指定时间范围内且输出 Token 达到要求的探针样本。'
        >
          <NumberField
            label='分析窗口（小时）'
            hint='账号风险统计最近这段时间内当前固定出口、临时切换出口及上游调度诊断产生的探针样本。默认 168 小时即最近 7 天；更短会更快淡化旧异常，更长会保留更久的历史影响。保存后会立即按新窗口重算全部账号。'
            value={form.analysisWindowHours}
            min={1}
            max={8760}
            onChange={(value) => set('analysisWindowHours', value)}
          />
          <NumberField
            label='最低输出 Token'
            value={form.minimumOutputTokens}
            min={1}
            max={4096}
            onChange={(value) => set('minimumOutputTokens', value)}
          />
        </RiskFieldGroup>

        <p className='rounded-lg bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground'>
          当前统计最近 {form.analysisWindowHours}{' '}
          小时。每次探针完成、删除结果或保存风险设置时，都会按该窗口重算异常占比、连续次数、风险分和账号状态。
        </p>

        <RiskFieldGroup
          title='TPS 阈值'
          hint='达到异常阈值的样本记为异常；达到强异常阈值的样本记为强异常。'
        >
          <NumberField
            label='异常 TPS 下限'
            value={form.degradationTps}
            min={0.1}
            step={0.1}
            onChange={(value) => set('degradationTps', value)}
          />
          <NumberField
            label='强异常 TPS 下限'
            value={form.strongDegradationTps}
            min={0.1}
            step={0.1}
            onChange={(value) => set('strongDegradationTps', value)}
          />
        </RiskFieldGroup>

        <RiskFieldGroup
          title='探针 TPS 重算'
          hint='grok2api 遇到推理 Token 末尾一次性刷出时，会改用总耗时，把 1400+ Token/s 压成 60 左右。命中后按 输出 Token ÷ 生成窗口 重算，才能检出这类账号。两种线索互斥，只能开一种。'
        >
          <div className='sm:col-span-2'>
            <SettingList>
              <SettingListItem
                label='按短生成窗口重算'
                description='有推理 Token、首 Token 达到阈值时，短生成窗口按 输出 Token ÷ 生成窗口 重算。窗口略超过上限，但生成窗口 TPS 已达强异常时同样重算。'
                checked={form.probeTpsOverrideMode === 'generation_window'}
                onCheckedChange={(value) => {
                  set(
                    'probeTpsOverrideMode',
                    value ? 'generation_window' : 'off'
                  )
                  set('probeTpsOverrideEnabled', value)
                }}
              >
                {form.probeTpsOverrideMode === 'generation_window' && (
                  <div className='space-y-3'>
                    <div className='grid gap-4 sm:grid-cols-2'>
                      <NumberField
                        label='首 Token 最低延迟（ms）'
                        hint='例如 5000 表示首字至少等待 5 秒。'
                        value={form.probeTpsOverrideMinFirstTokenMs}
                        min={0}
                        max={600000}
                        onChange={(value) =>
                          set('probeTpsOverrideMinFirstTokenMs', value)
                        }
                      />
                      <NumberField
                        label='最大生成窗口（ms）'
                        hint='grok2api 在 1000ms 内会压速。当前 800 会漏掉 877ms；可调到 2000，或靠强异常 TPS 兜底。'
                        value={form.probeTpsOverrideMaxGenerationMs}
                        min={1}
                        max={60000}
                        onChange={(value) =>
                          set('probeTpsOverrideMaxGenerationMs', value)
                        }
                      />
                    </div>
                    <p className='rounded-lg bg-muted/35 px-3 py-2 text-xs leading-5 text-muted-foreground'>
                      判定关系：推理 Token &gt; 0 且首 Token ≥{' '}
                      {form.probeTpsOverrideMinFirstTokenMs}ms，并且生成窗口 ≤{' '}
                      {form.probeTpsOverrideMaxGenerationMs}ms，或生成窗口短于首
                      Token 且生成窗口 TPS ≥ {form.strongDegradationTps}
                      。命中后按 输出 Token ÷ 生成窗口重算；这是为了抵消
                      grok2api 的全程均速，不是把速度压得更低。
                    </p>
                  </div>
                )}
              </SettingListItem>
              <SettingListItem
                label='按缺失思考正文重算'
                checked={form.probeTpsOverrideMode === 'missing_reasoning'}
                onCheckedChange={(value) => {
                  set(
                    'probeTpsOverrideMode',
                    value ? 'missing_reasoning' : 'off'
                  )
                  set('probeTpsOverrideEnabled', value)
                }}
              />
            </SettingList>
          </div>
        </RiskFieldGroup>

        <RiskFieldGroup
          title='缓冲特征'
          hint='用于识别等待较久后集中吐出内容的样本。'
        >
          <NumberField
            label='首 Token 占比'
            value={form.bufferFirstTokenShare}
            min={0.5}
            max={0.99}
            step={0.01}
            suffix='%'
            displayMultiplier={100}
            onChange={(value) => set('bufferFirstTokenShare', value)}
          />
          <NumberField
            label='最短生成窗口（ms）'
            value={form.minGenerationMs}
            min={1}
            max={60000}
            onChange={(value) => set('minGenerationMs', value)}
          />
        </RiskFieldGroup>
      </div>
    </SettingsCard>
  )
}

function ProbeStatusPanel({
  form,
  set,
}: {
  form: SettingsForm
  set: SettingsSetter
}) {
  return (
    <SettingsCard
      icon={ShieldAlert}
      title='账号风险判定'
      description='配置账号进入观察、疑似和高风险的条件。统计风险周期内全部出口策略产生的有效探针样本。'
    >
      <div className='space-y-5'>
        <div className='grid gap-4 sm:grid-cols-3'>
          <NumberField
            label='重复异常次数'
            hint='连续条件和累计条件共用这个最少次数'
            value={form.consecutiveAnomalies}
            min={2}
            max={20}
            onChange={(value) => set('consecutiveAnomalies', value)}
          />
          <NumberField
            label='累计异常占比'
            hint='累计异常达到重复次数后，还要满足该占比'
            value={form.cumulativeAnomalyRate}
            min={0.01}
            max={1}
            step={0.01}
            suffix='%'
            displayMultiplier={100}
            onChange={(value) => set('cumulativeAnomalyRate', value)}
          />
          <NumberField
            label='高风险最少强信号数'
            hint='先满足重复异常，再检查强信号数量'
            value={form.highRiskHardCount}
            min={1}
            max={100}
            onChange={(value) => set('highRiskHardCount', value)}
          />
        </div>

        <div className='overflow-hidden rounded-xl border'>
          <RiskStatusRule
            status='观察'
            description='窗口内出现异常，但还没有满足重复条件'
            tone='warning'
          />
          <RiskStatusRule
            status='疑似'
            description={`连续 ${form.consecutiveAnomalies} 次，或累计至少 ${form.consecutiveAnomalies} 次且占比达到 ${formatPercent(form.cumulativeAnomalyRate)}`}
            tone='danger'
            divided
          />
          <RiskStatusRule
            status='高风险'
            description={`已经进入疑似，并且强信号达到 ${form.highRiskHardCount} 次`}
            tone='danger'
            divided
          />
        </div>
      </div>
    </SettingsCard>
  )
}

function ProbeScoringPanel({
  form,
  set,
  restoreRecommendedRiskScoring,
}: {
  form: SettingsForm
  set: SettingsSetter
  restoreRecommendedRiskScoring: () => void
}) {
  return (
    <SettingsCard
      icon={Calculator}
      title='风险评分规则'
      description='配置各类风险信号每次增加多少分、同类信号最多累计多少分，以及不同账号状态的最低显示分。评分用于排序和展示，不直接改变状态判定。'
    >
      <div className='space-y-5'>
        <div className='flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between'>
          <p className='max-w-3xl text-xs leading-5 text-muted-foreground'>
            <span className='font-medium text-foreground'>每次加分</span>
            是该信号出现一次增加多少分；
            <span className='font-medium text-foreground'>最多计分</span>
            是同类信号的上限。例如强信号每次加{' '}
            {formatNumber(form.riskHardWeight)} 分、最多{' '}
            {formatNumber(form.riskHardCap)} 分，通常需要{' '}
            {formatFactorLimit(form.riskHardWeight, form.riskHardCap)}{' '}
            个强信号才到上限。
          </p>
          <Button
            type='button'
            variant='outline'
            className='shrink-0'
            onClick={restoreRecommendedRiskScoring}
          >
            恢复推荐计分参数
          </Button>
        </div>

        <div className='overflow-hidden rounded-xl border'>
          <div className='hidden grid-cols-[minmax(0,1fr)_9rem_9rem] gap-4 border-b bg-muted/30 px-4 py-2.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase md:grid'>
            <span>计分因子</span>
            <span>加分强度</span>
            <span>最多计分</span>
          </div>
          <RiskFactorRow
            title='异常信号率'
            description='按异常样本占比计分，不按次数累加。例如设置 30 分，异常占比 50% 时本项得 15 分。'
            weight={form.riskAnomalyRateWeight}
            automaticCap
            onWeightChange={(value) => set('riskAnomalyRateWeight', value)}
          />
          <RiskFactorRow
            title='强信号'
            description='buffered_hard、fast_risk、marker_miss，以及达到模型策略连续次数后的 reasoning_zero 会计为强信号；单次思考为 0 仅观察。'
            weight={form.riskHardWeight}
            cap={form.riskHardCap}
            onWeightChange={(value) => set('riskHardWeight', value)}
            onCapChange={(value) => set('riskHardCap', value)}
          />
          <RiskFactorRow
            title='持续高速'
            description='每个 fast_risk 样本的专项额外加分，用于提高持续高速生成信号的优先级。'
            weight={form.riskFastWeight}
            cap={form.riskFastCap}
            onWeightChange={(value) => set('riskFastWeight', value)}
            onCapChange={(value) => set('riskFastCap', value)}
          />
          <RiskFactorRow
            title='标记缺失'
            description='每个 marker_miss 样本的专项额外加分，用于提高预期标记缺失信号的优先级。'
            weight={form.riskMarkerMissWeight}
            cap={form.riskMarkerMissCap}
            onWeightChange={(value) => set('riskMarkerMissWeight', value)}
            onCapChange={(value) => set('riskMarkerMissCap', value)}
          />
          <RiskFactorRow
            title='连续信号'
            description='按分析窗口内最大连续异常次数逐次加分，中间的正常可测样本会中断连续计数。'
            weight={form.riskStreakWeight}
            cap={form.riskStreakCap}
            onWeightChange={(value) => set('riskStreakWeight', value)}
            onCapChange={(value) => set('riskStreakCap', value)}
          />
        </div>

        <div className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='flex items-center gap-1.5 text-sm font-medium'>
              分数边界
              <InfoTooltip
                label='分数边界'
                content='状态保底分按从低到高排列，并且不能超过总分上限。保存后立即热应用，并使用新公式重算已有账号。'
              />
            </div>
            <div className='flex flex-wrap gap-2'>
              <Badge variant='warning'>
                观察 {formatNumber(form.riskWatchFloor)}
              </Badge>
              <Badge variant='destructive'>
                疑似 {formatNumber(form.riskSuspectFloor)}
              </Badge>
              <Badge variant='destructive'>
                高风险 {formatNumber(form.riskHighFloor)}
              </Badge>
              <Badge variant='outline'>
                上限 {formatNumber(form.riskScoreCap)}
              </Badge>
            </div>
          </div>
          <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
            <RiskScoreField
              label='观察保底'
              hint='账号处于观察状态时，即使原始加权分更低，也至少显示该分数。'
              tone='warning'
              value={form.riskWatchFloor}
              onChange={(value) => set('riskWatchFloor', value)}
            />
            <RiskScoreField
              label='疑似保底'
              hint='账号满足重复异常条件后，风险分至少显示该分数。'
              tone='danger'
              value={form.riskSuspectFloor}
              onChange={(value) => set('riskSuspectFloor', value)}
            />
            <RiskScoreField
              label='高风险保底'
              hint='账号满足重复异常和强信号条件后，风险分至少显示该分数。'
              tone='danger'
              value={form.riskHighFloor}
              onChange={(value) => set('riskHighFloor', value)}
            />
            <RiskScoreField
              label='总分上限'
              hint='所有计分因子相加并应用保底分后，最终风险分不会超过该值。'
              tone='default'
              value={form.riskScoreCap}
              min={0.1}
              onChange={(value) => set('riskScoreCap', value)}
            />
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}

function AuditRulesPanel({
  form,
  set,
}: {
  form: SettingsForm
  set: SettingsSetter
}) {
  return (
    <SettingsCard
      icon={ListTree}
      title='风控规则目录'
      description='目录中的数字是执行顺序，不是风险分：数值越小越先判断，单次样本命中主规则后停止向后分类。新增规则在后端注册后会自动出现；关闭规则后按剩余规则重算账号。'
    >
      <div className='space-y-4'>
        <p className='text-xs leading-5 text-muted-foreground'>
          例如 <span className='font-mono text-foreground'>10</span> 会先于{' '}
          <span className='font-mono text-foreground'>100</span>{' '}
          执行；它们只控制规则先后，不会给账号加分。思考连续信号由聚合阶段单独累计，因此不会被 TPS 主分类遮蔽。
        </p>
        <div className='overflow-hidden rounded-xl border'>
          {form.riskRules.length ? (
            [...form.riskRules]
              .sort((left, right) => {
                const leftPriority =
                  form.riskRuleOverrides.find((item) => item.id === left.id)
                    ?.priority ?? left.priority
                const rightPriority =
                  form.riskRuleOverrides.find((item) => item.id === right.id)
                    ?.priority ?? right.priority
                return leftPriority - rightPriority
              })
              .map((rule, index) => {
                const override = form.riskRuleOverrides.find(
                  (item) => item.id === rule.id
                )
                const enabled = override?.enabled ?? rule.enabled
                return (
                  <div
                    key={rule.id}
                    className={cn(
                      'flex items-start justify-between gap-4 px-4 py-3.5',
                      index ? 'border-t' : ''
                    )}
                  >
                    <div className='min-w-0'>
                      <div className='flex flex-wrap items-center gap-2'>
                        <span className='text-sm font-medium'>{rule.label}</span>
                        <Badge variant='outline'>
                          顺序 {override?.priority ?? rule.priority}
                        </Badge>
                        {rule.scopes.map((scope) => (
                          <Badge key={scope} variant='secondary'>
                            {scope === 'probe'
                              ? '探针'
                              : scope === 'audit'
                                ? '审计'
                                : scope}
                          </Badge>
                        ))}
                      </div>
                      <p className='mt-1 text-xs leading-5 text-muted-foreground'>
                        {rule.description}
                        <span className='ml-2 font-mono text-[10px]'>
                          {rule.id}
                        </span>
                      </p>
                    </div>
                    <div className='flex shrink-0 items-center gap-2'>
                      <Input
                        className='h-8 w-20'
                        type='number'
                        min={-100000}
                        max={100000}
                        value={override?.priority ?? rule.priority}
                        disabled={!rule.configurable}
                        aria-label={`${rule.label}优先级`}
                        onChange={(event) =>
                          set(
                            'riskRuleOverrides',
                            setRiskRulePriority(
                              form,
                              rule.id,
                              Number(event.target.value)
                            )
                          )
                        }
                      />
                      <Switch
                        checked={enabled}
                        disabled={!rule.configurable}
                        aria-label={`${rule.label}规则`}
                        onCheckedChange={(value) => {
                          set(
                            'riskRuleOverrides',
                            setRiskRuleEnabled(form, rule.id, value)
                          )
                          if (rule.id === 'reasoning_zero') {
                            set('reasoningZeroRiskEnabled', value)
                          }
                          if (rule.id === 'media_input_observe') {
                            set('mediaInputObserveEnabled', value)
                          }
                        }}
                      />
                    </div>
                  </div>
                )
              })
          ) : (
            <div className='px-4 py-6 text-sm text-muted-foreground'>
              保存或刷新设置后载入规则目录。
            </div>
          )}
        </div>
      </div>
    </SettingsCard>
  )
}

function AuditIsolationPanel({
  form,
  set,
}: {
  form: SettingsForm
  set: SettingsSetter
}) {
  return (
    <SettingsCard
      icon={Power}
      title='请求审计自动隔离'
      description='按当前窗口请求处置。这里的隔离是永久停用 grok2api 账号并移入隔离区，和探针监控判定不是同一套规则。'
    >
      <div className='space-y-4'>
        <div className='overflow-hidden rounded-xl border'>
          <RiskStatusRule
            status='高风险'
            description={`窗口内任意一条 high 就会显示。高速 TPS ≥ ${formatNumber(form.strongDegradationTps)} 直接高风险；无媒体输入时思考连续为 0 达到策略次数后升为高风险。`}
            tone='danger'
          />
          <RiskStatusRule
            status='观察'
            description={`普通 TPS ≥ ${formatNumber(form.degradationTps)}，以及带 Media Input 的偏高 TPS 和思考为 0，只记观察，不单独停用。`}
            tone='warning'
            divided
          />
          <RiskStatusRule
            status='冷却'
            description={`高速 TPS 连续 ${form.requestAuditTpsOnlyMinCount} 次后，先停用账号 ${form.requestAuditTpsCooldownMinutes} 分钟，不进入隔离区；到期自动恢复调度。`}
            tone='warning'
            divided
          />
          <RiskStatusRule
            status='隔离'
            description={`冷却后再连续 ${form.requestAuditTpsOnlyMinCount} 次高速 TPS，且中间没有正常 TPS，才永久停用并移入隔离区。思考为 0 仍按模型策略连续次数直接停用。Media Input 不会因此隔离或停用。`}
            tone='danger'
            divided
          />
        </div>
        <SettingList>
          <SettingListItem
            label='请求审计账号处置'
            description='关闭后仍保存风险证据，但工作台和自动流程都不能冷却或停用账号。'
            checked={form.requestAuditIsolationEnabled}
            onCheckedChange={(value) =>
              set('requestAuditIsolationEnabled', value)
            }
          >
            <div className='grid max-w-xl gap-3 sm:grid-cols-2'>
              <NumberField
                label='高速 TPS 连续次数'
                hint='必须是连续的高速 TPS。中间出现一次可测的正常或观察 TPS 就从 0 重新计。'
                value={form.requestAuditTpsOnlyMinCount}
                min={2}
                max={100}
                suffix='次'
                onChange={(value) => set('requestAuditTpsOnlyMinCount', value)}
              />
              <NumberField
                label='账号冷却时间'
                hint='连续达到次数后先冷却。冷却后再连续同样次数，且没有恢复正常 TPS，才停用并隔离。'
                value={form.requestAuditTpsCooldownMinutes}
                min={1}
                max={1440}
                suffix='分钟'
                onChange={(value) =>
                  set('requestAuditTpsCooldownMinutes', value)
                }
              />
            </div>
          </SettingListItem>
        </SettingList>
      </div>
    </SettingsCard>
  )
}

function IsolationZonePanel({
  form,
  set,
}: {
  form: SettingsForm
  set: SettingsSetter
}) {
  return (
    <SettingsCard
      icon={ShieldBan}
      title='隔离区'
      description='按账号探针的监控判定长期隔离并停用上游，不删除 grok2api 账号。这不是请求审计页面的高风险标签。'
    >
      <SettingList>
        <SettingListItem
          label='自动移入隔离区'
          description='开启后按最低判定等级自动停用上游并移入隔离区；关闭后只能人工移入。默认关闭。'
          checked={form.autoIsolationEnabled}
          onCheckedChange={(value) => set('autoIsolationEnabled', value)}
        >
          {form.autoIsolationEnabled ? (
            <div className='max-w-xs'>
              <Field
                label='最低判定等级'
                hint='达到该等级及更严重的账号都会自动移入隔离区。例如选「疑似降智」时，疑似降智和高风险都会进入。'
              >
                <Select
                  value={form.autoIsolationMinStatus}
                  onValueChange={(value) =>
                    set(
                      'autoIsolationMinStatus',
                      value as AutoIsolationMinStatus
                    )
                  }
                >
                  <SelectTrigger
                    className='h-9 w-full'
                    aria-label='自动移入隔离区最低判定'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTO_ISOLATION_MIN_STATUS_OPTIONS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          ) : null}
        </SettingListItem>
        <SettingListItem
          label='同步 grok2api 降智停用'
          description='开启后定期把 grok2api 因降智二次命中而停用的账号移入隔离区，方便和 GrokIQ 自己隔离的账号区分。不依赖自动移入开关，也不会再次停用上游。'
          checked={form.qualityRetryIsolationEnabled}
          onCheckedChange={(value) =>
            set('qualityRetryIsolationEnabled', value)
          }
        >
          {form.qualityRetryIsolationEnabled ? (
            <div className='max-w-xs'>
              <NumberField
                label='同步间隔'
                hint='15–600 秒。只同步 grok2api 已永久降智停用的账号。'
                value={form.qualityRetryIsolationIntervalSeconds}
                min={15}
                max={600}
                suffix='秒'
                onChange={(value) =>
                  set('qualityRetryIsolationIntervalSeconds', value)
                }
              />
            </div>
          ) : null}
        </SettingListItem>
      </SettingList>
    </SettingsCard>
  )
}

function ProbeQuarantinePanel({
  form,
  set,
}: {
  form: SettingsForm
  set: SettingsSetter
}) {
  return (
    <SettingsCard
      icon={Timer}
      title='探针到期停用'
      description='探针侧进入高风险后暂时停用账号。若同时开启隔离区自动移入，高风险会直接进隔离区，不再走到期恢复。'
    >
      <SettingList>
        <SettingListItem
          label='到期停用高风险账号'
          description={`探针侧重复异常成立且强信号达到 ${form.highRiskHardCount} 次后暂时停用。`}
          checked={form.autoQuarantine}
          onCheckedChange={(value) => set('autoQuarantine', value)}
        />
        <SettingListItem
          label='到期自动恢复'
          description='开启后按停用时长自动启用并降至最低优先级；关闭后保持停用，只能人工恢复。隔离区账号不会走这条恢复。'
          checked={form.autoQuarantineRecoveryEnabled}
          disabled={!form.autoQuarantine}
          onCheckedChange={(value) =>
            set('autoQuarantineRecoveryEnabled', value)
          }
        >
          {form.autoQuarantine ? (
            <div className='max-w-xs'>
              <NumberField
                label='停用时长'
                hint='单位为分钟，仅在开启到期自动恢复时使用。'
                value={form.quarantineMinutes}
                min={1}
                max={10080}
                suffix='分钟'
                disabled={!form.autoQuarantineRecoveryEnabled}
                onChange={(value) => set('quarantineMinutes', value)}
              />
            </div>
          ) : null}
        </SettingListItem>
      </SettingList>
    </SettingsCard>
  )
}
