package sk.kyo.radio

import android.Manifest
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.IBinder
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.audio.CustomAudioEffect
import com.pedro.library.rtmp.RtmpOnlyAudio
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : AppCompatActivity(), ConnectChecker {

    private lateinit var tvStatus: TextView
    private lateinit var statusCircle: FrameLayout
    private lateinit var btnStart: MaterialButton
    private lateinit var btnSettings: MaterialButton
    private lateinit var seekVolume: SeekBar

    private var stream: RtmpOnlyAudio? = null
    private var serviceConn: ServiceConnection? = null
    private var broadcasterToken: String? = null
    private var currentState: State = State.OFFLINE

    // Slider 0–100 → ±20dB (50 = 0dB default)
    private var gainMultiplier = 1.0f

    private val gainEffect = object : CustomAudioEffect() {
        // Downward compressor: tames peaks so makeup gain lifts the average
        private var env = 0f
        private val attackCoef  = (1.0 - Math.exp(-1.0 / (44100.0 * 0.005))).toFloat()  // 5 ms
        private val releaseCoef = (1.0 - Math.exp(-1.0 / (44100.0 * 0.200))).toFloat()  // 200 ms
        private val threshold   = 0.25f   // -12 dBFS
        private val ratio       = 4f
        private val makeupGain  = 2.5f    // +8 dB

        override fun process(pcm: ByteArray): ByteArray {
            val out = ByteArray(pcm.size)
            var i = 0
            while (i < pcm.size - 1) {
                val lo = pcm[i].toInt() and 0xFF
                val hi = pcm[i + 1].toInt()
                val sample = ((hi shl 8) or lo) / 32768f

                val gained = sample * gainMultiplier
                val absIn  = if (gained < 0f) -gained else gained

                env = if (absIn > env)
                    (1f - attackCoef) * env + attackCoef * absIn
                else
                    (1f - releaseCoef) * env

                val gr = if (env > threshold)
                    Math.pow((threshold / env).toDouble(), 1.0 - 1.0 / ratio).toFloat()
                else 1f

                val result = (gained * gr * makeupGain).coerceIn(-1f, 1f)
                val outInt = (result * 32767f).toInt()
                out[i]     = (outInt and 0xFF).toByte()
                out[i + 1] = ((outInt shr 8) and 0xFF).toByte()
                i += 2
            }
            return out
        }
    }

    private val rtmpUrl = "rtmp://kyo.sk:45860/live/stream"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus    = findViewById(R.id.tvStatus)
        statusCircle = findViewById(R.id.statusCircle)
        btnStart    = findViewById(R.id.btnStart)
        btnSettings = findViewById(R.id.btnSettings)
        seekVolume  = findViewById(R.id.seekVolume)

        seekVolume.progress = 50
        gainMultiplier = 1.0f

        btnStart.setOnClickListener {
            if (currentState == State.LIVE) stopStream() else checkPermissionAndStart()
        }
        btnSettings.setOnClickListener { showSettingsDialog() }

        seekVolume.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                val dB = (progress - 50) / 50.0 * 20.0
                gainMultiplier = Math.pow(10.0, dB / 20.0).toFloat()
            }
            override fun onStartTrackingTouch(sb: SeekBar) {}
            override fun onStopTrackingTouch(sb: SeekBar) {}
        })

        checkAndShowSetupDialog()
        setState(State.OFFLINE)
    }

    // ── State ────────────────────────────────────────────────────────────────

    private enum class State { OFFLINE, CONNECTING, LIVE, ERROR }

    private fun setState(state: State, error: String = "") = runOnUiThread {
        currentState = state
        when (state) {
            State.OFFLINE -> {
                tvStatus.text = "OFFLINE"
                tvStatus.setTextColor(0xFF888888.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_offline)
                btnStart.text = "▶ GO LIVE"
                btnStart.isEnabled = true
            }
            State.CONNECTING -> {
                tvStatus.text = "CONNECTING"
                tvStatus.setTextColor(0xFF888888.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_connecting)
                btnStart.text = "● CONNECTING…"
                btnStart.isEnabled = false
            }
            State.LIVE -> {
                tvStatus.text = "LIVE"
                tvStatus.setTextColor(0xFFFF4444.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_live)
                btnStart.text = "■ STOP"
                btnStart.isEnabled = true
            }
            State.ERROR -> {
                tvStatus.text = if (error.isNotEmpty()) error.take(10) else "ERROR"
                tvStatus.setTextColor(0xFFFF4444.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_offline)
                btnStart.text = "▶ GO LIVE"
                btnStart.isEnabled = true
            }
        }
    }

    // ── Streaming ─────────────────────────────────────────────────────────────

    private fun checkPermissionAndStart() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 100)
        } else {
            startStream()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            startStream()
        } else {
            setState(State.ERROR, "mic denied")
        }
    }

    private fun startStream() {
        setState(State.CONNECTING)

        // Auth + streaming on background thread
        Thread {
            val prefs     = getSharedPreferences("kyo_radio", MODE_PRIVATE)
            val serverUrl = prefs.getString("server_url", "https://kyo.sk/kyosky") ?: run {
                setState(State.ERROR, "no url")
                stopService(Intent(this, BroadcastService::class.java))
                return@Thread
            }
            val password  = prefs.getString("broadcaster_password", "") ?: run {
                setState(State.ERROR, "no pwd")
                stopService(Intent(this, BroadcastService::class.java))
                return@Thread
            }

            if (!authenticate(serverUrl, password)) {
                setState(State.ERROR, "auth")
                stopService(Intent(this, BroadcastService::class.java))
                return@Thread
            }

            if (!notifyLiveStart(serverUrl)) {
                setState(State.ERROR, "live")
                stopService(Intent(this, BroadcastService::class.java))
                return@Thread
            }

            // Auth passed — start streaming on UI thread
            runOnUiThread {
                val svcIntent = Intent(this, BroadcastService::class.java)
                ContextCompat.startForegroundService(this, svcIntent)
                val conn = object : ServiceConnection {
                    override fun onServiceConnected(n: ComponentName?, b: IBinder?) {}
                    override fun onServiceDisconnected(n: ComponentName?) {}
                }
                serviceConn = conn
                bindService(svcIntent, conn, Context.BIND_AUTO_CREATE)

                val s = RtmpOnlyAudio(this)
                s.setCustomAudioEffect(gainEffect)
                s.prepareAudio(128_000, 44100, false)
                s.startStream(rtmpUrl)
                stream = s
            }
        }.start()
    }

    private fun stopStream() {
        stream?.stopStream()
        stream = null
        serviceConn?.let { runCatching { unbindService(it) } }
        serviceConn = null
        stopService(Intent(this, BroadcastService::class.java))
        setState(State.OFFLINE)

        Thread {
            val prefs = getSharedPreferences("kyo_radio", MODE_PRIVATE)
            val serverUrl = prefs.getString("server_url", "https://kyo.sk/kyosky") ?: return@Thread
            notifyLiveStop(serverUrl)
            broadcasterToken = null
        }.start()
    }

    // ── Settings & Auth ──────────────────────────────────────────────────────

    private fun checkAndShowSetupDialog() {
        val prefs = getSharedPreferences("kyo_radio", MODE_PRIVATE)
        if (!prefs.contains("broadcaster_password")) {
            showSettingsDialog()
        }
    }

    private fun showSettingsDialog() {
        val prefs = getSharedPreferences("kyo_radio", MODE_PRIVATE)
        val currentUrl  = prefs.getString("server_url", "https://kyo.sk/kyosky") ?: "https://kyo.sk/kyosky"
        val currentPass = prefs.getString("broadcaster_password", "") ?: ""

        val view = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 40, 40, 40)
        }
        val urlInput = TextInputEditText(this).apply {
            setText(currentUrl)
            hint = "Server URL"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        val passInput = TextInputEditText(this).apply {
            setText(currentPass)
            hint = "Broadcaster Password"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        view.addView(urlInput, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        view.addView(passInput, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = 20
        })

        AlertDialog.Builder(this)
            .setTitle("Broadcaster Settings")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                val url  = urlInput.text.toString().trim()
                val pass = passInput.text.toString().trim()
                if (url.isNotEmpty() && pass.isNotEmpty()) {
                    prefs.edit().apply {
                        putString("server_url", url)
                        putString("broadcaster_password", pass)
                        apply()
                    }
                } else {
                    setState(State.ERROR, "Invalid settings")
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun authenticate(serverUrl: String, password: String): Boolean {
        return try {
            val conn = URL("$serverUrl/api/radio/auth").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            val body = JSONObject().put("password", password).toString()
            conn.outputStream.use { it.write(body.toByteArray()) }
            if (conn.responseCode == 200) {
                val response = conn.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(response)
                val authenticated = json.optBoolean("authenticated", false)
                if (authenticated) {
                    broadcasterToken = json.optString("token", null)
                }
                authenticated
            } else false
        } catch (e: Exception) {
            false
        }
    }

    private fun notifyLiveStart(serverUrl: String): Boolean {
        return try {
            val conn = URL("$serverUrl/api/radio/live/start").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            if (broadcasterToken != null) {
                conn.setRequestProperty("X-Broadcaster-Token", broadcasterToken!!)
            }
            conn.responseCode == 200
        } catch (e: Exception) {
            false
        }
    }

    private fun notifyLiveStop(serverUrl: String): Boolean {
        return try {
            val conn = URL("$serverUrl/api/radio/live/stop").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            if (broadcasterToken != null) {
                conn.setRequestProperty("X-Broadcaster-Token", broadcasterToken!!)
            }
            conn.responseCode == 200
        } catch (e: Exception) {
            false
        }
    }

    // ── ConnectChecker ────────────────────────────────────────────────────────

    override fun onConnectionStarted(url: String) = setState(State.CONNECTING)
    override fun onConnectionSuccess()             = setState(State.LIVE)
    override fun onDisconnect()                    = setState(State.OFFLINE)

    override fun onConnectionFailed(reason: String) {
        setState(State.ERROR, reason)
        stopService(Intent(this, BroadcastService::class.java))
        stream = null
    }

    override fun onAuthError()         { setState(State.ERROR, "auth") }
    override fun onAuthSuccess()       {}
    override fun onNewBitrate(b: Long) {}

    override fun onDestroy() {
        stopStream()
        super.onDestroy()
    }
}
