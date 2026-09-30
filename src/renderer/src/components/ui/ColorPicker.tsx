import { ColorPicker as UIColorPicker, type ColorPickerProps } from '@clave/ui/components'
import { GROUP_TERMINAL_COLORS, TERMINAL_COLOR_VALUES } from '../../store/session-store'

export default function ColorPicker(
  props: Omit<ColorPickerProps, 'presets' | 'presetOrder'>
): React.JSX.Element {
  return (
    <UIColorPicker {...props} presets={TERMINAL_COLOR_VALUES} presetOrder={GROUP_TERMINAL_COLORS} />
  )
}
