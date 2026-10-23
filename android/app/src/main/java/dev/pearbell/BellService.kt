package dev.pearbell

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import org.json.JSONObject
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet

// Keeps the Bare worklet (and so the DHT server) alive in the background.
// Android needs a foreground service for that; the "remoteMessaging" type
// fits: it carries text messages from another device.
class BellService : Service() {
  private var worklet: Worklet? = null
  private var ipc: IPC? = null
  private val inbox = ByteArrayOutputStream()
  private val outbox = ArrayDeque<ByteBuffer>()
  private var writing = false
  private val ticker = Handler(Looper.getMainLooper())
  private val checkUpdates = object : Runnable {
    override fun run() {
      Updater.check(this@BellService)
      ticker.postDelayed(this, 60 * 60 * 1000L)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    Notifier.createChannels(this)

    goForeground()

    startWorklet()
    ticker.post(checkUpdates)
  }

  // Android wants startForeground() after every startForegroundService(), not
  // only the first; the app starts us on launch, on replies and after updates.
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    goForeground()
    return START_STICKY
  }

  private fun goForeground() {
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
    startForeground(Notifier.SERVICE_ID, Notifier.serviceNotification(this, Hub.peers.value), type)
  }

  override fun onDestroy() {
    ticker.removeCallbacks(checkUpdates)
    Hub.detach()
    ipc?.close()
    worklet?.terminate()
    ipc = null
    worklet = null
    super.onDestroy()
  }

  private fun startWorklet() {
    val w = Worklet(Worklet.Options())
    w.start("/app.bundle", assets.open("app.bundle"), null)

    // The IPC only gets a working pipe once the worklet runs.
    val channel = IPC(w)
    worklet = w
    ipc = channel
    channel.readable { drain() }

    write(JSONObject().put("type", "init").put("dir", filesDir.absolutePath).put("name", PhoneName.get(this)))
    Hub.attach { write(it) }
  }

  // Read whatever the worklet wrote and split it into JSON lines.
  private fun drain() {
    val channel = ipc ?: return
    while (true) {
      val data = channel.read() ?: break
      if (data.limit() == 0) {
        Log.w(TAG, "Worklet closed its IPC")
        Hub.online.value = false
        channel.readable(null)
        break
      }
      val bytes = ByteArray(data.remaining())
      data.get(bytes)
      inbox.write(bytes)
    }

    val buf = inbox.toByteArray()
    var start = 0
    for (i in buf.indices) {
      if (buf[i] != '\n'.code.toByte()) continue
      val line = String(buf, start, i - start, Charsets.UTF_8)
      start = i + 1
      if (line.isNotBlank()) {
        try {
          onEvent(JSONObject(line))
        } catch (e: Exception) {
          Log.e(TAG, "Bad event from worklet: $line", e)
        }
      }
    }
    inbox.reset()
    inbox.write(buf, start, buf.size - start)
  }

  private fun write(obj: JSONObject) {
    val bytes = (obj.toString() + "\n").toByteArray(Charsets.UTF_8)
    val buf = ByteBuffer.allocateDirect(bytes.size)
    buf.put(bytes)
    buf.flip()
    outbox.addLast(buf)
    pump()
  }

  // IPC.write(data, callback) in Bare Kit 2.5.5 crashes when the pipe is not
  // ready (write returns -2), so drive the plain write ourselves: -1 means
  // closed, other negatives mean "wait for writable".
  private fun pump() {
    val channel = ipc ?: return
    while (outbox.isNotEmpty()) {
      val next = outbox.first()
      val n = channel.write(next.slice())
      if (n == -1) {
        Log.e(TAG, "IPC closed, dropping ${outbox.size} commands")
        outbox.clear()
        break
      }
      if (n < 0) break
      next.position(next.position() + n)
      if (next.hasRemaining()) break
      outbox.removeFirst()
    }

    val waiting = outbox.isNotEmpty()
    if (waiting != writing) {
      writing = waiting
      channel.writable(if (waiting) IPC.PollCallback { pump() } else null)
    }
  }

  private fun onEvent(event: JSONObject) {
    when (event.optString("type")) {
      "ready" -> {
        Hub.online.value = true
        Hub.applyState(event)
        Notifier.updateService(this, Hub.peers.value)
      }
      "state" -> {
        Hub.applyState(event)
        Notifier.updateService(this, Hub.peers.value)
      }
      "message" -> {
        val msg = Hub.parseMessage(event.getJSONObject("message"))
        Hub.upsert(msg)
        Notifier.showMessage(this, msg)
      }
      "updated" -> {
        val msg = Hub.parseMessage(event.getJSONObject("message"))
        Hub.upsert(msg)
        if (!msg.open) Notifier.cancel(this, msg.id)
      }
      "paired" -> Hub.pairing.value = Pairing.Done(event.getJSONObject("peer").optString("name"))
      "pair-error" -> Hub.pairing.value = Pairing.Failed(event.optString("error"))
      "error" -> {
        Log.e(TAG, event.optString("error"))
        Hub.lastError.value = event.optString("error")
      }
    }
  }

  companion object {
    private const val TAG = "pearbell"

    fun start(context: Context) {
      context.startForegroundService(Intent(context, BellService::class.java))
    }
  }
}
