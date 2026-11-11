import ClaveCore
import PhotosUI
import SwiftUI
import UIKit

/// The prompt dock at the foot of the chat: what became of the last send, the picked files, the
/// growing field, the attachment menu and the send button.
struct Composer: View {
  @Bindable var model: ConversationModel

  @Environment(\.claveTheme) private var theme
  @FocusState private var focused: Bool
  @State private var showPhotos = false
  @State private var showCamera = false
  @State private var showFiles = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var pickFailure: String?
  @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = Theme.chatGlyph
  @ScaledMetric(relativeTo: .body) private var sendSize: CGFloat = 32
  @ScaledMetric(relativeTo: .body) private var fieldSize: CGFloat = Theme.text.sm

  private var ended: Bool { model.agentState == .ended }

  var body: some View {
    VStack(alignment: .leading, spacing: Theme.space(2)) {
      notices
      dock
    }
    .padding(.horizontal, Theme.gutter)
    .padding(.top, Theme.space(2))
    .padding(.bottom, Theme.space(2))
    .background(theme.colors.surface0)
    .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: maxAttachments, matching: .any(of: [.images, .videos]))
    .onChange(of: photoItems) { _, items in
      guard !items.isEmpty else { return }
      photoItems = []
      Task { await importPhotos(items) }
    }
    .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      importFiles(result)
    }
    .fullScreenCover(isPresented: $showCamera) {
      CameraPicker { image in
        showCamera = false
        guard let image else { return }
        do {
          if let file = try PickedFiles.importCamera(image) { model.attach(file) }
        } catch {
          pickFailure = "The photo could not be kept: \(error.localizedDescription)"
        }
      }
      .ignoresSafeArea()
    }
  }

  // MARK: - Above the field

  @ViewBuilder
  private var notices: some View {
    if let mark = model.deliveryMark, mark.kind == .unknown, !model.sending {
      DeliveryMarkBar(
        reason: mark.reason,
        resend: { Task { await model.resendUnderNewId() } },
        discard: { Task { await model.discardUnknownSend() } })
    }
    if let notice = model.sendNotice {
      ToneLine(notice, tone: .error)
        .accessibilityIdentifier("chat.composer.send-error")
    }
    if let notice = model.deliveryNotice {
      // What became of a send of unknown outcome, in the primary text ink: readable on the
      // composer's ground in every theme, and not a tone (nothing failed).
      Text(notice)
        .font(.geist(Theme.text.xs, relativeTo: .caption))
        .foregroundStyle(theme.colors.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("chat.composer.delivery-notice")
    }
    if let notice = model.actionError {
      ToneLine(notice, tone: .error)
        .accessibilityIdentifier("chat.composer.action-error")
    }
    if let notice = pickFailure ?? model.attachNotice {
      noticeLine(notice, identifier: "chat.composer.attach-notice")
    }
    if model.sending {
      HStack(spacing: Theme.space(2)) {
        ProgressView().controlSize(.small)
        Text("Sending…")
          .font(.geist(Theme.text.xs, relativeTo: .caption))
          .foregroundStyle(theme.colors.textSecondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("chat.composer.sending")
    }
  }

  private func noticeLine(_ text: String, identifier: String) -> some View {
    Text(text)
      .font(.geist(Theme.text.xs, relativeTo: .caption))
      .foregroundStyle(theme.colors.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier(identifier)
  }

  // MARK: - The dock

  private var dock: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radius.xxl, style: .continuous)
    return VStack(alignment: .leading, spacing: Theme.space(2)) {
      if !model.pendingFiles.isEmpty {
        FlowRow(spacing: Theme.space(1.5)) {
          ForEach(Array(model.pendingFiles.enumerated()), id: \.offset) { index, file in
            Button {
              model.removeFile(at: index)
            } label: {
              HStack(spacing: Theme.space(1)) {
                Icon(file.kind == .image ? .photo : .document, size: 12)
                // A word on surface200: textPrimary (textSecondary reads 4.45 there in charcoal).
                Text(file.name).lineLimit(1).foregroundStyle(theme.colors.textPrimary)
                Icon(.xMark, size: 12)
              }
              .font(.geist(Theme.text.xs, relativeTo: .caption))
              .foregroundStyle(theme.colors.textSecondary)
              .padding(.horizontal, Theme.space(2))
              .padding(.vertical, Theme.space(1))
              .background(Capsule().fill(theme.colors.surface200))
              .frame(minHeight: 44)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.sending)
            .accessibilityIdentifier("chat.composer.file.\(index)")
            .accessibilityLabel("Remove \(file.name)")
          }
        }
      }
      HStack(alignment: .bottom, spacing: Theme.space(2)) {
        attachMenu
        // A text view rather than a growing text field: its own frame is the box a finger and
        // VoiceOver reach, from 44 points to eight lines, where it scrolls. The prompt is layered
        // over it while it is empty.
        ZStack(alignment: .topLeading) {
          TextEditor(text: $model.draft)
            .font(.geist(Theme.text.sm, weight: .regular, relativeTo: .body))
            .foregroundStyle(theme.colors.textPrimary)
            .scrollContentBackground(.hidden)
            .focused($focused)
            .disabled(model.sending || ended)
            .accessibilityIdentifier("chat.composer.field")
            .accessibilityLabel("Message")
            .frame(minHeight: 44, maxHeight: growingFieldHeight(lines: 8, size: fieldSize, weight: .regular))
            .fixedSize(horizontal: false, vertical: true)
          if model.draft.isEmpty {
            GrowingFieldPrompt(ended ? "This session has ended" : "Message", size: Theme.text.sm, weight: .regular)
          }
        }
        sendButton
      }
    }
    .padding(.horizontal, Theme.space(2))
    .padding(.vertical, Theme.space(1))
    .background(shape.fill(theme.colors.surfaceRaised))
    .overlay(shape.strokeBorder(theme.colors.borderSubtle, lineWidth: 1))
    .claveShadow(theme.raised)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chat.composer.dock")
  }

  private var attachMenu: some View {
    Menu {
      Button {
        showPhotos = true
      } label: {
        Label("Photos", systemImage: "photo.on.rectangle")
      }
      .accessibilityIdentifier("chat.composer.attach.photos")
      if CameraPicker.isAvailable {
        Button {
          showCamera = true
        } label: {
          Label("Camera", systemImage: "camera")
        }
        .accessibilityIdentifier("chat.composer.attach.camera")
      }
      Button {
        showFiles = true
      } label: {
        Label("Files", systemImage: "folder")
      }
      .accessibilityIdentifier("chat.composer.attach.files")
    } label: {
      // The frame follows the scaled glyph past 44 points, so the dock grows with it.
      Icon(.paperClip, size: glyph)
        .foregroundStyle(theme.colors.textSecondary)
        .frame(width: max(44, glyph), height: max(44, glyph))
        .contentShape(Rectangle())
    }
    .disabled(model.sending || ended || model.pendingFiles.count >= maxAttachments)
    .accessibilityIdentifier("chat.composer.attach")
    .accessibilityLabel("Add files")
  }

  @ViewBuilder
  private var sendButton: some View {
    let enabled = model.canSend && !ended
    if model.sending {
      ProgressView()
        .frame(width: max(44, sendSize), height: max(44, sendSize))
        .accessibilityLabel("Sending")
        .accessibilityIdentifier("chat.composer.progress")
    } else {
      Button {
        Task { await model.send() }
      } label: {
        Icon(.arrowUp, size: glyph)
          .foregroundStyle(enabled ? theme.colors.actionForeground : theme.colors.textTertiary)
          .frame(width: sendSize, height: sendSize)
          .background(Circle().fill(enabled ? theme.colors.action : theme.colors.surface200))
          // The circle grows with the text size; its frame grows with it, so the dock holds it.
          .frame(width: max(44, sendSize), height: max(44, sendSize))
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!enabled)
      .accessibilityIdentifier("chat.composer.send")
      .accessibilityLabel("Send message")
    }
  }

  // MARK: - Picking

  private func importPhotos(_ items: [PhotosPickerItem]) async {
    pickFailure = nil
    var files: [PickedFile] = []
    for (index, item) in items.enumerated() {
      do {
        if let file = try await PickedFiles.importPhoto(item, index: model.pendingFiles.count + index) { files.append(file) }
      } catch {
        pickFailure = "A photo could not be read: \(error.localizedDescription)"
      }
    }
    model.attach(files)
  }

  private func importFiles(_ result: Result<[URL], Error>) {
    pickFailure = nil
    switch result {
    case .success(let urls):
      var files: [PickedFile] = []
      for url in urls {
        do {
          files.append(try PickedFiles.importFile(url))
        } catch {
          pickFailure = "\(url.lastPathComponent) could not be read: \(error.localizedDescription)"
        }
      }
      model.attach(files)
    case .failure(let error):
      pickFailure = error.localizedDescription
    }
  }
}

/// A send whose outcome nobody can tell: the sentence, and the person's two choices.
struct DeliveryMarkBar: View {
  let reason: String
  let resend: () -> Void
  let discard: () -> Void

  @Environment(\.claveTheme) private var theme

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radius.lg, style: .continuous)
    VStack(alignment: .leading, spacing: Theme.space(2)) {
      HStack(alignment: .firstTextBaseline, spacing: Theme.space(2)) {
        Icon(.exclamationTriangle, size: Theme.chatGlyph).foregroundStyle(theme.colors.warning)
        VStack(alignment: .leading, spacing: Theme.space(0.5)) {
          Text("Delivery unknown")
            .font(.geist(Theme.text.sm, weight: .semibold, relativeTo: .body))
            .foregroundStyle(theme.colors.textPrimary)
          Text(reason)
            .font(.geist(Theme.text.xs, relativeTo: .caption))
            .foregroundStyle(theme.colors.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("chat.delivery.reason")
      ViewThatFits(in: .horizontal) {
        HStack(spacing: Theme.space(2)) { buttons }
        VStack(alignment: .leading, spacing: Theme.space(1)) { buttons }
      }
    }
    .padding(Theme.space(3))
    .background(shape.fill(theme.colors.surfaceRaised))
    .overlay(shape.strokeBorder(theme.colors.border, lineWidth: 1))
  }

  @ViewBuilder
  private var buttons: some View {
    Button("Discard", action: discard)
      .buttonStyle(.clave(.secondary, size: .small))
      .accessibilityIdentifier("chat.delivery.discard")
    Button("Send again (may duplicate)", action: resend)
      .buttonStyle(.clave(.primary, size: .small))
      .accessibilityIdentifier("chat.delivery.resend")
      .accessibilityHint("Sends the message under a new id; the agent may receive it twice.")
  }
}
