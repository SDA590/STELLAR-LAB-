// Tipos y textos compartidos del análisis (línea base, signos vitales, chequeo diario).

export type Level = 'calibrating' | 'normal' | 'unreliable' | 'observe' | 'alert'

export type SignalBaseline = {
  label: string; unit: string; level: Level; n: number
  center: number | null; sd: number | null; low: number | null; high: number | null
  current: number | null; z: number | null; delta: number | null; message: string
}

export type Baseline = {
  source: 'simulation' | 'hardware' | null; window_s: number; method?: string; level: Level
  signals: Partial<Record<'heart_rate_bpm' | 'respiration_rate_bpm', SignalBaseline>>
}

export type VitalsItem = {
  ts: number; source: 'simulation' | 'manual'
  systolic_mmhg: number | null; diastolic_mmhg: number | null; temperature_c: number | null
  bp_label: string | null; temp_label: string | null
}

export type Vitals = { interval_min: number; next_ts: number; latest_bp: VitalsItem | null; latest_temp: VitalsItem | null; items: VitalsItem[] }

export type Checkin = {
  astronaut_id: string; created_at: string
  sleep_hours: number | null; mood: number | null; stress: number | null; glucose_mg_dl: number | null
  systolic_mmhg: number | null; diastolic_mmhg: number | null; temperature_c: number | null; notes: string | null
}

const LEVELS: Record<Level, { label: string; short: string; tone: string; title: string }> = {
  calibrating: { label: 'Calibrando', short: 'BASE…', tone: 'blue', title: 'Calibrando tu línea base' },
  normal: { label: 'Normal', short: 'NORMAL', tone: 'mint', title: 'Dentro de tu normal' },
  unreliable: { label: 'Poco confiable', short: 'SEÑAL', tone: 'gray', title: 'Lectura poco confiable' },
  observe: { label: 'Observar', short: 'OBSERVAR', tone: 'amber', title: 'Cambio que conviene observar' },
  alert: { label: 'Alerta', short: 'ALERTA', tone: 'red', title: 'Cambio importante frente a tu base' },
}

export function levelInfo(level?: Level | null) {
  return LEVELS[level ?? 'calibrating'] ?? LEVELS.calibrating
}

export type Alert = {
  id: string; level: 0 | 1 | 2 | 3; level_title: string; who: string; title: string; reason: string
  actions: string[]; hazard: string; link: 'Wellness' | 'Exercise Coach' | null; evidence: string[]
}

export type Report = {
  astronaut_id: string; generated_ts: number; trigger: string; priority: string; max_level: number
  data_source: { ecg: string | null; vitals: string | null; checkin: string | null }
  summary: Partial<Record<'heart_rate_bpm' | 'respiration_rate_bpm', { base: number | null; now: number | null; level: Level; z: number | null }>>
  vitals: { bp: VitalsItem | null; temp: VitalsItem | null }
  checkin: Checkin | null
  alerts: { level: number; title: string; reason: string }[]
  recommendation: string; size_bytes: number; raw_bytes: number
}
