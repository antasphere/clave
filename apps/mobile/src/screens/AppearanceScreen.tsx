/**
 * Appearance: the four themes of the desktop's Appearance page, plus the
 * phone's own "match the system", one row each with the chosen one ticked.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { Icon } from '../ui/Icon'
import { PaneHeader } from '../ui/PaneHeader'
import { useAppearance } from '../ui/appearance-context'
import { Card, Row, Screen, SectionTitle } from '../ui/components'
import { APPEARANCES, THEME_LABELS, chatGlyph, space, useTheme } from '../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Appearance'>

export function AppearanceScreen({ navigation }: Props): ReactNode {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { appearance, setAppearance } = useAppearance()
  return (
    <Screen>
      <PaneHeader title="Appearance" meta="Theme" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={{ paddingTop: space(4), paddingBottom: insets.bottom + space(6) }}
      >
        <SectionTitle
          title="Theme"
          description="The desktop's four themes. Matching the system picks dark or light with the phone."
        />
        <Card>
          {APPEARANCES.map((option) => (
            <Row
              key={option}
              title={THEME_LABELS[option]}
              onPress={() => setAppearance(option)}
              testID={`appearance-${option}`}
              accessibilityLabel={`${THEME_LABELS[option]}${appearance === option ? ', selected' : ''}`}
              controls={
                appearance === option ? (
                  <Icon name="check" size={chatGlyph} color={t.colors.accent} />
                ) : (
                  <View style={{ width: chatGlyph }} />
                )
              }
            />
          ))}
        </Card>
      </ScrollView>
    </Screen>
  )
}
