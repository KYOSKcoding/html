# Android — add broadcaster password auth

## Goal
Add a one-time password setup and auth check before RTMP streaming starts.
The streaming itself (RtmpOnlyAudio + CustomAudioEffect) is **not changed**.

---

## TODO

### 1. `app/src/main/res/layout/activity_main.xml`
Add a ⚙ Settings button after the seek bar tick-labels LinearLayout:
```xml
<com.google.android.material.button.MaterialButton
    android:id="@+id/btnSettings"
    style="@style/Widget.MaterialComponents.Button.OutlinedButton"
    android:layout_width="wrap_content"
    android:layout_height="wrap_content"
    android:text="⚙ Settings"
    android:textColor="#00aa00"
    android:textSize="11sp"
    android:fontFamily="monospace"
    app:strokeColor="#444444"
    app:strokeWidth="1dp"
    app:backgroundTint="@android:color/transparent"
    android:layout_marginTop="32dp" />
```

---

### 2. `app/src/main/java/sk/kyo/radio/MainActivity.kt`

#### Add imports
```kotlin
import android.app.AlertDialog
import android.widget.LinearLayout
import com.google.android.material.textfield.TextInputEditText
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
```

#### Add field
```kotlin
private lateinit var btnSettings: MaterialButton
```

#### In `onCreate()` — add after existing view bindings
```kotlin
btnSettings = findViewById(R.id.btnSettings)
btnSettings.setOnClickListener { showSettingsDialog() }
checkAndShowSetupDialog()
```

#### Add method: first-run check
```kotlin
private fun checkAndShowSetupDialog() {
    val prefs = getSharedPreferences("kyo_radio", MODE_PRIVATE)
    if (!prefs.contains("broadcaster_password")) showSettingsDialog()
}
```

#### Add method: settings dialog
```kotlin
private fun showSettingsDialog() {
    val prefs = getSharedPreferences("kyo_radio", MODE_PRIVATE)
    val currentUrl  = prefs.getString("server_url", "https://kyo.sk/kyosky") ?: "https://kyo.sk/kyosky"
    val currentPass = prefs.getString("broadcaster_password", "") ?: ""

    val view = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(40, 40, 40, 40)
    }
    val urlInput = TextInputEditText(this).apply { setText(currentUrl);  hint = "Server URL" }
    val passInput = TextInputEditText(this).apply {
        setText(currentPass); hint = "Broadcaster Password"
        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
    }
    view.addView(urlInput,  LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    view.addView(passInput, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = 20 })

    AlertDialog.Builder(this)
        .setTitle("Broadcaster Settings")
        .setView(view)
        .setPositiveButton("Save") { _, _ ->
            val url  = urlInput.text.toString().trim()
            val pass = passInput.text.toString().trim()
            if (url.isNotEmpty() && pass.isNotEmpty()) {
                prefs.edit().putString("server_url", url).putString("broadcaster_password", pass).apply()
            } else {
                setState(State.ERROR, "Invalid settings")
            }
        }
        .setNegativeButton("Cancel", null)
        .show()
}
```

#### Add method: auth check
```kotlin
private fun authenticate(serverUrl: String, password: String): Boolean {
    return try {
        val conn = URL("$serverUrl/api/radio/auth").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        conn.outputStream.use { it.write(JSONObject().put("password", password).toString().toByteArray()) }
        if (conn.responseCode == 200) {
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            JSONObject(body).optBoolean("authenticated", false)
        } else false
    } catch (e: Exception) { false }
}
```

#### Modify `startStream()` — wrap existing code in auth check on background thread
Replace the body of `startStream()` with:
```kotlin
private fun startStream() {
    setState(State.CONNECTING)
    Thread {
        val prefs     = getSharedPreferences("kyo_radio", MODE_PRIVATE)
        val serverUrl = prefs.getString("server_url", "https://kyo.sk/kyosky") ?: return@Thread
        val password  = prefs.getString("broadcaster_password", "") ?: return@Thread
        if (!authenticate(serverUrl, password)) {
            setState(State.ERROR, "auth")
            stopService(Intent(this, BroadcastService::class.java))
            return@Thread
        }
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
```

---

## Verification
1. `./gradlew assembleDebug` — clean build
2. First install → settings dialog auto-appears
3. Enter `https://kyo.sk/kyosky` + broadcaster password → Save
4. Tap Go Live → CONNECTING → LIVE (RTMP stream starts)
5. Open `https://kyo.sk/radio` in browser → listener switches to live HLS
6. Tap Stop → OFFLINE, playlist resumes
7. Tap ⚙ Settings → can update password/URL
