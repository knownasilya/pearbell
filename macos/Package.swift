// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Pearbell",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "Pearbell", path: "Sources/Pearbell")
  ]
)
