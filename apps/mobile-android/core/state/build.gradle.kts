// A pure JVM module of the Android companion: runs under JUnit on the Mac and in CI
// without an emulator. Compiled against the Java 8 class library, the rule the root build sets
// for every JVM module.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}
tasks.withType<Test>().configureEach {
    useJUnit()
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
dependencies {
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.serialization.json)
    api(project(":core:ports"))
    api(project(":core:contract"))
    api(project(":core:transport"))
    api(project(":core:chat"))
    api(project(":core:devices"))
    api(project(":core:auth"))
    api(project(":core:notifications"))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
