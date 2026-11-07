export default {
  activate() {
    // The native contribution mounts in the renderer after host activation.
  },
  deactivate() {
    // The host unmounts the view, which releases its session subscription.
  }
}
