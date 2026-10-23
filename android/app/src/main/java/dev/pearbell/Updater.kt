package dev.pearbell

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject

// Checks GitHub for a newer release and installs its APK. Updates install in
// place only when the release is signed with the same key as this app.
object Updater {
  private const val LATEST = "https://api.github.com/repos/knownasilya/pearbell/releases/latest"
  private const val CHECK_EVERY = 6 * 60 * 60 * 1000L
  private const val PREFS = "updater"
  private const val TAG = "pearbell-update"

  data class Release(val version: String, val apkUrl: String, val size: Long)

  sealed interface State {
    data object Idle : State
    data class Available(val release: Release) : State
    data class Downloading(val release: Release, val progress: Float) : State
    data class Installing(val release: Release) : State
    data class Failed(val release: Release?, val error: String) : State
  }

  val state = MutableStateFlow<State>(State.Idle)
  @Volatile private var lastCheck = 0L
  @Volatile private var busy = false

  fun currentVersion(context: Context): String =
    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"

  fun autoInstall(context: Context) = prefs(context).getBoolean("auto", true)

  fun setAutoInstall(context: Context, on: Boolean) = prefs(context).edit().putBoolean("auto", on).apply()

  // Rate-limited unless forced. Installs on its own when allowed, else notifies.
  fun check(context: Context, force: Boolean = false) {
    val now = System.currentTimeMillis()
    if (busy || (!force && now - lastCheck < CHECK_EVERY)) return
    lastCheck = now
    val app = context.applicationContext

    thread(name = "update-check") {
      try {
        val release = fetchLatest() ?: return@thread
        if (!isNewer(release.version, currentVersion(app))) {
          if (state.value is State.Available || force) state.value = State.Idle
          if (force) toast(app, "pearbell ${currentVersion(app)} is up to date")
          return@thread
        }

        state.value = State.Available(release)
        if (autoInstall(app) && canInstallSilently(app)) {
          install(app, release)
        } else if (prefs(app).getString("notified", null) != release.version) {
          prefs(app).edit().putString("notified", release.version).apply()
          Notifier.showUpdate(app, release.version)
        }
      } catch (e: Exception) {
        Log.w(TAG, "Update check failed", e)
        if (force) state.value = State.Failed(null, e.message ?: "Could not reach GitHub")
      }
    }
  }

  fun install(context: Context, release: Release) {
    if (busy) return
    busy = true
    val app = context.applicationContext

    thread(name = "update-install") {
      try {
        state.value = State.Downloading(release, 0f)
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
          setAppPackageName(app.packageName)
          if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)

        installer.openSession(id).use { session ->
          val conn = URL(release.apkUrl).openConnection() as HttpURLConnection
          conn.connectTimeout = 15_000
          conn.readTimeout = 30_000
          val total = conn.contentLengthLong.takeIf { it > 0 } ?: release.size

          conn.inputStream.use { input ->
            session.openWrite("pearbell.apk", 0, total).use { out ->
              val buf = ByteArray(64 * 1024)
              var done = 0L
              var lastShown = 0f
              while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                done += n
                val p = if (total > 0) done.toFloat() / total else 0f
                if (p - lastShown >= 0.02f) {
                  lastShown = p
                  state.value = State.Downloading(release, p)
                }
              }
              session.fsync(out)
            }
          }

          state.value = State.Installing(release)
          val intent = Intent(app, UpdateReceiver::class.java).putExtra(EXTRA_VERSION, release.version)
          val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
          session.commit(PendingIntent.getBroadcast(app, id, intent, flags).intentSender)
        }
      } catch (e: Exception) {
        Log.w(TAG, "Update install failed", e)
        fail(release, e.message ?: "Download failed")
      }
    }
  }

  internal fun fail(release: Release?, error: String) {
    busy = false
    state.value = State.Failed(release, error)
  }

  internal fun done() {
    busy = false
    state.value = State.Idle
  }

  private fun fetchLatest(): Release? {
    val conn = URL(LATEST).openConnection() as HttpURLConnection
    conn.connectTimeout = 15_000
    conn.readTimeout = 15_000
    conn.setRequestProperty("Accept", "application/vnd.github+json")
    if (conn.responseCode != 200) return null

    val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
    val assets = json.optJSONArray("assets") ?: return null
    for (i in 0 until assets.length()) {
      val a = assets.getJSONObject(i)
      if (a.optString("name").endsWith(".apk")) {
        return Release(json.getString("tag_name").removePrefix("v"), a.getString("browser_download_url"), a.optLong("size"))
      }
    }
    return null
  }

  // Android 12+ skips the prompt when this app installed itself last time.
  private fun canInstallSilently(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < 31) return false
    val source = context.packageManager.getInstallSourceInfo(context.packageName)
    return source.installingPackageName == context.packageName
  }

  // "0.2.0" > "0.1.0", and a release beats a dev build of the same number.
  fun isNewer(candidate: String, current: String): Boolean {
    fun parts(v: String) = v.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
    val a = parts(candidate)
    val b = parts(current)
    for (i in 0 until maxOf(a.size, b.size)) {
      val x = a.getOrElse(i) { 0 }
      val y = b.getOrElse(i) { 0 }
      if (x != y) return x > y
    }
    return '-' in current && '-' !in candidate
  }

  private fun toast(context: Context, text: String) {
    Handler(Looper.getMainLooper()).post { Toast.makeText(context, text, Toast.LENGTH_SHORT).show() }
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  const val EXTRA_VERSION = "version"
}

// Result of an install session.
class UpdateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val version = intent.getStringExtra(Updater.EXTRA_VERSION) ?: ""
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        @Suppress("DEPRECATION")
        val confirm = (if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
          intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }) ?: return
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // Works while the app is open; from the background, the notification does it.
        try {
          context.startActivity(confirm)
        } catch (e: Exception) {
          Log.w("pearbell-update", "Could not open the install prompt", e)
        }
        Notifier.showInstallPrompt(context, version, confirm)
      }
      PackageInstaller.STATUS_SUCCESS -> {
        Notifier.cancelUpdate(context)
        Updater.done()
      }
      else -> {
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val why = if (status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE) {
          "This build is signed with a different key. Uninstall pearbell, then install the new APK by hand."
        } else {
          message ?: "Install failed ($status)"
        }
        Notifier.cancelUpdate(context)
        Updater.fail(null, why)
      }
    }
  }
}
