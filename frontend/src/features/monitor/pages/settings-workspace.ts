import { createContext, useContext } from 'react'
import type {
  EditableRuntimeSettings,
  ProbeProfile,
  SecretSettingName,
  WechatTestScenario,
} from '@/lib/api'
import type {
  SettingsForm,
  SettingsSetter,
} from '@/features/monitor/components/settings-model'

export type SettingsWorkspaceValue = {
  form: SettingsForm
  settings: EditableRuntimeSettings
  clearSecrets: SecretSettingName[]
  set: SettingsSetter
  toggleSecretClear: (name: SecretSettingName) => void
  profiles: ProbeProfile[]
  profilesLoading: boolean
  registerTokenReady: boolean
  webhookUrl: string
  busy: boolean
  wechatTestPending: boolean
  testWechat: (scenario: WechatTestScenario) => void
  restoreRecommendedRiskScoring: () => void
}

export const SettingsWorkspaceContext =
  createContext<SettingsWorkspaceValue | null>(null)

export function useSettingsWorkspace() {
  const value = useContext(SettingsWorkspaceContext)
  if (!value) throw new Error('设置子页面必须位于 SettingsLayout 内')
  return value
}
