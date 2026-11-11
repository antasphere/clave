import SwiftUI

/// A Heroicon (24/outline) or a provider mark from the asset catalog, tinted
/// by the foreground style the way the desktop paints `currentColor`. Hidden
/// from VoiceOver by default because the control around it carries the label.
struct Icon: View {
  let name: IconName
  let size: CGFloat
  private let hidden: Bool

  init(_ name: IconName, size: CGFloat = 16, accessibilityHidden hidden: Bool = true) {
    self.name = name
    self.size = size
    self.hidden = hidden
  }

  var body: some View {
    Image(name.assetName)
      .renderingMode(.template)
      .resizable()
      .scaledToFit()
      .frame(width: size, height: size)
      .accessibilityHidden(hidden)
  }
}
