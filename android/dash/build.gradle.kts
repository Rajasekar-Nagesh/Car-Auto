plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The web app (HTML/JS/CSS) is copied into the APK so it opens instantly and
// works offline; the WebView serves it from https://appassets.androidplatform.net/web/.
val repoRoot: File = rootProject.projectDir.parentFile
val webOut: File = layout.buildDirectory.dir("generated/web").get().asFile

val syncWeb = tasks.register<Sync>("syncWeb") {
    into(File(webOut, "web"))
    from(listOf("index.html", "car.html", "phone.html").map { File(repoRoot, it) })
    listOf("css", "js", "vendor", "icons").forEach { dir -> from(File(repoRoot, dir)) { into(dir) } }
}
tasks.named("preBuild") { dependsOn(syncWeb) }

android {
    namespace = "app.carauto.dash"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.carauto.dash"
        minSdk = 21
        targetSdk = 34
        versionCode = 9
        versionName = "1.8"
    }

    signingConfigs {
        // Fixed key so new builds install over old ones. It is public: fine for
        // side-loading, but create your own key before publishing anywhere.
        create("shared") {
            storeFile = rootProject.file("carauto.keystore")
            storePassword = "carauto"
            keyAlias = "carauto"
            keyPassword = "carauto"
            // Sign with every scheme for the widest phone/stereo compatibility.
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets.getByName("main").assets.srcDir(webOut)

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}
