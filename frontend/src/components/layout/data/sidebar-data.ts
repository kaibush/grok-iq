import {
  Activity,
  BookOpenCheck,
  CalendarClock,
  Cpu,
  Gauge,
  LayoutDashboard,
  Network,
  MessageSquareText,
  ScanSearch,
  Settings2,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  TestTube2,
  UsersRound,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: { name: 'GrokIQ', email: 'API-only integration', avatar: '' },
  teams: [{ name: 'GrokIQ', logo: ShieldCheck, plan: '账号质量工作台' }],
  navGroups: [
    {
      title: '运行监控',
      items: [
        { title: '监控概览', url: '/', icon: LayoutDashboard },
        { title: '上游状态', url: '/status', icon: Gauge },
        { title: '账号探针', url: '/accounts', icon: UsersRound },
        { title: '隔离区', url: '/quarantine', icon: ShieldBan },
        { title: '任务中心', url: '/runs', icon: Activity },
        { title: '请求审计', url: '/request-audits', icon: ShieldAlert },
        { title: 'Worker', url: '/workers', icon: Cpu },
      ],
    },
    {
      title: '策略与调度',
      items: [
        { title: '探针方案', url: '/probe-profiles', icon: TestTube2 },
        { title: 'Cron 调度', url: '/plans', icon: CalendarClock },
      ],
    },
    {
      title: '工作台',
      items: [
        { title: '聊天广场', url: '/playground', icon: MessageSquareText },
        { title: 'SSO 检测', url: '/sso-reports', icon: ScanSearch },
      ],
    },
    {
      title: '系统',
      items: [
        { title: '判定说明', url: '/guide', icon: BookOpenCheck },
        { title: '上游节点', url: '/egress-nodes', icon: Network },
        { title: '系统设置', url: '/settings', icon: Settings2 },
      ],
    },
  ],
}
