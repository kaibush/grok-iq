import { createFileRoute } from '@tanstack/react-router'
import { PageVisitsPage } from '@/features/monitor/pages/page-visits'

export const Route = createFileRoute('/_authenticated/page-visits/')({
  component: PageVisitsPage,
})
