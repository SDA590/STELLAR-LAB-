#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "secrets.h"

// ESP32 DevKit V1 / WROOM-32 de 38 pines + AD8232.
// GPIO 34 pertenece a ADC1 y puede utilizarse mientras Wi-Fi está activo.
constexpr uint8_t ECG_PIN = 34;
constexpr uint8_t LO_PLUS_PIN = 32;
constexpr uint8_t LO_MINUS_PIN = 33;

constexpr uint16_t SAMPLE_RATE_HZ = 250;
constexpr TickType_t SAMPLE_PERIOD = pdMS_TO_TICKS(1000 / SAMPLE_RATE_HZ);
constexpr uint32_t SEND_PERIOD_MS = 1000;
constexpr uint32_t REFRACTORY_MS = 300;
constexpr uint32_t WARMUP_MS = 2500;
constexpr uint8_t EDR_CAPACITY = 40;
constexpr uint8_t EDR_MIN_BEATS = 12;
constexpr uint32_t EDR_MIN_WINDOW_MS = 18000;

struct EcgState {
  uint16_t raw = 0;
  float filtered = 0;
  float threshold = 90;
  float heartRateBpm = 0;
  uint16_t respRaw = 2048;
  float respirationRateBpm = 0;
  bool respirationValid = false;
  bool leadsOff = true;
  uint32_t sampleCount = 0;
};

EcgState ecgState;
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
WiFiClientSecure secureClient;

float baseline = 2048;
float lowPass = 0;
float envelope = 90;
bool peakActive = false;
float peakMagnitude = 0;
uint32_t peakTimeMs = 0;
uint32_t peakStartedMs = 0;
uint32_t lastBeatMs = 0;
uint32_t leadsConnectedSinceMs = 0;
float intervalsMs[5] = {0, 0, 0, 0, 0};
uint8_t intervalCount = 0;
uint8_t intervalIndex = 0;
uint32_t edrTimesMs[EDR_CAPACITY] = {0};
float edrAmplitudes[EDR_CAPACITY] = {0};
uint8_t edrCount = 0;
uint16_t derivedRespRaw = 2048;
float derivedRespirationRate = 0;
bool derivedRespirationValid = false;

bool credentialsConfigured() {
  return strcmp(WIFI_SSID, "TU_RED_WIFI") != 0 &&
         strcmp(WIFI_PASSWORD, "TU_CLAVE_WIFI") != 0 &&
         strcmp(SUPABASE_KEY, "sb_publishable_PEGAR_AQUI") != 0;
}

void resetBeatDetector(uint16_t raw) {
  baseline = raw;
  lowPass = 0;
  envelope = 90;
  peakActive = false;
  peakMagnitude = 0;
  peakTimeMs = 0;
  peakStartedMs = 0;
  lastBeatMs = 0;
  intervalCount = 0;
  intervalIndex = 0;
  edrCount = 0;
  derivedRespRaw = 2048;
  derivedRespirationRate = 0;
  derivedRespirationValid = false;
}

float averageHeartRate() {
  if (intervalCount < 2) return 0;
  float total = 0;
  for (uint8_t i = 0; i < intervalCount; ++i) total += intervalsMs[i];
  return total > 0 ? 60000.0f / (total / intervalCount) : 0;
}

void updateDerivedRespiration(uint32_t beatMs, float amplitude) {
  if (edrCount < EDR_CAPACITY) {
    edrTimesMs[edrCount] = beatMs;
    edrAmplitudes[edrCount] = amplitude;
    ++edrCount;
  } else {
    for (uint8_t i = 1; i < EDR_CAPACITY; ++i) {
      edrTimesMs[i - 1] = edrTimesMs[i];
      edrAmplitudes[i - 1] = edrAmplitudes[i];
    }
    edrTimesMs[EDR_CAPACITY - 1] = beatMs;
    edrAmplitudes[EDR_CAPACITY - 1] = amplitude;
  }

  float mean = 0;
  for (uint8_t i = 0; i < edrCount; ++i) mean += edrAmplitudes[i];
  mean /= edrCount;

  float variance = 0;
  for (uint8_t i = 0; i < edrCount; ++i) {
    const float centered = edrAmplitudes[i] - mean;
    variance += centered * centered;
  }

  const float standardDeviation = sqrtf(variance / max(1, (int)edrCount));
  const float normalizedLatest = standardDeviation > 1 ?
      (edrAmplitudes[edrCount - 1] - mean) / standardDeviation : 0;
  derivedRespRaw = constrain(
      (int)lroundf(2048 + constrain(normalizedLatest, -3.0f, 3.0f) * 450),
      0, 4095);

  const uint32_t windowMs = edrTimesMs[edrCount - 1] - edrTimesMs[0];
  if (edrCount < EDR_MIN_BEATS || windowMs < EDR_MIN_WINDOW_MS || variance < 1) {
    derivedRespirationValid = false;
    derivedRespirationRate = 0;
    return;
  }

  // Periodograma sobre muestras irregulares: busca entre 6 y 30 respiraciones/min.
  float bestRate = 0;
  float bestQuality = 0;
  const float originMs = edrTimesMs[0];
  for (float candidate = 6.0f; candidate <= 30.0f; candidate += 0.5f) {
    const float frequencyHz = candidate / 60.0f;
    float cosineProjection = 0;
    float sineProjection = 0;
    for (uint8_t i = 0; i < edrCount; ++i) {
      const float seconds = (edrTimesMs[i] - originMs) / 1000.0f;
      const float phase = TWO_PI * frequencyHz * seconds;
      const float centered = edrAmplitudes[i] - mean;
      cosineProjection += centered * cosf(phase);
      sineProjection += centered * sinf(phase);
    }
    const float quality =
        (cosineProjection * cosineProjection + sineProjection * sineProjection) /
        (variance * edrCount);
    if (quality > bestQuality) {
      bestQuality = quality;
      bestRate = candidate;
    }
  }

  derivedRespirationValid = bestQuality >= 0.18f;
  derivedRespirationRate = derivedRespirationValid ? bestRate : 0;
}

void registerHeartbeat(uint32_t beatMs, float amplitude) {
  if (lastBeatMs != 0) {
    const uint32_t interval = beatMs - lastBeatMs;
    if (interval >= 300 && interval <= 1715) {
      intervalsMs[intervalIndex] = interval;
      intervalIndex = (intervalIndex + 1) % 5;
      if (intervalCount < 5) ++intervalCount;
    }
  }
  lastBeatMs = beatMs;
  updateDerivedRespiration(beatMs, amplitude);
}

void processEcgSample(uint16_t raw, bool leadsOff, uint32_t nowMs) {
  if (leadsOff) {
    leadsConnectedSinceMs = 0;
    resetBeatDetector(raw);
    portENTER_CRITICAL(&stateMux);
    ecgState.raw = raw;
    ecgState.filtered = 0;
    ecgState.threshold = 90;
    ecgState.heartRateBpm = 0;
    ecgState.respRaw = 2048;
    ecgState.respirationRateBpm = 0;
    ecgState.respirationValid = false;
    ecgState.leadsOff = true;
    ++ecgState.sampleCount;
    portEXIT_CRITICAL(&stateMux);
    return;
  }

  if (leadsConnectedSinceMs == 0) {
    leadsConnectedSinceMs = nowMs;
    resetBeatDetector(raw);
  }

  // Elimina lentamente la línea base y suaviza ruido de alta frecuencia.
  baseline += 0.002f * (raw - baseline);
  const float centered = raw - baseline;
  lowPass += 0.20f * (centered - lowPass);

  // Umbral adaptativo para distintos niveles de contacto y módulos AD8232.
  envelope = max(fabsf(lowPass), envelope * 0.998f);
  const float threshold = max(90.0f, envelope * 0.55f);
  const float magnitude = fabsf(lowPass);

  if (nowMs - leadsConnectedSinceMs > WARMUP_MS && !peakActive &&
      magnitude > threshold &&
      (lastBeatMs == 0 || nowMs - lastBeatMs >= REFRACTORY_MS)) {
    peakActive = true;
    peakMagnitude = magnitude;
    peakTimeMs = nowMs;
    peakStartedMs = nowMs;
  } else if (peakActive) {
    if (magnitude > peakMagnitude) {
      peakMagnitude = magnitude;
      peakTimeMs = nowMs;
    }
    if (magnitude < threshold * 0.40f || nowMs - peakStartedMs > 220) {
      registerHeartbeat(peakTimeMs, peakMagnitude);
      peakActive = false;
    }
  }

  const float bpm = averageHeartRate();
  portENTER_CRITICAL(&stateMux);
  ecgState.raw = raw;
  ecgState.filtered = lowPass;
  ecgState.threshold = threshold;
  ecgState.heartRateBpm = bpm;
  ecgState.respRaw = derivedRespRaw;
  ecgState.respirationRateBpm = derivedRespirationRate;
  ecgState.respirationValid = derivedRespirationValid;
  ecgState.leadsOff = false;
  ++ecgState.sampleCount;
  portEXIT_CRITICAL(&stateMux);
}

void ecgTask(void* parameter) {
  TickType_t lastWake = xTaskGetTickCount();
  for (;;) {
    const uint16_t raw = analogRead(ECG_PIN);
    const bool leadsOff = digitalRead(LO_PLUS_PIN) == HIGH ||
                          digitalRead(LO_MINUS_PIN) == HIGH;
    processEcgSample(raw, leadsOff, millis());
    vTaskDelayUntil(&lastWake, SAMPLE_PERIOD);
  }
}

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Conectando Wi-Fi");
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 12000) {
    delay(300);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi conectado. IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.println("Wi-Fi no disponible; se reintentará.");
  return false;
}

bool sendEcgTelemetry(const EcgState& snapshot) {
  if (!connectWiFi()) return false;

  JsonDocument doc;
  doc["astronaut_id"] = ASTRONAUT_ID;
  doc["device_id"] = DEVICE_ID;
  doc["ecg_raw"] = snapshot.raw;
  if (snapshot.heartRateBpm >= 25 && snapshot.heartRateBpm <= 240) {
    doc["heart_rate_bpm"] = roundf(snapshot.heartRateBpm * 10) / 10;
  } else {
    doc["heart_rate_bpm"] = nullptr;
  }
  doc["leads_off"] = snapshot.leadsOff;
  doc["resp_raw"] = snapshot.respRaw;
  if (snapshot.respirationValid) {
    doc["respiration_rate_bpm"] =
        roundf(snapshot.respirationRateBpm * 10) / 10;
  } else {
    doc["respiration_rate_bpm"] = nullptr;
  }
  doc["ax"] = 0; doc["ay"] = 0; doc["az"] = 0;
  doc["gx"] = 0; doc["gy"] = 0; doc["gz"] = 0;
  doc["pos_x_m"] = 0; doc["pos_y_m"] = 0; doc["area_m2"] = 0;
  doc["steps"] = 0;
  doc["battery_pct"] = 100;
  doc["timestamp_ms"] = millis();

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(secureClient, SUPABASE_URL)) {
    Serial.println("No se pudo iniciar HTTPS.");
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  const int code = http.POST(body);
  if (code == 201) {
    if (snapshot.respirationValid) {
      Serial.printf("ECG enviado | raw=%u | bpm=%.1f | resp=%.1f | electrodos=%s\n",
                    snapshot.raw, snapshot.heartRateBpm,
                    snapshot.respirationRateBpm,
                    snapshot.leadsOff ? "OFF" : "OK");
    } else {
      Serial.printf("ECG enviado | raw=%u | bpm=%.1f | resp=calculando | electrodos=%s\n",
                    snapshot.raw, snapshot.heartRateBpm,
                    snapshot.leadsOff ? "OFF" : "OK");
    }
  } else {
    Serial.printf("Error Supabase %d: %s\n", code, http.getString().c_str());
  }
  http.end();
  return code == 201;
}

void networkTask(void* parameter) {
  for (;;) {
    EcgState snapshot;
    portENTER_CRITICAL(&stateMux);
    snapshot = ecgState;
    portEXIT_CRITICAL(&stateMux);
    sendEcgTelemetry(snapshot);
    vTaskDelay(pdMS_TO_TICKS(SEND_PERIOD_MS));
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\nSTELLAR ECG Node v1.0");

  if (!credentialsConfigured()) {
    Serial.println("ERROR: copia secrets.example.h como secrets.h y completa Wi-Fi/Supabase.");
    while (true) delay(1000);
  }

  pinMode(ECG_PIN, INPUT);
  pinMode(LO_PLUS_PIN, INPUT);
  pinMode(LO_MINUS_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(ECG_PIN, ADC_11db);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  secureClient.setInsecure();  // Prototipo: cifra HTTPS, pero no valida el certificado.

  xTaskCreatePinnedToCore(ecgTask, "ecg-250hz", 4096, nullptr, 3, nullptr, 1);
  xTaskCreatePinnedToCore(networkTask, "supabase-1hz", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  // El trabajo se divide en dos tareas para que HTTPS no interrumpa el ECG.
  delay(1000);
}
