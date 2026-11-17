// swift-tools-version:5.9
// Momotombo macOS recording helper. Apple system frameworks only; no third-party packages.
import PackageDescription

let package = Package(
    name: "MomotomboRecorder",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "momotombo-recorder",
            path: "Sources/MomotomboRecorder",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("AppKit"),
            ]
        ),
    ]
)
