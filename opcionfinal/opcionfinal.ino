#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <Wire.h>

#include "secrets.h"

// ---------- AD8232 ----------
constexpr uint8_t ECG_PIN = 34;
constexpr uint8_t LO_PLUS_PIN = 32;
constexpr uint8_t LO_MINUS_PIN = 33;

// ---------- MPU6050 ----------
constexpr uint8_t MPU6050_ADDRESS = 0x68;
constexpr uint8_t MPU_SDA_PIN = 21;
constexpr uint8_t MPU_SCL_PIN = 22;

constexpr uint16_t MPU_SAMPLE_RATE_HZ = 50;
constexpr TickType_t MPU_SAMPLE_PERIOD =
    pdMS_TO_TICKS(1000 / MPU_SAMPLE_RATE_HZ);

constexpr uint16_t MPU_CALIBRATION_SAMPLES = 250;
constexpr float STANDARD_GRAVITY = 9.80665f;
constexpr float ACCEL_SCALE_4G = 8192.0f;
constexpr float GYRO_SCALE_500DPS = 65.5f;

constexpr float MOVEMENT_ACCEL_THRESHOLD = 0.35f;
constexpr float MOVEMENT_GYRO_THRESHOLD = 8.0f;
constexpr uint32_t STATIONARY_RESET_MS = 600;
constexpr float SAFE_RADIUS_M = 2.0f;

// ---------- ECG ----------
constexpr uint16_t SAMPLE_RATE_HZ = 250;
constexpr TickType_t SAMPLE_PERIOD =
    pdMS_TO_TICKS(1000 / SAMPLE_RATE_HZ);

constexpr uint32_t SEND_PERIOD_MS = 1000;
constexpr uint32_t REFRACTORY_MS = 300;
constexpr uint32_t WARMUP_MS = 2500;

constexpr uint8_t EDR_CAPACITY = 40;
constexpr uint8_t EDR_MIN_BEATS = 12;
constexpr uint32_t EDR_MIN_WINDOW_MS = 18000;

// ---------- Valores simulados ----------
constexpr float MIN_TEMPERATURE_C = 30.0f;
constexpr float MAX_TEMPERATURE_C = 45.0f;

constexpr uint16_t MIN_SYSTOLIC_MMHG = 70;
constexpr uint16_t MAX_SYSTOLIC_MMHG = 220;

constexpr uint16_t MIN_DIASTOLIC_MMHG = 40;
constexpr uint16_t MAX_DIASTOLIC_MMHG = 140;

struct EcgState {
  uint16_t raw = 0;
  float filtered = 0;
  float threshold = 90;
  float heartRateBpm = 0;

  uint16_t respRaw = 2048;
  float respirationRateBpm = 0;
  bool respirationValid = false;

  float temperatureC = 36.7f;
  uint16_t systolicMmHg = 120;
  uint16_t diastolicMmHg = 80;

  float ax = 0;
  float ay = 0;
  float az = 0;

  float gx = 0;
  float gy = 0;
  float gz = 0;

  float posX = 0;
  float posY = 0;
  float posZ = 0;

  float distanceFromOrigin = 0;

  bool movementDetected = false;
  bool outsideSafeRadius = false;
  bool mpuReady = false;
  bool leadsOff = true;

  uint32_t sampleCount = 0;
};

EcgState ecgState;

portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;

WiFiClientSecure secureClient;
WebServer localServer(80);

bool manualSendRequested = false;
bool resetPositionRequested = false;

// ---------- Variables MPU6050 ----------
float gravityX = 0;
float gravityY = 0;
float gravityZ = STANDARD_GRAVITY;

float gyroBiasX = 0;
float gyroBiasY = 0;
float gyroBiasZ = 0;

float velocityX = 0;
float velocityY = 0;
float velocityZ = 0;

float estimatedPosX = 0;
float estimatedPosY = 0;
float estimatedPosZ = 0;

uint32_t stationarySinceMs = 0;

// ---------- Variables ECG ----------
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

// ============================================================
// CREDENCIALES
// ============================================================

bool credentialsConfigured() {
  return strcmp(WIFI_SSID, "TU_RED_WIFI") != 0 &&
         strcmp(WIFI_PASSWORD, "TU_CLAVE_WIFI") != 0 &&
         strcmp(SUPABASE_KEY, "sb_publishable_PEGAR_AQUI") != 0;
}

// ============================================================
// MPU6050
// ============================================================

bool writeMpuRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU6050_ADDRESS);
  Wire.write(reg);
  Wire.write(value);

  return Wire.endTransmission() == 0;
}

bool readMpuRegisters(
    uint8_t startRegister,
    uint8_t* buffer,
    size_t length
) {
  Wire.beginTransmission(MPU6050_ADDRESS);
  Wire.write(startRegister);

  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  const size_t received = Wire.requestFrom(
      static_cast<uint8_t>(MPU6050_ADDRESS),
      static_cast<uint8_t>(length),
      true
  );

  if (received != length) {
    return false;
  }

  for (size_t i = 0; i < length; ++i) {
    buffer[i] = Wire.read();
  }

  return true;
}

bool readMpuSample(
    float& ax,
    float& ay,
    float& az,
    float& gx,
    float& gy,
    float& gz
) {
  uint8_t data[14];

  if (!readMpuRegisters(0x3B, data, sizeof(data))) {
    return false;
  }

  auto wordAt = [&](uint8_t index) -> int16_t {
    return static_cast<int16_t>(
        (static_cast<uint16_t>(data[index]) << 8) |
        data[index + 1]
    );
  };

  const int16_t rawAx = wordAt(0);
  const int16_t rawAy = wordAt(2);
  const int16_t rawAz = wordAt(4);

  const int16_t rawGx = wordAt(8);
  const int16_t rawGy = wordAt(10);
  const int16_t rawGz = wordAt(12);

  ax = rawAx * STANDARD_GRAVITY / ACCEL_SCALE_4G;
  ay = rawAy * STANDARD_GRAVITY / ACCEL_SCALE_4G;
  az = rawAz * STANDARD_GRAVITY / ACCEL_SCALE_4G;

  gx = rawGx / GYRO_SCALE_500DPS;
  gy = rawGy / GYRO_SCALE_500DPS;
  gz = rawGz / GYRO_SCALE_500DPS;

  return true;
}

void setEstimatedPositionZero() {
  velocityX = 0;
  velocityY = 0;
  velocityZ = 0;

  estimatedPosX = 0;
  estimatedPosY = 0;
  estimatedPosZ = 0;

  stationarySinceMs = millis();

  portENTER_CRITICAL(&stateMux);

  ecgState.posX = 0;
  ecgState.posY = 0;
  ecgState.posZ = 0;

  ecgState.distanceFromOrigin = 0;
  ecgState.outsideSafeRadius = false;

  portEXIT_CRITICAL(&stateMux);
}

bool initializeMpu6050() {
  Wire.begin(MPU_SDA_PIN, MPU_SCL_PIN);
  Wire.setClock(400000);

  delay(100);

  uint8_t identity = 0;

  if (!readMpuRegisters(0x75, &identity, 1) ||
      identity != 0x68) {
    Serial.printf(
        "MPU6050 no encontrado en 0x%02X "
        "(WHO_AM_I=0x%02X).\n",
        MPU6050_ADDRESS,
        identity
    );

    return false;
  }

  // Despertar MPU6050.
  // Filtro digital.
  // Frecuencia 50 Hz.
  // Acelerómetro +/-4 g.
  // Giroscopio +/-500 grados/s.
  if (!writeMpuRegister(0x6B, 0x00) ||
      !writeMpuRegister(0x1A, 0x03) ||
      !writeMpuRegister(0x19, 19) ||
      !writeMpuRegister(0x1B, 0x08) ||
      !writeMpuRegister(0x1C, 0x08)) {
    Serial.println("No se pudo configurar el MPU6050.");
    return false;
  }

  delay(100);

  Serial.println(
      "MPU6050 detectado. "
      "NO MUEVAS el sensor durante 5 segundos..."
  );

  double sumAx = 0;
  double sumAy = 0;
  double sumAz = 0;

  double sumGx = 0;
  double sumGy = 0;
  double sumGz = 0;

  for (uint16_t i = 0; i < MPU_CALIBRATION_SAMPLES; ++i) {
    float ax;
    float ay;
    float az;

    float gx;
    float gy;
    float gz;

    if (!readMpuSample(ax, ay, az, gx, gy, gz)) {
      Serial.println(
          "Fallo de lectura durante la calibracion "
          "del MPU6050."
      );

      return false;
    }

    sumAx += ax;
    sumAy += ay;
    sumAz += az;

    sumGx += gx;
    sumGy += gy;
    sumGz += gz;

    if (i % 50 == 49) {
      Serial.print('.');
    }

    delay(1000 / MPU_SAMPLE_RATE_HZ);
  }

  Serial.println();

  gravityX = sumAx / MPU_CALIBRATION_SAMPLES;
  gravityY = sumAy / MPU_CALIBRATION_SAMPLES;
  gravityZ = sumAz / MPU_CALIBRATION_SAMPLES;

  gyroBiasX = sumGx / MPU_CALIBRATION_SAMPLES;
  gyroBiasY = sumGy / MPU_CALIBRATION_SAMPLES;
  gyroBiasZ = sumGz / MPU_CALIBRATION_SAMPLES;

  setEstimatedPositionZero();

  portENTER_CRITICAL(&stateMux);
  ecgState.mpuReady = true;
  portEXIT_CRITICAL(&stateMux);

  Serial.println(
      "Calibracion terminada. "
      "Posicion inicial guardada como X=0, Y=0, Z=0."
  );

  return true;
}

void motionTask(void* parameter) {
  TickType_t lastWake = xTaskGetTickCount();

  uint32_t previousUs = micros();
  bool previousOutside = false;

  for (;;) {
    bool resetNow = false;

    portENTER_CRITICAL(&stateMux);

    if (resetPositionRequested) {
      resetPositionRequested = false;
      resetNow = true;
    }

    portEXIT_CRITICAL(&stateMux);

    if (resetNow) {
      setEstimatedPositionZero();

      Serial.println(
          "Posicion MPU restablecida a X=0, Y=0, Z=0."
      );
    }

    float measuredAx;
    float measuredAy;
    float measuredAz;

    float measuredGx;
    float measuredGy;
    float measuredGz;

    if (!readMpuSample(
            measuredAx,
            measuredAy,
            measuredAz,
            measuredGx,
            measuredGy,
            measuredGz
        )) {
      portENTER_CRITICAL(&stateMux);
      ecgState.mpuReady = false;
      portEXIT_CRITICAL(&stateMux);

      vTaskDelayUntil(&lastWake, MPU_SAMPLE_PERIOD);
      continue;
    }

    const uint32_t nowUs = micros();

    float dt = (nowUs - previousUs) / 1000000.0f;
    previousUs = nowUs;

    dt = constrain(dt, 0.001f, 0.05f);

    // Elimina lentamente la gravedad y el offset.
    constexpr float GRAVITY_FILTER = 0.985f;

    gravityX =
        GRAVITY_FILTER * gravityX +
        (1.0f - GRAVITY_FILTER) * measuredAx;

    gravityY =
        GRAVITY_FILTER * gravityY +
        (1.0f - GRAVITY_FILTER) * measuredAy;

    gravityZ =
        GRAVITY_FILTER * gravityZ +
        (1.0f - GRAVITY_FILTER) * measuredAz;

    const float linearAx = measuredAx - gravityX;
    const float linearAy = measuredAy - gravityY;
    const float linearAz = measuredAz - gravityZ;

    const float correctedGx = measuredGx - gyroBiasX;
    const float correctedGy = measuredGy - gyroBiasY;
    const float correctedGz = measuredGz - gyroBiasZ;

    const float accelerationMagnitude = sqrtf(
        linearAx * linearAx +
        linearAy * linearAy +
        linearAz * linearAz
    );

    const float gyroMagnitude = sqrtf(
        correctedGx * correctedGx +
        correctedGy * correctedGy +
        correctedGz * correctedGz
    );

    const bool moving =
        accelerationMagnitude > MOVEMENT_ACCEL_THRESHOLD ||
        gyroMagnitude > MOVEMENT_GYRO_THRESHOLD;

    if (moving) {
      stationarySinceMs = 0;

      velocityX += linearAx * dt;
      velocityY += linearAy * dt;
      velocityZ += linearAz * dt;

      constexpr float VELOCITY_DAMPING = 0.995f;

      velocityX *= VELOCITY_DAMPING;
      velocityY *= VELOCITY_DAMPING;
      velocityZ *= VELOCITY_DAMPING;

      estimatedPosX += velocityX * dt;
      estimatedPosY += velocityY * dt;
      estimatedPosZ += velocityZ * dt;
    } else {
      if (stationarySinceMs == 0) {
        stationarySinceMs = millis();
      }

      if (millis() - stationarySinceMs >=
          STATIONARY_RESET_MS) {
        velocityX = 0;
        velocityY = 0;
        velocityZ = 0;
      }
    }

    const float distance = sqrtf(
        estimatedPosX * estimatedPosX +
        estimatedPosY * estimatedPosY +
        estimatedPosZ * estimatedPosZ
    );

    const bool outside = distance > SAFE_RADIUS_M;

    portENTER_CRITICAL(&stateMux);

    ecgState.ax = linearAx;
    ecgState.ay = linearAy;
    ecgState.az = linearAz;

    ecgState.gx = correctedGx;
    ecgState.gy = correctedGy;
    ecgState.gz = correctedGz;

    ecgState.posX = estimatedPosX;
    ecgState.posY = estimatedPosY;
    ecgState.posZ = estimatedPosZ;

    ecgState.distanceFromOrigin = distance;
    ecgState.movementDetected = moving;
    ecgState.outsideSafeRadius = outside;
    ecgState.mpuReady = true;

    portEXIT_CRITICAL(&stateMux);

    if (outside != previousOutside) {
      Serial.printf(
          "Zona MPU | distancia estimada=%.2f m | estado=%s\n",
          distance,
          outside ? "FUERA DE 2 M" : "DENTRO DE 2 M"
      );

      previousOutside = outside;
    }

    vTaskDelayUntil(&lastWake, MPU_SAMPLE_PERIOD);
  }
}

// ============================================================
// ECG Y RESPIRACIÓN ESTIMADA
// ============================================================

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
  if (intervalCount < 2) {
    return 0;
  }

  float total = 0;

  for (uint8_t i = 0; i < intervalCount; ++i) {
    total += intervalsMs[i];
  }

  return total > 0
             ? 60000.0f / (total / intervalCount)
             : 0;
}

void updateDerivedRespiration(
    uint32_t beatMs,
    float amplitude
) {
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

  for (uint8_t i = 0; i < edrCount; ++i) {
    mean += edrAmplitudes[i];
  }

  mean /= edrCount;

  float variance = 0;

  for (uint8_t i = 0; i < edrCount; ++i) {
    const float centered =
        edrAmplitudes[i] - mean;

    variance += centered * centered;
  }

  const float standardDeviation =
      sqrtf(variance / max(1, static_cast<int>(edrCount)));

  const float normalizedLatest =
      standardDeviation > 1
          ? (edrAmplitudes[edrCount - 1] - mean) /
                standardDeviation
          : 0;

  derivedRespRaw = constrain(
      static_cast<int>(
          lroundf(
              2048 +
              constrain(
                  normalizedLatest,
                  -3.0f,
                  3.0f
              ) * 450
          )
      ),
      0,
      4095
  );

  const uint32_t windowMs =
      edrTimesMs[edrCount - 1] -
      edrTimesMs[0];

  if (edrCount < EDR_MIN_BEATS ||
      windowMs < EDR_MIN_WINDOW_MS ||
      variance < 1) {
    derivedRespirationValid = false;
    derivedRespirationRate = 0;
    return;
  }

  float bestRate = 0;
  float bestQuality = 0;

  const float originMs = edrTimesMs[0];

  for (float candidate = 6.0f;
       candidate <= 30.0f;
       candidate += 0.5f) {
    const float frequencyHz =
        candidate / 60.0f;

    float cosineProjection = 0;
    float sineProjection = 0;

    for (uint8_t i = 0; i < edrCount; ++i) {
      const float seconds =
          (edrTimesMs[i] - originMs) /
          1000.0f;

      const float phase =
          TWO_PI * frequencyHz * seconds;

      const float centered =
          edrAmplitudes[i] - mean;

      cosineProjection +=
          centered * cosf(phase);

      sineProjection +=
          centered * sinf(phase);
    }

    const float quality =
        (
            cosineProjection * cosineProjection +
            sineProjection * sineProjection
        ) /
        (variance * edrCount);

    if (quality > bestQuality) {
      bestQuality = quality;
      bestRate = candidate;
    }
  }

  derivedRespirationValid =
      bestQuality >= 0.18f;

  derivedRespirationRate =
      derivedRespirationValid
          ? bestRate
          : 0;
}

void registerHeartbeat(
    uint32_t beatMs,
    float amplitude
) {
  if (lastBeatMs != 0) {
    const uint32_t interval =
        beatMs - lastBeatMs;

    if (interval >= 300 &&
        interval <= 1715) {
      intervalsMs[intervalIndex] =
          interval;

      intervalIndex =
          (intervalIndex + 1) % 5;

      if (intervalCount < 5) {
        ++intervalCount;
      }
    }
  }

  lastBeatMs = beatMs;

  updateDerivedRespiration(
      beatMs,
      amplitude
  );
}

void processEcgSample(
    uint16_t raw,
    bool leadsOff,
    uint32_t nowMs
) {
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

  baseline +=
      0.002f * (raw - baseline);

  const float centered =
      raw - baseline;

  lowPass +=
      0.20f * (centered - lowPass);

  envelope =
      max(fabsf(lowPass), envelope * 0.998f);

  const float threshold =
      max(90.0f, envelope * 0.55f);

  const float magnitude =
      fabsf(lowPass);

  if (
      nowMs - leadsConnectedSinceMs > WARMUP_MS &&
      !peakActive &&
      magnitude > threshold &&
      (
          lastBeatMs == 0 ||
          nowMs - lastBeatMs >= REFRACTORY_MS
      )
  ) {
    peakActive = true;
    peakMagnitude = magnitude;
    peakTimeMs = nowMs;
    peakStartedMs = nowMs;
  } else if (peakActive) {
    if (magnitude > peakMagnitude) {
      peakMagnitude = magnitude;
      peakTimeMs = nowMs;
    }

    if (
        magnitude < threshold * 0.40f ||
        nowMs - peakStartedMs > 220
    ) {
      registerHeartbeat(
          peakTimeMs,
          peakMagnitude
      );

      peakActive = false;
    }
  }

  const float bpm =
      averageHeartRate();

  portENTER_CRITICAL(&stateMux);

  ecgState.raw = raw;
  ecgState.filtered = lowPass;
  ecgState.threshold = threshold;
  ecgState.heartRateBpm = bpm;

  ecgState.respRaw = derivedRespRaw;
  ecgState.respirationRateBpm =
      derivedRespirationRate;

  ecgState.respirationValid =
      derivedRespirationValid;

  ecgState.leadsOff = false;
  ++ecgState.sampleCount;

  portEXIT_CRITICAL(&stateMux);
}

void ecgTask(void* parameter) {
  TickType_t lastWake =
      xTaskGetTickCount();

  for (;;) {
    const uint16_t raw =
        analogRead(ECG_PIN);

    const bool leadsOff =
        digitalRead(LO_PLUS_PIN) == HIGH ||
        digitalRead(LO_MINUS_PIN) == HIGH;

    processEcgSample(
        raw,
        leadsOff,
        millis()
    );

    vTaskDelayUntil(
        &lastWake,
        SAMPLE_PERIOD
    );
  }
}

// ============================================================
// WIFI
// ============================================================

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  WiFi.disconnect();
  WiFi.begin(
      WIFI_SSID,
      WIFI_PASSWORD
  );

  Serial.print("Conectando Wi-Fi");

  const uint32_t started =
      millis();

  while (
      WiFi.status() != WL_CONNECTED &&
      millis() - started < 12000
  ) {
    delay(300);
    Serial.print('.');
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi conectado. IP: ");
    Serial.println(WiFi.localIP());

    return true;
  }

  Serial.println(
      "Wi-Fi no disponible; se reintentara."
  );

  return false;
}

// ============================================================
// SERVIDOR WEB LOCAL
// ============================================================

String dashboardHtml(
    const EcgState& snapshot,
    bool saved
) {
  String page;
  page.reserve(4800);

  page += F(
      "<!doctype html>"
      "<html lang='es'>"
      "<head>"
      "<meta charset='utf-8'>"
      "<meta name='viewport' "
      "content='width=device-width,initial-scale=1'>"
      "<title>STELLAR Vitals</title>"
      "<style>"
      "*{box-sizing:border-box}"
      "body{"
      "margin:0;"
      "background:#04111d;"
      "color:#eef7ff;"
      "font-family:Arial,sans-serif;"
      "min-height:100vh;"
      "display:grid;"
      "place-items:center;"
      "padding:20px"
      "}"
      "main{"
      "width:min(520px,100%);"
      "background:#091c2b;"
      "border:1px solid #1a506d;"
      "border-radius:20px;"
      "padding:24px;"
      "box-shadow:0 20px 60px #0008"
      "}"
      "h1{"
      "margin:0 0 6px;"
      "color:#71ddff;"
      "font-size:25px"
      "}"
      ".sub{"
      "color:#8cb1c7;"
      "margin:0 0 22px"
      "}"
      ".grid{"
      "display:grid;"
      "grid-template-columns:1fr 1fr;"
      "gap:14px"
      "}"
      "label{"
      "display:block;"
      "color:#a9c9da;"
      "font-size:13px"
      "}"
      ".wide{grid-column:1/-1}"
      "input{"
      "width:100%;"
      "margin-top:7px;"
      "padding:12px;"
      "border:1px solid #2c617a;"
      "border-radius:10px;"
      "background:#061521;"
      "color:white;"
      "font-size:17px"
      "}"
      "button{"
      "width:100%;"
      "margin-top:20px;"
      "padding:14px;"
      "border:0;"
      "border-radius:11px;"
      "background:#20c997;"
      "color:#001a16;"
      "font-weight:800;"
      "font-size:15px;"
      "cursor:pointer"
      "}"
      ".secondary{"
      "background:#1d4960;"
      "color:#eaffff"
      "}"
      ".saved{"
      "background:#123d36;"
      "color:#7fffd4;"
      "padding:10px;"
      "border-radius:9px;"
      "margin-bottom:16px"
      "}"
      ".motion{"
      "margin-top:20px;"
      "padding:16px;"
      "background:#061521;"
      "border-radius:12px;"
      "line-height:1.8"
      "}"
      ".alert{color:#ff7373}"
      ".safe{color:#7fffd4}"
      ".status{"
      "margin-top:18px;"
      "padding-top:16px;"
      "border-top:1px solid #1a4055;"
      "color:#8cb1c7;"
      "font-size:13px"
      "}"
      ".value{color:#fff}"
      "</style>"
      "</head>"
      "<body>"
      "<main>"
      "<h1>STELLAR Vitals</h1>"
      "<p class='sub'>"
      "Simulador manual del ESP32"
      "</p>"
  );

  if (saved) {
    page += F(
        "<div class='saved'>"
        "Datos actualizados y preparados "
        "para el servidor principal."
        "</div>"
    );
  }

  page += F(
      "<form method='post' action='/set'>"
      "<div class='grid'>"
      "<label class='wide'>"
      "Temperatura corporal (C)"
      "<input "
      "name='temperature' "
      "type='number' "
      "min='30' "
      "max='45' "
      "step='0.1' "
      "required "
      "value='"
  );

  page += String(
      snapshot.temperatureC,
      1
  );

  page += F(
      "'></label>"
      "<label>"
      "Presion sistolica (mmHg)"
      "<input "
      "name='systolic' "
      "type='number' "
      "min='70' "
      "max='220' "
      "step='1' "
      "required "
      "value='"
  );

  page += String(
      snapshot.systolicMmHg
  );

  page += F(
      "'></label>"
      "<label>"
      "Presion diastolica (mmHg)"
      "<input "
      "name='diastolic' "
      "type='number' "
      "min='40' "
      "max='140' "
      "step='1' "
      "required "
      "value='"
  );

  page += String(
      snapshot.diastolicMmHg
  );

  page += F(
      "'></label>"
      "</div>"
      "<button type='submit'>"
      "APLICAR Y ENVIAR DATOS"
      "</button>"
      "</form>"
  );

  page += F(
      "<div class='motion'>"
      "<strong>Movimiento estimado</strong>"
      "<br>X: <span class='value'>"
  );

  page += String(snapshot.posX, 2);

  page += F(
      " m</span>"
      " &nbsp; Y: <span class='value'>"
  );

  page += String(snapshot.posY, 2);

  page += F(
      " m</span>"
      " &nbsp; Z: <span class='value'>"
  );

  page += String(snapshot.posZ, 2);

  page += F(
      " m</span>"
      "<br>Distancia desde cero: "
      "<span class='value'>"
  );

  page += String(
      snapshot.distanceFromOrigin,
      2
  );

  page += F(
      " m</span>"
      "<br>Estado: "
      "<strong class='"
  );

  if (snapshot.outsideSafeRadius) {
    page += F(
        "alert'>FUERA DEL RADIO DE 2 M"
    );
  } else {
    page += F(
        "safe'>DENTRO DEL RADIO DE 2 M"
    );
  }

  page += F(
      "</strong>"
      "<form "
      "method='post' "
      "action='/reset-position'>"
      "<button "
      "class='secondary' "
      "type='submit'>"
      "RESTABLECER POSICION CERO"
      "</button>"
      "</form>"
      "</div>"
      "<div class='status'>"
      "ESP32: <span class='value'>"
  );

  page += WiFi.localIP().toString();

  page += F(
      "</span>"
      "<br>API local: "
      "<span class='value'>"
      "/api/vitals"
      "</span>"
      "<br>Movimiento: "
      "<span class='value'>"
      "/api/motion"
      "</span>"
      "</div>"
      "</main>"
      "</body>"
      "</html>"
  );

  return page;
}

void handleDashboard() {
  EcgState snapshot;

  portENTER_CRITICAL(&stateMux);
  snapshot = ecgState;
  portEXIT_CRITICAL(&stateMux);

  localServer.send(
      200,
      "text/html; charset=utf-8",
      dashboardHtml(
          snapshot,
          localServer.hasArg("saved")
      )
  );
}

void handleVitalsJson() {
  EcgState snapshot;

  portENTER_CRITICAL(&stateMux);
  snapshot = ecgState;
  portEXIT_CRITICAL(&stateMux);

  JsonDocument doc;

  doc["temperature_c"] =
      roundf(snapshot.temperatureC * 10) / 10;

  doc["blood_pressure_systolic_mmhg"] =
      snapshot.systolicMmHg;

  doc["blood_pressure_diastolic_mmhg"] =
      snapshot.diastolicMmHg;

  String body;
  serializeJson(doc, body);

  localServer.send(
      200,
      "application/json",
      body
  );
}

void handleMotionJson() {
  EcgState snapshot;

  portENTER_CRITICAL(&stateMux);
  snapshot = ecgState;
  portEXIT_CRITICAL(&stateMux);

  JsonDocument doc;

  doc["mpu_ready"] =
      snapshot.mpuReady;

  doc["ax"] = snapshot.ax;
  doc["ay"] = snapshot.ay;
  doc["az"] = snapshot.az;

  doc["gx"] = snapshot.gx;
  doc["gy"] = snapshot.gy;
  doc["gz"] = snapshot.gz;

  doc["pos_x_m"] = snapshot.posX;
  doc["pos_y_m"] = snapshot.posY;
  doc["pos_z_m"] = snapshot.posZ;

  doc["distance_from_origin_m"] =
      snapshot.distanceFromOrigin;

  doc["movement_detected"] =
      snapshot.movementDetected;

  doc["outside_safe_radius"] =
      snapshot.outsideSafeRadius;

  String body;
  serializeJson(doc, body);

  localServer.send(
      200,
      "application/json",
      body
  );
}

void handleResetPosition() {
  portENTER_CRITICAL(&stateMux);
  resetPositionRequested = true;
  portEXIT_CRITICAL(&stateMux);

  localServer.sendHeader(
      "Location",
      "/",
      true
  );

  localServer.send(
      303,
      "text/plain",
      ""
  );
}

void handleSetVitals() {
  if (
      !localServer.hasArg("temperature") ||
      !localServer.hasArg("systolic") ||
      !localServer.hasArg("diastolic")
  ) {
    localServer.send(
        400,
        "text/plain; charset=utf-8",
        "Faltan valores."
    );

    return;
  }

  const float temperature =
      localServer.arg("temperature").toFloat();

  const int systolic =
      localServer.arg("systolic").toInt();

  const int diastolic =
      localServer.arg("diastolic").toInt();

  if (
      temperature < MIN_TEMPERATURE_C ||
      temperature > MAX_TEMPERATURE_C ||
      systolic < MIN_SYSTOLIC_MMHG ||
      systolic > MAX_SYSTOLIC_MMHG ||
      diastolic < MIN_DIASTOLIC_MMHG ||
      diastolic > MAX_DIASTOLIC_MMHG ||
      diastolic >= systolic
  ) {
    localServer.send(
        400,
        "text/plain; charset=utf-8",
        "Valores fuera de rango o presion "
        "diastolica mayor o igual a la sistolica."
    );

    return;
  }

  portENTER_CRITICAL(&stateMux);

  ecgState.temperatureC = temperature;
  ecgState.systolicMmHg =
      static_cast<uint16_t>(systolic);

  ecgState.diastolicMmHg =
      static_cast<uint16_t>(diastolic);

  manualSendRequested = true;

  portEXIT_CRITICAL(&stateMux);

  Serial.printf(
      "Simulacion manual | "
      "temperatura=%.1f C | "
      "presion=%d/%d mmHg\n",
      temperature,
      systolic,
      diastolic
  );

  localServer.sendHeader(
      "Location",
      "/?saved=1",
      true
  );

  localServer.send(
      303,
      "text/plain",
      ""
  );
}

void startLocalServer() {
  localServer.on(
      "/",
      HTTP_GET,
      handleDashboard
  );

  localServer.on(
      "/api/vitals",
      HTTP_GET,
      handleVitalsJson
  );

  localServer.on(
      "/api/motion",
      HTTP_GET,
      handleMotionJson
  );

  localServer.on(
      "/set",
      HTTP_POST,
      handleSetVitals
  );

  localServer.on(
      "/reset-position",
      HTTP_POST,
      handleResetPosition
  );

  localServer.onNotFound([]() {
    localServer.send(
        404,
        "text/plain; charset=utf-8",
        "Ruta no encontrada."
    );
  });

  localServer.begin();

  Serial.print(
      "Servidor manual disponible en http://"
  );

  Serial.println(
      WiFi.localIP()
  );
}

// ============================================================
// ENVÍO A SUPABASE
// ============================================================

bool sendEcgTelemetry(
    const EcgState& snapshot
) {
  if (!connectWiFi()) {
    return false;
  }

  JsonDocument doc;

  doc["astronaut_id"] =
      ASTRONAUT_ID;

  doc["device_id"] =
      DEVICE_ID;

  doc["ecg_raw"] =
      snapshot.raw;

  if (
      snapshot.heartRateBpm >= 25 &&
      snapshot.heartRateBpm <= 240
  ) {
    doc["heart_rate_bpm"] =
        roundf(
            snapshot.heartRateBpm * 10
        ) / 10;
  } else {
    doc["heart_rate_bpm"] = nullptr;
  }

  doc["leads_off"] =
      snapshot.leadsOff;

  doc["resp_raw"] =
      snapshot.respRaw;

  if (snapshot.respirationValid) {
    doc["respiration_rate_bpm"] =
        roundf(
            snapshot.respirationRateBpm * 10
        ) / 10;
  } else {
    doc["respiration_rate_bpm"] = nullptr;
  }

  doc["temperature_c"] =
      roundf(
          snapshot.temperatureC * 10
      ) / 10;

  doc["blood_pressure_systolic_mmhg"] =
      snapshot.systolicMmHg;

  doc["blood_pressure_diastolic_mmhg"] =
      snapshot.diastolicMmHg;

  doc["ax"] =
      roundf(snapshot.ax * 1000) / 1000;

  doc["ay"] =
      roundf(snapshot.ay * 1000) / 1000;

  doc["az"] =
      roundf(snapshot.az * 1000) / 1000;

  doc["gx"] =
      roundf(snapshot.gx * 100) / 100;

  doc["gy"] =
      roundf(snapshot.gy * 100) / 100;

  doc["gz"] =
      roundf(snapshot.gz * 100) / 100;

  doc["pos_x_m"] =
      roundf(snapshot.posX * 1000) / 1000;

  doc["pos_y_m"] =
      roundf(snapshot.posY * 1000) / 1000;

  doc["pos_z_m"] =
      roundf(snapshot.posZ * 1000) / 1000;

  doc["distance_from_origin_m"] =
      roundf(
          snapshot.distanceFromOrigin * 1000
      ) / 1000;

  doc["movement_detected"] =
      snapshot.movementDetected;

  doc["outside_safe_radius"] =
      snapshot.outsideSafeRadius;

  doc["area_m2"] = 0;
  doc["steps"] = 0;
  doc["battery_pct"] = 100;
  doc["timestamp_ms"] = millis();

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.setTimeout(8000);

  if (!http.begin(
          secureClient,
          SUPABASE_URL
      )) {
    Serial.println(
        "No se pudo iniciar HTTPS."
    );

    return false;
  }

  http.addHeader(
      "Content-Type",
      "application/json"
  );

  http.addHeader(
      "apikey",
      SUPABASE_KEY
  );

  const int code =
      http.POST(body);

  if (code == 201) {
    if (snapshot.respirationValid) {
      Serial.printf(
          "ECG enviado | "
          "raw=%u | "
          "bpm=%.1f | "
          "resp=%.1f | "
          "movimiento=%s | "
          "distancia=%.2f m | "
          "electrodos=%s\n",
          snapshot.raw,
          snapshot.heartRateBpm,
          snapshot.respirationRateBpm,
          snapshot.movementDetected
              ? "SI"
              : "NO",
          snapshot.distanceFromOrigin,
          snapshot.leadsOff
              ? "OFF"
              : "OK"
      );
    } else {
      Serial.printf(
          "ECG enviado | "
          "raw=%u | "
          "bpm=%.1f | "
          "resp=calculando | "
          "movimiento=%s | "
          "distancia=%.2f m | "
          "electrodos=%s\n",
          snapshot.raw,
          snapshot.heartRateBpm,
          snapshot.movementDetected
              ? "SI"
              : "NO",
          snapshot.distanceFromOrigin,
          snapshot.leadsOff
              ? "OFF"
              : "OK"
      );
    }
  } else {
    Serial.printf(
        "Error Supabase %d: %s\n",
        code,
        http.getString().c_str()
    );
  }

  http.end();

  return code == 201;
}

void networkTask(void* parameter) {
  uint32_t lastSendMs = 0;

  for (;;) {
    bool shouldSend = false;
    EcgState snapshot;

    portENTER_CRITICAL(&stateMux);

    const bool forceSend =
        manualSendRequested;

    if (forceSend) {
      manualSendRequested = false;
    }

    if (
        forceSend ||
        millis() - lastSendMs >= SEND_PERIOD_MS
    ) {
      snapshot = ecgState;
      shouldSend = true;
    }

    portEXIT_CRITICAL(&stateMux);

    if (shouldSend) {
      sendEcgTelemetry(snapshot);
      lastSendMs = millis();
    }

    vTaskDelay(
        pdMS_TO_TICKS(100)
    );
  }
}

// ============================================================
// SETUP Y LOOP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println(
      "\nSTELLAR ECG + MPU6050 Node v2.0"
  );

  if (!credentialsConfigured()) {
    Serial.println(
        "ERROR: completa secrets.h "
        "con Wi-Fi y Supabase."
    );

    while (true) {
      delay(1000);
    }
  }

  pinMode(ECG_PIN, INPUT);
  pinMode(LO_PLUS_PIN, INPUT);
  pinMode(LO_MINUS_PIN, INPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(
      ECG_PIN,
      ADC_11db
  );

  const bool mpuStarted =
      initializeMpu6050();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  secureClient.setInsecure();

  connectWiFi();
  startLocalServer();

  xTaskCreatePinnedToCore(
      ecgTask,
      "ecg-250hz",
      4096,
      nullptr,
      3,
      nullptr,
      1
  );

  if (mpuStarted) {
    xTaskCreatePinnedToCore(
        motionTask,
        "mpu-50hz",
        4096,
        nullptr,
        2,
        nullptr,
        1
    );
  }

  xTaskCreatePinnedToCore(
      networkTask,
      "supabase-1hz",
      8192,
      nullptr,
      1,
      nullptr,
      0
  );
}

void loop() {
  localServer.handleClient();
  delay(2);
}
