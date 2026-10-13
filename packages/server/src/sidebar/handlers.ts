/**
 * The sidebar domain on the buses: one handler per command and query of the
 * contract, each a thin call into the `SidebarLayouts` the server was given.
 * The handlers publish nothing themselves. Every change, whoever made it (a
 * command here, or the shell calling the class directly as a window closes),
 * goes through the class's own listeners, and `SidebarEventsLive` is the one
 * listener that turns them into server events, so no change is told twice
 * and none is missed.
 */
import { Effect, Layer, Runtime } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import {
  AbsorbLayout,
  AddGroupTerminal,
  CreateGroup,
  DeleteGroup,
  GetWindowLayout,
  GroupNotFound,
  LayoutConflict,
  ListWindowLayouts,
  MoveGroupToWindow,
  MoveItems,
  MoveSessionsToWindow,
  PlaceSession,
  RemoveGroupTerminal,
  RemoveSession,
  RenameGroup,
  SaveWindowLayout,
  SetGroupCollapsed,
  SetGroupColor,
  SetGroupPrompt,
  SetGroupView,
  TerminalNotFound,
  UpdateGroupTerminal,
  WindowNotFound
} from '@clave/contract/sidebar'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { ServerEvents } from '../events'
import type { Result, SidebarFailure, SidebarLayouts } from './layouts'
import { SidebarLayoutsPort } from './port'

/** The class's plain failure as the contract's error, the shape the bus
 *  and the HTTP bridge recognise as declared. */
type ContractFailure<F extends SidebarFailure> = F extends { _tag: 'LayoutConflict' }
  ? LayoutConflict
  : F extends { _tag: 'GroupNotFound' }
    ? GroupNotFound
    : F extends { _tag: 'TerminalNotFound' }
      ? TerminalNotFound
      : F extends { _tag: 'WindowNotFound' }
        ? WindowNotFound
        : CapabilityUnavailable

function toContract<F extends SidebarFailure>(failure: F): ContractFailure<F>
function toContract(failure: SidebarFailure): SidebarFailureClass {
  switch (failure._tag) {
    case 'LayoutConflict':
      return new LayoutConflict({ windowKey: failure.windowKey, current: failure.current })
    case 'GroupNotFound':
      return new GroupNotFound({ groupId: failure.groupId })
    case 'TerminalNotFound':
      return new TerminalNotFound({ groupId: failure.groupId, terminalId: failure.terminalId })
    case 'WindowNotFound':
      return new WindowNotFound({ windowKey: failure.windowKey })
    case 'CapabilityUnavailable':
      return new CapabilityUnavailable({ capability: failure.capability, message: failure.message })
  }
}
type SidebarFailureClass =
  | LayoutConflict
  | GroupNotFound
  | TerminalNotFound
  | WindowNotFound
  | CapabilityUnavailable

/** A method of the class, its `Result` answered as an effect. */
const run = <T, F extends SidebarFailure>(
  call: (layouts: SidebarLayouts) => Result<T, F>
): Effect.Effect<T, ContractFailure<F>, SidebarLayoutsPort> =>
  Effect.flatMap(SidebarLayoutsPort, (layouts) => {
    const result = call(layouts)
    return result.ok ? Effect.succeed(result.value) : Effect.fail(toContract(result.error))
  })

/** A method that cannot fail. */
const read = <T>(
  call: (layouts: SidebarLayouts) => T
): Effect.Effect<T, never, SidebarLayoutsPort> => Effect.map(SidebarLayoutsPort, call)

export const sidebarHandlers = [
  QueryHandler.make(GetWindowLayout, (p) => read((l) => l.get(p.windowKey))),
  QueryHandler.make(ListWindowLayouts, () => read((l) => l.list())),
  CommandHandler.make(SaveWindowLayout, (p) =>
    run((l) =>
      l.save(p.windowKey, { groups: p.groups, displayOrder: p.displayOrder }, p.baseRevision)
    )
  ),
  CommandHandler.make(CreateGroup, (p) => read((l) => l.createGroup(p.windowKey, p.group))),
  CommandHandler.make(RenameGroup, (p) =>
    run((l) => l.renameGroup(p.windowKey, p.groupId, p.name))
  ),
  CommandHandler.make(SetGroupView, (p) =>
    run((l) => l.setGroupView(p.windowKey, p.groupId, p.view))
  ),
  CommandHandler.make(SetGroupColor, (p) =>
    run((l) => l.setGroupColor(p.windowKey, p.groupId, p.color))
  ),
  CommandHandler.make(SetGroupPrompt, (p) =>
    run((l) => l.setGroupPrompt(p.windowKey, p.groupId, p.prompt))
  ),
  CommandHandler.make(SetGroupCollapsed, (p) =>
    run((l) => l.setGroupCollapsed(p.windowKey, p.groupId, p.collapsed))
  ),
  CommandHandler.make(DeleteGroup, (p) =>
    run((l) => l.deleteGroup(p.windowKey, p.groupId, p.mode))
  ),
  CommandHandler.make(AddGroupTerminal, (p) =>
    run((l) => l.addTerminal(p.windowKey, p.groupId, p.terminal))
  ),
  CommandHandler.make(UpdateGroupTerminal, (p) =>
    run((l) => l.updateTerminal(p.windowKey, p.groupId, p.terminalId, p.patch))
  ),
  CommandHandler.make(RemoveGroupTerminal, (p) =>
    run((l) => l.removeTerminal(p.windowKey, p.groupId, p.terminalId))
  ),
  CommandHandler.make(MoveItems, (p) =>
    read((l) => l.moveItems(p.windowKey, p.itemIds, p.targetId, p.position))
  ),
  CommandHandler.make(PlaceSession, (p) =>
    read((l) => l.placeSession(p.windowKey, p.sessionId, p.groupId))
  ),
  CommandHandler.make(RemoveSession, (p) => read((l) => l.removeSession(p.windowKey, p.sessionId))),
  CommandHandler.make(AbsorbLayout, (p) =>
    read((l) => l.absorb(p.windowKey, { groups: p.groups, displayOrder: p.displayOrder }))
  ),
  CommandHandler.make(MoveSessionsToWindow, (p) =>
    run((l) => l.moveSessionsToWindow(p.sessionIds, p.targetWindowKey, p.focus ?? false))
  ),
  CommandHandler.make(MoveGroupToWindow, (p) =>
    run((l) => l.moveGroupToWindow(p.windowKey, p.groupId, p.targetWindowKey))
  )
] as const

/**
 * Every change of the layouts told to every client. `onChange` is a plain
 * callback, so each event is forked on the runtime the layer was built in;
 * the publish is serialised by `ServerEvents` itself, which keeps the order.
 */
export const SidebarEventsLive: Layer.Layer<never, never, SidebarLayoutsPort | ServerEvents> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const layouts = yield* SidebarLayoutsPort
      const events = yield* ServerEvents
      const runtime = yield* Effect.runtime<never>()
      const unsubscribe = layouts.onChange((event) => {
        Runtime.runFork(runtime)(events.publish(event))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
    })
  )
