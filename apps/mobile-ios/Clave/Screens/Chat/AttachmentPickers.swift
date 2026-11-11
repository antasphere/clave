import ClaveCore
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// The three ways a file reaches the composer: the photo library, the camera, the Files app. Each
// copies the bytes into the app's own temporary folder and hands over a `PickedFile` whose uri
// points there, so the send reads them later without any picker's permission still open.

enum PickedFiles {
  /// The folder picked files are copied into for the time of a draft.
  static var folder: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("clave-attachments", isDirectory: true)
  }

  /// Keeps the bytes under the name and describes them for the attachment policy.
  static func keep(_ data: Data, name: String) throws -> PickedFile {
    let directory = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent(sanitized(name), isDirectory: false)
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    let mimeType = mimeTypeOf(name)
    return PickedFile(uri: url.absoluteString, name: name, mimeType: mimeType, size: data.count, kind: kindOf(mimeType))
  }

  /// A file the Files app handed over. One larger than the server takes is described but not
  /// copied: the policy refuses it by its size and nothing is read.
  static func importFile(_ url: URL) throws -> PickedFile {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let name = url.lastPathComponent
    let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize
    if let size, size > maxTransferBytes {
      let mimeType = mimeTypeOf(name)
      return PickedFile(uri: url.absoluteString, name: name, mimeType: mimeType, size: size, kind: kindOf(mimeType))
    }
    return try keep(try Data(contentsOf: url), name: name)
  }

  /// A photo from the library: a format a provider takes travels as is, any other picture
  /// (HEIC above all) is re-encoded as JPEG so it can still go as a picture.
  static func importPhoto(_ item: PhotosPickerItem, index: Int) async throws -> PickedFile? {
    guard let data = try await item.loadTransferable(type: Data.self) else { return nil }
    let type = item.supportedContentTypes.first
    let stem = "Photo \(index + 1)"
    if let type, type.conforms(to: .movie) {
      return try keep(data, name: "\(stem).\(type.preferredFilenameExtension ?? "mov")")
    }
    if let type, let ext = type.preferredFilenameExtension, imageMimeTypes.contains(mimeTypeOf("x.\(ext)")) {
      return try keep(data, name: "\(stem).\(ext)")
    }
    if let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) {
      return try keep(jpeg, name: "\(stem).jpg")
    }
    return try keep(data, name: "\(stem).\(type?.preferredFilenameExtension ?? "bin")")
  }

  /// A photo the camera took, as JPEG.
  static func importCamera(_ image: UIImage) throws -> PickedFile? {
    guard let jpeg = image.jpegData(compressionQuality: 0.9) else { return nil }
    return try keep(jpeg, name: "Camera photo.jpg")
  }

  private static func sanitized(_ name: String) -> String {
    let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
    return cleaned.isEmpty ? "file" : cleaned
  }
}

/// The system camera, wrapped for SwiftUI. Shown only where a camera exists.
struct CameraPicker: UIViewControllerRepresentable {
  let onPick: (UIImage?) -> Void

  static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let onPick: (UIImage?) -> Void

    init(onPick: @escaping (UIImage?) -> Void) {
      self.onPick = onPick
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      onPick(info[.originalImage] as? UIImage)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
      onPick(nil)
    }
  }
}
