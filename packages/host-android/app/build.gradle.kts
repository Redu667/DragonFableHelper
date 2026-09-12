plugins {
    id("com.android.application")
}

android {
    namespace = "com.dfhelper.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dfhelper.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The web bundle (UI + bot + bridge) is built by Vite and copied into
    // assets by `syncWebBundle` below.
    sourceSets["main"].assets.srcDirs("src/main/assets")
}

/**
 * Copy the built web app into the APK's assets.
 *
 * Run `pnpm --filter @dfh/ui build` first; this task fails loudly rather than
 * shipping an APK with no UI in it.
 */
val syncWebBundle by tasks.registering(Copy::class) {
    val webDist = rootProject.file("../ui/dist")
    doFirst {
        if (!webDist.exists()) {
            throw GradleException(
                "Web bundle not found at ${webDist.path}. Run: pnpm --filter @dfh/ui build"
            )
        }
    }
    from(webDist)
    into(layout.projectDirectory.dir("src/main/assets/dfh"))
}

tasks.named("preBuild") { dependsOn(syncWebBundle) }
