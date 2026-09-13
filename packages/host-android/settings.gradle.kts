// Gradle resolves plugins only from repositories declared here. Without the
// google() repository the Android Gradle Plugin is not found at all, and the
// build fails before it ever reaches the app module.
pluginManagement {
    repositories {
        google()
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

rootProject.name = "DragonFableHelper"
include(":app")
