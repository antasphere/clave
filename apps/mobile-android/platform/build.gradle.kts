// The platform adapters behind the core's ports, as an Android library: the Keystore, the
// preferences, the system browser's sign-in, OkHttp, the notification channel, Firebase's
// token, the content resolver and the foreground activity. The app wires them; nothing here
// knows a screen.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}
android {
    namespace = "com.clave.platform"
    compileSdk = 37
    buildToolsVersion = "36.0.0"
    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = false }
}
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
dependencies {
    api(project(":core:ports"))
    api(project(":core:contract"))
    api(project(":core:auth"))
    api(project(":core:transport"))
    api(project(":core:chat"))
    api(project(":core:notifications"))
    api(project(":core:state"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    // IncomingResponse carries the push's data as a JsonElement.
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.firebase.messaging)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}
