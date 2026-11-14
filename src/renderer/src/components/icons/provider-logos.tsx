// The marks of the providers a connection is stored for (PRDCT-4552), drawn
// as the harness logos in `cli-logos.tsx` are: a 24×24 (or the Pi family's
// 800×800) box, one path in `currentColor`, the size given by the caller's
// class. Custom SVGs on purpose: these are vendor marks, not UI glyphs.
//
// Where each one comes from: the companies' own published marks as collected
// by Simple Icons (simple-icons 16.37.0, CC0-1.0: Moonshot AI, Mistral AI,
// DeepSeek, MiniMax, Alibaba Cloud, OpenRouter, Vercel) and by Lobe Icons
// (@lobehub/icons-static-svg 1.102.0, MIT: Z.ai), redrawn here as inline
// paths. Nothing is fetched at run time. The marks stay their owners'
// trademarks and name the provider only. Ollama and "another provider" get a
// mark of Clave's own, in the block hand of `PiLogo` and `OpenCodeLogo`.

import type { ProviderCompanyId } from '@clave/contract/settings/provider-catalogue'
import { ClaudeLogo, CodexLogo } from './cli-logos'

type Mark = (p: { className?: string }) => React.JSX.Element

function svg24(path: string, label: string): Mark {
  function ProviderMark({ className }: { className?: string }): React.JSX.Element {
    return (
      <svg
        className={className}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
        data-provider-mark={label}
      >
        <path d={path} fill="currentColor" fillRule="evenodd" />
      </svg>
    )
  }
  return ProviderMark
}

export const MoonshotLogo = svg24(
  'm1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866',
  'moonshot'
)

export const ZaiLogo = svg24(
  'M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z',
  'zai'
)

export const MistralLogo = svg24(
  'M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z',
  'mistral'
)

export const DeepSeekLogo = svg24(
  'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45',
  'deepseek'
)

export const MiniMaxLogo = svg24(
  'M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997',
  'minimax'
)

export const AlibabaLogo = svg24(
  'M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z',
  'alibaba'
)

export const OpenRouterLogo = svg24(
  'M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z',
  'openrouter'
)

export const VercelLogo = svg24('m12 1.608 12 20.784H0Z', 'vercel-ai-gateway')

/** Clave's own mark for Ollama: a llama's head in the block hand of `PiLogo`
 *  (two ears, two eyes, the muzzle cut out). */
export function OllamaLogo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 800 800"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      data-provider-mark="ollama"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M235 110H335V270H465V110H565V300H615V690H185V300H235ZM295 400V480H365V400ZM435 400V480H505V400ZM330 560V620H470V560Z"
      />
    </svg>
  )
}

/** Clave's own mark for another provider: a plug, in the same hand. */
export function GenericProviderLogo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 800 800"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      data-provider-mark="generic"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M280 110H370V270H430V110H520V270H600V490L470 620V700H330V620L200 490V270H280Z"
      />
    </svg>
  )
}

/** Every company a connection is made with, by its id on Settings →
 *  Connections: the two subscriptions' companies and the ten providers. */
export type ConnectionCompanyKey = 'anthropic' | 'openai' | ProviderCompanyId

export const PROVIDER_LOGOS: Readonly<Record<ConnectionCompanyKey, Mark>> = {
  anthropic: ClaudeLogo,
  openai: CodexLogo,
  moonshot: MoonshotLogo,
  zai: ZaiLogo,
  mistral: MistralLogo,
  deepseek: DeepSeekLogo,
  minimax: MiniMaxLogo,
  alibaba: AlibabaLogo,
  openrouter: OpenRouterLogo,
  'vercel-ai-gateway': VercelLogo,
  ollama: OllamaLogo,
  generic: GenericProviderLogo
}
