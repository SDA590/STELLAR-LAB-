import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from './i18n'
import TrainingFigure, { useCycle, type Exercise } from './TrainingFigure'

type MotionSample = {
  source?: string; received_at?: string; ax: number | null; ay: number | null; az: number | null
  gx: number | null; gy: number | null; gz: number | null; respiration_rate_bpm: number | null; heart_rate_bpm: number | null
}

// Rutinas del protocolo diario (Entrenamiento.txt): fuerza en ARED y cardio en T2 / CEVIS.
// goal = ángulo objetivo (grados) respecto a la postura neutra calibrada; 0 = se guía por tiempo y pulso.
const routines = () => [
  { id: 'squat' as Exercise, block: 'ared', name: t('Sentadillas', 'Squats'), sets: '4×10', rest: 90, load: '180 kg', muscles: t('Cuádriceps · Glúteos · Core', 'Quads · Glutes · Core'), sensor: t('MPU6050 en el muslo', 'MPU6050 on the thigh'), goal: 80, cue: t('Desciende con el torso estable y la espalda neutra, y empuja desde los talones contra la resistencia del ARED.', 'Go down with a steady torso and neutral back, and push through your heels against the ARED resistance.'), why: t('Estimula fémur, cadera y pelvis para frenar la pérdida de hueso y conserva cuádriceps y glúteos para sostener tu peso al volver a la Tierra.', 'Loads the femur, hips and pelvis to slow bone loss and keeps quads and glutes strong enough to carry your weight back on Earth.') },
  { id: 'deadlift' as Exercise, block: 'ared', name: t('Peso muerto', 'Deadlift'), sets: '3×12', rest: 90, load: '160 kg', muscles: t('Cadena posterior · Core', 'Posterior chain · Core'), sensor: t('MPU6050 en el muslo', 'MPU6050 on the thigh'), goal: 60, cue: t('Eleva la barra desde la plataforma extendiendo cadera y tronco, con el abdomen contraído.', 'Lift the bar from the platform by extending hips and trunk, with the core braced.'), why: t('Protege la densidad de las vértebras lumbares y fortalece isquiotibiales, glúteos y erectores: evita dolor de espalda y atrofia postural.', 'Protects lumbar bone density and strengthens hamstrings, glutes and spinal erectors: prevents back pain and postural atrophy.') },
  { id: 'calf' as Exercise, block: 'ared', name: t('Elevación de talones', 'Calf raises'), sets: '3×20', rest: 60, load: '90 kg', muscles: t('Gastrocnemios · Sóleo', 'Gastrocnemius · Soleus'), sensor: t('MPU6050 en el pie', 'MPU6050 on the foot'), goal: 20, cue: t('Con la barra en los hombros y las puntas en la plataforma, sube al máximo y baja lento.', 'With the bar on your shoulders and toes on the platform, rise all the way and lower slowly.'), why: t('Evita la pérdida rápida de masa en las pantorrillas, clave para el equilibrio y para caminar tras el aterrizaje.', 'Prevents fast calf muscle loss, key for balance and walking after landing.') },
  { id: 'bench' as Exercise, block: 'ared', name: t('Press de banca', 'Bench press'), sets: '3×10', rest: 90, load: '70 kg', muscles: t('Pectorales · Deltoides · Tríceps', 'Chest · Deltoids · Triceps'), sensor: t('MPU6050 en el antebrazo', 'MPU6050 on the forearm'), goal: 85, cue: t('Acostado en el banco con las correas puestas, empuja la barra hacia arriba y bájala controlada al pecho.', 'Lying on the bench with the straps on, push the bar up and lower it under control to your chest.'), why: t('Mantiene la fuerza del tren superior para maniobras de emergencia, mover equipo pesado y las caminatas espaciales.', 'Keeps upper-body strength for emergency manoeuvres, moving heavy equipment and spacewalks.') },
  { id: 'run' as Exercise, block: 'cardio', name: t('Carrera con arnés (T2)', 'Harness run (T2)'), sets: '30–45 min', rest: 0, load: t('70–80 % del peso', '70–80 % of weight'), muscles: t('Piernas · Sistema cardiovascular', 'Legs · Cardiovascular system'), sensor: t('Pulso (ECG)', 'Heart rate (ECG)'), goal: 0, cue: t('Trote continuo con intervalos rápidos; el arnés y los bungees te empujan contra la banda.', 'Steady jog with fast intervals; the harness and bungees pull you against the belt.'), why: t('Los impactos estimulan la regeneración del hueso de las piernas y mantienen el volumen de sangre y la capacidad aeróbica.', 'The impacts stimulate leg bone regeneration and keep blood volume and aerobic capacity.') },
  { id: 'cevis' as Exercise, block: 'cardio', name: t('Bicicleta CEVIS', 'CEVIS cycle'), sets: '15–30 min', rest: 0, load: t('Nivel 8', 'Level 8'), muscles: t('Cuádriceps · Glúteos · Cardio', 'Quads · Glutes · Cardio'), sensor: t('Pulso (ECG)', 'Heart rate (ECG)'), goal: 0, cue: t('Intervalos de alta intensidad con los pies anclados a los pedales y la pelvis sujeta al asiento.', 'High-intensity intervals with feet clipped to the pedals and the pelvis strapped to the seat.'), why: t('Fortalece la resistencia cardiovascular y el flujo de sangre a las piernas sin hacer vibrar la nave.', 'Builds cardiovascular endurance and blood flow to the legs without shaking the spacecraft.') },
]

type Rep = { peak: number; seconds: number; full: boolean }
type Vec = [number, number, number]

const norm = (v: Vec) => Math.hypot(...v)
function angleBetween(a: Vec, b: Vec) {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b))
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
}

export default function ExerciseCoach({ sample, astronautId = 'crew' }: { sample: MotionSample | null; astronautId?: string }) {
  const [selected, setSelected] = useState(0)
  const [phase, setPhase] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [view, setView] = useState(-12)
  const [elapsed, setElapsed] = useState(0)
  const [reps, setReps] = useState<Rep[]>([])
  const [angle, setAngle] = useState<number | null>(null)
  const [neutral, setNeutral] = useState<Vec | null>(() => {
    try { const raw = localStorage.getItem(`stellar-neutral-${astronautId}`); return raw ? JSON.parse(raw) : null } catch { return null }
  })
  const [demoChoice, setDemoChoice] = useState<boolean | null>(null)
  const repState = useRef<{ up: boolean; peak: number; start: number }>({ up: false, peak: 0, start: 0 })
  const lastSeen = useRef<string>('')
  const playingRef = useRef(playing)
  playingRef.current = playing

  const list = routines()
  const routine = list[selected]
  const usesSensor = routine.goal > 0
  const cycle = useCycle(playing || !usesSensor, routine.id === 'run' ? 0.8 : routine.id === 'cevis' ? 1.2 : 4)
  const guideF = 0.5 - 0.5 * Math.cos(2 * Math.PI * cycle)
  const accel: Vec | null = sample && sample.ax != null && sample.ay != null && sample.az != null ? [sample.ax, sample.ay, sample.az] : null
  const imuLive = sample?.source === 'hardware' && accel != null && norm(accel) > 2 // en reposo el acelerómetro mide ~9,8 m/s² (gravedad)
  const imuZeros = sample?.source === 'hardware' && (accel == null || norm(accel) <= 2)
  const demo = demoChoice ?? !imuLive

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => { setPhase(p => (p + 1) % 4); setElapsed(s => s + 1) }, 1000)
    return () => window.clearInterval(timer)
  }, [playing])

  const registerAngle = (value: number, now: number, goal: number) => {
    setAngle(value)
    if (!playingRef.current || goal <= 0) return
    const st = repState.current
    if (!st.up && value >= goal * 0.5) { st.up = true; st.peak = value; st.start = now }
    else if (st.up) {
      st.peak = Math.max(st.peak, value)
      if (value <= goal * 0.25) {
        const rep = { peak: Math.round(st.peak), seconds: Math.max(1, Math.round((now - st.start) / 1000)), full: st.peak >= goal * 0.85 }
        setReps(r => [...r, rep]); st.up = false; st.peak = 0
      }
    }
  }

  // Ángulo REAL: cada lectura nueva del ESP32 (se ignoran las repetidas)
  useEffect(() => {
    if (demo || !imuLive || !accel) return
    const key = sample?.received_at ?? ''
    if (key === lastSeen.current) return
    lastSeen.current = key
    registerAngle(neutral ? angleBetween(accel, neutral) : 0, Date.now(), routine.goal)
  }, [sample?.received_at, demo, imuLive, neutral, routine.goal])

  // Ángulo SIMULADO para la demo: sigue la guía con pequeñas imperfecciones
  useEffect(() => {
    if (!demo || !usesSensor) return
    const t0 = Date.now()
    const timer = window.setInterval(() => {
      const sec = (Date.now() - t0) / 1000, cycle = Math.floor(sec / 4)
      const reach = cycle % 4 === 3 ? 0.7 : 0.95 // una de cada cuatro queda corta, para mostrar la corrección
      registerAngle(Math.max(0, routine.goal * reach * (0.5 - 0.5 * Math.cos((2 * Math.PI * sec) / 4)) + Math.sin(sec * 7) * 2), Date.now(), routine.goal)
    }, 250)
    return () => window.clearInterval(timer)
  }, [demo, usesSensor, routine.goal])

  const resetSession = () => { setReps([]); setElapsed(0); setPhase(0); repState.current = { up: false, peak: 0, start: 0 } }
  const calibrate = () => {
    if (!accel) return
    setNeutral(accel)
    try { localStorage.setItem(`stellar-neutral-${astronautId}`, JSON.stringify(accel)) } catch { /* sin almacenamiento */ }
  }

  const full = reps.filter(r => r.full).length
  const fast = reps.filter(r => r.seconds < 2).length
  const score = reps.length ? Math.round((full / reps.length) * 100) : null
  const lastRep = reps[reps.length - 1]
  const breathing = sample?.respiration_rate_bpm ?? null
  const progress = usesSensor && angle != null ? Math.min(100, (angle / routine.goal) * 100) : 0
  const advice = !usesSensor ? ((sample?.heart_rate_bpm ?? 0) > 165 ? t('Pulso muy alto: baja la intensidad un momento.', 'Heart rate very high: ease off for a moment.') : t('Mantén un ritmo constante en zona aeróbica; la app vigila tu pulso.', 'Keep a steady pace in the aerobic zone; the app watches your heart rate.'))
    : !playing ? t('Pulsa "Iniciar rutina" para empezar a contar repeticiones.', 'Press "Start routine" to begin counting reps.')
    : !lastRep ? t(`Sube hasta unos ${routine.goal}° y vuelve a la posición inicial.`, `Go up to about ${routine.goal}° and return to the start position.`)
    : !lastRep.full ? t(`Última repetición: ${lastRep.peak}° de ${routine.goal}°. Intenta subir un poco más.`, `Last rep: ${lastRep.peak}° of ${routine.goal}°. Try to go a little higher.`)
    : lastRep.seconds < 2 ? t('Buen rango, pero muy rápido: hazlo más lento y controlado.', 'Good range, but too fast: make it slower and controlled.')
    : t('Repetición completa y controlada. ¡Sigue así!', 'Full, controlled rep. Keep it up!')

  return <section className="coach-page">
    <div className="coach-heading"><div><span>STELLAR MOTION COACH</span><h2>{t('Entrenamiento guiado', 'Guided training')}</h2><p>{t('Un sensor MPU6050 mide el ángulo de tu pierna o brazo frente a tu postura neutra y cuenta las repeticiones.', 'An MPU6050 sensor measures the angle of your leg or arm against your neutral posture and counts reps.')}</p></div><div className="session-health"><b>{sample?.heart_rate_bpm != null ? Math.round(sample.heart_rate_bpm) : '—'} {t('lpm', 'bpm')}</b><span>{t('FC durante ejercicio', 'HR during exercise')}</span><b>{breathing?.toFixed(1) ?? '—'} {t('rpm', 'br/min')}</b><span>{t('Respiración', 'Breathing')}</span></div></div>

    <div className={`imu-strip ${imuLive && !demo ? 'real' : ''}`}>
      <b>{demo ? t('MODO DEMOSTRACIÓN · movimiento simulado', 'DEMO MODE · simulated movement') : t('SENSOR REAL · MPU6050 vía ESP32', 'REAL SENSOR · MPU6050 via ESP32')}</b>
      <span>{imuLive ? (neutral ? t('Postura neutra calibrada.', 'Neutral posture calibrated.') : t('Ponte en la postura inicial y pulsa "Calibrar postura neutra".', 'Get into the start posture and press "Calibrate neutral posture".')) : imuZeros ? t('El ESP32 está conectado pero no envía datos del acelerómetro (llegan en 0): falta activar el MPU6050 en el firmware.', 'The ESP32 is connected but sends no accelerometer data (all 0): the MPU6050 still needs enabling in the firmware.') : t('No llegan datos del acelerómetro; se usa el modo demostración.', 'No accelerometer data is arriving; demo mode is used.')}</span>
      <div>
        {imuLive && <button onClick={calibrate}>{t('Calibrar postura neutra', 'Calibrate neutral posture')}</button>}
        <label><input type="checkbox" checked={demo} onChange={e => setDemoChoice(e.target.checked)} disabled={!imuLive} /> {t('Demostración', 'Demo')}</label>
      </div>
    </div>

    <div className="coach-layout">
      <div className="routine-list" aria-label={t('Rutinas disponibles', 'Available routines')}>
        <span>{t('PROTOCOLO DIARIO · ARED + T2 / CEVIS', 'DAILY PROTOCOL · ARED + T2 / CEVIS')}</span>
        {list.map((item, index) => <button key={item.id} className={selected === index ? 'selected' : ''} onClick={() => { setSelected(index); resetSession(); setPlaying(false) }}><i>{String(index + 1).padStart(2, '0')}</i><div><b>{item.name}</b><small>{item.muscles} · {item.sets}</small></div></button>)}
      </div>

      <article className="pose-panel">
        <div className="pose-toolbar"><div><span>{t('EJERCICIO ACTIVO', 'ACTIVE EXERCISE')} · {selected + 1}/{list.length} · {routine.block === 'ared' ? t('FUERZA EN ARED', 'ARED STRENGTH') : t('CARDIO T2 / CEVIS', 'T2 / CEVIS CARDIO')}</span><h3>{routine.name} <small className="pose-sets">{routine.sets}{routine.rest ? ` · ${t('descanso', 'rest')} ${routine.rest} s` : ''} · {routine.load}</small></h3></div><div className="match"><b>{usesSensor && angle != null ? `${Math.round(angle)}°` : '—'}</b><span>{usesSensor ? `${routine.sensor} · ${t(`meta ${routine.goal}°`, `goal ${routine.goal}°`)}` : t('guiado por tiempo y pulso', 'guided by time and heart rate')}</span></div></div>
        <div className="pose-stage">
          <div className="deck-grid"/>
          <div className="tf-wrap" style={{ transform: `rotateY(${view}deg)` }}><span>{t('MOVIMIENTO GUÍA', 'GUIDE MOVEMENT')}</span><TrainingFigure exercise={routine.id} f={playing ? guideF : 0.6} cycle={cycle} ghost /></div>
          <div className="pose-divider dashed"/>
          <div className="tf-wrap" style={{ transform: `rotateY(${view}deg)` }}><span>{t('TU MOVIMIENTO', 'YOUR MOVEMENT')}</span><TrainingFigure exercise={routine.id} f={usesSensor ? (angle ?? 0) / routine.goal : guideF} cycle={cycle} /></div>
          <div className="active-muscles"><b><i />{t('Músculos activos', 'Active muscles')}</b><small>{routine.muscles}</small></div>
          <div className="orientation"><span>{t('VISTA', 'VIEW')}</span><input aria-label={t('Rotar vista 3D', 'Rotate 3D view')} type="range" min="-45" max="45" value={view} onChange={e => setView(Number(e.target.value))}/><b>{view}°</b></div>
        </div>
        {usesSensor && <div className="angle-meter"><i style={{ width: `${progress}%` }} /><em /><span>0°</span><span>{t('meta', 'goal')} {routine.goal}°</span></div>}
        <div className="coach-cue"><span>{t('PASO', 'STEP')} {phase + 1}</span><p>{routine.cue}</p><div className="session-controls"><button className="primary-action" onClick={() => { if (!playing) resetSession(); setPlaying(p => !p) }}>{playing ? t('Pausar rutina', 'Pause routine') : t('Iniciar rutina', 'Start routine')}</button><button onClick={resetSession}>{t('Reiniciar conteo', 'Reset count')}</button><b>{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</b></div></div>
      </article>

      <div className="coach-feedback">
        <span>{t('RETROALIMENTACIÓN', 'FEEDBACK')}</span><h3>{advice}</h3>
        <div className="alignment-ring" style={{'--score': `${(score ?? 0) * 3.6}deg`} as React.CSSProperties}><b>{reps.length}</b><small>{t('repeticiones', 'reps')}</small></div>
        <ul>
          <li><i className={score == null || score >= 80 ? 'ok' : 'watch'}/>{t('Rango completo', 'Full range')}: {usesSensor ? `${full} ${t('de', 'of')} ${reps.length}` : '—'}</li>
          <li><i className={fast === 0 ? 'ok' : 'watch'}/>{fast === 0 ? t('Ritmo controlado', 'Controlled pace') : t(`${fast} repetición(es) muy rápidas`, `${fast} rep(s) too fast`)}</li>
          <li><i className={(breathing ?? 0) > 20 ? 'watch' : 'ok'}/>{(breathing ?? 0) > 20 ? t('Respiración alta: reduce la intensidad', 'High breathing: lower the intensity') : t('Respiración uniforme', 'Steady breathing')}</li>
        </ul>
        <div className="safety-note"><b>{t('Por qué en el espacio', 'Why in space')}</b><p>{routine.why}</p></div>
        <div className="safety-note"><b>{t('Seguridad', 'Safety')}</b><p>{t('Detén la rutina si aparece dolor, mareo o dificultad respiratoria. En microgravedad el ángulo se calcularía con el giroscopio; en la Tierra usamos la gravedad como referencia.', 'Stop the routine if you feel pain, dizziness or shortness of breath. In microgravity the angle would be computed with the gyroscope; on Earth we use gravity as the reference.')}</p></div>
      </div>
    </div>
  </section>
}
