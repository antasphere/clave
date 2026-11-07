/**
 * The provider's mark at the end of the transcript (`ProviderMark` on the
 * desktop): the agent at work, breathing while it works, gone the moment it
 * stops. Claude keeps its colour; the others are drawn in ink; an unknown
 * provider is a dot.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import { Icon, type IconName } from '../../ui/Icon'
import { space, useTheme } from '../../ui/theme'

const MARKS: Record<string, IconName> = {
  claude: 'logo-claude',
  codex: 'logo-codex',
  pi: 'logo-pi',
  antigravity: 'logo-antigravity'
}

export function ProviderMark({ provider }: { provider: string }): ReactNode {
  const t = useTheme()
  const [breath] = useState(() => new Animated.Value(0.25))
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        }),
        Animated.timing(breath, {
          toValue: 0.25,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        })
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [breath])
  const mark = MARKS[provider]
  const color = provider === 'claude' ? t.colors.brandClaude : t.colors.textPrimary
  return (
    <Animated.View
      style={[styles.mark, { opacity: breath }]}
      accessibilityRole="progressbar"
      accessibilityLabel={`${provider} is working`}
      testID="provider-mark"
    >
      {mark ? (
        <Icon name={mark} size={16} color={color} />
      ) : (
        <View style={[styles.dot, { backgroundColor: t.colors.textPrimary }]} />
      )}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  mark: {
    alignSelf: 'flex-start',
    width: space(5),
    height: space(5),
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space(1),
    marginLeft: space(1)
  },
  dot: { width: space(2), height: space(2), borderRadius: space(2) }
})
