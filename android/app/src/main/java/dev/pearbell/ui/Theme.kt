package dev.pearbell.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Light = lightColorScheme(
  primary = Color(0xFF4A6400),
  onPrimary = Color(0xFFFFFFFF),
  primaryContainer = Color(0xFFD8EE96),
  onPrimaryContainer = Color(0xFF141F00),
  secondary = Color(0xFF5A6147),
  secondaryContainer = Color(0xFFE6EBD0),
  onSecondaryContainer = Color(0xFF181D0A),
  tertiary = Color(0xFF8A5A00),
  tertiaryContainer = Color(0xFFFFE2B5),
  onTertiaryContainer = Color(0xFF2C1A00),
  background = Color(0xFFF5F6EF),
  onBackground = Color(0xFF1A1C16),
  surface = Color(0xFFF5F6EF),
  onSurface = Color(0xFF1A1C16),
  surfaceVariant = Color(0xFFE3E5D8),
  onSurfaceVariant = Color(0xFF5B5F51),
  surfaceContainerLowest = Color(0xFFFFFFFF),
  surfaceContainerLow = Color(0xFFFFFFFF),
  surfaceContainer = Color(0xFFEDEFE5),
  surfaceContainerHigh = Color(0xFFE7E9DF),
  outline = Color(0xFF8A8E7F),
  outlineVariant = Color(0xFFD5D8C9),
  error = Color(0xFFB3261E),
  errorContainer = Color(0xFFF9DEDC),
)

private val Dark = darkColorScheme(
  primary = Color(0xFFC3E36A),
  onPrimary = Color(0xFF213000),
  primaryContainer = Color(0xFF2F3F0C),
  onPrimaryContainer = Color(0xFFDCF39B),
  secondary = Color(0xFFC2C9AA),
  secondaryContainer = Color(0xFF2A3020),
  onSecondaryContainer = Color(0xFFDEE5C4),
  tertiary = Color(0xFFF5BE63),
  tertiaryContainer = Color(0xFF3A2A0C),
  onTertiaryContainer = Color(0xFFFFDDA8),
  background = Color(0xFF0E120C),
  onBackground = Color(0xFFE3E5DA),
  surface = Color(0xFF0E120C),
  onSurface = Color(0xFFE3E5DA),
  surfaceVariant = Color(0xFF262B21),
  onSurfaceVariant = Color(0xFFA9AE9C),
  surfaceContainerLowest = Color(0xFF0A0D08),
  surfaceContainerLow = Color(0xFF161B13),
  surfaceContainer = Color(0xFF1B2118),
  surfaceContainerHigh = Color(0xFF22291E),
  outline = Color(0xFF747A69),
  outlineVariant = Color(0xFF353B2F),
  error = Color(0xFFF2B8B5),
  errorContainer = Color(0xFF5C1B16),
)

private val Type = Typography().run {
  copy(
    displaySmall = displaySmall.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp),
    headlineMedium = headlineMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp),
    titleLarge = titleLarge.copy(fontWeight = FontWeight.SemiBold),
    titleMedium = titleMedium.copy(fontWeight = FontWeight.SemiBold),
    labelLarge = labelLarge.copy(fontWeight = FontWeight.SemiBold),
  )
}

private val AppShapes = Shapes(
  small = RoundedCornerShape(10.dp),
  medium = RoundedCornerShape(18.dp),
  large = RoundedCornerShape(26.dp),
)

val Mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp)

// Colors outside the Material roles.
@Immutable
data class Extra(val online: Color, val offline: Color, val avatars: List<Color>)

val LocalExtra = staticCompositionLocalOf {
  Extra(Color.Green, Color.Gray, listOf(Color.Gray))
}

@Composable
fun PearbellTheme(content: @Composable () -> Unit) {
  val dark = isSystemInDarkTheme()
  val extra = if (dark) {
    Extra(
      online = Color(0xFFC3E36A),
      offline = Color(0xFF6B7062),
      avatars = listOf(0xFF3E5216, 0xFF1F4B4A, 0xFF4F3A62, 0xFF5E3D20, 0xFF2D4466, 0xFF5A2E3A).map(::Color),
    )
  } else {
    Extra(
      online = Color(0xFF5E8A00),
      offline = Color(0xFF9EA294),
      avatars = listOf(0xFFD8EE96, 0xFFC4EBE6, 0xFFE6D8F2, 0xFFF6DCC2, 0xFFD3E0F5, 0xFFF3D3DA).map(::Color),
    )
  }
  androidx.compose.runtime.CompositionLocalProvider(LocalExtra provides extra) {
    MaterialTheme(colorScheme = if (dark) Dark else Light, typography = Type, shapes = AppShapes, content = content)
  }
}

// A round badge with the first letter of a name, colored by the name.
@Composable
fun Avatar(name: String, size: Dp = 40.dp) {
  val palette = LocalExtra.current.avatars
  val color = palette[(name.hashCode() and 0x7fffffff) % palette.size]
  val letter = initials(name)
  Box(
    Modifier.size(size).background(color, CircleShape),
    contentAlignment = Alignment.Center
  ) {
    Text(
      letter,
      style = MaterialTheme.typography.titleMedium.copy(fontSize = (size.value * (if (letter.length > 1) 0.36f else 0.42f)).sp),
      color = MaterialTheme.colorScheme.onSurface
    )
  }
}

@Composable
fun StatusDot(online: Boolean, size: Dp = 8.dp) {
  val extra = LocalExtra.current
  Box(Modifier.size(size).background(if (online) extra.online else extra.offline, CircleShape))
}

// "Claude Code" -> "CC", "GitHub Actions" -> "GA", "codex" -> "C".
fun initials(name: String): String {
  val words = name.split(' ', '-', '_', '.').filter { w -> w.any { it.isLetterOrDigit() } }
  val letters = words.take(2).mapNotNull { w -> w.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar() }
  return if (letters.isEmpty()) "•" else letters.joinToString("")
}
