import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from './i18n'

type MotionSample = {
  source?: string; received_at?: string; ax: number | null; ay: number | null; az: number | null
  gx: number | null; gy: number | null; gz: number | null; respiration_rate_bpm: number | null; heart_rate_bpm: number | null
}

// goal = ángulo objetivo (grados) respecto a la postura neutra calibrada.
const routines = () => [
  { id: 'knee', name: t('Elevación de rodilla', 'Knee raise'), duration: '06:00', target: t('Cadera y piernas', 'Hips and legs'), sensor: t('MPU6050 en el muslo', 'MPU6050 on the thigh'), goal: 70, cue: t('Eleva la rodilla de forma controlada y conserva el tronco estable.', 'Raise the knee in a controlled way and keep the torso steady.'), why: t('Mantiene fuerza en cadera y piernas, que pierden masa muscular en microgravedad.', 'Keeps strength in hips and legs, which lose muscle mass in microgravity.') },
  { id: 'hip', name: t('Movilidad de cadera', 'Hip mobility'), duration: '05:00', target: t('Cadera y equilibrio', 'Hips and balance'), sensor: t('MPU6050 en el muslo', 'MPU6050 on the thigh'), goal: 35, cue: t('Abre la pierna hacia un lado sin inclinar el torso.', 'Open the leg to the side without tilting the torso.'), why: t('Conserva la movilidad de la cadera y el equilibrio al volver a la gravedad.', 'Preserves hip mobility and balance for the return to gravity.') },
  { id: 'shoulder', name: t('Elevación de brazo', 'Arm raise'), duration: '04:00', target: t('Hombros y espalda', 'Shoulders and back'), sensor: t('MPU6050 en el brazo', 'MPU6050 on the arm'), goal: 90, cue: t('Sube el brazo hacia el lado hasta la altura del hombro y baja despacio.', 'Raise the arm sideways to shoulder height and lower it slowly.'), why: t('Previene rigidez de hombros y espalda por posturas fijas en la nave.', 'Prevents shoulder and back stiffness from fixed postures in the spacecraft.') },
  { id: 'breath', name: t('Respiración de recuperación', 'Recovery breathing'), duration: '03:00', target: t('Estrés y recuperación', 'Stress and recovery'), sensor: t('ECG (respiración estimada)', 'ECG (estimated breathing)'), goal: 0, cue: t('Inhala cuatro segundos y exhala seis segundos sin forzar.', 'Breathe in for four seconds and out for six without forcing.'), why: t('Baja el pulso y la tensión después del ejercicio o de una alerta.', 'Lowers heart rate and stress after exercise or an alert.') },
]

type Rep = { peak: number; seconds: number; full: boolean }
type Vec = [number, number, number]

const norm = (v: Vec) => Math.hypot(...v)
function angleBetween(a: Vec, b: Vec) {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b))
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
}

function Figure({ pose, phase, view, live = false, liveAngle = null }: { pose: string; phase: number; view: number; live?: boolean; liveAngle?: number | null }) {
  const swing = phase % 2 === 0 ? 1 : -1
  const vars = useMemo(() => {
    let la = -12, ra = 12, ll = 3, rl = -3, torso = 0
    if (pose === 'knee') { ll = swing > 0 ? -48 : 5; rl = swing < 0 ? 48 : -5; la = swing * 22; ra = swing * 18 }
    if (pose === 'hip') { ll = swing > 0 ? -42 : 5; rl = swing < 0 ? 42 : -5; la = -32; ra = 32 }
    if (pose === 'shoulder') { la = -68 + swing * 20; ra = 68 - swing * 20; torso = swing * 3 }
    if (pose === 'breath') { la = -28 - phase * 3; ra = 28 + phase * 3; torso = phase % 2 ? 2 : -2 }
    if (live && liveAngle != null) {
      // La figura "tu movimiento" copia el ángulo medido por el sensor.
      if (pose === 'knee' || pose === 'hip') { ll = 3 - liveAngle * 0.7; rl = -3; la = -12; ra = 12 }
      if (pose === 'shoulder') { la = -12 - liveAngle * 0.85; ra = 12; torso = 0 }
    }
    return { '--view': `${view}deg`, '--la': `${la}deg`, '--ra': `${ra}deg`, '--ll': `${ll}deg`, '--rl': `${rl}deg`, '--torso': `${torso}deg` } as React.CSSProperties
  }, [pose, phase, view, live, liveAngle, swing])

  return <div className={`figure-wrap ${live ? 'live-figure' : 'guide-figure'}`}>
    <span>{live ? t('TU MOVIMIENTO', 'YOUR MOVEMENT') : t('MOVIMIENTO GUÍA', 'GUIDE MOVEMENT')}</span>
    <div className="figure3d" style={vars} aria-label={live ? t('Movimiento medido por el sensor', 'Movement measured by the sensor') : t('Movimiento recomendado', 'Recommended movement')}>
      <div className="body-part head">
        <i className="hair"/><i className="ear ear-left"/><i className="ear ear-right"/>
        <i className="eyebrow brow-left"/><i className="eyebrow brow-right"/><i className="eye eye-left"/><i className="eye eye-right"/>
        <i className="nose"/><i className="mouth"/>
      </div>
      <i className="body-part neck"/>
      <div className="body-part torso"><i className="suit-collar"/><i className="zipper"/><i className="mission-patch">S</i><i className="name-patch">CREW 01</i><i className="utility-pocket"/></div>
      <div className="body-part arm left"><i className="sleeve-patch">01</i></div><div className="body-part arm right"><i className="sleeve-stripe"/></div>
      <div className="body-part leg left"><i className="knee-pad"/></div><div className="body-part leg right"><i className="knee-pad"/></div>
      <i className="body-part joint shoulder-l"/><i className="body-part joint shoulder-r"/><i className="body-part joint hip-l"/><i className="body-part joint hip-r"/>
    </div>
  </div>
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
  const advice = !usesSensor ? t('Sigue el ritmo de la respiración guiada.', 'Follow the guided breathing rhythm.')
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
        <span>{t('RUTINA DE HOY · 18 MIN', 'TODAY’S ROUTINE · 18 MIN')}</span>
        {list.map((item, index) => <button key={item.id} className={selected === index ? 'selected' : ''} onClick={() => { setSelected(index); resetSession(); setPlaying(false) }}><i>{String(index + 1).padStart(2, '0')}</i><div><b>{item.name}</b><small>{item.target} · {item.duration}</small></div></button>)}
      </div>

      <article className="pose-panel">
        <div className="pose-toolbar"><div><span>{t('EJERCICIO', 'EXERCISE')} {selected + 1} {t('DE', 'OF')} {list.length} · {routine.sensor.toUpperCase()}</span><h3>{routine.name}</h3></div><div className="match"><b>{usesSensor && angle != null ? `${Math.round(angle)}°` : '—'}</b><span>{usesSensor ? t(`ángulo actual · meta ${routine.goal}°`, `current angle · goal ${routine.goal}°`) : t('sin sensor de movimiento', 'no motion sensor')}</span></div></div>
        <div className="pose-stage">
          <div className="deck-grid"/><Figure pose={routine.id} phase={phase} view={view}/><div className="pose-divider"/><Figure pose={routine.id} phase={phase} view={view} live liveAngle={usesSensor ? angle : null}/>
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
