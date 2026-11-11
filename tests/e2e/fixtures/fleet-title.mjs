// The Claude of the isolated fleet runs, as the daemons' default launch
// profile runs it. Never calls a provider. Every one-shot helper starts on
// that profile (PRDCT-4326), so this stands for the server's whole Claude:
// a tab title is answered (the fixture's name), and every other helper — a
// commit message, a push summary, a digest — meets a signed-out Claude Code
// (the sentence `fleet-git.spec.mjs` reads in the git panel).
let prompt = ''
process.stdin.on('data', (chunk) => {
  prompt += chunk
})
process.stdin.on('end', () => {
  if (prompt.trimStart().startsWith('Generate a short 2-4 word title')) {
    process.stdout.write('personal fleet fixture\n')
    return
  }
  process.stderr.write('Not logged in · Please run /login\n')
  process.exitCode = 1
})
