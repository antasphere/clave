/** The provider adapter can report uncertainty without loading Effect at app
 * boot. The server translates this internal error to SessionWriteUnknown on
 * the wire. Keep this entry free of runtime imports. */
export class UnconfirmedSessionWrite extends Error {
  readonly _tag = 'UnconfirmedSessionWrite'

  constructor(
    readonly id: string,
    readonly clientMessageId: string
  ) {
    super('the provider did not confirm whether the message arrived')
    this.name = 'UnconfirmedSessionWrite'
  }
}
