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

const FLAME_FRAG = /* glsl */ `uniform float t; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a*n(p); p *= 2.03; a *= .5; } return v; }
void main(){
  vec2 uv = vUv; vec2 p = uv * vec2(3.2, 3.6); p.y -= t * 1.3;
  float q = fbm(p + fbm(p * 1.7 + t * .2));
  float body = 1. - length((uv - vec2(.5, .38)) * vec2(2.3, 1.25));
  float f = clamp(body * 1.5 + q * 1.1 - .75 - uv.y * .2, 0., 1.);
  vec3 c = mix(vec3(.28, .05, .5), vec3(1., .12, .05), smoothstep(.05, .5, f));
  c = mix(c, vec3(1., .62, .25), smoothstep(.65, 1., f));
  gl_FragColor = vec4(c * f * 1.4, f);
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
      uniforms: { t: { value: 0 } },
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
      const back = new Mesh(new PlaneGeometry(0.34, 0.2), new MeshBasicMaterial({ color: 0xfff1ee }))
      back.position.set(sx * 0.23, -0.03, -0.06)
      back.rotation.y = sx * 0.35
      this.mask.add(back)
      const halo = new Sprite(new SpriteMaterial({ map: eyeGlow, ...additive }))
      halo.position.set(sx * 0.3, -0.06, 0.25)
      halo.scale.set(0.9, 0.55, 1)
      this.mask.add(halo)
      const core = new Sprite(new SpriteMaterial({ map: white, ...additive, opacity: 0.8 }))
      core.position.set(sx * 0.3, -0.06, 0.26)
      core.scale.set(0.32, 0.16, 1)
      this.mask.add(core)
    }

    const flame = new Mesh(new PlaneGeometry(3.6, 4.4), this.flameMat)
    flame.position.set(0, 0.45, -0.6)
    this.mask.add(flame)

    for (let i = 0; i < EMBERS; i++) this.resetEmber(i, (Math.random() - 0.5) * 4)
    this.emberGeo.setAttribute('position', new BufferAttribute(this.emberPos, 3))
    this.mask.add(new Points(this.emberGeo, new PointsMaterial({ size: 0.05, map: glowTex('rgba(255,170,90,1)', 'rgba(255,40,0,0)'), ...additive })))

    const haze = new Sprite(new SpriteMaterial({ map: glowTex('rgba(64,95,250,.55)', 'rgba(53,54,156,0)'), ...additive }))
    haze.position.z = -1.4
    haze.scale.set(7, 7, 1)
    this.mask.add(haze)
    this.scene.add(this.mask)

    this.scene.add(new AmbientLight(0x3b3664, 1.2))
    const key = new PointLight(0xff3a2a, 30, 12)
    key.position.set(0, -1.2, 3)
    const rim = new DirectionalLight(0x405ffa, 4)
    rim.position.set(-3, 2, -3)
    const rim2 = new DirectionalLight(0x09bbc8, 1.5)
    rim2.position.set(3, 1, -2)
    const top = new DirectionalLight(0xffffff, 0.8)
    top.position.set(1, 3, 4)
    this.scene.add(key, rim, rim2, top)
  }

  private resetEmber(i: number, y?: number) {
    this.emberPos[i * 3] = (Math.random() - 0.5) * 3.2
    this.emberPos[i * 3 + 1] = y ?? -1.6 + Math.random() * 0.6
    this.emberPos[i * 3 + 2] = (Math.random() - 0.5) * 1.5
    this.emberVel[i] = 0.25 + Math.random() * 0.7
  }

  /** Put the mask over this element (null hides it). Jumps there without easing. */
  follow(el: HTMLElement | null) {
    this.slot = el
    this.mask.visible = !!el
    this.place()
    this.mask.position.copy(this.target.pos)
    this.mask.scale.setScalar(this.target.scale)
    if (this.reduced) this.frame(performance.now())
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
    this.target.scale = (r.height * worldPerPx) / 2
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
    const ease = this.reduced ? 1 : 0.12
    m.position.lerp(this.target.pos, ease)
    const s = MathUtils.lerp(m.scale.x, this.target.scale, ease)
    m.scale.setScalar(s)
    if (!this.reduced) {
      m.rotation.y = MathUtils.lerp(m.rotation.y, this.mouse.x * 0.7 + Math.sin(t * 0.5) * 0.08, 0.06)
      m.rotation.x = MathUtils.lerp(m.rotation.x, this.mouse.y * 0.4, 0.06)
      m.position.y += Math.sin(t * 1.2) * 0.03 * s
      this.maskMat.emissiveIntensity = 0.3 + Math.sin(t * 3) * 0.06 + Math.sin(t * 7.3) * 0.03
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
