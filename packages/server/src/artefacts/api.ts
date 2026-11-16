import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import * as A from '@clave/contract/artefacts'

/** PRDCT-4472: the artefacts, under the bearer token like every route. */
export const ArtefactsLive = HttpApiBuilder.group(ClaveApi, 'artefacts', (handlers) =>
  handlers
    .handle('list', HttpCqrs.query(A.ListArtefacts))
    .handle('slidelessState', HttpCqrs.query(A.GetSlidelessState))
    .handle('open', HttpCqrs.command(A.OpenArtefact))
    .handle('close', HttpCqrs.command(A.CloseArtefact))
    .handle('hold', HttpCqrs.command(A.HoldArtefactPreview))
    .handle('release', HttpCqrs.command(A.ReleaseArtefactPreview))
    .handle('saveVersion', HttpCqrs.command(A.SaveArtefactVersion))
    .handle('versions', HttpCqrs.query(A.ListArtefactVersions))
    .handle('installSlideless', HttpCqrs.command(A.InstallSlideless))
)
