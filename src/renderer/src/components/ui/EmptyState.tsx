import { EmptyState as UIEmptyState } from '@clave/ui/components'
import { NewSessionButton } from '../session/NewSessionButton'

export function EmptyState(): React.JSX.Element {
  return <UIEmptyState action={<NewSessionButton />} />
}
