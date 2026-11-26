/**
 * The implementation's "no", answered as `ArtefactRefused` with its sentence.
 * Defined here, not imported from the server package: the handlers know it
 * by its name, and this module must not load the framework (the routines'
 * refusal does the same). Its own module, so the service and the modules it
 * is built from (the Slideless accounts, the sign-in, the links) share it
 * without importing each other; `service.ts` exports it as before.
 */
export class ArtefactRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtefactRefusal'
  }
}
