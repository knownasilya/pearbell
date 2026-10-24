package dev.pearbell.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.em

// A small Markdown renderer for message bodies: **bold**, *italic*, `code`,
// ~~strike~~, [links](https://…), bare URLs, headings, lists, task lists
// (- [ ] and - [x]), quotes and fenced code. Only http(s) and mailto links become tappable, so a message
// cannot launch other apps through odd URL schemes.
object Markdown {
  data class Colors(val link: Color, val code: Color, val quote: Color)

  private val Plain = Colors(Color.Unspecified, Color.Unspecified, Color.Unspecified)

  fun render(text: String, links: Boolean, colors: Colors = Plain): AnnotatedString =
    buildAnnotatedString { Renderer(this, links, colors).blocks(text) }

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

  private class Renderer(val out: AnnotatedString.Builder, val links: Boolean, val colors: Colors) {
    private var started = false
    private var pendingBlank = false
    private var nested = 0 // > 0 while rendering a link's label

    fun blocks(text: String) {
      val lines = text.replace("\r\n", "\n").split('\n')
      var i = 0
      while (i < lines.size) {
        val line = lines[i]

        if (line.trimStart().startsWith("```")) {
          val code = mutableListOf<String>()
          i++
          while (i < lines.size && !lines[i].trimStart().startsWith("```")) code += lines[i++]
          i++ // closing fence
          newLine()
          out.withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = colors.code)) {
            append(code.joinToString("\n"))
          }
          continue
        }

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
        if (c == '\\' && i + 1 < s.length && s[i + 1] in "\\`*_~[]()<>#") {
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
fun rememberMarkdown(text: String, links: Boolean): AnnotatedString {
  val scheme = MaterialTheme.colorScheme
  val colors = Markdown.Colors(
    link = scheme.primary,
    code = scheme.surfaceVariant,
    quote = scheme.onSurfaceVariant,
  )
  return remember(text, links, colors) { Markdown.render(text, links, colors) }
}
