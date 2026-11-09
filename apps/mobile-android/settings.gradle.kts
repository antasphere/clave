// Clave on Android: the native companion (Kotlin, Jetpack Compose), its own Gradle
// build inside the repository. Every version is pinned in gradle/libs.versions.toml and
// gradle/wrapper/gradle-wrapper.properties; nothing is resolved from "latest".
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "clave-android"
include(":app")
include(":core:ports")
include(":core:contract")
include(":core:auth")
include(":core:transport")
include(":core:chat")
include(":core:devices")
include(":core:notifications")
include(":core:state")
include(":ui")
