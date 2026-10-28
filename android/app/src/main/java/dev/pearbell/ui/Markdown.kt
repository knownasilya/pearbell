package dev.pearbell.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.em
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// A small Markdown renderer for message bodies: **bold**, *italic*, `code`,
// ~~strike~~, [links](https://…), bare URLs, headings, lists, task lists
// (- [ ] and - [x]), tables, quotes, fenced code and images (![alt](https://…)
// on a line of its own). Only http(s) and mailto links become tappable, so a
// message cannot launch other apps through odd URL schemes, and only https
// images load.
object Markdown {
  data class Colors(val link: Color, val code: Color, val quote: Color)

  private val Plain = Colors(Color.Unspecified, Color.Unspecified, Color.Unspecified)

  fun render(text: String, links: Boolean, colors: Colors = Plain): AnnotatedString =
    buildAnnotatedString { Renderer(this, links, colors).blocks(text) }

  // One table cell or other single line, without block syntax.
  fun renderInline(text: String, links: Boolean, colors: Colors = Plain): AnnotatedString =
    buildAnnotatedString { Renderer(this, links, colors).inline(text) }

  // For notifications and copying: the text without the markup.
  fun plain(text: String): String = render(text, links = false).text

  fun isSafeUrl(url: String): Boolean {
    val u = url.lowercase()
    return u.startsWith("https://") || u.startsWith("http://") || u.startsWith("mailto:")
  }

  // Task list boxes. The text variant selector keeps ☑ from turning into an emoji.
  const val UNCHECKED = "☐"
  const val CHECKED = "☑\uFE0E"

  private val task = Regex("""^\s*(?:[-*+]|\d{1,3}[.)])\s+\[([ xX])]\s+(.*)$""")
  private val heading = Regex("""^(#{1,6})\s+(.*)$""")
  private val bullet = Regex("""^\s*[-*+]\s+(.*)$""")
  private val ordered = Regex("""^\s*(\d{1,3})[.)]\s+(.*)$""")
  private val quote = Regex("""^\s*>\s?(.*)$""")
  private val bareUrl = java.util.regex.Pattern.compile("""https?://[^\s<>"]+""")
  private val image = Regex("""^\s*!\[([^\]]*)]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)\s*$""")
  private val delimiter = Regex("""^\s*(:?)\s*-+\s*(:?)\s*$""")

  enum class Align { START, CENTER, END }

  data class Table(val header: List<String>, val align: List<Align>, val rows: List<List<String>>)

  // A message split into runs of ordinary Markdown and the blocks that need their own layout.
  sealed interface Part {
    data class Prose(val text: String) : Part
    data class Grid(val table: Table) : Part
    data class Code(val language: String, val text: String) : Part
    data class Image(val alt: String, val url: String) : Part
  }

  fun isSafeImage(url: String) = url.lowercase().startsWith("https://")

  fun parts(text: String): List<Part> {
    val lines = text.replace("\r\n", "\n").split('\n')
    val parts = mutableListOf<Part>()
    val prose = mutableListOf<String>()
    fun add(part: Part) {
      if (prose.isNotEmpty()) parts += Part.Prose(prose.joinToString("\n"))
      prose.clear()
      parts += part
    }

    var i = 0
    while (i < lines.size) {
      val line = lines[i]

      if (line.trimStart().startsWith("```")) {
        val language = line.trim().removePrefix("```").trim()
        val code = mutableListOf<String>()
        i++
        while (i < lines.size && !lines[i].trimStart().startsWith("```")) code += lines[i++]
        i++ // closing fence
        add(Part.Code(language, code.joinToString("\n")))
        continue
      }

      val picture = image.matchEntire(line)
      if (picture != null && isSafeImage(picture.groupValues[2])) {
        add(Part.Image(picture.groupValues[1], picture.groupValues[2]))
        i++
        continue
      }

      val found = table(lines, i)
      if (found != null) {
        add(Part.Grid(found.first))
        i = found.second
        continue
      }

      prose += line
      i++
    }
    if (prose.isNotEmpty()) parts += Part.Prose(prose.joinToString("\n"))
    return parts
  }

  // A table at lines[at]: a header row, then a delimiter row (| --- | :-: |) with as many cells.
  // Returns it with the index of the line after it.
  private fun table(lines: List<String>, at: Int): Pair<Table, Int>? {
    if (at + 1 >= lines.size || '|' !in lines[at] || '|' !in lines[at + 1]) return null
    val header = cells(lines[at])
    val marks = cells(lines[at + 1]).map { delimiter.matchEntire(it) ?: return null }
    if (marks.size != header.size) return null
    val align = marks.map { m ->
      val left = m.groupValues[1].isNotEmpty()
      val right = m.groupValues[2].isNotEmpty()
      if (left && right) Align.CENTER else if (right) Align.END else Align.START
    }
    val rows = mutableListOf<List<String>>()
    var i = at + 2
    while (i < lines.size && lines[i].isNotBlank() && '|' in lines[i]) {
      val row = cells(lines[i++])
      rows += List(header.size) { row.getOrElse(it) { "" } }
    }
    return Table(header, align, rows) to i
  }

  // "| a | b |" as ["a", "b"]. An escaped \| is a pipe inside a cell.
  private fun cells(line: String): List<String> {
    var s = line.trim()
    if (s.startsWith("|")) s = s.substring(1)
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.dropLast(1)
    val cells = mutableListOf<String>()
    val cell = StringBuilder()
    var i = 0
    while (i < s.length) {
      when {
        s[i] == '\\' && i + 1 < s.length && s[i + 1] == '|' -> { cell.append('|'); i++ }
        s[i] == '|' -> { cells += cell.toString().trim(); cell.clear() }
        else -> cell.append(s[i])
      }
      i++
    }
    cells += cell.toString().trim()
    return cells
  }

  private class Renderer(val out: AnnotatedString.Builder, val links: Boolean, val colors: Colors) {
    private var started = false
    private var pendingBlank = false
    private var nested = 0 // > 0 while rendering a link's label

    fun blocks(text: String) {
      for (part in parts(text)) when (part) {
        is Part.Prose -> prose(part.text)
        is Part.Grid -> table(part.table)
        is Part.Code -> code(part.text)
        is Part.Image -> {
          newLine()
          link(part.url, part.alt.ifBlank { "Image" })
        }
      }
    }

    private fun code(text: String) {
      newLine()
      out.withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = colors.code)) { append(text) }
    }

    // Where a table can't be laid out (previews, notifications): one line per row, cells split by " | ".
    private fun table(table: Table) {
      newLine()
      out.withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { row(table.header) }
      for (cells in table.rows) {
        out.append("\n")
        row(cells)
      }
    }

    private fun row(cells: List<String>) {
      cells.forEachIndexed { j, cell ->
        if (j > 0) out.withStyle(SpanStyle(color = colors.quote, fontWeight = FontWeight.Normal)) { append(" | ") }
        inline(cell)
      }
    }

    private fun prose(text: String) {
      val lines = text.split('\n')
      var i = 0
      while (i < lines.size) {
        val line = lines[i]

        if (line.isBlank()) {
          pendingBlank = started
          i++
          continue
        }

        newLine()
        heading.matchEntire(line)?.let { m ->
          val size = if (m.groupValues[1].length <= 2) 1.15.em else 1.05.em
          out.withStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = size)) { inline(m.groupValues[2]) }
        } ?: task.matchEntire(line)?.let { m ->
          if (m.groupValues[1] == " ") {
            out.append("$UNCHECKED  ")
            inline(m.groupValues[2])
          } else {
            out.withStyle(SpanStyle(color = colors.link)) { append(CHECKED) }
            out.append("  ")
            out.withStyle(SpanStyle(color = colors.quote, textDecoration = TextDecoration.LineThrough)) { inline(m.groupValues[2]) }
          }
        } ?: bullet.matchEntire(line)?.let { m ->
          out.append("•  ")
          inline(m.groupValues[1])
        } ?: ordered.matchEntire(line)?.let { m ->
          out.append("${m.groupValues[1]}.  ")
          inline(m.groupValues[2])
        } ?: quote.matchEntire(line)?.let { m ->
          out.withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = colors.quote)) { inline(m.groupValues[1]) }
        } ?: inline(line)
        i++
      }
    }

    private fun newLine() {
      if (started) out.append(if (pendingBlank) "\n\n" else "\n")
      started = true
      pendingBlank = false
    }

    fun inline(s: String) {
      var i = 0
      val text = StringBuilder()
      fun flush() {
        if (text.isNotEmpty()) out.append(text.toString())
        text.clear()
      }

      while (i < s.length) {
        val c = s[i]

        // \* and friends: the next character is literal.
        if (c == '\\' && i + 1 < s.length && s[i + 1] in "\\`*_~[]()<>#|") {
          text.append(s[i + 1]); i += 2; continue
        }

        if (c == '`') {
          val end = s.indexOf('`', i + 1)
          if (end > i + 1) {
            flush()
            out.withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = colors.code)) {
              append(s.substring(i + 1, end))
            }
            i = end + 1; continue
          }
        }

        if (s.startsWith("**", i) || s.startsWith("__", i) || s.startsWith("~~", i)) {
          val mark = s.substring(i, i + 2)
          val end = s.indexOf(mark, i + 2)
          if (end > i + 2 && !s[i + 2].isWhitespace() && !s[end - 1].isWhitespace() &&
            (mark != "__" || boundary(s, i - 1) && boundary(s, end + 2))
          ) {
            flush()
            val style = if (mark == "~~") SpanStyle(textDecoration = TextDecoration.LineThrough) else SpanStyle(fontWeight = FontWeight.Bold)
            out.withStyle(style) { inline(s.substring(i + 2, end)) }
            i = end + 2; continue
          }
        }

        if ((c == '*' || c == '_') && i + 1 < s.length && !s[i + 1].isWhitespace() && (c == '*' || boundary(s, i - 1))) {
          val end = closing(s, c, i + 1)
          if (end > i + 1) {
            flush()
            out.withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { inline(s.substring(i + 1, end)) }
            i = end + 1; continue
          }
        }

        // An image inside a line shows as its alt text, linked to the picture.
        if (c == '!' && nested == 0 && s.startsWith("![", i)) {
          val mid = s.indexOf("](", i + 2)
          val end = if (mid > i) closeParen(s, mid + 2) else -1
          if (mid >= i + 2 && end > mid + 2) {
            flush()
            val alt = s.substring(i + 2, mid)
            link(s.substring(mid + 2, end).trim().substringBefore(' '), alt.ifBlank { "Image" })
            i = end + 1; continue
          }
        }

        if (c == '[' && nested == 0) {
          val mid = s.indexOf("](", i + 1)
          val end = if (mid > i) closeParen(s, mid + 2) else -1
          if (mid > i + 1 && end > mid + 2) {
            flush()
            link(s.substring(mid + 2, end).trim(), s.substring(i + 1, mid))
            i = end + 1; continue
          }
        }

        if (c == '<' && nested == 0) {
          val end = s.indexOf('>', i + 1)
          val url = if (end > i) s.substring(i + 1, end) else ""
          if (isSafeUrl(url) && url.none { it.isWhitespace() }) {
            flush()
            link(url, url)
            i = end + 1; continue
          }
        }

        if (c == 'h' && nested == 0 && boundary(s, i - 1)) {
          val m = bareUrl.matcher(s).region(i, s.length)
          if (m.lookingAt()) {
            val url = trimUrl(m.group())
            flush()
            link(url, url)
            i += url.length
            continue
          }
        }

        text.append(c)
        i++
      }
      flush()
    }

    private fun link(url: String, label: String) {
      nested++
      if (links && isSafeUrl(url)) {
        val style = TextLinkStyles(SpanStyle(color = colors.link, textDecoration = TextDecoration.Underline))
        out.withLink(LinkAnnotation.Url(url, style)) { inline(label) }
      } else {
        out.withStyle(SpanStyle(color = colors.link)) { inline(label) }
      }
      nested--
    }

    // The ")" that ends a link address, allowing balanced parentheses inside.
    private fun closeParen(s: String, from: Int): Int {
      var depth = 0
      for (j in from until s.length) {
        when (s[j]) {
          '(' -> depth++
          ')' -> if (depth == 0) return j else depth--
        }
      }
      return -1
    }

    // A word boundary for _emphasis_, so snake_case_names stay as they are.
    private fun boundary(s: String, at: Int) = at < 0 || at >= s.length || !s[at].isLetterOrDigit()

    private fun closing(s: String, mark: Char, from: Int): Int {
      var j = from
      while (true) {
        j = s.indexOf(mark, j)
        if (j < 0) return -1
        val doubled = j + 1 < s.length && s[j + 1] == mark
        if (!s[j - 1].isWhitespace() && !doubled && (mark == '*' || boundary(s, j + 1))) return j
        j += if (doubled) 2 else 1
      }
    }

    // Leave sentence punctuation and an unmatched ")" outside the link.
    private fun trimUrl(url: String): String {
      var u = url.trimEnd('.', ',', ';', ':', '!', '?', '\'', '"')
      while (u.endsWith(")") && u.count { it == ')' } > u.count { it == '(' }) u = u.dropLast(1)
      return u
    }
  }
}

@Composable
private fun markdownColors(): Markdown.Colors {
  val scheme = MaterialTheme.colorScheme
  return Markdown.Colors(
    link = scheme.primary,
    code = scheme.surfaceVariant,
    quote = scheme.onSurfaceVariant,
  )
}

@Composable
fun rememberMarkdown(text: String, links: Boolean): AnnotatedString {
  val colors = markdownColors()
  return remember(text, links, colors) { Markdown.render(text, links, colors) }
}

private sealed interface Block {
  class Prose(val text: AnnotatedString) : Block
  class Grid(val align: List<Markdown.Align>, val rows: List<List<AnnotatedString>>) : Block // header first
  class Code(val text: String) : Block
  class Image(val alt: String, val url: String) : Block
}

// A message body with its tables, code blocks and images laid out as blocks. Use
// rememberMarkdown where the text has to be one string, like a preview cut to a few lines.
@Composable
fun MarkdownText(text: String, links: Boolean, style: TextStyle, modifier: Modifier = Modifier) {
  val colors = markdownColors()
  val blocks = remember(text, links, colors) {
    Markdown.parts(text).mapNotNull { part ->
      when (part) {
        is Markdown.Part.Prose ->
          part.text.takeIf { it.isNotBlank() }?.let { Block.Prose(Markdown.render(it, links, colors)) }
        is Markdown.Part.Grid -> Block.Grid(
          part.table.align,
          (listOf(part.table.header) + part.table.rows).map { row -> row.map { Markdown.renderInline(it, links, colors) } },
        )
        is Markdown.Part.Code -> Block.Code(part.text)
        is Markdown.Part.Image -> Block.Image(part.alt, part.url)
      }
    }
  }
  Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    for (block in blocks) when (block) {
      is Block.Prose -> Text(block.text, style = style)
      is Block.Grid -> Grid(block, style)
      is Block.Code -> CodeBlock(block.text, style)
      is Block.Image -> key(block.url) { MessageImage(block.alt, block.url, style) }
    }
  }
}

// Lines keep their indentation and don't wrap; a long one scrolls sideways.
@Composable
private fun CodeBlock(text: String, style: TextStyle) {
  val mono = style.copy(fontFamily = FontFamily.Monospace)
  Text(
    text,
    style = if (style.fontSize.isSpecified && style.lineHeight.isSpecified) {
      mono.copy(fontSize = style.fontSize * 0.85f, lineHeight = style.lineHeight * 0.85f)
    } else {
      mono
    },
    softWrap = false,
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(10.dp))
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .horizontalScroll(rememberScrollState())
      .padding(12.dp),
  )
}

// An https image, fit to the width. Until it loads, or if it can't, the alt text stands in.
@Composable
private fun MessageImage(alt: String, url: String, style: TextStyle) {
  val bitmap by produceState(Images.cached(url), url) { if (value == null) value = Images.load(url) }
  val image = bitmap
  if (image != null) {
    Image(
      image,
      contentDescription = alt.ifBlank { null },
      contentScale = ContentScale.FillWidth,
      modifier = Modifier
        .widthIn(max = (image.width / LocalDensity.current.density).dp)
        .fillMaxWidth()
        .clip(RoundedCornerShape(10.dp)),
    )
  } else {
    Text(alt.ifBlank { "Image" }, style = style.copy(fontStyle = FontStyle.Italic), color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

// Downloads message images, kept in memory so scrolling back doesn't fetch them again.
private object Images {
  private const val MAX_BYTES = 10 shl 20
  private const val MAX_SIDE = 2048
  private val cache = object : LruCache<String, ImageBitmap>(32 shl 20) {
    override fun sizeOf(key: String, value: ImageBitmap) = value.asAndroidBitmap().byteCount
  }

  fun cached(url: String): ImageBitmap? = cache.get(url)

  suspend fun load(url: String): ImageBitmap? = withContext(Dispatchers.IO) {
    if (!Markdown.isSafeImage(url)) return@withContext null
    runCatching {
      val connection = URL(url).openConnection() as HttpURLConnection
      connection.connectTimeout = 10_000
      connection.readTimeout = 15_000
      val bytes = try {
        connection.inputStream.use { input ->
          val out = ByteArrayOutputStream()
          val buffer = ByteArray(16 shl 10)
          while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            out.write(buffer, 0, n)
            if (out.size() > MAX_BYTES) return@runCatching null
          }
          out.toByteArray()
        }
      } finally {
        connection.disconnect()
      }
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
      var sample = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_SIDE) sample *= 2
      val options = BitmapFactory.Options().apply { inSampleSize = sample }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
    }.getOrNull()?.also { cache.put(url, it) }
  }
}

// Cells don't wrap; a table wider than the screen scrolls sideways.
@Composable
private fun Grid(grid: Block.Grid, style: TextStyle) {
  val scheme = MaterialTheme.colorScheme
  val line = scheme.outlineVariant
  val shape = RoundedCornerShape(8.dp)
  val columns = grid.align.size
  Layout(
    content = {
      grid.rows.forEachIndexed { r, row ->
        row.forEachIndexed { c, cell ->
          Box(
            Modifier
              .background(if (r == 0) scheme.surfaceVariant else Color.Transparent)
              .drawBehind {
                val stroke = 1.dp.toPx()
                if (r > 0) drawLine(line, Offset(0f, 0f), Offset(size.width, 0f), stroke)
                if (c > 0) drawLine(line, Offset(0f, 0f), Offset(0f, size.height), stroke)
              }
              .padding(horizontal = 12.dp, vertical = 6.dp),
            contentAlignment = when (grid.align[c]) {
              Markdown.Align.START -> Alignment.CenterStart
              Markdown.Align.CENTER -> Alignment.Center
              Markdown.Align.END -> Alignment.CenterEnd
            },
          ) {
            Text(cell, style = if (r == 0) style.copy(fontWeight = FontWeight.Bold) else style, softWrap = false)
          }
        }
      }
    },
    modifier = Modifier
      .clip(shape)
      .border(1.dp, line, shape)
      .horizontalScroll(rememberScrollState()),
  ) { measurables, _ ->
    // Each column as wide as its widest cell, each row as tall as its tallest.
    val widths = IntArray(columns)
    measurables.forEachIndexed { i, m -> widths[i % columns] = maxOf(widths[i % columns], m.maxIntrinsicWidth(Constraints.Infinity)) }
    val heights = measurables.chunked(columns).map { row -> row.withIndex().maxOf { (c, m) -> m.minIntrinsicHeight(widths[c]) } }
    val placeables = measurables.mapIndexed { i, m -> m.measure(Constraints.fixed(widths[i % columns], heights[i / columns])) }
    layout(widths.sum(), heights.sum()) {
      var y = 0
      placeables.chunked(columns).forEachIndexed { r, row ->
        var x = 0
        row.forEachIndexed { c, p ->
          p.place(x, y)
          x += widths[c]
        }
        y += heights[r]
      }
    }
  }
}
