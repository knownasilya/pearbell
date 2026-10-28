package dev.pearbell.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
  private fun links(s: AnnotatedString) =
    s.getLinkAnnotations(0, s.length).map { (it.item as LinkAnnotation.Url).url to s.text.substring(it.start, it.end) }

  @Test fun plainTextStaysTheSame() {
    assertEquals("Build finished, 42 tests pass", Markdown.plain("Build finished, 42 tests pass"))
  }

  @Test fun stripsInlineMarkup() {
    assertEquals("bold italic code strike", Markdown.plain("**bold** *italic* `code` ~~strike~~"))
  }

  @Test fun snakeCaseIsNotItalic() {
    assertEquals("run my_test_file now", Markdown.plain("run my_test_file now"))
  }

  @Test fun loneStarsStay() {
    assertEquals("2 * 3 = 6 and a*", Markdown.plain("2 * 3 = 6 and a*"))
  }

  @Test fun markdownLink() {
    val out = Markdown.render("See [PR #42](https://github.com/o/r/pull/42) now", links = true)
    assertEquals("See PR #42 now", out.text)
    assertEquals(listOf("https://github.com/o/r/pull/42" to "PR #42"), links(out))
  }

  @Test fun bareUrlTrimsPunctuation() {
    val out = Markdown.render("Done: https://example.com/a?b=1. Next", links = true)
    assertEquals(listOf("https://example.com/a?b=1" to "https://example.com/a?b=1"), links(out))
  }

  @Test fun urlInParentheses() {
    val out = Markdown.render("(see https://en.wikipedia.org/wiki/Foo_(bar)) ok", links = true)
    assertEquals(listOf("https://en.wikipedia.org/wiki/Foo_(bar)" to "https://en.wikipedia.org/wiki/Foo_(bar)"), links(out))
  }

  @Test fun unsafeSchemesAreNotLinks() {
    val out = Markdown.render("[open](intent://evil#Intent;end) [js](javascript:alert(1))", links = true)
    assertEquals("open js", out.text)
    assertTrue(links(out).isEmpty())
  }

  @Test fun noLinksWhenDisabled() {
    val out = Markdown.render("https://example.com", links = false)
    assertEquals("https://example.com", out.text)
    assertTrue(links(out).isEmpty())
  }

  @Test fun linkLabelHoldingAUrlMakesOneLink() {
    val out = Markdown.render("[https://a.com](https://b.com)", links = true)
    assertEquals(listOf("https://b.com" to "https://a.com"), links(out))
  }

  @Test fun blocks() {
    val md = "# Deploy\n\n- one\n- **two**\n1. first\n> careful\n```\nnpm test\n```"
    assertEquals("Deploy\n\n•  one\n•  two\n1.  first\ncareful\nnpm test", Markdown.plain(md))
  }

  @Test fun headingIsBold() {
    val out = Markdown.render("## Title", links = false)
    assertTrue(out.spanStyles.any { it.item.fontWeight == FontWeight.Bold && it.start == 0 && it.end == 5 })
  }

  @Test fun escapes() {
    assertEquals("*not italic* and [x]", Markdown.plain("\\*not italic\\* and \\[x\\]"))
  }

  @Test fun unclosedMarkupIsLiteral() {
    assertEquals("**open and `tick", Markdown.plain("**open and `tick"))
  }

  @Test fun taskList() {
    val md = "- [ ] build\n- [x] test\n* [X] lint\n1. [ ] ship"
    val c = Markdown.CHECKED
    val u = Markdown.UNCHECKED
    assertEquals("$u  build\n$c  test\n$c  lint\n$u  ship", Markdown.plain(md))
  }

  @Test fun doneTaskIsStruckThrough() {
    val out = Markdown.render("- [x] test", links = false)
    val start = out.text.indexOf("test")
    assertTrue(out.spanStyles.any { it.item.textDecoration == TextDecoration.LineThrough && it.start == start && it.end == start + 4 })
  }

  @Test fun bracketsWithoutATaskStayABullet() {
    assertEquals("•  [link] text", Markdown.plain("- [link] text"))
  }

  @Test fun table() {
    val md = "Results:\n\n| Suite | Passed |\n| :--- | ---: |\n| unit | **42** |\n| e2e | 7 |\n\nDone"
    val parts = Markdown.parts(md)
    assertEquals(3, parts.size)
    val table = (parts[1] as Markdown.Part.Grid).table
    assertEquals(listOf("Suite", "Passed"), table.header)
    assertEquals(listOf(Markdown.Align.START, Markdown.Align.END), table.align)
    assertEquals(listOf(listOf("unit", "**42**"), listOf("e2e", "7")), table.rows)
    assertEquals("Results:\n\nSuite | Passed\nunit | 42\ne2e | 7\n\nDone", Markdown.plain(md))
  }

  @Test fun tableWithoutOuterPipes() {
    val table = (Markdown.parts("a | b | c\n-|:-:|-\n1 | 2").single() as Markdown.Part.Grid).table
    assertEquals(Markdown.Align.CENTER, table.align[1])
    assertEquals(listOf(listOf("1", "2", "")), table.rows)
  }

  @Test fun escapedPipeStaysInTheCell() {
    val table = (Markdown.parts("| cmd |\n| --- |\n| `a \\| b` |").single() as Markdown.Part.Grid).table
    assertEquals(listOf(listOf("`a | b`")), table.rows)
  }

  @Test fun pipesWithoutADelimiterRowAreText() {
    assertEquals("a | b\nc | d", Markdown.plain("a | b\nc | d"))
    assertTrue(Markdown.parts("| a | b |\n| --- |").single() is Markdown.Part.Prose)
  }

  @Test fun tableInsideCodeIsCode() {
    val md = "```md\n| a |\n| - |\n```"
    assertEquals(listOf(Markdown.Part.Code("md", "| a |\n| - |")), Markdown.parts(md))
  }

  @Test fun imageOnItsOwnLine() {
    val parts = Markdown.parts("Chart:\n![build times](https://example.com/c.png \"title\")")
    assertEquals(Markdown.Part.Image("build times", "https://example.com/c.png"), parts[1])
    assertEquals("Chart:\nbuild times", Markdown.plain("Chart:\n![build times](https://example.com/c.png)"))
  }

  @Test fun onlyHttpsImagesLoad() {
    assertTrue(Markdown.parts("![x](http://example.com/a.png)").single() is Markdown.Part.Prose)
    assertTrue(Markdown.parts("![x](file:///etc/passwd)").single() is Markdown.Part.Prose)
  }

  @Test fun imageInsideALineIsItsAltText() {
    val out = Markdown.render("see ![the chart](https://example.com/c.png) here", links = true)
    assertEquals("see the chart here", out.text)
    assertEquals(listOf("https://example.com/c.png" to "the chart"), links(out))
  }
}
