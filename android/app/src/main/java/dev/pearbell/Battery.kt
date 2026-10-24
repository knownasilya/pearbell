package dev.pearbell

import android.content.Context
import android.os.PowerManager

// The "Stay reachable" banner: whether Android still holds pearbell to battery
// optimization, and whether the user closed the banner (undone on Computers).
object Battery {
  private const val PREFS = "battery"

  fun exempt(context: Context) =
    context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

  fun bannerHidden(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("hidden", false)

  fun setBannerHidden(context: Context, hidden: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("hidden", hidden).apply()
  }
}
