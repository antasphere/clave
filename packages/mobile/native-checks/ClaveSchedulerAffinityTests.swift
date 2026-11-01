import ExpoModulesCore
import ExpoModulesJSI
import CryptoKit
import Foundation
import MachO
import Testing
import UserNotifications

// Installed in the SDK's existing Tests target with its real Hermes runtime,
// dedicated TestRuntimeScheduler thread, installed records and prebuilt Core.
// The outer owned deadline must close deadlocks. Swift Testing's timeLimit
// alone cannot stop a synchronous waiter or an unresumed continuation.
@Suite(.serialized, .timeLimit(.minutes(1)))
struct ClaveSchedulerAffinityTests: Sendable {
  private enum CheckFailure: Error, Equatable {
    case offJavaScriptThread
    case expectedNativeError
    case missingLoadedFramework
  }

  private func recordLoadedFrameworks() throws {
    var images: [[String: String]] = []
    for index in 0..<_dyld_image_count() {
      guard let name = _dyld_get_image_name(index) else { continue }
      let file = String(cString: name)
      for framework in ["ExpoModulesJSI", "ExpoModulesCore", "hermesvm"] {
        guard file.hasSuffix("/\(framework).framework/\(framework)") else { continue }
        let bytes = try Data(contentsOf: URL(fileURLWithPath: file))
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        images.append(["name": framework, "path": file, "sha256": digest])
      }
    }
    for framework in ["ExpoModulesJSI", "ExpoModulesCore", "hermesvm"] {
      guard images.filter({ $0["name"] == framework }).count == 1 else {
        throw CheckFailure.missingLoadedFramework
      }
    }
    // The packet compares loaded-image file bytes with the newly compiled
    // products. This is a path/file binding, not a hash of mapped process memory.
    let data = try JSONSerialization.data(withJSONObject: images, options: [.sortedKeys])
    print("CLAVE_NATIVE_IMAGES " + String(decoding: data, as: UTF8.self))
  }

  @JavaScriptActor
  private func checkThread(_ runtime: JavaScriptRuntime) throws {
    // Check before any unsafe Hermes access. Actor isolation alone is not a
    // physical-thread guarantee, including after an asynchronous suspension.
    guard runtime.isOnJavaScriptThread() else { throw CheckFailure.offJavaScriptThread }
  }

  @JavaScriptActor
  private func encodeCategory(_ ordinal: Int, context: AppContext) throws -> JavaScriptValue {
    try self.checkThread(try context.runtime)
    let native = UNNotificationCategory(
      identifier: "clave-affinity-\(ordinal)", actions: [], intentIdentifiers: [], options: []
    )
    return try CategoryRecord(native).toObject(appContext: context).asValue()
  }

  private func withRuntime(
    _ body: (JavaScriptRuntime, TestRuntimeScheduler, AppContext) async throws -> Void
  ) async throws {
    try recordLoadedFrameworks()
    let testRuntime = await TestRuntimeScheduler().makeRuntime()
    let scheduler = testRuntime.scheduler
    let context = await scheduler.run {
      let context = AppContext()
      testRuntime.owningRuntime.withUnsafePointee { pointer in
        context.setRuntime(pointer, scheduler: scheduler.opaquePointer,
          dispatch: unsafeBitCast(scheduleOnTestRuntime, to: UnsafeRawPointer.self))
      }
      return context
    }
    do {
      let runtime = try context.runtime
      try #require(runtime.supportsAsyncScheduling)
      try #require(!runtime.isOnJavaScriptThread())
      let sameEngine = await scheduler.run {
        testRuntime.owningRuntime.withUnsafePointee { owner in
          runtime.withUnsafePointee { $0 == owner }
        }
      }
      try #require(sameEngine)
      try await body(runtime, scheduler, context)
    } catch {
      await scheduler.run { context.destroy() }
      withExtendedLifetime(testRuntime) {}
      throw error
    }
    // Core installs a native-state reference to its AppContext. Unpin it on the
    // JavaScript thread while the owning Hermes runtime is still alive.
    await scheduler.run { context.destroy() }
    withExtendedLifetime(testRuntime) {}
  }

  @Test
  func eightSequentialNativeCategoryReturnsStayOnRuntimeThread() async throws {
    try await withRuntime { runtime, _, context in
      var completed = 0
      for ordinal in 0..<8 {
        await Task.yield()
        // Explicit noncopyable result selects JavaScriptValue's async execute
        // adapter and the off-JS async scheduler branch at original site212.
        let value = try await runtime.execute { () async throws -> JavaScriptValue in
          return try self.encodeCategory(ordinal, context: context)
        }
        let returned = value.ref()
        let valid = try await runtime.execute { () throws -> Bool in
          try self.checkThread(runtime)
          let object = try returned.take().getObject()
          return object.getProperty("options").getObject().hasProperty("allowAnnouncement")
        }
        #expect(valid)
        completed += 1
      }
      #expect(completed == 8)
    }
  }

  @Test
  func asyncScheduleAndOnThreadAsyncExecuteMakeProgress() async throws {
    try await withRuntime { runtime, _, context in
      let completed = try await withCheckedThrowingContinuation { (done: CheckedContinuation<Int, any Error>) in
        // Explicit async closure covers original site88. Reaching execute
        // below on the physical JS thread also exercises original site208.
        runtime.schedule { () async throws in
          do {
            try self.checkThread(runtime)
            let valid = try await runtime.execute { () async throws -> Bool in
              try self.checkThread(runtime)
              return try self.encodeCategory(0, context: context).isObject()
            }
            await Task.yield()
            // Native bodies can suspend. Check subsequent JSI use via explicit
            // execute reentry, as Core does for its returned value. Do not
            // assert that arbitrary post-await code has JS-thread affinity.
            let reentered = try await runtime.execute { () throws -> Bool in
              try self.checkThread(runtime)
              return try self.encodeCategory(1, context: context).isObject()
            }
            done.resume(returning: valid && reentered ? 1 : 0)
          } catch { done.resume(throwing: error) }
        }
      }
      #expect(completed == 1)
    }
  }

  @Test(arguments: [false, true])
  func blockingAsyncExecuteMakesProgress(fromJavaScriptThread: Bool) async throws {
    try await withRuntime { runtime, scheduler, context in
      let completed = try await withCheckedThrowingContinuation { (done: CheckedContinuation<Int, any Error>) in
        let work: @Sendable () -> Void = {
          do {
            // Explicit async body selects site178, for both off-thread and
            // runInline callers. No synthetic run loop is added to this host.
            let result: Int = try runtime.execute { () async throws -> Int in
              try self.checkThread(runtime)
              return try self.encodeCategory(0, context: context).isObject() ? 1 : 0
            }
            done.resume(returning: result)
          } catch { done.resume(throwing: error) }
        }
        if fromJavaScriptThread {
          scheduler.schedule { work() }
        } else {
          Thread.detachNewThread { work() }
        }
      }
      #expect(completed == 1)
    }
  }

  @Test
  func cancellationDoesNotDoubleCompleteOrLoseRuntimeProgress() async throws {
    try await withRuntime { runtime, _, context in
      let completions = CompletionCount()
      let caller = Task {
        let value = try await runtime.execute { () async throws -> JavaScriptValue in
          let encoded = try self.encodeCategory(0, context: context)
          completions.increment()
          return encoded
        }
        let returned = value.ref()
        return try await runtime.execute { () throws -> Bool in
          try self.checkThread(runtime)
          return try returned.take().isObject()
        }
      }
      caller.cancel()
      // Both versions use unstructured tasks. Cancellation is not claimed to
      // interrupt native work or prevent conversion. Await its one completion.
      #expect(try await caller.value)
      #expect(caller.isCancelled)
      #expect(completions.value == 1)
      let stillAlive = try await runtime.execute { () throws -> Bool in
        try self.checkThread(runtime)
        return runtime.global().hasProperty("Object")
      }
      #expect(stillAlive)
    }
  }

  @Test
  func nativeErrorReachesCallerOnceAndRuntimeStillProgresses() async throws {
    try await withRuntime { runtime, _, _ in
      let completions = CompletionCount()
      await #expect(throws: CheckFailure.expectedNativeError) {
        _ = try await runtime.execute { () async throws -> Int in
          try self.checkThread(runtime)
          completions.increment()
          throw CheckFailure.expectedNativeError
        }
      }
      #expect(completions.value == 1)
      let stillAlive: Bool = try await runtime.execute { () throws -> Bool in
        try self.checkThread(runtime)
        return runtime.global().hasProperty("Object")
      }
      #expect(stillAlive)
    }
  }

  @Test
  func droppedHostTasksReleaseAsyncAndBlockingWaiters() async throws {
    let testRuntime = await ReleasableTestRuntime(dispatch: dropOnTestRuntime)
    let runtime = try #require(testRuntime.runtime)
    let bodies = CompletionCount()
    await #expect(throws: JavaScriptCallback.RuntimeLostError.self) {
      _ = try await runtime.execute { () async throws -> Int in
        bodies.increment()
        return 1
      }
    }
    let released = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      Thread.detachNewThread {
        do {
          let _: Int = try runtime.execute { () async throws -> Int in
            bodies.increment()
            return 1
          }
          done.resume(returning: false)
        } catch { done.resume(returning: error is JavaScriptCallback.RuntimeLostError) }
      }
    }
    #expect(released)
    #expect(bodies.value == 0)
    await testRuntime.tearDown()
  }
}

private final class CompletionCount: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var value: Int { lock.withLock { count } }
  func increment() { lock.withLock { count += 1 } }
}
