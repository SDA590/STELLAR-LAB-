import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import Icon from './Icon'
import { apiFetch } from './api'
import { t } from './i18n'

type Position = {
  source: 'hardware' | 'simulation'; x: number; y: number; z: number; distance_m: number; speed_m_s: number | null
  max_distance_m: number; zone: 'cerca' | 'atencion' | 'fuera'; safe_m: number; tether_m: number; trail: [number, number, number][]
}

const ZONE = {
  cerca: { color: '#35C99A' },
  atencion: { color: '#F2B84B' },
  fuera: { color: '#F16F78' },
}
const zoneText = (z: keyof typeof ZONE) => ({
  cerca: { label: t('Zona cercana', 'Near zone'), text: t('Dentro de la zona cercana a la escotilla.', 'Inside the zone near the hatch.') },
  atencion: { label: t('Atención', 'Attention'), text: t('Te acercas al largo del cable de seguridad.', 'You are nearing the safety tether length.') },
  fuera: { label: t('Fuera de rango', 'Out of range'), text: t('Más lejos que el cable de seguridad de referencia: regresa hacia la estación.', 'Beyond the reference safety tether: head back to the station.') },
})[z]

// Datos: X, Y en el plano y Z hacia arriba (metros desde el punto 0). En three.js "arriba" es Y.
const toScene = ([x, y, z]: [number, number, number]) => new THREE.Vector3(x, z, -y)

function textSprite(text: string, color = '#91A2B4', size = 64) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.font = `600 ${size}px Inter, sans-serif`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 64)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }))
  sprite.scale.set(4, 2, 1)
  return sprite
}

function buildStation() {
  const g = new THREE.Group()
  const hull = new THREE.MeshStandardMaterial({ color: '#c9d4df', metalness: 0.55, roughness: 0.35 })
  const dark = new THREE.MeshStandardMaterial({ color: '#26394B', metalness: 0.4, roughness: 0.6 })
  const panel = new THREE.MeshStandardMaterial({ color: '#1b4c7a', emissive: '#0b2a4a', metalness: 0.3, roughness: 0.4, side: THREE.DoubleSide })
  const glow = new THREE.MeshBasicMaterial({ color: '#45D6C5' })
  // Módulo principal (eje X) y módulos laterales
  const main = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 9, 32), hull); main.rotation.z = Math.PI / 2; g.add(main)
  const node = new THREE.Mesh(new THREE.SphereGeometry(1.7, 32, 16), hull); g.add(node)
  const side = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 6, 32), hull); side.rotation.x = Math.PI / 2; g.add(side)
  for (const sx of [-4.5, 4.5]) { const ring = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.08, 8, 32), dark); ring.rotation.y = Math.PI / 2; ring.position.x = sx; g.add(ring) }
  // Armazón y paneles solares
  const truss = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 22), dark); truss.position.set(-2, 0, 0); g.add(truss)
  for (const sz of [-1, 1]) for (const dx of [-1.6, 1.6]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.05, 6.5), panel); p.position.set(-2 + dx, 0, sz * 7.6); g.add(p)
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(p.geometry), new THREE.LineBasicMaterial({ color: '#79A9D8' })); frame.position.copy(p.position); g.add(frame)
  }
  const radiator = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.2, 0.06), new THREE.MeshStandardMaterial({ color: '#e8eef5', roughness: 0.8 })); radiator.position.set(3, 2.6, 0); g.add(radiator)
  // Escotilla = punto 0
  const hatch = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.09, 8, 32), glow); g.add(hatch)
  for (const lx of [-4.4, 4.4]) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), glow); l.position.set(lx, 1.35, 0); g.add(l) }
  return g
}

function buildAstronaut() {
  const g = new THREE.Group()
  const suit = new THREE.MeshStandardMaterial({ color: '#f1f5f9', roughness: 0.7 })
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.7, 6, 16), suit); g.add(torso)
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.36, 24, 16), suit); helmet.position.y = 0.85; g.add(helmet)
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16, 0, Math.PI), new THREE.MeshStandardMaterial({ color: '#45D6C5', emissive: '#1b7f74', metalness: 0.9, roughness: 0.1 }))
  visor.position.set(0, 0.85, 0.1); g.add(visor)
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.9, 0.35), suit); pack.position.set(0, 0.15, -0.42); g.add(pack)
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.55, 4, 8), suit); arm.position.set(s * 0.58, 0.15, 0); arm.rotation.z = s * 0.5; g.add(arm)
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.6, 4, 8), suit); leg.position.set(s * 0.22, -0.85, 0); leg.rotation.z = s * 0.15; g.add(leg)
  }
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), new THREE.MeshBasicMaterial({ color: '#45D6C5', transparent: true, opacity: 0.08, depthWrite: false })); g.add(halo)
  g.scale.setScalar(1.4)
  return g
}

export default function EvaView({ astronautId, name }: { astronautId: string; name: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<{ setData: (p: Position) => void; reset: () => void } | null>(null)
  const [pos, setPos] = useState<Position | null>(null)
  const [demo, setDemo] = useState(false)
  const [error, setError] = useState(false)

  // Escena 3D: se crea una sola vez
  useEffect(() => {
    const mount = mountRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000)
    camera.position.set(30, 24, 40)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.maxDistance = 140; controls.minDistance = 8

    scene.add(new THREE.AmbientLight('#8fb3d9', 0.9))
    const sun = new THREE.DirectionalLight('#ffffff', 2.2); sun.position.set(30, 40, 20); scene.add(sun)

    // Estrellas
    const starPos = new Float32Array(1500 * 3)
    for (let i = 0; i < starPos.length; i++) starPos[i] = (Math.random() - 0.5) * 900
    const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(starPos, 3)), new THREE.PointsMaterial({ color: '#c8d6e5', size: 0.8 }))
    scene.add(stars)

    // Planeta de fondo
    const planet = new THREE.Mesh(new THREE.SphereGeometry(260, 64, 48), new THREE.MeshStandardMaterial({ color: '#1d5d9b', emissive: '#08223f', roughness: 0.9 }))
    planet.position.set(-260, -420, -820); scene.add(planet)

    // Referencias: rejilla, ejes, zonas
    const grid = new THREE.PolarGridHelper(30, 12, 6, 64, '#26394B', '#1a2a3a'); grid.position.y = -0.01; scene.add(grid)
    const axes: [THREE.Vector3, string, string][] = [[new THREE.Vector3(32, 0, 0), '#F16F78', 'X'], [new THREE.Vector3(0, 0, -32), '#35C99A', 'Y'], [new THREE.Vector3(0, 32, 0), '#79A9D8', 'Z']]
    for (const [end, color, label] of axes) {
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), end]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })))
      const s = textSprite(label, color); s.position.copy(end.clone().multiplyScalar(1.06)); scene.add(s)
    }
    const zoneMat = (color: string) => new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.035, depthWrite: false })
    const safeSphere = new THREE.Mesh(new THREE.SphereGeometry(15, 18, 10), zoneMat('#35C99A')); scene.add(safeSphere)
    const tetherSphere = new THREE.Mesh(new THREE.SphereGeometry(25, 24, 12), zoneMat('#F2B84B')); scene.add(tetherSphere)
    const zero = textSprite("Punto 0", "#45D6C5", 44); zero.position.set(0, 1.8, 0); scene.add(zero)

    const station = buildStation(); station.scale.setScalar(0.55); scene.add(station)
    const astronaut = buildAstronaut(); scene.add(astronaut)

    const tetherMat = new THREE.LineDashedMaterial({ color: '#45D6C5', dashSize: 0.6, gapSize: 0.4 })
    const tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), tetherMat); scene.add(tether)
    const trailMat = new THREE.LineBasicMaterial({ color: '#79A9D8', transparent: true, opacity: 0.7 })
    const trail = new THREE.Line(new THREE.BufferGeometry(), trailMat); scene.add(trail)

    let target = new THREE.Vector3(); let first = true
    const setData = (p: Position) => {
      target = toScene([p.x, p.y, p.z])
      if (first) { astronaut.position.copy(target); first = false }
      const color = ZONE[p.zone].color
      tetherMat.color.set(color)
      trail.geometry.dispose(); trail.geometry = new THREE.BufferGeometry().setFromPoints(p.trail.map(toScene))
    }
    const reset = () => { camera.position.set(30, 24, 40); controls.target.set(0, 0, 0) }

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize); observer.observe(mount); resize()

    let frame = 0
    const clock = new THREE.Clock()
    const loop = () => {
      frame = requestAnimationFrame(loop)
      const t = clock.getElapsedTime()
      astronaut.position.lerp(target, 0.06) // movimiento suave entre lecturas (1 por segundo)
      astronaut.rotation.y = t * 0.3; astronaut.rotation.z = Math.sin(t * 0.7) * 0.15
      tether.geometry.setFromPoints([new THREE.Vector3(), astronaut.position.clone()]); tether.computeLineDistances()
      stars.rotation.y = t * 0.002
      controls.update(); renderer.render(scene, camera)
      // Etiqueta de distancia encima del astronauta
      const label = labelRef.current
      if (label) {
        const v = astronaut.position.clone().add(new THREE.Vector3(0, 2.4, 0)).project(camera)
        label.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * mount.clientWidth}px, ${(-v.y * 0.5 + 0.5) * mount.clientHeight}px)`
        label.style.opacity = v.z < 1 ? '1' : '0'
      }
    }
    loop()
    sceneRef.current = { setData, reset }
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); renderer.dispose()
      scene.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.() })
      mount.removeChild(renderer.domElement); sceneRef.current = null
    }
  }, [])

  // Datos: una consulta por segundo
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await apiFetch(`/api/position?astronaut_id=${astronautId}&limit=120${demo ? '&demo=true' : ''}`)
        if (!res.ok) throw new Error(String(res.status))
        const data: Position = await res.json()
        if (alive) { setPos(data); setError(false); sceneRef.current?.setData(data) }
      } catch { if (alive) setError(true) }
    }
    load(); const timer = window.setInterval(load, 1000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [astronautId, demo])

  const zone = { ...(pos ? ZONE[pos.zone] : ZONE.cerca), ...zoneText(pos?.zone ?? 'cerca') }
  return <section className="eva-page">
    <div className="eva-stage">
      <div ref={mountRef} className="eva-canvas" />
      <div ref={labelRef} className="eva-label" style={{ borderColor: zone.color }}><b>{pos ? `${pos.distance_m.toFixed(1)} m` : '—'}</b><small>{name}</small></div>
      <div className="eva-hud">
        <span className={`eva-source ${pos?.source === 'hardware' ? 'real' : ''}`}>{pos?.source === 'hardware' ? t('POSICIÓN · ESP32 + MPU6050', 'POSITION · ESP32 + MPU6050') : t('POSICIÓN · SIMULACIÓN DE EVA', 'POSITION · EVA SIMULATION')}</span>
        {error && <span className="eva-source off">{t('Sin conexión con la API', 'No connection to the API')}</span>}
      </div>
      <div className="eva-controls">
        <button onClick={() => sceneRef.current?.reset()}>{t('Centrar vista', 'Reset view')}</button>
        <label><input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} /> {t('Trayectoria de demostración', 'Demo path')}</label>
      </div>
      <p className="eva-hint">{t('Arrastra para girar · rueda para acercar', 'Drag to rotate · scroll to zoom')}</p>
    </div>

    <div className="eva-side">
      <article className="eva-distance" style={{ borderColor: zone.color }}>
        <span><Icon name="cohete" size={16} /> {t('DISTANCIA A LA ESTACIÓN', 'DISTANCE TO THE STATION')}</span>
        <b style={{ color: zone.color }}>{pos ? pos.distance_m.toFixed(1) : '—'}<small> m</small></b>
        <p><i style={{ background: zone.color }} />{zone.label} · {zone.text}</p>
        <div className="eva-bar"><i style={{ width: `${Math.min(100, ((pos?.distance_m ?? 0) / (pos?.tether_m ?? 25)) * 100)}%`, background: zone.color }} /><em style={{ left: `${((pos?.safe_m ?? 15) / (pos?.tether_m ?? 25)) * 100}%` }} /></div>
        <small className="eva-scale"><span>0 m</span><span>{pos?.safe_m ?? 15} m</span><span>{pos?.tether_m ?? 25} m {t('cable', 'tether')}</span></small>
      </article>
      <article className="eva-coords">
        <div><span>X</span><b>{pos?.x.toFixed(1) ?? '—'}</b><small>m</small></div>
        <div><span>Y</span><b>{pos?.y.toFixed(1) ?? '—'}</b><small>m</small></div>
        <div><span>Z</span><b>{pos?.z.toFixed(1) ?? '—'}</b><small>m</small></div>
        <div><span>{t('Velocidad', 'Speed')}</span><b>{pos?.speed_m_s?.toFixed(2) ?? '—'}</b><small>m/s</small></div>
        <div><span>{t('Máx. (2 min)', 'Max (2 min)')}</span><b>{pos?.max_distance_m.toFixed(1) ?? '—'}</b><small>m</small></div>
      </article>
      <article className="eva-note">
        <span>{t('CÓMO SE MIDE', 'HOW IT IS MEASURED')}</span>
        <p>{t('El punto 0 es la escotilla de la estación. El ESP32 estima X, Y y Z integrando el acelerómetro MPU6050 desde ese punto, y lo envía a Supabase una vez por segundo.', 'Point 0 is the station hatch. The ESP32 estimates X, Y and Z by integrating the MPU6050 accelerometer from that point, and sends it to Supabase once per second.')}</p>
        <p>{t('Integrar la aceleración acumula error con el tiempo: es una', 'Integrating acceleration builds up error over time: it is an')} <b>{t('estimación', 'estimate')}</b>. {t('Una misión real lo combinaría con balizas de radio (UWB) en la estación.', 'A real mission would combine it with radio beacons (UWB) on the station.')}</p>
      </article>
    </div>
  </section>
}
