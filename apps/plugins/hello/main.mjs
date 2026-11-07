// Equivalent to definePlugin({...}); the runnable bundle needs no runtime dependency.
export default {
  async activate(api) {
    await api.ui.registerPanel('hello')
    await api.ui.registerPanel('hello-main')
    await api.ui.registerToolbar('wave')
    await api.ui.registerToolbar('hello-menu')
    // Two ways to the same fact, kept apart on purpose so each one can be seen failing:
    // `pushed` is what the host announced unasked through context.changed, and
    // `focused-session` asks for it. A panel following the user draws the first.
    let pushed = 'nothing pushed'
    api.sessions.onContextChanged((session) => {
      pushed = session ? `${session.folderName} (${session.id})` : 'no focused session'
    })
    await api.ui.registerCommand('say-hello', async () => {
      await api.notify({
        title: 'Hello from Clave',
        body: 'This command ran in the plugin utility process.'
      })
    })
    await api.ui.registerCommand('wave', async () => {
      await api.notify({ title: 'Wave from the toolbar' })
    })
    await api.ui.registerCommand('pushed-context', async () => {
      await api.notify({ title: 'Pushed context', body: pushed })
    })
    await api.ui.registerCommand('focused-session', async () => {
      const session = await api.sessions.focused()
      await api.notify({
        title: 'Focused session',
        body: session ? `${session.folderName} (${session.id})` : 'no focused session'
      })
    })
    await api.log('info', `Hello activated with host API ${api.version}`)
  },
  deactivate() {
    /* No persistent resources in the hello plugin. */
  }
}
