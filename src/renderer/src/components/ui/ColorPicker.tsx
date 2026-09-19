import { ColorPicker as UIColorPicker, type ColorPickerProps } from '@clave/ui/components'
import { TERMINAL_COLOR_VALUES } from '../../store/session-store'

export default function ColorPicker(props: Omit<ColorPickerProps, 'presets'>): React.JSX.Element {
  return <UIColorPicker {...props} presets={TERMINAL_COLOR_VALUES} />
}
