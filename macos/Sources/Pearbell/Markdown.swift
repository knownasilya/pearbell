import AppKit
import SwiftUI

// A small Markdown renderer for message bodies, like the Android app's
// (android/app/src/main/java/dev/pearbell/ui/Markdown.kt): **bold**, *italic*,
// `code`, ~~strike~~, [links](https://…), bare URLs, headings, lists, task
// lists (- [ ] and - [x]), tables, quotes, fenced code and images
// (![alt](https://…) on a line of its own). Only http(s) and mailto links open,
// so a message cannot launch other apps through odd URL schemes, and only https
// images load.
enum MarkdownBlock: Hashable {
  case paragraph(String)
  case heading(Int, String)
  case bullet(String)
  case task(Bool, String)
  case ordered(String, String)
  case quote(String)
  case code(String)
  case table(MarkdownTable)
  case image(String, URL)
}

struct MarkdownTable: Hashable {
  enum Align: Hashable { case leading, center, trailing }
  var header: [String]
  var align: [Align]
  var rows: [[String]]
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

      if let m = line.wholeMatch(of: #/\s*!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)\s*/#),
         let url = URL(string: String(m.2)), url.scheme?.lowercased() == "https" {
        flush()
        blocks.append(.image(String(m.1), url))
        i += 1
        continue
      }

      if let found = table(lines, at: i) {
        flush()
        blocks.append(.table(found.0))
        i = found.1
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

  // A GFM table at lines[at]: a header row, then a delimiter row (| --- | :-: |)
  // with as many cells. Returns it with the index of the line after it.
  static func table(_ lines: [String], at: Int) -> (MarkdownTable, Int)? {
    guard at + 1 < lines.count, lines[at].contains("|"), lines[at + 1].contains("|") else { return nil }
    let header = cells(lines[at])
    var align: [MarkdownTable.Align] = []
    for cell in cells(lines[at + 1]) {
      guard let m = cell.wholeMatch(of: #/\s*(:?)\s*-+\s*(:?)\s*/#) else { return nil }
      switch (!m.1.isEmpty, !m.2.isEmpty) {
      case (true, true): align.append(.center)
      case (false, true): align.append(.trailing)
      default: align.append(.leading)
      }
    }
    guard align.count == header.count else { return nil }

    var rows: [[String]] = []
    var i = at + 2
    while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
      let row = cells(lines[i])
      rows.append(header.indices.map { $0 < row.count ? row[$0] : "" })
      i += 1
    }
    return (MarkdownTable(header: header, align: align, rows: rows), i)
  }

  // "| a | b |" as ["a", "b"]. An escaped \| is a pipe inside a cell.
  static func cells(_ line: String) -> [String] {
    var s = Substring(line.trimmingCharacters(in: .whitespaces))
    if s.hasPrefix("|") { s = s.dropFirst() }
    if s.hasSuffix("|") && !s.hasSuffix("\\|") { s = s.dropLast() }
    var cells: [String] = []
    var cell = ""
    var escaped = false
    for c in s {
      if escaped {
        cell += c == "|" ? "|" : "\\\(c)"
        escaped = false
      } else if c == "\\" {
        escaped = true
      } else if c == "|" {
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        cell = ""
      } else {
        cell.append(c)
      }
    }
    if escaped { cell += "\\" }
    cells.append(cell.trimmingCharacters(in: .whitespaces))
    return cells
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
      case .table(let t):
        return ([t.header] + t.rows).map { row in
          row.map { String(inline($0).characters) }.joined(separator: " | ")
        }.joined(separator: "\n")
      case .image(let alt, _): return alt.isEmpty ? "Image" : alt
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
      // Lines keep their indentation and don't wrap; a long one scrolls sideways.
      ScrollView(.horizontal) {
        allowSelection(Text(s).font(.system(size: size - 1, design: .monospaced)).lineSpacing(3).fixedSize())
          .padding(10)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.surfaceContainer))
    case .table(let t):
      table(t)
    case .image(let alt, let url):
      MessageImage(alt: alt, url: url, size: size)
    }
  }

  // Cells don't wrap; a table wider than the popover scrolls sideways.
  private func table(_ t: MarkdownTable) -> some View {
    ScrollView(.horizontal) {
      Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
        GridRow {
          ForEach(t.header.indices, id: \.self) { c in
            cell(Text(Markdown.inline(t.header[c])).bold(), t.align[c])
          }
        }
        ForEach(t.rows.indices, id: \.self) { r in
          Rectangle().fill(Palette.outlineVariant).frame(height: r == 0 ? 2 : 1)
            .gridCellUnsizedAxes(.horizontal)
          GridRow {
            ForEach(t.rows[r].indices, id: \.self) { c in
              cell(Text(Markdown.inline(t.rows[r][c])), t.align[c])
            }
          }
        }
      }
      .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.outlineVariant))
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func cell(_ text: Text, _ align: MarkdownTable.Align) -> some View {
    allowSelection(text.font(.system(size: size)).fixedSize())
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .gridColumnAlignment(align == .center ? .center : align == .trailing ? .trailing : .leading)
  }

  @ViewBuilder
  private func allowSelection(_ view: some View) -> some View {
    if selectable {
      view.textSelection(.enabled)
    } else {
      view
    }
  }

  private func line(_ text: Text, font: Font? = nil) -> some View {
    allowSelection(text.font(font ?? .system(size: size)).lineSpacing(3).fixedSize(horizontal: false, vertical: true))
  }
}

// An https image, fit to the width and never shown larger than it is. Until it
// loads, or if it can't, the alt text stands in.
struct MessageImage: View {
  let alt: String
  let url: URL
  var size: CGFloat = 13
  @State private var image: NSImage?

  private static let cache = NSCache<NSURL, NSImage>()
  private static let maxBytes = 10 << 20

  var body: some View {
    Group {
      if let image {
        Image(nsImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: image.size.width)
          .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
          .accessibilityLabel(alt)
      } else {
        Text(alt.isEmpty ? "Image" : alt)
          .font(.system(size: size))
          .italic()
          .foregroundColor(Palette.onSurfaceVariant)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .task(id: url) { image = await Self.load(url) }
  }

  private static func load(_ url: URL) async -> NSImage? {
    if let cached = cache.object(forKey: url as NSURL) { return cached }
    guard url.scheme?.lowercased() == "https",
          let data = try? await URLSession.shared.data(from: url).0,
          data.count <= maxBytes,
          let image = NSImage(data: data) else { return nil }
    cache.setObject(image, forKey: url as NSURL)
    return image
  }
}
