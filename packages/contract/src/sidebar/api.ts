/**
 * The sidebar domain as one group of the HTTP API (`../api.ts` adds it to
 * `ClaveApi`): commands as POST endpoints, queries as GET endpoints, through
 * the framework's CQRS bridge. The paths name the window's layout and the
 * groups in it; every definition is the one `layout.ts` exports.
 */
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import {
  AbsorbLayout,
  AddGroupTerminal,
  CreateGroup,
  DeleteGroup,
  GetWindowLayout,
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
  UpdateGroupTerminal
} from './layout'

export const sidebarGroup = ApiGroup.make('sidebar')
  .add(HttpCqrs.queryEndpoint('getLayout', '/sidebar/layout', GetWindowLayout))
  .add(HttpCqrs.queryEndpoint('listLayouts', '/sidebar/layouts', ListWindowLayouts))
  .add(HttpCqrs.commandEndpoint('saveLayout', '/sidebar/layout', SaveWindowLayout))
  .add(HttpCqrs.commandEndpoint('createGroup', '/sidebar/groups', CreateGroup))
  .add(HttpCqrs.commandEndpoint('renameGroup', '/sidebar/groups/rename', RenameGroup))
  .add(HttpCqrs.commandEndpoint('setGroupView', '/sidebar/groups/view', SetGroupView))
  .add(HttpCqrs.commandEndpoint('setGroupColor', '/sidebar/groups/color', SetGroupColor))
  .add(HttpCqrs.commandEndpoint('setGroupPrompt', '/sidebar/groups/prompt', SetGroupPrompt))
  .add(
    HttpCqrs.commandEndpoint('setGroupCollapsed', '/sidebar/groups/collapsed', SetGroupCollapsed)
  )
  .add(HttpCqrs.commandEndpoint('deleteGroup', '/sidebar/groups/delete', DeleteGroup))
  .add(HttpCqrs.commandEndpoint('addTerminal', '/sidebar/groups/terminals', AddGroupTerminal))
  .add(
    HttpCqrs.commandEndpoint(
      'updateTerminal',
      '/sidebar/groups/terminals/update',
      UpdateGroupTerminal
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'removeTerminal',
      '/sidebar/groups/terminals/remove',
      RemoveGroupTerminal
    )
  )
  .add(HttpCqrs.commandEndpoint('moveItems', '/sidebar/move', MoveItems))
  .add(HttpCqrs.commandEndpoint('placeSession', '/sidebar/place', PlaceSession))
  .add(HttpCqrs.commandEndpoint('removeSession', '/sidebar/remove', RemoveSession))
  .add(HttpCqrs.commandEndpoint('absorbLayout', '/sidebar/absorb', AbsorbLayout))
  .add(
    HttpCqrs.commandEndpoint('moveSessions', '/sidebar/windows/move-sessions', MoveSessionsToWindow)
  )
  .add(HttpCqrs.commandEndpoint('moveGroup', '/sidebar/windows/move-group', MoveGroupToWindow))
