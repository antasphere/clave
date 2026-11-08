import * as fs from 'node:fs'

/** Private daemon state must never follow a symlink or accept another user's files. */
export function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('Private server directory must be owned by this user with mode 0700')
  }
}

export function readPrivateFile(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > 2 * 1024 * 1024
    ) {
      throw new Error('Private server file must be owned by this user with mode 0600')
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function createPrivateFile(file: string, content: Buffer | string): void {
  fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' })
}
