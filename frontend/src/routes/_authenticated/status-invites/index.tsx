import { createFileRoute } from '@tanstack/react-router'
import { StatusInvitesPage } from '@/features/monitor/pages/status-invites'

export const Route = createFileRoute('/_authenticated/status-invites/')({
  component: StatusInvitesPage,
})
