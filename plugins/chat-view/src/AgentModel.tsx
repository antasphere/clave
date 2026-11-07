import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { claudeModelName, findClaudeModel } from '../../../src/shared/claude-models'
import type { SubAgent } from './terminal-status'

/** The families a subagent can be relaunched on: the Agent tool takes an
 *  alias, never a version, so each is named by the version it stands for. */
const AGENT_MODELS = (['opus', 'fable', 'sonnet', 'haiku'] as const).map((alias) => ({
  alias,
  name: claudeModelName(alias) ?? alias
}))

/** The model chip in a subagent's window and the menu that relaunches the
 *  agent on another. Only a background agent can be stopped on its own, and only
 *  where the conversation can relaunch it (`onPick`); any other shows its
 *  model, by the provider's own name when it is not a Claude one, and offers
 *  no menu. */
export function AgentModel({
  agent,
  onPick
}: {
  agent: SubAgent
  onPick?: (alias: string) => void
}): React.JSX.Element {
  const name = claudeModelName(agent.model) ?? agent.model
  const label = name ?? '…'
  const title = name ? `Runs on ${name}` : 'Its model is named at its first answer'
  if (!agent.taskId || !onPick)
    return (
      <span className="term-agent-model" title={title}>
        {label}
      </span>
    )
  const current = findClaudeModel(agent.model)?.alias
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="term-agent-model"
          aria-label={`Model of ${agent.description || agent.type}`}
          title={`${title} — relaunch it on another model`}
        >
          {label}
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Relaunch on"
        >
          <DropdownMenu.Label className="menu-label">Relaunch on</DropdownMenu.Label>
          {AGENT_MODELS.map((model) => (
            <DropdownMenu.Item
              key={model.alias}
              className="menu-item chat-model-option"
              data-selected={model.alias === current ? 'true' : undefined}
              disabled={model.alias === current}
              onSelect={() => onPick(model.alias)}
            >
              <span className="chat-model-option-text">
                <span className="truncate">{model.name}</span>
              </span>
              {model.alias === current && <CheckIcon className="select-option-check" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
