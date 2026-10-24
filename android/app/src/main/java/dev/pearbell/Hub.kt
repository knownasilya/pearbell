package dev.pearbell

import android.content.Context
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject

data class Peer(val publicKey: String, val name: String, val pairedAt: Long, val connected: Boolean)

data class Message(
  val id: String,
  val from: String,
  val fromName: String,
  val title: String,
  val topic: String,
  val body: String,
  val actions: List<String>,
  val wantsReply: Boolean,
  val receivedAt: Long,
  val answer: String?,
  val answeredAt: Long?,
  val closed: Boolean,
  val archived: Boolean,
) {
  val open get() = wantsReply && answer == null && !closed
}

sealed interface Pairing {
  data object Idle : Pairing
  data object Busy : Pairing
  data class Done(val name: String) : Pairing
  data class Failed(val error: String) : Pairing
}

// App-wide state, fed by the worklet through BellService and read by the UI.
// Commands to the worklet queue here while the service is not running.
object Hub {
  val online = MutableStateFlow(false)
  val peers = MutableStateFlow<List<Peer>>(emptyList())
  val messages = MutableStateFlow<List<Message>>(emptyList())
  val pairing = MutableStateFlow<Pairing>(Pairing.Idle)
  val lastError = MutableStateFlow<String?>(null)
  // A message to show in full, set when a notification is tapped.
  val openMessage = MutableStateFlow<String?>(null)

  private val main = Handler(Looper.getMainLooper())
  private val queue = ArrayDeque<JSONObject>()
  private var sink: ((JSONObject) -> Unit)? = null

  fun attach(send: (JSONObject) -> Unit) {
    main.post {
      sink = send
      while (queue.isNotEmpty()) send(queue.removeFirst())
    }
  }

  fun detach() {
    main.post {
      sink = null
      online.value = false
    }
  }

  fun command(type: String, vararg fields: Pair<String, Any?>) {
    val cmd = JSONObject().put("type", type)
    for ((k, v) in fields) cmd.put(k, v)
    main.post { sink?.invoke(cmd) ?: queue.addLast(cmd) }
  }

  fun pair(code: String, phoneName: String) {
    pairing.value = Pairing.Busy
    command("rename", "name" to phoneName)
    command("pair", "code" to code.trim(), "name" to phoneName)
  }

  // Save the name and tell paired computers about it.
  fun rename(context: Context, name: String) {
    PhoneName.set(context, name)
    command("rename", "name" to PhoneName.clean(name))
  }

  fun answer(id: String, text: String) = command("answer", "id" to id, "text" to text)

  fun unpair(publicKey: String) = command("unpair", "publicKey" to publicKey)

  fun clear() = command("clear")

  fun archive(id: String, archived: Boolean = true) = command("archive", "id" to id, "archived" to archived)

  fun delete(id: String) = command("delete", "id" to id)

  fun undelete(id: String) = command("undelete", "id" to id)

  fun applyState(event: JSONObject) {
    event.optJSONArray("peers")?.let { peers.value = parsePeers(it) }
    event.optJSONArray("messages")?.let { arr ->
      messages.value = (0 until arr.length()).map { parseMessage(arr.getJSONObject(it)) }
    }
  }

  fun upsert(message: Message) {
    val rest = messages.value.filter { it.id != message.id }
    messages.value = (listOf(message) + rest).sortedByDescending { it.receivedAt }
  }

  private fun parsePeers(arr: JSONArray) = (0 until arr.length()).map {
    val o = arr.getJSONObject(it)
    Peer(o.getString("publicKey"), pretty(o.optString("name")), o.optLong("pairedAt"), o.optBoolean("connected"))
  }

  // Older CLIs sent the raw host name, like "Ilyas-MacBook-Pro.local".
  private fun pretty(name: String) = name.removeSuffix(".local")

  fun parseMessage(o: JSONObject): Message {
    val actions = o.optJSONArray("actions")
    return Message(
      id = o.getString("id"),
      from = o.optString("from"),
      fromName = pretty(o.optString("fromName")),
      title = o.optString("title"),
      topic = o.optString("topic"),
      body = o.optString("body"),
      actions = if (actions == null) emptyList() else (0 until actions.length()).map { actions.getString(it) },
      wantsReply = o.optBoolean("wantsReply"),
      receivedAt = o.optLong("receivedAt"),
      answer = if (o.isNull("answer")) null else o.optString("answer"),
      answeredAt = if (o.isNull("answeredAt") || !o.has("answeredAt")) null else o.optLong("answeredAt"),
      closed = o.optBoolean("closed"),
      archived = o.optBoolean("archived"),
    )
  }
}
