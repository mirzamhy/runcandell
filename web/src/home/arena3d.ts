/**
 * Arena backdrop: the 3D warrior mask in front of a flame shader, with rising embers.
 * The mask follows a DOM "slot" element so the HTML layout decides where it sits.
 */
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Path,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  Shape,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { EYE_L, EYE_R, MASK_H, MASK_W, OUTLINE } from './mask'

const FLAME_FRAG = /* glsl */ `uniform float t; uniform float grow; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a*n(p); p *= 2.03; a *= .5; } return v; }
void main(){
  vec2 uv = vUv; vec2 p = uv * vec2(3.2, 3.6); p.y -= t * 1.3;
  float q = fbm(p + fbm(p * 1.7 + t * .2));
  float body = 1. - length((uv - vec2(.5, .4)) * vec2(1.9, 1.15));
  float f = clamp(body * 1.5 + q * 1.15 - .72 - uv.y * .18 - (1. - grow) * .9, 0., 1.);
  vec3 c = mix(vec3(.13, .04, .38), vec3(.52, .18, 1.), smoothstep(.05, .5, f));
  c = mix(c, vec3(.93, .78, 1.), smoothstep(.68, 1., f));
  f *= grow; // grow = 0: no fire at all, not even the brightest noise peaks
  f *= smoothstep(.0, .28, uv.y) * smoothstep(1., .66, uv.y); // soft edges, no hard cut at the plane border
  gl_FragColor = vec4(c * f * 1.5, f);
}`

function glowTex(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  r.addColorStop(0, inner)
  r.addColorStop(1, outer)
  g.fillStyle = r
  g.fillRect(0, 0, 64, 64)
  return new CanvasTexture(c)
}

const additive = { transparent: true, depthWrite: false, blending: AdditiveBlending } as const
const EMBERS = 220

export class Arena3D {
  private renderer: WebGLRenderer
  private scene = new Scene()
  private camera = new PerspectiveCamera(35, 1, 0.1, 100)
  private mask = new Group()
  private maskMat: MeshStandardMaterial
  private flameMat: ShaderMaterial
  private emberPos = new Float32Array(EMBERS * 3)
  private emberVel = new Float32Array(EMBERS)
  private emberGeo = new BufferGeometry()
  private target = { pos: new Vector3(), scale: 1 }
  private slot: HTMLElement | null = null
  private mouse = { x: 0, y: 0 }
  /** 0 = lost in the dark, 1 = fully lit; eased towards revealTarget */
  private reveal = 1
  private revealFrom = 1
  private revealStart = 0
  private revealMs = 0
  /** no tilt / bob / mouse follow */
  private still = false
  private fades: { m: { opacity: number }; base: number; early?: boolean }[] = []
  private lights: { l: { intensity: number }; base: number }[] = []
  private smooth = false
  private raf = 0
  private last = 0
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75))
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.camera.position.set(0, 0, 9)
    this.maskMat = new MeshStandardMaterial({ color: 0x8a0410, emissive: 0xff1a10, emissiveIntensity: 0.35, roughness: 0.32, metalness: 0.55 })
    this.flameMat = new ShaderMaterial({
      uniforms: { t: { value: 0 }, grow: { value: 1 } },
      ...additive,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: FLAME_FRAG,
    })
    this.build()
    addEventListener('resize', this.onResize)
    addEventListener('scroll', this.place, { passive: true })
    addEventListener('pointermove', this.onPointer)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.onResize()
  }

  private build() {
    const cx = MASK_W / 2
    const cy = MASK_H / 2
    const v = ([x, y]: [number, number]) => new Vector2(x - cx, cy - y)
    const shape = new Shape(OUTLINE.map(v))
    for (const eye of [EYE_R, EYE_L]) shape.holes.push(new Path(eye.map(v)))
    const geo = new ExtrudeGeometry(shape, { depth: 16, bevelEnabled: true, bevelThickness: 7, bevelSize: 5, bevelSegments: 4, curveSegments: 6 })
    geo.translate(0, 0, -8)
    geo.scale(1 / cy, 1 / cy, 1 / cy) // 2 units tall
    // curve the face around a vertical axis and push the nose ridge forward
    const p = geo.attributes.position
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      p.setZ(i, p.getZ(i) - x * x * 0.42 + Math.max(0, 0.18 - Math.abs(x) * 0.9) * (y < 0.5 ? 1 : 0.3))
    }
    geo.computeVertexNormals()
    this.mask.add(new Mesh(geo, this.maskMat))

    // glowing eyes: bright backing seen through the holes + red halo in front
    const eyeGlow = glowTex('rgba(255,80,60,1)', 'rgba(255,0,0,0)')
    const white = glowTex()
    for (const sx of [-1, 1]) {
      const back = new Mesh(new PlaneGeometry(0.34, 0.2), new MeshBasicMaterial({ color: 0xfff1ee, transparent: true }))
      this.fades.push({ m: back.material, base: 1, early: true })
      back.position.set(sx * 0.23, -0.03, -0.06)
      back.rotation.y = sx * 0.35
      this.mask.add(back)
      const halo = new Sprite(new SpriteMaterial({ map: eyeGlow, ...additive }))
      this.fades.push({ m: halo.material, base: 1, early: true })
      halo.position.set(sx * 0.3, -0.06, 0.25)
      halo.scale.set(0.9, 0.55, 1)
      this.mask.add(halo)
      const core = new Sprite(new SpriteMaterial({ map: white, ...additive, opacity: 0.8 }))
      this.fades.push({ m: core.material, base: 0.8, early: true })
      core.position.set(sx * 0.3, -0.06, 0.26)
      core.scale.set(0.32, 0.16, 1)
      this.mask.add(core)
    }

    const flame = new Mesh(new PlaneGeometry(4, 4.8), this.flameMat)
    flame.position.set(0, 0.7, -0.6)
    this.mask.add(flame)

    for (let i = 0; i < EMBERS; i++) this.resetEmber(i, (Math.random() - 0.5) * 4)
    this.emberGeo.setAttribute('position', new BufferAttribute(this.emberPos, 3))
    const emberMat = new PointsMaterial({ size: 0.05, map: glowTex('rgba(214,170,255,1)', 'rgba(120,40,255,0)'), ...additive })
    this.fades.push({ m: emberMat, base: 1 })
    this.mask.add(new Points(this.emberGeo, emberMat))

    const haze = new Sprite(new SpriteMaterial({ map: glowTex('rgba(124,77,255,.5)', 'rgba(53,54,156,0)'), ...additive }))
    haze.position.z = -1.4
    haze.scale.set(7, 7, 1)
    this.fades.push({ m: haze.material, base: 1 })
    this.mask.add(haze)
    this.scene.add(this.mask)

    const amb = new AmbientLight(0x3b3664, 1.2)
    this.scene.add(amb)
    const key = new PointLight(0xff3a2a, 30, 12)
    key.position.set(0, -1.2, 3)
    const rim = new DirectionalLight(0x405ffa, 4)
    rim.position.set(-3, 2, -3)
    const rim2 = new DirectionalLight(0x09bbc8, 1.5)
    rim2.position.set(3, 1, -2)
    const top = new DirectionalLight(0xffffff, 0.8)
    top.position.set(1, 3, 4)
    // purple fire light licking the sides of the mask
    const fireL = new PointLight(0x8a4dff, 14, 8)
    fireL.position.set(-1.6, 0.6, 1.2)
    const fireR = new PointLight(0x8a4dff, 14, 8)
    fireR.position.set(1.6, 0.6, 1.2)
    this.scene.add(key, rim, rim2, top, fireL, fireR)
    for (const l of [amb, key, rim, rim2, top, fireL, fireR]) this.lights.push({ l, base: l.intensity })
  }

  private resetEmber(i: number, y?: number) {
    this.emberPos[i * 3] = (Math.random() - 0.5) * 3.2
    this.emberPos[i * 3 + 1] = y ?? -1.6 + Math.random() * 0.6
    this.emberPos[i * 3 + 2] = (Math.random() - 0.5) * 1.5
    this.emberVel[i] = 0.25 + Math.random() * 0.7
  }

  /** Put the mask over this element (null hides it). Jumps there without easing. */
  follow(el: HTMLElement | null, glide = false) {
    this.slot = el
    this.mask.visible = !!el
    this.smooth = glide
    this.place()
    if (!glide) {
      this.mask.position.copy(this.target.pos)
      this.mask.scale.setScalar(this.target.scale)
    }
    if (this.reduced) this.frame(performance.now())
  }

  /** Hold the mask still (intro) or let it breathe and follow the mouse. */
  setStill(still: boolean) {
    this.still = still
  }

  /** Fade the scene to black now, or bring it up from black over `ms`. */
  setReveal(target: 0 | 1, ms = 0) {
    this.revealFrom = this.reveal
    this.revealStart = performance.now()
    this.revealMs = ms
    if (!ms) this.reveal = target
    this.revealTarget = target
    this.applyReveal()
    if (this.reduced) this.frame(performance.now())
  }
  private revealTarget = 1

  private applyReveal() {
    const r = this.reveal
    const body = Math.max(0, (r - 0.25) / 0.75) // eyes light up first, then the rest
    const eyes = Math.min(1, r * 2.5)
    for (const f of this.fades) f.m.opacity = f.base * (f.early ? eyes : body)
    for (const x of this.lights) x.l.intensity = x.base * body
    this.flameMat.uniforms.grow.value = body
  }

  private place = () => {
    const el = this.slot
    if (!el) return
    const r = el.getBoundingClientRect()
    const cam = this.camera
    cam.updateMatrixWorld()
    const dir = new Vector3(((r.left + r.width / 2) / innerWidth) * 2 - 1, -((r.top + r.height / 2) / innerHeight) * 2 + 1, 0.5)
      .unproject(cam)
      .sub(cam.position)
      .normalize()
    this.target.pos.copy(cam.position).addScaledVector(dir, -cam.position.z / dir.z)
    const worldPerPx = (2 * Math.tan(MathUtils.degToRad(cam.fov / 2)) * cam.position.z) / innerHeight
    // 0.86: the bevel and nose sit in front of z=0 and read bigger through the perspective
    this.target.scale = ((r.height * worldPerPx) / 2) * 0.86
    if (this.reduced) this.frame(performance.now())
  }

  private onResize = () => {
    this.renderer.setSize(innerWidth, innerHeight, false)
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    this.follow(this.slot)
  }

  private onPointer = (e: PointerEvent) => {
    this.mouse.x = e.clientX / innerWidth - 0.5
    this.mouse.y = e.clientY / innerHeight - 0.5
  }

  private onVisibility = () => (document.hidden ? this.stop() : this.start())

  start() {
    if (this.raf || this.reduced) return this.frame(performance.now())
    this.last = performance.now()
    const loop = (now: number) => {
      this.frame(now)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    const t = now / 1000
    const m = this.mask
    if (this.revealMs && this.reveal !== this.revealTarget) {
      const k = Math.min(1, (now - this.revealStart) / this.revealMs)
      const e = k * k * (3 - 2 * k)
      this.reveal = this.revealFrom + (this.revealTarget - this.revealFrom) * e
      this.applyReveal()
    }
    const ease = this.reduced ? 1 : this.smooth ? 0.05 : 0.12
    m.position.lerp(this.target.pos, ease)
    const s = MathUtils.lerp(m.scale.x, this.target.scale, ease)
    m.scale.setScalar(s)
    const lit = Math.max(0, (this.reveal - 0.25) / 0.75)
    if (this.still || this.reduced) {
      m.rotation.y = MathUtils.lerp(m.rotation.y, 0, 0.06)
      m.rotation.x = MathUtils.lerp(m.rotation.x, 0, 0.06)
      this.maskMat.emissiveIntensity = 0.32 * lit
    } else {
      m.rotation.y = MathUtils.lerp(m.rotation.y, this.mouse.x * 0.7 + Math.sin(t * 0.5) * 0.08, 0.06)
      m.rotation.x = MathUtils.lerp(m.rotation.x, this.mouse.y * 0.4, 0.06)
      m.position.y += Math.sin(t * 1.2) * 0.03 * s
      this.maskMat.emissiveIntensity = (0.3 + Math.sin(t * 3) * 0.06 + Math.sin(t * 7.3) * 0.03) * lit
    }
    if (!this.reduced) {
      for (let i = 0; i < EMBERS; i++) {
        this.emberPos[i * 3 + 1] += this.emberVel[i] * dt
        this.emberPos[i * 3] += Math.sin(t + i) * dt * 0.1
        if (this.emberPos[i * 3 + 1] > 2.4) this.resetEmber(i)
      }
      this.emberGeo.attributes.position.needsUpdate = true
    }
    this.flameMat.uniforms.t.value = t
    this.renderer.render(this.scene, this.camera)
  }
}
