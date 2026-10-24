import AppKit
import SwiftUI

// A small Markdown renderer for message bodies, like the Android app's
// (android/app/src/main/java/dev/pearbell/ui/Markdown.kt): **bold**, *italic*,
// `code`, ~~strike~~, [links](https://…), bare URLs, headings, lists, task
// lists (- [ ] and - [x]), quotes and fenced code. Only http(s) and mailto links open, so a message cannot
// launch other apps through odd URL schemes.
enum MarkdownBlock: Hashable {
  case paragraph(String)
  case heading(Int, String)
  case bullet(String)
  case task(Bool, String)
  case ordered(String, String)
  case quote(String)
  case code(String)
}

enum Markdown {
  static func blocks(_ text: String) -> [MarkdownBlock] {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    func flush() {
      if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
      paragraph = []
    }

    var i = 0
    while i < lines.count {
      let line = lines[i]
      let trimmed = line.trimmingCharacters(in: .whitespaces)

      if trimmed.hasPrefix("```") {
        flush()
        var code: [String] = []
        i += 1
        while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
          code.append(lines[i])
          i += 1
        }
        i += 1 // the closing fence
        blocks.append(.code(code.joined(separator: "\n")))
        continue
      }

      if trimmed.isEmpty {
        flush()
      } else if let m = line.firstMatch(of: #/^(#{1,6})\s+(.*)$/#) {
        flush()
        blocks.append(.heading(m.1.count, String(m.2)))
      } else if let m = line.firstMatch(of: #/^\s*(?:[-*+]|\d{1,3}[.)])\s+\[([ xX])\]\s+(.*)$/#) {
        flush()
        blocks.append(.task(m.1 != " ", String(m.2)))
      } else if let m = line.firstMatch(of: #/^\s*[-*+]\s+(.*)$/#) {
        flush()
        blocks.append(.bullet(String(m.1)))
      } else if let m = line.firstMatch(of: #/^\s*(\d{1,3})[.)]\s+(.*)$/#) {
        flush()
        blocks.append(.ordered(String(m.1), String(m.2)))
      } else if let m = line.firstMatch(of: #/^\s*>\s?(.*)$/#) {
        flush()
        blocks.append(.quote(String(m.1)))
      } else {
        paragraph.append(line)
      }
      i += 1
    }
    flush()
    return blocks
  }

  // One line of inline Markdown, with safe links styled and bare URLs linked.
  static func inline(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    var out = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)

    for run in out.runs {
      guard let url = run.link else { continue }
      if !isSafe(url) { out[run.range].link = nil }
    }

    let plain = String(out.characters)
    if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
      for match in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
        // Only what is written as a URL, like the phone: not "example.com".
        guard let url = match.url, isSafe(url),
              let found = Range(match.range, in: plain), plain[found].lowercased().hasPrefix("http"),
              let range = Range(match.range, in: out),
              !out[range].runs.contains(where: { $0.link != nil }) else { continue }
        out[range].link = url
      }
    }

    for run in out.runs where run.link != nil {
      out[run.range].swiftUI.foregroundColor = Palette.primary
      out[run.range].swiftUI.underlineStyle = .single
    }
    return out
  }

  // For notifications and previews: the text without the markup.
  static func plain(_ text: String) -> String {
    blocks(text).map { block in
      switch block {
      case .paragraph(let s), .heading(_, let s), .quote(let s): return String(inline(s).characters)
      case .bullet(let s): return "• " + String(inline(s).characters)
      case .task(let done, let s): return (done ? "☑ " : "☐ ") + String(inline(s).characters)
      case .ordered(let n, let s): return "\(n). " + String(inline(s).characters)
      case .code(let s): return s
      }
    }.joined(separator: "\n")
  }

  static func isSafe(_ url: URL) -> Bool {
    ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "")
  }
}

// A message body, block by block.
struct MarkdownText: View {
  let text: String
  var size: CGFloat = 13
  var selectable = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(Markdown.blocks(text).enumerated()), id: \.offset) { _, block in
        view(block)
      }
    }
    .tint(Palette.primary)
    .environment(\.openURL, OpenURLAction { url in
      Markdown.isSafe(url) ? .systemAction : .discarded
    })
  }

  @ViewBuilder
  private func view(_ block: MarkdownBlock) -> some View {
    switch block {
    case .paragraph(let s):
      line(Text(Markdown.inline(s)))
    case .heading(let level, let s):
      line(Text(Markdown.inline(s)), font: .system(size: level <= 2 ? size * 1.15 : size * 1.05, weight: .bold))
    case .bullet(let s):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("•")
        line(Text(Markdown.inline(s)))
      }
    case .task(let done, let s):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: done ? "checkmark.square.fill" : "square")
          .foregroundStyle(done ? Palette.primary : Palette.onSurfaceVariant)
          .accessibilityLabel(done ? "Done" : "To do")
        if done {
          line(Text(Markdown.inline(s)).strikethrough().foregroundColor(Palette.onSurfaceVariant))
        } else {
          line(Text(Markdown.inline(s)))
        }
      }
    case .ordered(let n, let s):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("\(n).").monospacedDigit()
        line(Text(Markdown.inline(s)))
      }
    case .quote(let s):
      HStack(spacing: 8) {
        RoundedRectangle(cornerRadius: 1.5)
          .fill(Palette.outlineVariant)
          .frame(width: 3)
        line(Text(Markdown.inline(s)).italic().foregroundColor(Palette.onSurfaceVariant))
      }
      .fixedSize(horizontal: false, vertical: true)
    case .code(let s):
      line(Text(s), font: .system(size: size - 1, design: .monospaced))
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.surfaceContainer))
    }
  }

  @ViewBuilder
  private func line(_ text: Text, font: Font? = nil) -> some View {
    let styled = text.font(font ?? .system(size: size)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
    if selectable {
      styled.textSelection(.enabled)
    } else {
      styled
    }
  }
}
