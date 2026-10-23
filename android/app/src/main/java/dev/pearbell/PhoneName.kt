package dev.pearbell

import android.content.Context
import android.os.Build
import android.provider.Settings

// The name paired computers show for this phone. Defaults to the device name
// set in Android's settings ("Ilya's Pixel"), then the model ("Pixel 8").
object PhoneName {
  private const val PREFS = "phone"

  fun get(context: Context): String =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("name", null)
      ?.takeIf { it.isNotBlank() } ?: default(context)

  fun default(context: Context): String =
    Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
      ?: Build.MODEL?.takeIf { it.isNotBlank() }
      ?: "Android phone"

  fun set(context: Context, name: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("name", clean(name)).apply()
  }

  fun clean(name: String) = name.trim().take(64)
}
