// The root build: the plugins are declared here at their pinned versions and applied in
// the modules. Nothing is built at the root; the one rule below is for every pure JVM module.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}

// Every pure JVM module (the core) compiles against the Java 8 class library, to Java 8 class
// files. The app's minSdk is 26 (Android 8.0) while the JVM tests run on JDK 21, so without a
// ceiling a Java 9+ API compiles and passes every unit test, then throws NoSuchMethodError on an
// older phone. That happened with URLEncoder.encode(String, Charset), a Java 10 overload Android
// has from API 33, in the conversation's history query (found on the Android 8.0 virtual device
// on 9 November 2026). -Xjdk-release limits the JDK API Kotlin sees, the way javac's --release
// does, so such a call fails to compile with the pinned JDK 21; Kotlin does not promise that
// ceiling on every JDK distribution. It is a safeguard for the JDK API, not a proof of Android
// compatibility: a Java 8 API that Android 8.0 lacks still compiles, and the instrumented runs on
// the API 26 device are the evidence. The Android modules (ui, platform, app) compile against
// android.jar and are checked by Lint's NewApi.
subprojects {
    plugins.withId("org.jetbrains.kotlin.jvm") {
        extensions.configure<JavaPluginExtension> {
            sourceCompatibility = JavaVersion.VERSION_1_8
            targetCompatibility = JavaVersion.VERSION_1_8
        }
        extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension> {
            compilerOptions {
                jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8)
                freeCompilerArgs.add("-Xjdk-release=1.8")
            }
        }
        tasks.withType<JavaCompile>().configureEach { options.release.set(8) }
    }
}
