import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import gsap from 'gsap'

// ── design tokens ─────────────────────────────────────────────────────────────
const tokens = {
  bg:      '#000000',
  gold:    '#C9A84C',
  xenon:   '#C8E8FF',
  key:     '#FFD580',
  rim:     '#4466FF',
  muted:   'rgba(255,255,255,0.40)',
  display: '"Bebas Neue", cursive',
  body:    '"Inter", sans-serif',
}

// ── touch detection ───────────────────────────────────────────────────────────
const isTouch = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

// ── Web Audio engine startup ──────────────────────────────────────────────────
function playEngineStartup() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()

    // 1. Mechanical click — sawtooth burst
    const clickOsc  = ctx.createOscillator()
    const clickGain = ctx.createGain()
    clickOsc.type = 'sawtooth'
    clickOsc.frequency.value = 40
    clickGain.gain.setValueAtTime(0,   ctx.currentTime)
    clickGain.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.04)
    clickGain.gain.linearRampToValueAtTime(0,   ctx.currentTime + 0.15)
    clickOsc.connect(clickGain)
    clickGain.connect(ctx.destination)
    clickOsc.start()
    clickOsc.stop(ctx.currentTime + 0.15)

    // 2. Noise burst
    const bufLen = Math.floor(ctx.sampleRate * 0.3)
    const nBuf   = ctx.createBuffer(1, bufLen, ctx.sampleRate)
    const nData  = nBuf.getChannelData(0)
    for (let i = 0; i < bufLen; i++) nData[i] = Math.random() * 2 - 1
    const nSrc  = ctx.createBufferSource()
    const nGain = ctx.createGain()
    nSrc.buffer = nBuf
    nGain.gain.setValueAtTime(0.3,   ctx.currentTime + 0.12)
    nGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.42)
    nSrc.connect(nGain)
    nGain.connect(ctx.destination)
    nSrc.start(ctx.currentTime + 0.12)

    // 3. Idle rumble — sine 28 Hz, lingers
    const idleOsc  = ctx.createOscillator()
    const idleGain = ctx.createGain()
    idleOsc.type = 'sine'
    idleOsc.frequency.value = 28
    idleGain.gain.setValueAtTime(0,    ctx.currentTime + 0.2)
    idleGain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 3.2)
    idleOsc.connect(idleGain)
    idleGain.connect(ctx.destination)
    idleOsc.start(ctx.currentTime + 0.2)

    return () => { try { ctx.close() } catch (_) {} }
  } catch (_) {
    return () => {}
  }
}

// ── Three.js scene ────────────────────────────────────────────────────────────
class JeskoScene {
  constructor(canvas, mobile, onLoaded, onRevealed) {
    this.canvas      = canvas
    this.mobile      = mobile
    this.onLoaded    = onLoaded   || (() => {})
    this.onRevealed  = onRevealed || (() => {})
    this._animId     = null
    this.carGroup    = null
    this._baseY      = 0
    this.mouseTarget = { x: 0, y: 0 }
    this.mouseLerp   = { x: 0, y: 0 }
    this._disposeAudio = () => {}
    this._tweens     = []

    this._initRenderer()
    this._initLights()
    this._loadModel()
  }

  _initRenderer() {
    const c = this.canvas
    this.renderer = new THREE.WebGLRenderer({
      canvas: c,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(c.clientWidth, c.clientHeight, false)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap
    this.renderer.toneMapping       = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.3
    this.renderer.setClearColor(0x000000, 1)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x000000)

    const w = c.clientWidth, h = c.clientHeight
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100)
    this.camera.position.set(0, 0.8, 4.5)
    this.camera.lookAt(0, 0.3, 0)
  }

  _initLights() {
    const dim = this.mobile ? 0.7 : 1.0

    this.ambient = new THREE.AmbientLight(0xffffff, 0)
    this.scene.add(this.ambient)

    const makeHead = (x) => {
      const s = new THREE.SpotLight(0xC8E8FF, 0, 30, 0.15, 0.3)
      s.position.set(x, 0.3, 1.8)
      s.target.position.set(x, 0.3, 10)
      this.scene.add(s)
      this.scene.add(s.target)
      return s
    }
    this.headL = makeHead(-0.6)
    this.headR = makeHead( 0.6)

    this.keyLight = new THREE.SpotLight(0xFFD580, 0, 40, 0.6, 0.5)
    this.keyLight.position.set(3, 4, 2)
    this.keyLight.castShadow = true
    this.keyLight.shadow.mapSize.setScalar(1024)
    this.scene.add(this.keyLight)

    this.rimLight = new THREE.SpotLight(0x4466FF, 0, 30, 0.7, 0.6)
    this.rimLight.position.set(-2, 2, -3)
    this.scene.add(this.rimLight)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.ShadowMaterial({ opacity: 0.5 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)

    this._dim = dim
  }

  _loadModel() {
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')

    const loader = new GLTFLoader()
    loader.setDRACOLoader(draco)

    loader.load(
      'https://pub-dec131da5d0340eabf06ef52ffc98beb.r2.dev/koenigsegg_compressed.glb',
      (gltf) => {
        this.carGroup = gltf.scene

        this.carGroup.traverse((n) => {
          if (n.isMesh) { n.castShadow = true; n.receiveShadow = true }
        })

        const box    = new THREE.Box3().setFromObject(this.carGroup)
        const center = box.getCenter(new THREE.Vector3())
        const size   = box.getSize(new THREE.Vector3())
        const scale  = 3.5 / Math.max(size.x, size.y, size.z)

        this.carGroup.scale.setScalar(scale)
        this.carGroup.position.set(
          -center.x * scale,
          -center.y * scale,
          -center.z * scale,
        )

        this.scene.add(this.carGroup)
        this.onLoaded()
        this._reveal()
      },
      undefined,
      (err) => console.error('[JeskoScene]', err),
    )
  }

  _reveal() {
    const dim = this._dim
    const tw  = (target, vars) => { const t = gsap.to(target, vars);       this._tweens.push(t); return t }
    const dc  = (delay, fn)    => { const t = gsap.delayedCall(delay, fn); this._tweens.push(t); return t }

    // t+1s — headlights cut through, engine fires
    dc(1.0, () => {
      this._disposeAudio = playEngineStartup()
      tw([this.headL, this.headR], {
        intensity: 12 * dim,
        duration: 0.8,
        ease: 'power2.out',
        onComplete: () => this.onRevealed(),
      })
    })

    // t+1.5s — car silhouette emerges from darkness
    dc(1.5, () => tw(this.ambient,  { intensity: 0.15,      duration: 3.0, ease: 'power1.inOut' }))

    // t+2s — warm top-right key light
    dc(2.0, () => tw(this.keyLight, { intensity: 1.8 * dim, duration: 2.0, ease: 'power1.inOut' }))

    // t+2.5s — cool rim from behind
    dc(2.5, () => tw(this.rimLight, { intensity: 1.2 * dim, duration: 2.0, ease: 'power1.inOut' }))
  }

  startLoop() {
    const tick = () => {
      this._animId = requestAnimationFrame(tick)

      if (!this.mobile) {
        this.mouseLerp.x += (this.mouseTarget.x - this.mouseLerp.x) * 0.03
        this.mouseLerp.y += (this.mouseTarget.y - this.mouseLerp.y) * 0.03
      }

      if (this.carGroup) {
        this._baseY += 0.002
        this.carGroup.rotation.y = this._baseY + (this.mobile ? 0 : this.mouseLerp.x * 0.15)
        this.carGroup.rotation.x = this.mobile ? 0 : this.mouseLerp.y * 0.15
      }

      this.renderer.render(this.scene, this.camera)
    }
    tick()
  }

  stopLoop() {
    if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null }
  }

  onMouseMove(nx, ny) {
    this.mouseTarget.x = nx
    this.mouseTarget.y = ny
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  dispose() {
    this.stopLoop()
    this._tweens.forEach(t => t.kill())
    this._disposeAudio()
    this.renderer.dispose()
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const canvasRef  = useRef(null)
  const [loaded,   setLoaded]   = useState(false)
  const [revealed, setRevealed] = useState(false)
  const mobile     = useMemo(isTouch, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const scene = new JeskoScene(
      canvas,
      mobile,
      () => setLoaded(true),
      () => setRevealed(true),
    )
    scene.startLoop()

    const onResize = () => scene.resize()
    const onMove   = (e) => scene.onMouseMove(
      (e.clientX / window.innerWidth  - 0.5) * 2,
      -(e.clientY / window.innerHeight - 0.5) * 2,
    )

    window.addEventListener('resize', onResize)
    if (!mobile) window.addEventListener('mousemove', onMove, { passive: true })

    return () => {
      window.removeEventListener('resize', onResize)
      if (!mobile) window.removeEventListener('mousemove', onMove)
      scene.dispose()
    }
  }, [mobile])

  return (
    <div style={{ position: 'fixed', inset: 0, background: tokens.bg, overflow: 'hidden' }}>

      {/* Full-screen canvas */}
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />

      {/* Loading bar — fills left→right while GLB downloads; static on mobile */}
      {!loaded && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            width: '60%', height: '2px',
            background: `${tokens.gold}1A`,
            overflow: 'hidden',
          }}>
            <div style={{
              width: '100%', height: '100%',
              background: tokens.gold,
              transformOrigin: 'left center',
              transform: mobile ? 'scaleX(1)' : 'scaleX(0)',
              animation: mobile ? 'none' : 'lfill 5s cubic-bezier(.4,0,.2,1) forwards',
            }} />
          </div>
        </div>
      )}

      {/* Top-left: wordmark — always visible */}
      <div style={{
        position: 'absolute', top: 28, left: 32,
        fontFamily: tokens.body, fontSize: 10,
        letterSpacing: '0.22em', textTransform: 'uppercase',
        color: tokens.gold, opacity: 0.4,
        pointerEvents: 'none', userSelect: 'none',
      }}>
        KOENIGSEGG
      </div>

      {/* Bottom-center: model name — fades in after headlight reveal */}
      <div style={{
        position: 'absolute', bottom: 36, left: 0, right: 0,
        display: 'flex', justifyContent: 'center',
        pointerEvents: 'none', userSelect: 'none',
        opacity: revealed ? 1 : 0,
        transition: 'opacity 1.4s ease',
      }}>
        <span style={{
          fontFamily: tokens.display,
          fontSize: 18,
          letterSpacing: '0.5em',
          color: tokens.gold,
          textTransform: 'uppercase',
        }}>
          JESKO&nbsp;ABSOLUT
        </span>
      </div>

      {/* Bottom-right: spec — fades in with slight delay */}
      <div style={{
        position: 'absolute', bottom: 36, right: 32,
        fontFamily: tokens.body, fontSize: 11,
        letterSpacing: '0.08em', color: tokens.muted,
        pointerEvents: 'none', userSelect: 'none',
        opacity: revealed ? 1 : 0,
        transition: 'opacity 1.4s ease 0.3s',
      }}>
        1,600 BHP
      </div>

      <style>{`
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { overflow: hidden; background: #000; }
        @keyframes lfill {
          from { transform: scaleX(0); }
          to   { transform: scaleX(1); }
        }
      `}</style>
    </div>
  )
}
