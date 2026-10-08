/**
 * The workspace files' port on the server, in lane A's pattern
 * (`../ports.ts`): the `WorkspaceFiles` instance the entry built over its
 * data directory, as a service. `none` is a server with no data directory
 * behind it: the trust store lives in memory for the life of the process,
 * the files themselves are still read from this machine's disk.
 */
import { Context, Layer } from 'effect'
import { WorkspaceFiles, memoryWorkspaceFilesStorage } from './files'

export class WorkspaceFilesPort extends Context.Tag('@clave/server/WorkspaceFiles')<
  WorkspaceFilesPort,
  WorkspaceFiles
>() {
  static layer(instance: WorkspaceFiles): Layer.Layer<WorkspaceFilesPort> {
    return Layer.succeed(WorkspaceFilesPort, instance)
  }
  static get none(): WorkspaceFiles {
    return new WorkspaceFiles(memoryWorkspaceFilesStorage())
  }
}
