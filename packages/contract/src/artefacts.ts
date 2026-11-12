/**
 * The artefacts domain's API group (PRDCT-4472). The shapes, the commands,
 * the queries and the events are `./artefacts/model.ts`, re-exported here so
 * the server and the client keep one import; the window imports the model
 * alone, which carries no HTTP.
 */
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import {
  CloseArtefact,
  GetSlidelessState,
  HoldArtefactPreview,
  InstallSlideless,
  ListArtefacts,
  OpenArtefact,
  ReleaseArtefactPreview,
  SaveArtefactVersion
} from './artefacts/model'

export * from './artefacts/model'

export const artefactsGroup = ApiGroup.make('artefacts')
  .add(HttpCqrs.queryEndpoint('list', '/artefacts', ListArtefacts))
  .add(HttpCqrs.queryEndpoint('slidelessState', '/artefacts/slideless', GetSlidelessState))
  .add(HttpCqrs.commandEndpoint('open', '/artefacts/open', OpenArtefact))
  .add(HttpCqrs.commandEndpoint('close', '/artefacts/close', CloseArtefact))
  .add(HttpCqrs.commandEndpoint('hold', '/artefacts/hold', HoldArtefactPreview))
  .add(HttpCqrs.commandEndpoint('release', '/artefacts/release', ReleaseArtefactPreview))
  .add(HttpCqrs.commandEndpoint('saveVersion', '/artefacts/save-version', SaveArtefactVersion))
  .add(
    HttpCqrs.commandEndpoint('installSlideless', '/artefacts/slideless/install', InstallSlideless)
  )
