/**
 * The artefacts domain's API group (PRDCT-4472). The shapes, the commands,
 * the queries and the events are `./artefacts/model.ts`, re-exported here so
 * the server and the client keep one import; the window imports the model
 * alone, which carries no HTTP.
 */
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import {
  AddSlidelessSite,
  AnswerSlidelessSignIn,
  CancelSlidelessSignIn,
  CheckSlidelessAccounts,
  CloseArtefact,
  GetArtefactDeck,
  GetSlidelessState,
  HoldArtefactPreview,
  InstallSlideless,
  ListArtefacts,
  ListArtefactVersions,
  ListSlidelessAccounts,
  OpenArtefact,
  PasteSlidelessKey,
  ReleaseArtefactPreview,
  RevokeArtefactLink,
  RunSlidelessFix,
  SaveArtefactVersion,
  SetNewLinksSite,
  ShareArtefact,
  StartSlidelessSignIn
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
  .add(HttpCqrs.queryEndpoint('versions', '/artefacts/versions', ListArtefactVersions))
  .add(
    HttpCqrs.commandEndpoint('installSlideless', '/artefacts/slideless/install', InstallSlideless)
  )
  // ── PRDCT-4266: the Slideless accounts of the server's machine ──
  .add(
    HttpCqrs.queryEndpoint(
      'slidelessAccounts',
      '/artefacts/slideless/accounts',
      ListSlidelessAccounts
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'checkSlidelessAccounts',
      '/artefacts/slideless/accounts/check',
      CheckSlidelessAccounts
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'addSlidelessSite',
      '/artefacts/slideless/accounts/sites',
      AddSlidelessSite
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'setNewLinksSite',
      '/artefacts/slideless/accounts/new-links-site',
      SetNewLinksSite
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'runSlidelessFix',
      '/artefacts/slideless/accounts/fix',
      RunSlidelessFix
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'startSlidelessSignIn',
      '/artefacts/slideless/accounts/sign-in',
      StartSlidelessSignIn
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'answerSlidelessSignIn',
      '/artefacts/slideless/accounts/sign-in/answer',
      AnswerSlidelessSignIn
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'cancelSlidelessSignIn',
      '/artefacts/slideless/accounts/sign-in/cancel',
      CancelSlidelessSignIn
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'pasteSlidelessKey',
      '/artefacts/slideless/accounts/key',
      PasteSlidelessKey
    )
  )
  // ── PRDCT-4266: an artefact's deck and its links ──
  .add(HttpCqrs.queryEndpoint('artefactDeck', '/artefacts/deck', GetArtefactDeck))
  .add(HttpCqrs.commandEndpoint('shareArtefact', '/artefacts/deck/share', ShareArtefact))
  .add(HttpCqrs.commandEndpoint('revokeArtefactLink', '/artefacts/deck/revoke', RevokeArtefactLink))
