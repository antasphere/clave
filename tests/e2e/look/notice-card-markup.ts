// The notice card's showcase as markup, for `drop-refusal.spec.mjs` to lay
// into the running app (whose stylesheet is the real one): every tone docked,
// and the inline form as the cards to come will use it (a server's ended
// state with Resume, the limit with its Continue actions, an error row).
// Rendered by the component itself, so the look is the component's:
//   npx vite-node --config vitest.config.ts tests/e2e/look/notice-card-markup.ts
// prints one JSON object. The words are invented examples, never real data.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DropDrawing } from '../../../plugins/chat-view/src/DropDrawing'
import { NoticeCard, type NoticeTone } from '../../../plugins/chat-view/src/NoticeCard'

const none = (): void => {}
const docked = (tone: NoticeTone): string =>
  renderToStaticMarkup(
    createElement(NoticeCard, {
      tone,
      placement: 'docked',
      drawing: createElement(DropDrawing, { kind: 'refused' }),
      eyebrow: 'Studio',
      title: `${tone[0].toUpperCase()}${tone.slice(1)} notice, docked above the composer`,
      body: 'One sentence that says what happened. A second one that says the way on.',
      actions: [
        { label: 'Continue on Work', primary: true, onClick: none },
        { label: 'Continue on Codex', onClick: none }
      ],
      onDismiss: none
    })
  )

const inline = [
  renderToStaticMarkup(
    createElement(NoticeCard, {
      tone: 'info',
      placement: 'inline',
      drawing: createElement(DropDrawing, { kind: 'refused' }),
      eyebrow: 'Studio',
      title: 'Session ended on Studio (exit 0)',
      body: 'The server stopped this conversation, on a restart or on its own.',
      actions: [{ label: 'Resume', primary: true, onClick: none }]
    })
  ),
  renderToStaticMarkup(
    createElement(NoticeCard, {
      tone: 'warning',
      placement: 'inline',
      title: 'Work is out on Fable, back in 2d 5h.',
      actions: [
        { label: 'Continue on Personal', primary: true, onClick: none },
        { label: 'Continue on Opus', onClick: none },
        { label: 'Continue on Codex', onClick: none }
      ]
    })
  ),
  renderToStaticMarkup(
    createElement(NoticeCard, {
      tone: 'error',
      placement: 'inline',
      body: 'The command could not start: the working folder is gone.'
    })
  )
].join('')

console.log(
  JSON.stringify({
    docked: { info: docked('info'), warning: docked('warning'), error: docked('error') },
    inline
  })
)
