// Equivalent to definePlugin({...}); the runnable bundle needs no runtime dependency.
export default {
  async activate(api) {
    await api.ui.registerPanel('hello')
    await api.ui.registerCommand('say-hello', async () => {
      await api.notify({
        title: 'Hello from Clave',
        body: 'This command ran in the plugin utility process.'
      })
    })
    await api.log('info', `Hello activated with host API ${api.version}`)
  },
  deactivate() {
    /* No persistent resources in the hello plugin. */
  }
}
