// Clave on Android, the application module: the platform wiring (Keystore, the system
// browser, the pickers, the notification channel and the push service), the activities,
// and the composition of the core modules and the screens.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}
android {
    namespace = "com.clave.android"
    compileSdk = 37
    buildToolsVersion = "36.0.0"
    defaultConfig {
        // Never the React Native prototype's com.clave.app.mobile, never the Mac's
        // com.clave.app: a test install can replace neither nor read their data.
        applicationId = "com.clave.app.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // The callback scheme names the platform and is not the prototype's clave://.
        manifestPlaceholders["oauthScheme"] = "clave-android"
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            // A development build may send a credential over plain http to the
            // loopback (the fixture issuer, relay and server reached through adb
            // reverse) and to nothing else; the network security config of this build
            // type says the same to the platform.
            buildConfigField("boolean", "DEVELOPMENT", "true")
        }
        release {
            isMinifyEnabled = false
            buildConfigField("boolean", "DEVELOPMENT", "false")
            // No signing configured here: a release APK needs the team's keystore,
            // named apart as owed in the lane's record.
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging { resources.excludes += setOf("META-INF/LICENSE.md", "META-INF/LICENSE-notice.md") }
}
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
dependencies {
    implementation(project(":core:ports"))
    implementation(project(":core:contract"))
    implementation(project(":core:auth"))
    implementation(project(":core:transport"))
    implementation(project(":core:chat"))
    implementation(project(":core:devices"))
    implementation(project(":core:notifications"))
    implementation(project(":core:state"))
    implementation(project(":ui"))
    val bom = platform(libs.compose.bom)
    implementation(bom)
    androidTestImplementation(bom)
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.firebase.messaging)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.uiautomator)
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.kotlinx.coroutines.test)
    debugImplementation(libs.compose.ui.test.manifest)
}
