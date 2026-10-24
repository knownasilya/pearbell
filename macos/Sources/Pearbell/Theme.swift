import AppKit
import SwiftUI

// The Android app's colors (android/.../ui/Theme.kt), light and dark.
enum Palette {
  static let primary = Color(light: 0x4A6400, dark: 0xC3E36A)
  static let onPrimary = Color(light: 0xFFFFFF, dark: 0x213000)
  static let primaryContainer = Color(light: 0xD8EE96, dark: 0x2F3F0C)
  static let tertiary = Color(light: 0x8A5A00, dark: 0xF5BE63)
  static let tertiaryContainer = Color(light: 0xFFE2B5, dark: 0x3A2A0C)
  static let onTertiaryContainer = Color(light: 0x2C1A00, dark: 0xFFDDA8)
  static let background = Color(light: 0xF5F6EF, dark: 0x0E120C)
  static let onSurface = Color(light: 0x1A1C16, dark: 0xE3E5DA)
  static let onSurfaceVariant = Color(light: 0x5B5F51, dark: 0xA9AE9C)
  static let surfaceLowest = Color(light: 0xFFFFFF, dark: 0x0A0D08)
  static let surfaceLow = Color(light: 0xFFFFFF, dark: 0x161B13)
  static let surfaceContainer = Color(light: 0xEDEFE5, dark: 0x1B2118)
  static let outline = Color(light: 0x8A8E7F, dark: 0x747A69)
  static let outlineVariant = Color(light: 0xD5D8C9, dark: 0x353B2F)
  static let online = Color(light: 0x5E8A00, dark: 0xC3E36A)
  static let offline = Color(light: 0x9EA294, dark: 0x6B7062)
  static let avatars: [Color] = zip(
    [0xD8EE96, 0xC4EBE6, 0xE6D8F2, 0xF6DCC2, 0xD3E0F5, 0xF3D3DA],
    [0x3E5216, 0x1F4B4A, 0x4F3A62, 0x5E3D20, 0x2D4466, 0x5A2E3A]
  ).map { Color(light: $0, dark: $1) }
}

extension Color {
  init(light: UInt32, dark: UInt32) {
    self.init(nsColor: NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      return NSColor(hex: isDark ? dark : light)
    })
  }
}

extension NSColor {
  convenience init(hex: UInt32) {
    self.init(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: 1
    )
  }
}

// A round badge with the initials of a name, colored by the name. Same
// colors as on the phone: the index comes from Java's String.hashCode.
struct Avatar: View {
  let name: String
  var size: CGFloat = 40

  var body: some View {
    let letters = initials(name)
    Circle()
      .fill(Palette.avatars[Int(javaHash(name) & 0x7fffffff) % Palette.avatars.count])
      .frame(width: size, height: size)
      .overlay(
        Text(letters)
          .font(.system(size: size * (letters.count > 1 ? 0.36 : 0.42), weight: .semibold))
          .foregroundStyle(Palette.onSurface)
      )
  }
}

struct StatusDot: View {
  let online: Bool
  var size: CGFloat = 8

  var body: some View {
    Circle().fill(online ? Palette.online : Palette.offline).frame(width: size, height: size)
  }
}

// "Claude Code" -> "CC", "GitHub Actions" -> "GA", "codex" -> "C".
func initials(_ name: String) -> String {
  let words = name.split(whereSeparator: { " -_.".contains($0) })
    .filter { $0.contains(where: { $0.isLetter || $0.isNumber }) }
  let letters = words.prefix(2).compactMap { $0.first(where: { $0.isLetter || $0.isNumber })?.uppercased() }
  return letters.isEmpty ? "•" : letters.joined()
}

func javaHash(_ s: String) -> Int32 {
  var h: Int32 = 0
  for unit in s.utf16 { h = 31 &* h &+ Int32(unit) }
  return h
}

// Filled first action, outlined others: the phone's buttons.
struct PillButtonStyle: ButtonStyle {
  var filled: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .semibold))
      .padding(.horizontal, 16)
      .padding(.vertical, 7)
      .foregroundStyle(filled ? Palette.onPrimary : Palette.primary)
      .background(Capsule().fill(filled ? Palette.primary : Color.clear))
      .overlay(Capsule().strokeBorder(filled ? Color.clear : Palette.outline, lineWidth: 1))
      .opacity(configuration.isPressed ? 0.75 : 1)
      .contentShape(Capsule())
  }
}
