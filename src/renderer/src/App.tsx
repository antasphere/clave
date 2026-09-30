import { MotionConfig } from 'framer-motion'
import { AppShell } from './components/layout/AppShell'
import { TooltipProvider } from '@clave/ui/components'

function App(): React.JSX.Element {
  return (
    // reducedMotion="user": when the OS asks for reduced motion, framer skips
    // transform animations and keeps opacity — pairs with the CSS media query
    // guarding the data-state animations in main.css.
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={700} skipDelayDuration={300}>
        <AppShell />
      </TooltipProvider>
    </MotionConfig>
  )
}

export default App
