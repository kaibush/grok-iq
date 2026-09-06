import { SettingsBootstrapTab } from '@/features/monitor/components/settings-bootstrap-tab'
import { SettingsConnectionTab } from '@/features/monitor/components/settings-connection-tab'
import { SettingsExecutionTab } from '@/features/monitor/components/settings-execution-tab'
import { SettingsIntegrationTab } from '@/features/monitor/components/settings-integration-tab'
import { SettingsNotificationsTab } from '@/features/monitor/components/settings-notifications-tab'
import { SettingsRequestAuditTab } from '@/features/monitor/components/settings-request-audit-tab'
import { SettingsRiskTab } from '@/features/monitor/components/settings-risk-tab'
import { SettingsVersionTab } from '@/features/monitor/components/settings-version-tab'
import { SettingsRouteContent } from './settings'
import { useSettingsWorkspace } from './settings-workspace'

export function SettingsConnectionPage() {
  const workspace = useSettingsWorkspace()
  return (
    <SettingsRouteContent>
      <SettingsConnectionTab
        form={workspace.form}
        settings={workspace.settings}
        clearSecrets={workspace.clearSecrets}
        set={workspace.set}
        toggleSecretClear={workspace.toggleSecretClear}
      />
    </SettingsRouteContent>
  )
}

export function SettingsExecutionPage() {
  const { form, set } = useSettingsWorkspace()
  return (
    <SettingsRouteContent>
      <SettingsExecutionTab form={form} set={set} />
    </SettingsRouteContent>
  )
}

export function SettingsRequestAuditPage() {
  const { form, set } = useSettingsWorkspace()
  return (
    <SettingsRouteContent>
      <SettingsRequestAuditTab form={form} set={set} />
    </SettingsRouteContent>
  )
}

export function SettingsRiskPage() {
  const { form, set, restoreRecommendedRiskScoring, settings } =
    useSettingsWorkspace()
  return (
    <SettingsRouteContent>
      <SettingsRiskTab
        form={form}
        set={set}
        restoreRecommendedRiskScoring={restoreRecommendedRiskScoring}
        tpsFuseSync={settings.tpsFuseSync}
      />
    </SettingsRouteContent>
  )
}

export function SettingsNotificationsPage() {
  const workspace = useSettingsWorkspace()
  return (
    <SettingsRouteContent>
      <SettingsNotificationsTab
        form={workspace.form}
        settings={workspace.settings}
        clearSecrets={workspace.clearSecrets}
        busy={workspace.busy}
        testPending={workspace.wechatTestPending}
        set={workspace.set}
        toggleSecretClear={workspace.toggleSecretClear}
        onTest={workspace.testWechat}
      />
    </SettingsRouteContent>
  )
}

export function SettingsIntegrationsPage() {
  const workspace = useSettingsWorkspace()
  return (
    <SettingsRouteContent>
      <SettingsIntegrationTab
        form={workspace.form}
        settings={workspace.settings}
        clearSecrets={workspace.clearSecrets}
        profiles={workspace.profiles}
        profilesLoading={workspace.profilesLoading}
        registerTokenReady={workspace.registerTokenReady}
        webhookUrl={workspace.webhookUrl}
        set={workspace.set}
        toggleSecretClear={workspace.toggleSecretClear}
      />
    </SettingsRouteContent>
  )
}

export function SettingsBootstrapPage() {
  const { settings } = useSettingsWorkspace()
  return (
    <SettingsRouteContent>
      <SettingsBootstrapTab settings={settings} />
    </SettingsRouteContent>
  )
}

export function SettingsVersionPage() {
  return (
    <SettingsRouteContent>
      <SettingsVersionTab />
    </SettingsRouteContent>
  )
}
