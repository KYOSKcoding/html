package sk.kyo.radio

import android.Manifest
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.widget.CheckBox
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
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
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity(), ConnectChecker {

    private lateinit var tvStatus: TextView
    private lateinit var statusCircle: FrameLayout
    private lateinit var btnStart: MaterialButton
    private lateinit var btnSettings: MaterialButton
    private lateinit var seekVolume: SeekBar
    private lateinit var levelMeter: ProgressBar

    private var stream: RtmpOnlyAudio? = null
    private var serviceConn: ServiceConnection? = null
    private var currentState: State = State.OFFLINE

    // Slider 0–100 → ±20dB (50 = 0dB default)
    private var gainMultiplier = 1.0f

    // ── Audio constants — must match prepareAudio() below ─────────────────────
    private val sampleRate = 44100
    private val channels = 1            // prepareAudio(..., isStereo = false)
    private val bitsPerSample = 16

    // ── Live level meter — peak written by the audio thread, read by the UI ──
    @Volatile private var meterPeak = 0f
    private val uiHandler = Handler(Looper.getMainLooper())
    private var meterDisplayed = 0
    private val meterTick = object : Runnable {
        override fun run() {
            val peak = meterPeak
            meterPeak = 0f
            val db = if (peak > 0f) 20.0 * Math.log10(peak.toDouble()) else -96.0
            // -24..0 dBFS over the bar: green ends ~-12 dBFS, orange mid, red near clip.
            val target = (((db + 24.0) / 24.0) * 100).coerceIn(0.0, 100.0).toInt()
            // Snappy rise, smooth fall.
            meterDisplayed = if (target >= meterDisplayed) target else maxOf(target, meterDisplayed - 4)
            levelMeter.progress = meterDisplayed
            uiHandler.postDelayed(this, 40)   // ~25 Hz
        }
    }

    // ── Local .wav recording ─────────────────────────────────────────────────
    @Volatile private var wavOut: BufferedOutputStream? = null
    @Volatile private var wavBytes = 0L
    private var wavFile: File? = null

    // ── Reconnect ─────────────────────────────────────────────────────────────
    private var streamWanted = false
    private var reconnectAttempts = 0
    private val maxReconnects = 5

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
            var peakInBuffer = 0f
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
                val ra = if (result < 0f) -result else result
                if (ra > peakInBuffer) peakInBuffer = ra

                val outInt = (result * 32767f).toInt()
                out[i]     = (outInt and 0xFF).toByte()
                out[i + 1] = ((outInt shr 8) and 0xFF).toByte()
                i += 2
            }
            // Meter + local recording — must never break the audio path.
            try {
                if (peakInBuffer > meterPeak) meterPeak = peakInBuffer
                val w = wavOut
                if (w != null) {
                    w.write(out)
                    wavBytes += out.size.toLong()
                }
            } catch (e: Exception) {
                stopWavRecording()   // disk full / I/O error — drop recording, keep streaming
            }
            return out
        }
    }

    private val rtmpUrl = "rtmp://kyo.sk:45860/live/stream"

    // Notification "Stop" action — MainActivity owns the stream object.
    private val stopReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (currentState == State.LIVE || currentState == State.CONNECTING) stopStream()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus    = findViewById(R.id.tvStatus)
        statusCircle = findViewById(R.id.statusCircle)
        btnStart    = findViewById(R.id.btnStart)
        btnSettings = findViewById(R.id.btnSettings)
        seekVolume  = findViewById(R.id.seekVolume)
        levelMeter  = findViewById(R.id.levelMeter)

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

        val filter = IntentFilter(BroadcastService.ACTION_STOP)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(stopReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(stopReceiver, filter)
        }

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
                stopMeter()
            }
            State.CONNECTING -> {
                tvStatus.text = "CONNECTING"
                tvStatus.setTextColor(0xFF888888.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_connecting)
                btnStart.text = "● CONNECTING…"
                btnStart.isEnabled = false
                startMeter()
            }
            State.LIVE -> {
                tvStatus.text = "LIVE"
                tvStatus.setTextColor(0xFFFF4444.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_live)
                btnStart.text = "■ STOP"
                btnStart.isEnabled = true
                startMeter()
            }
            State.ERROR -> {
                tvStatus.text = if (error.isNotEmpty()) error.take(10) else "ERROR"
                tvStatus.setTextColor(0xFFFF4444.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_offline)
                btnStart.text = "▶ GO LIVE"
                btnStart.isEnabled = true
                stopMeter()
            }
        }
    }

    // ── Level meter ───────────────────────────────────────────────────────────

    private fun startMeter() {
        uiHandler.removeCallbacks(meterTick)
        uiHandler.post(meterTick)
    }

    private fun stopMeter() {
        uiHandler.removeCallbacks(meterTick)
        meterDisplayed = 0
        meterPeak = 0f
        levelMeter.progress = 0
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
        streamWanted = true
        reconnectAttempts = 0

        // Streaming on background thread — send password directly as X-Broadcaster-Token
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

            // Best-effort: the server's start-radio-hls.sh also flips live mode
            // on RTMP connect, so a failed call here must not abort the broadcast.
            notifyLiveStart(serverUrl, password)

            runOnUiThread {
                val svcIntent = Intent(this, BroadcastService::class.java)
                ContextCompat.startForegroundService(this, svcIntent)
                val conn = object : ServiceConnection {
                    override fun onServiceConnected(n: ComponentName?, b: IBinder?) {}
                    override fun onServiceDisconnected(n: ComponentName?) {}
                }
                serviceConn = conn
                bindService(svcIntent, conn, Context.BIND_AUTO_CREATE)

                if (prefs.getBoolean("record_wav", true)) startWavRecording()

                val s = RtmpOnlyAudio(this)
                s.setCustomAudioEffect(gainEffect)
                s.prepareAudio(128_000, sampleRate, false)
                s.startStream(rtmpUrl)
                stream = s
            }
        }.start()
    }

    private fun stopStream() {
        streamWanted = false
        stream?.stopStream()
        stream = null
        stopWavRecording()   // stream stopped first — no concurrent process() writes
        serviceConn?.let { runCatching { unbindService(it) } }
        serviceConn = null
        stopService(Intent(this, BroadcastService::class.java))
        setState(State.OFFLINE)

        Thread {
            val prefs = getSharedPreferences("kyo_radio", MODE_PRIVATE)
            val serverUrl = prefs.getString("server_url", "https://kyo.sk/kyosky") ?: return@Thread
            val password = prefs.getString("broadcaster_password", "") ?: return@Thread
            notifyLiveStop(serverUrl, password)
        }.start()
    }

    /** Final give-up after reconnects are exhausted — caller already set ERROR. */
    private fun cleanupAfterFailure() {
        streamWanted = false
        stream = null
        stopWavRecording()
        serviceConn?.let { runCatching { unbindService(it) } }
        serviceConn = null
        stopService(Intent(this, BroadcastService::class.java))
    }

    // ── Local .wav recording ──────────────────────────────────────────────────

    private fun startWavRecording() {
        try {
            val dir = File(getExternalFilesDir(null), "recordings")
            dir.mkdirs()
            val ts = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
            val f = File(dir, "kyo_$ts.wav")
            val os = BufferedOutputStream(FileOutputStream(f))
            os.write(wavHeader(0))   // placeholder sizes — patched on stop
            wavFile = f
            wavBytes = 0L
            wavOut = os
        } catch (e: Exception) {
            wavOut = null
            wavFile = null
        }
    }

    private fun stopWavRecording() {
        val os = wavOut ?: return
        wavOut = null
        try { os.flush(); os.close() } catch (e: Exception) {}
        val f = wavFile ?: return
        wavFile = null
        try {
            val dataLen = wavBytes.toInt()
            RandomAccessFile(f, "rw").use { raf ->
                raf.seek(4);  raf.write(leInt(36 + dataLen))   // RIFF chunk size
                raf.seek(40); raf.write(leInt(dataLen))        // data chunk size
            }
        } catch (e: Exception) {}
    }

    private fun leInt(v: Int) = byteArrayOf(
        (v and 0xFF).toByte(),
        ((v shr 8) and 0xFF).toByte(),
        ((v shr 16) and 0xFF).toByte(),
        ((v shr 24) and 0xFF).toByte()
    )

    private fun leShort(v: Int) = byteArrayOf(
        (v and 0xFF).toByte(),
        ((v shr 8) and 0xFF).toByte()
    )

    private fun wavHeader(dataLen: Int): ByteArray {
        val byteRate = sampleRate * channels * bitsPerSample / 8
        val blockAlign = channels * bitsPerSample / 8
        val h = ByteArrayOutputStream(44)
        h.write("RIFF".toByteArray()); h.write(leInt(36 + dataLen)); h.write("WAVE".toByteArray())
        h.write("fmt ".toByteArray()); h.write(leInt(16)); h.write(leShort(1))   // PCM
        h.write(leShort(channels)); h.write(leInt(sampleRate)); h.write(leInt(byteRate))
        h.write(leShort(blockAlign)); h.write(leShort(bitsPerSample))
        h.write("data".toByteArray()); h.write(leInt(dataLen))
        return h.toByteArray()
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
        val recordCheck = CheckBox(this).apply {
            text = "Record .wav locally while streaming"
            isChecked = prefs.getBoolean("record_wav", true)
        }
        view.addView(urlInput, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        view.addView(passInput, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = 20
        })
        view.addView(recordCheck, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
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
                        putBoolean("record_wav", recordCheck.isChecked)
                        apply()
                    }
                } else {
                    setState(State.ERROR, "Invalid settings")
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun notifyLiveStart(serverUrl: String, password: String): Boolean {
        return try {
            val conn = URL("$serverUrl/api/radio/live/start").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("X-Broadcaster-Token", password)
            conn.responseCode == 200
        } catch (e: Exception) {
            false
        }
    }

    private fun notifyLiveStop(serverUrl: String, password: String): Boolean {
        return try {
            val conn = URL("$serverUrl/api/radio/live/stop").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("X-Broadcaster-Token", password)
            conn.responseCode == 200
        } catch (e: Exception) {
            false
        }
    }

    // ── ConnectChecker ────────────────────────────────────────────────────────

    override fun onConnectionStarted(url: String) = setState(State.CONNECTING)

    override fun onConnectionSuccess() {
        reconnectAttempts = 0
        setState(State.LIVE)
    }

    override fun onDisconnect() {
        if (!streamWanted) setState(State.OFFLINE)
    }

    override fun onConnectionFailed(reason: String) {
        // Auto-reconnect through transient network drops; the .wav file and the
        // foreground service stay alive so one broadcast remains one recording.
        if (streamWanted && stream != null && reconnectAttempts < maxReconnects) {
            reconnectAttempts++
            setState(State.CONNECTING)
            uiHandler.postDelayed({
                val s = stream
                if (streamWanted && s != null) {
                    try {
                        s.stopStream()
                        s.startStream(rtmpUrl)
                    } catch (e: Exception) {
                        setState(State.ERROR, "reconnect")
                        cleanupAfterFailure()
                    }
                }
            }, 5000)
        } else {
            setState(State.ERROR, reason)
            cleanupAfterFailure()
        }
    }

    override fun onAuthError()         { setState(State.ERROR, "auth") }
    override fun onAuthSuccess()       {}
    override fun onNewBitrate(b: Long) {}

    override fun onDestroy() {
        stopStream()
        uiHandler.removeCallbacksAndMessages(null)
        runCatching { unregisterReceiver(stopReceiver) }
        super.onDestroy()
    }
}
