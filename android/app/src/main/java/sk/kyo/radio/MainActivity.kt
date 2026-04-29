package sk.kyo.radio

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.IBinder
import android.widget.FrameLayout
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.audio.CustomAudioEffect
import com.pedro.library.rtmp.RtmpOnlyAudio

class MainActivity : AppCompatActivity(), ConnectChecker {

    private lateinit var tvStatus: TextView
    private lateinit var statusCircle: FrameLayout
    private lateinit var btnStart: MaterialButton
    private lateinit var btnStop: MaterialButton
    private lateinit var seekVolume: SeekBar

    private var stream: RtmpOnlyAudio? = null
    private var serviceConn: ServiceConnection? = null

    // Slider 0–100 → gain 0–16x (50 = 8x default)
    private var gainMultiplier = 8.0f

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
        btnStop     = findViewById(R.id.btnStop)
        seekVolume  = findViewById(R.id.seekVolume)

        seekVolume.progress = 50
        gainMultiplier = 8.0f

        btnStart.setOnClickListener { checkPermissionAndStart() }
        btnStop.setOnClickListener  { stopStream() }

        seekVolume.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                gainMultiplier = progress / 100.0f * 16.0f
            }
            override fun onStartTrackingTouch(sb: SeekBar) {}
            override fun onStopTrackingTouch(sb: SeekBar) {}
        })

        setState(State.OFFLINE)
    }

    // ── State ────────────────────────────────────────────────────────────────

    private enum class State { OFFLINE, CONNECTING, LIVE, ERROR }

    private fun setState(state: State, error: String = "") = runOnUiThread {
        when (state) {
            State.OFFLINE -> {
                tvStatus.text = "OFFLINE"
                tvStatus.setTextColor(0xFFFF6600.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_offline)
                btnStart.isEnabled = true
                setStopEnabled(false)
            }
            State.CONNECTING -> {
                tvStatus.text = "CONNECTING"
                tvStatus.setTextColor(0xFF00AA00.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_connecting)
                btnStart.isEnabled = false
                setStopEnabled(false)
            }
            State.LIVE -> {
                tvStatus.text = "LIVE"
                tvStatus.setTextColor(0xFF00FF00.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_live)
                btnStart.isEnabled = false
                setStopEnabled(true)
            }
            State.ERROR -> {
                tvStatus.text = if (error.isNotEmpty()) error.take(10) else "ERROR"
                tvStatus.setTextColor(0xFFFF4444.toInt())
                statusCircle.setBackgroundResource(R.drawable.circle_offline)
                btnStart.isEnabled = true
                setStopEnabled(false)
            }
        }
    }

    private fun setStopEnabled(enabled: Boolean) {
        btnStop.isEnabled = enabled
        val color = if (enabled) 0xFF00FF00.toInt() else 0xFF444444.toInt()
        btnStop.setTextColor(color)
        btnStop.strokeColor = android.content.res.ColorStateList.valueOf(color)
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

    private fun stopStream() {
        stream?.stopStream()
        stream = null
        serviceConn?.let { runCatching { unbindService(it) } }
        serviceConn = null
        stopService(Intent(this, BroadcastService::class.java))
        setState(State.OFFLINE)
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
