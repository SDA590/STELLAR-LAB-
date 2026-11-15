import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import Icon from './Icon'
import { apiFetch } from './api'
import { t } from './i18n'

// Posición del astronauta DENTRO de la cabina (cápsula tipo Orion, espacio habitable ~2 × 2 m).
// Punto 0 = centro de la cabina. X = hacia los paneles, Y = hacia los lados, Z = hacia arriba.
type Position = {
  source: 'hardware' | 'simulation'; x: number; y: number; z: number; distance_m: number; speed_m_s: number | null
  max_distance_m: number; edge_m?: number; cabin_half_m?: number
  zone: 'cerca' | 'atencion' | 'fuera'; safe_m: number; tether_m: number; trail: [number, number, number][]
}

const ZONE = {
  cerca: { color: '#35C99A' },
  atencion: { color: '#F2B84B' },
  fuera: { color: '#F16F78' },
}
const zoneText = (z: keyof typeof ZONE) => ({
  cerca: { label: t('Dentro de la cabina', 'Inside the cabin'), text: t('Lejos de las paredes.', 'Away from the walls.') },
  atencion: { label: t('Junto a una pared', 'Next to a wall'), text: t('A menos de 25 cm de la pared, el piso o el techo.', 'Less than 25 cm from the wall, floor or ceiling.') },
  fuera: { label: t('Fuera de la cabina', 'Outside the cabin'), text: t('Imposible en la realidad: la estimación se desvió. Recalibra el nodo en el centro.', 'Impossible in reality: the estimate drifted. Recalibrate the node at the centre.') },
})[z]

// Datos: X, Y en el plano y Z hacia arriba (metros desde el punto 0). En three.js "arriba" es Y.
const toScene = ([x, y, z]: [number, number, number]) => new THREE.Vector3(x, z, -y)

// Medidas de la cápsula (m). El cilindro habitable (r = 1, alto 2) cabe dentro del cono.
const CAP = { bottomR: 2.2, topR: 0.95, bottomY: -1.2, topY: 1.4 }

function textSprite(text: string, color = '#91A2B4', size = 64, scale = 0.5) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.font = `600 ${size}px Inter, sans-serif`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 64)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }))
  sprite.scale.set(2 * scale, scale, 1)
  return sprite
}

/** Cápsula tipo Orion: escudo térmico, casco cónico translúcido, túnel de acople, ventanas, asientos y paneles. */
function buildCapsule() {
  const g = new THREE.Group()
  const h = CAP.topY - CAP.bottomY
  // Casco cónico (translúcido para ver el interior) y sus aristas
  const hullGeo = new THREE.CylinderGeometry(CAP.topR, CAP.bottomR, h, 48, 1, true)
  const hull = new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({ color: '#c9d4df', metalness: 0.5, roughness: 0.4, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }))
  hull.position.y = (CAP.topY + CAP.bottomY) / 2; g.add(hull)
  const ribs = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(CAP.topR, CAP.bottomR, h, 16, 1, true)), new THREE.LineBasicMaterial({ color: '#79A9D8', transparent: true, opacity: 0.35 }))
  ribs.position.copy(hull.position); g.add(ribs)
  // Escudo térmico (base) y anillo de unión
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(CAP.bottomR + 0.05, CAP.bottomR - 0.25, 0.28, 48), new THREE.MeshStandardMaterial({ color: '#5a4636', roughness: 0.9 }))
  shield.position.y = CAP.bottomY - 0.14; g.add(shield)
  const floor = new THREE.Mesh(new THREE.CircleGeometry(CAP.bottomR - 0.05, 48), new THREE.MeshStandardMaterial({ color: '#192A3B', roughness: 0.9, side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; floor.position.y = CAP.bottomY + 0.01; g.add(floor)
  // Túnel de acople y escotilla superior
  const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.55, 32), new THREE.MeshStandardMaterial({ color: '#c9d4df', metalness: 0.6, roughness: 0.35, transparent: true, opacity: 0.55 }))
  tunnel.position.y = CAP.topY + 0.27; g.add(tunnel)
  const hatchRing = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 8, 32), new THREE.MeshBasicMaterial({ color: '#45D6C5' }))
  hatchRing.rotation.x = Math.PI / 2; hatchRing.position.y = CAP.topY + 0.56; g.add(hatchRing)
  // Ventanas en el cono (lado de los paneles, +X)
  const slope = Math.atan2(CAP.bottomR - CAP.topR, h)
  for (const a of [-0.35, 0.35]) {
    const y = 0.75, r = CAP.topR + (CAP.bottomR - CAP.topR) * ((CAP.topY - y) / h) + 0.01
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.26), new THREE.MeshBasicMaterial({ color: '#79A9D8', transparent: true, opacity: 0.7, side: THREE.DoubleSide }))
    win.position.set(Math.cos(a) * r, y, Math.sin(a) * r); win.lookAt(win.position.clone().multiplyScalar(2).setY(y)); win.rotateX(-slope); g.add(win)
  }
  // Panel de control (frente, +X) con pantallas
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 1.5), new THREE.MeshStandardMaterial({ color: '#26394B', roughness: 0.6 }))
  panel.position.set(1.15, 0.05, 0); panel.rotation.z = -0.35; g.add(panel)
  for (const z of [-0.45, 0, 0.45]) {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.28), new THREE.MeshBasicMaterial({ color: '#45D6C5', transparent: true, opacity: 0.55 }))
    screen.position.set(1.08, 0.08, z); screen.rotation.y = -Math.PI / 2; screen.rotation.x = 0; screen.rotateX(0.35); g.add(screen)
  }
  // 4 asientos reclinados mirando a los paneles (2 abajo, 2 arriba como en Orion)
  const seatMat = new THREE.MeshStandardMaterial({ color: '#3b5068', roughness: 0.7 })
  for (const [x, y, z] of [[-0.2, -0.95, -0.45], [-0.2, -0.95, 0.45], [-0.55, -0.35, -0.45], [-0.55, -0.35, 0.45]] as const) {
    const seat = new THREE.Group()
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.07, 0.42), seatMat); seat.add(base)
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.6, 0.42), seatMat); back.position.set(-0.3, 0.26, 0); back.rotation.z = 0.45; seat.add(back)
    seat.position.set(x, y, z); g.add(seat)
  }
  return g
}

/** Astronauta con traje de vuelo azul, a escala real (~1,75 m). */
function buildAstronaut() {
  const g = new THREE.Group()
  const suit = new THREE.MeshStandardMaterial({ color: '#3d6fb6', roughness: 0.65 })
  const skin = new THREE.MeshStandardMaterial({ color: '#e0b48f', roughness: 0.8 })
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.42, 6, 12), suit); torso.position.y = 0.1; g.add(torso)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), skin); head.position.y = 0.55; g.add(head)
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.5, 4, 8), suit); arm.position.set(s * 0.22, 0.12, 0); arm.rotation.z = s * 0.35; g.add(arm)
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.6, 4, 8), suit); leg.position.set(s * 0.09, -0.5, 0); leg.rotation.z = s * 0.08; g.add(leg)
  }
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), new THREE.MeshBasicMaterial({ color: '#45D6C5', transparent: true, opacity: 0.07, depthWrite: false })); g.add(halo)
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
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2000)
    const home = new THREE.Vector3(4.6, 2.6, 5.2)
    camera.position.copy(home)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.maxDistance = 14; controls.minDistance = 1.5

    scene.add(new THREE.AmbientLight('#8fb3d9', 1.1))
    const sun = new THREE.DirectionalLight('#ffffff', 2.0); sun.position.set(6, 8, 4); scene.add(sun)
    const cabinLight = new THREE.PointLight('#bfe9ff', 6, 4); cabinLight.position.set(0, 0.9, 0); scene.add(cabinLight)

    // Estrellas y Tierra de fondo
    const starPos = new Float32Array(1200 * 3)
    for (let i = 0; i < starPos.length; i++) starPos[i] = (Math.random() - 0.5) * 600
    const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(starPos, 3)), new THREE.PointsMaterial({ color: '#c8d6e5', size: 0.6 }))
    scene.add(stars)
    const planet = new THREE.Mesh(new THREE.SphereGeometry(120, 48, 32), new THREE.MeshStandardMaterial({ color: '#1d5d9b', emissive: '#08223f', roughness: 0.9 }))
    planet.position.set(-150, -170, -320); scene.add(planet)

    scene.add(buildCapsule())

    // Cabina habitable (~2 m de diámetro × 2 m de alto) y zona "junto a la pared"
    const cabin = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2, 32, 1, true), new THREE.MeshBasicMaterial({ color: '#45D6C5', wireframe: true, transparent: true, opacity: 0.12, depthWrite: false }))
    scene.add(cabin)
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.5, 32, 1, true), new THREE.MeshBasicMaterial({ color: '#35C99A', wireframe: true, transparent: true, opacity: 0.06, depthWrite: false }))
    scene.add(inner)
    const sizeLabel = textSprite(t('cabina ≈ 2 m', 'cabin ≈ 2 m'), '#45D6C5', 40, 0.45); sizeLabel.position.set(0, 1.18, -1.05); scene.add(sizeLabel)

    // Ejes de referencia desde el punto 0 (1 m)
    const axes: [THREE.Vector3, string, string][] = [[new THREE.Vector3(1.05, 0, 0), '#F16F78', 'X'], [new THREE.Vector3(0, 0, -1.05), '#35C99A', 'Y'], [new THREE.Vector3(0, 1.05, 0), '#79A9D8', 'Z']]
    for (const [end, color, label] of axes) {
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), end]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })))
      const s = textSprite(label, color, 64, 0.22); s.position.copy(end.clone().multiplyScalar(1.12)); scene.add(s)
    }
    const zeroDot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: '#45D6C5' })); scene.add(zeroDot)
    const zero = textSprite(t('Punto 0', 'Point 0'), '#45D6C5', 44, 0.35); zero.position.set(0, -0.14, 0); scene.add(zero)

    const astronaut = buildAstronaut(); scene.add(astronaut)

    const lineMat = new THREE.LineDashedMaterial({ color: '#45D6C5', dashSize: 0.06, gapSize: 0.04 })
    const toCenter = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMat); scene.add(toCenter)
    const trailMat = new THREE.LineBasicMaterial({ color: '#79A9D8', transparent: true, opacity: 0.7 })
    const trail = new THREE.Line(new THREE.BufferGeometry(), trailMat); scene.add(trail)

    let target = new THREE.Vector3(); let first = true
    const setData = (p: Position) => {
      target = toScene([p.x, p.y, p.z])
      if (first) { astronaut.position.copy(target); first = false }
      lineMat.color.set(ZONE[p.zone].color)
      trail.geometry.dispose(); trail.geometry = new THREE.BufferGeometry().setFromPoints(p.trail.map(toScene))
    }
    const reset = () => { camera.position.copy(home); controls.target.set(0, 0, 0) }

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize); observer.observe(mount); resize()

    let frame = 0
    const clock = new THREE.Clock()
    const loop = () => {
      frame = requestAnimationFrame(loop)
      const time = clock.getElapsedTime()
      astronaut.position.lerp(target, 0.06) // movimiento suave entre lecturas (1 por segundo)
      astronaut.rotation.y = time * 0.25; astronaut.rotation.z = Math.sin(time * 0.6) * 0.25 // flota en microgravedad
      toCenter.geometry.setFromPoints([new THREE.Vector3(), astronaut.position.clone()]); toCenter.computeLineDistances()
      stars.rotation.y = time * 0.002
      controls.update(); renderer.render(scene, camera)
      // Etiqueta de distancia encima del astronauta
      const label = labelRef.current
      if (label) {
        const v = astronaut.position.clone().add(new THREE.Vector3(0, 0.85, 0)).project(camera)
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
  const half = pos?.cabin_half_m ?? 1, edge = pos?.edge_m ?? 0
  return <section className="eva-page">
    <div className="eva-stage">
      <div ref={mountRef} className="eva-canvas" />
      <div ref={labelRef} className="eva-label" style={{ borderColor: zone.color }}><b>{pos ? `${pos.distance_m.toFixed(2)} m` : '—'}</b><small>{name}</small></div>
      <div className="eva-hud">
        <span className={`eva-source ${pos?.source === 'hardware' ? 'real' : ''}`}>{pos?.source === 'hardware' ? t('POSICIÓN · ESP32 + MPU6050', 'POSITION · ESP32 + MPU6050') : t('POSICIÓN · SIMULACIÓN EN CABINA', 'POSITION · CABIN SIMULATION')}</span>
        {error && <span className="eva-source off">{t('Sin conexión con la API', 'No connection to the API')}</span>}
      </div>
      <div className="eva-controls">
        <button onClick={() => sceneRef.current?.reset()}>{t('Centrar vista', 'Reset view')}</button>
        <label><input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} /> {t('Movimiento de demostración', 'Demo movement')}</label>
      </div>
      <p className="eva-hint">{t('Arrastra para girar · rueda para acercar', 'Drag to rotate · scroll to zoom')}</p>
    </div>

    <div className="eva-side">
      <article className="eva-distance" style={{ borderColor: zone.color }}>
        <span><Icon name="cohete" size={16} /> {t('DISTANCIA AL CENTRO DE LA CABINA', 'DISTANCE TO CABIN CENTRE')}</span>
        <b style={{ color: zone.color }}>{pos ? pos.distance_m.toFixed(2) : '—'}<small> m</small></b>
        <p><i style={{ background: zone.color }} />{zone.label} · {zone.text}</p>
        <div className="eva-bar"><i style={{ width: `${Math.min(100, (edge / half) * 100)}%`, background: zone.color }} /><em style={{ left: `${((pos?.safe_m ?? 0.75) / half) * 100}%` }} /></div>
        <small className="eva-scale"><span>{t('centro', 'centre')}</span><span>{pos?.safe_m ?? 0.75} m</span><span>{half} m {t('pared', 'wall')}</span></small>
      </article>
      <article className="eva-coords">
        <div><span>X</span><b>{pos?.x.toFixed(2) ?? '—'}</b><small>m</small></div>
        <div><span>Y</span><b>{pos?.y.toFixed(2) ?? '—'}</b><small>m</small></div>
        <div><span>Z</span><b>{pos?.z.toFixed(2) ?? '—'}</b><small>m</small></div>
        <div><span>{t('Velocidad', 'Speed')}</span><b>{pos?.speed_m_s?.toFixed(2) ?? '—'}</b><small>m/s</small></div>
        <div><span>{t('Máx. (2 min)', 'Max (2 min)')}</span><b>{pos?.max_distance_m.toFixed(2) ?? '—'}</b><small>m</small></div>
      </article>
      <article className="eva-note">
        <span>{t('CÓMO SE MIDE', 'HOW IT IS MEASURED')}</span>
        <p>{t('La cabina habitable de la cápsula mide unos 2 m de lado a lado. El punto 0 es su centro: el ESP32 estima X, Y y Z integrando el acelerómetro MPU6050 desde ahí y lo envía una vez por segundo.', 'The capsule’s habitable cabin is about 2 m across. Point 0 is its centre: the ESP32 estimates X, Y and Z by integrating the MPU6050 accelerometer from there and sends it once per second.')}</p>
        <p>{t('Integrar la aceleración acumula error: es una', 'Integrating acceleration builds up error: it is an')} <b>{t('estimación', 'estimate')}</b>. {t('Si la posición sale de la cabina, la app avisa para recalibrar el nodo.', 'If the position leaves the cabin, the app asks you to recalibrate the node.')}</p>
      </article>
    </div>
  </section>
}
