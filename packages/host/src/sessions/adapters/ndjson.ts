import { StringDecoder } from 'node:string_decoder'

/** Pipe chunks need not end on a line or UTF-8 code point. */
export class NdjsonLines {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  constructor(private readonly line: (line: string) => void) {}
  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk)
    let end: number
    while ((end = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, end).replace(/\r$/, '')
      this.pending = this.pending.slice(end + 1)
      if (line.trim()) this.line(line)
    }
  }
  end(): void {
    this.pending += this.decoder.end()
    if (this.pending.trim()) this.line(this.pending)
    this.pending = ''
  }
}
