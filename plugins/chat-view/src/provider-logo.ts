import {
  AntigravityLogo,
  ClaudeLogo,
  CodexLogo,
  PiLogo
} from '../../../src/renderer/src/components/icons/cli-logos'

type Logo = (props: { className?: string }) => React.JSX.Element

/** The mark that breathes at the transcript's end while that provider works;
 *  a provider with none gets the views' dot. One table for both views, which
 *  each kept a copy and both forgot Antigravity. No prototype: a provider's
 *  name is an adapter's own string. */
export const PROVIDER_LOGOS: Readonly<Record<string, Logo | undefined>> = Object.assign(
  Object.create(null),
  { claude: ClaudeLogo, codex: CodexLogo, antigravity: AntigravityLogo, pi: PiLogo }
)
