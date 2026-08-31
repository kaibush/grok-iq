import { createFileRoute } from '@tanstack/react-router'
import { ClientKeysPage } from '@/features/monitor/pages/client-keys'

export const Route = createFileRoute('/_authenticated/client-keys/')({
  component: ClientKeysPage,
})
