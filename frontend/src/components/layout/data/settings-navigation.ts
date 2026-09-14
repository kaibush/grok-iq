import {
  Activity,
  Bell,
  BrainCircuit,
  PackageCheck,
  PlugZap,
  ScanSearch,
  ServerCog,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

export type SettingsSection = {
  value:
    | 'connection'
    | 'execution'
    | 'request-audit'
    | 'risk'
    | 'notifications'
    | 'integrations'
    | 'bootstrap'
    | 'version'
  href:
    | '/settings/connection'
    | '/settings/execution'
    | '/settings/request-audit'
    | '/settings/risk'
    | '/settings/notifications'
    | '/settings/integrations'
    | '/settings/bootstrap'
    | '/settings/version'
  title: string
  description: string
  icon: LucideIcon
}

export const settingsSections = [
  {
    value: 'connection',
    href: '/settings/connection',
    title: '连接与凭据',
    description: '上游地址、管理鉴权、HTTP 指纹、SSO 检测代理和状态页登录。',
    icon: PlugZap,
  },
  {
    value: 'execution',
    href: '/settings/execution',
    title: '任务与执行',
    description: 'Worker 并发、队列容量、探针节奏和重试策略。',
    icon: Activity,
  },
  {
    value: 'request-audit',
    href: '/settings/request-audit',
    title: '请求审计',
    description: '审计采集、自适应扫描、页面刷新和本地保留周期。',
    icon: ScanSearch,
  },
  {
    value: 'risk',
    href: '/settings/risk',
    title: '风险与隔离',
    description: '探针判定、请求审计规则，以及隔离区和到期停用。',
    icon: BrainCircuit,
  },
  {
    value: 'notifications',
    href: '/settings/notifications',
    title: '通知推送',
    description: '按通道、账号异常、密钥正常率和上游成功率分别配置微信通知。',
    icon: Bell,
  },
  {
    value: 'integrations',
    href: '/settings/integrations',
    title: '注册联动',
    description: '注册接入、导入探针和首次探针策略。',
    icon: Workflow,
  },
  {
    value: 'bootstrap',
    href: '/settings/bootstrap',
    title: '启动项',
    description: '监听地址、数据库路径和 CORS 等启动级参数。',
    icon: ServerCog,
  },
  {
    value: 'version',
    href: '/settings/version',
    title: '版本更新',
    description: '版本来源、更新检查和部署信息。',
    icon: PackageCheck,
  },
] as const satisfies readonly SettingsSection[]
