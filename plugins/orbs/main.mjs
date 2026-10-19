export default {
  activate() {
    // The mark pack is native: it mounts in the renderer once the host lists
    // the plugin as enabled (components/plugins/native-marks.tsx).
  },
  deactivate() {
    // Disabling the plugin takes its pack out of Appearance → Agent mark; a
    // choice that named it falls back to the logo until it is enabled again.
  }
}
