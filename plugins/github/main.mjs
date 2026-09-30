// The panel itself is native — compiled into the renderer, see src/ — so this
// process only claims the contribution; the host mounts the component once the
// panel is registered. Reads and writes go through the host's own `github:*`
// IPC, which runs the user's `gh`; nothing here touches the network.
export default {
  async activate(api) {
    await api.ui.registerPanel('pull-request')
  },
  deactivate() {
    // The host unmounts the panel when the plugin stops.
  }
}
