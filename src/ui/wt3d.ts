// WebGL2 3D wavetable view: all frames drawn as receding line strips, with a
// bright interpolated line at the oscillator's current (modulated) morph
// position — the classic Vital/Serum table visual.

import { paramIndex } from '../shared/params'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'

const POINTS = 128

const VERT = `#version 300 es
precision highp float;
in vec3 aPos; // x: 0..1 along cycle, y: sample value, z: 0..1 frame position
uniform float uAspect;
uniform float uZ; // -1 = use aPos.z, otherwise override (morph line)
void main() {
  float z01 = uZ < 0.0 ? aPos.z : uZ;
  vec3 p = vec3(aPos.x * 1.7 - 0.85, aPos.y * 0.35, z01 * 1.5 - 0.75);
  // yaw
  float cy = cos(0.55), sy = sin(0.55);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  // pitch
  float cx = cos(0.42), sx = sin(0.42);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  float zc = p.z + 2.6;
  gl_Position = vec4(p.x * 2.0 / zc / uAspect, p.y * 2.0 / zc + 0.05, p.z * 0.1, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`

export class WavetableView {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null = null
  private prog: WebGLProgram | null = null
  private framesVbo: WebGLBuffer | null = null
  private morphVbo: WebGLBuffer | null = null
  private framesVao: WebGLVertexArrayObject | null = null
  private morphVao: WebGLVertexArrayObject | null = null
  private numFrames = 0
  private osc = 0
  private uColor: WebGLUniformLocation | null = null
  private uAspect: WebGLUniformLocation | null = null
  private uZ: WebGLUniformLocation | null = null
  private readonly morphScratch = new Float32Array(POINTS * 3)
  private readonly oscTabs: HTMLButtonElement[] = []

  constructor(private readonly engine: SynthEngine) {
    this.root = el('div', 'wt3d')
    const tabs = el('div', 'wt3d-tabs')
    for (let o = 0; o < 3; o++) {
      const b = el('button', o === 0 ? 'scope-tab on' : 'scope-tab', `OSC ${o + 1}`) as HTMLButtonElement
      b.addEventListener('click', () => {
        this.osc = o
        this.oscTabs.forEach((t, i) => t.classList.toggle('on', i === o))
        this.rebuild()
      })
      this.oscTabs.push(b)
      tabs.appendChild(b)
    }
    this.canvas = el('canvas')
    this.root.append(tabs, this.canvas)

    new ResizeObserver(() => this.resize()).observe(this.root)
    engine.onTableChange(osc => {
      if (osc === this.osc) this.rebuild()
    })
    this.initGl()
    this.rebuild()
  }

  private initGl(): void {
    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: true })
    if (!gl) return // WebGL2 unavailable: the panel simply stays blank
    this.gl = gl
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(String(gl.getShaderInfoLog(sh)))
      }
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(String(gl.getProgramInfoLog(prog)))
    }
    this.prog = prog
    this.uColor = gl.getUniformLocation(prog, 'uColor')
    this.uAspect = gl.getUniformLocation(prog, 'uAspect')
    this.uZ = gl.getUniformLocation(prog, 'uZ')

    this.framesVbo = gl.createBuffer()
    this.morphVbo = gl.createBuffer()
    this.framesVao = gl.createVertexArray()
    this.morphVao = gl.createVertexArray()
    for (const [vao, vbo] of [[this.framesVao, this.framesVbo], [this.morphVao, this.morphVbo]] as const) {
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
    }
    gl.bindVertexArray(null)
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = this.root.clientWidth
    const h = this.root.clientHeight - 22
    this.canvas.width = Math.max(w, 1) * dpr
    this.canvas.height = Math.max(h, 1) * dpr
    this.canvas.style.width = `${Math.max(w, 1)}px`
    this.canvas.style.height = `${Math.max(h, 1)}px`
  }

  /** Rebuild the static frame geometry from the current table. */
  private rebuild(): void {
    const gl = this.gl
    const table = this.engine.currentTables[this.osc]
    if (!gl || !table) {
      this.numFrames = 0
      return
    }
    const { frameSize, numFrames, data } = table
    const verts = new Float32Array(numFrames * POINTS * 3)
    let vi = 0
    for (let f = 0; f < numFrames; f++) {
      const z = numFrames > 1 ? f / (numFrames - 1) : 0
      for (let i = 0; i < POINTS; i++) {
        const si = Math.floor((i / (POINTS - 1)) * (frameSize - 1))
        verts[vi++] = i / (POINTS - 1)
        verts[vi++] = data[f * frameSize + si]
        verts[vi++] = z
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.framesVbo)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW)
    this.numFrames = numFrames
  }

  /** called from the app's requestAnimationFrame loop */
  draw(): void {
    const gl = this.gl
    if (!gl || !this.prog) return
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0.055, 0.06, 0.08, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (this.numFrames === 0) return

    gl.useProgram(this.prog)
    gl.uniform1f(this.uAspect, this.canvas.width / Math.max(this.canvas.height, 1))
    gl.lineWidth(1)

    // current morph value including live modulation
    const morphIdx = paramIndex(`osc${this.osc + 1}.morph`)
    let morph = this.engine.getParam(morphIdx)
    for (const { state } of this.engine.routesForDest(morphIdx)) {
      if (state.enabled) morph += state.depth * (this.engine.sourceValues[state.source] ?? 0)
    }
    morph = Math.max(0, Math.min(1, morph))

    // frame strips
    gl.bindVertexArray(this.framesVao)
    gl.uniform1f(this.uZ, -1)
    const highlight = Math.round(morph * (this.numFrames - 1))
    for (let f = 0; f < this.numFrames; f++) {
      const d = Math.abs(f - highlight) / Math.max(this.numFrames - 1, 1)
      if (f === highlight) gl.uniform4f(this.uColor, 0.55, 0.83, 1.0, 0.9)
      else gl.uniform4f(this.uColor, 0.25, 0.42, 0.65, 0.75 - d * 0.45)
      gl.drawArrays(gl.LINE_STRIP, f * POINTS, POINTS)
    }

    // interpolated morph line
    const table = this.engine.currentTables[this.osc]
    if (table && this.numFrames > 1) {
      const { frameSize, numFrames, data } = table
      const fpos = morph * (numFrames - 1)
      const f0 = Math.min(Math.floor(fpos), numFrames - 2)
      const t = fpos - f0
      let vi = 0
      for (let i = 0; i < POINTS; i++) {
        const si = Math.floor((i / (POINTS - 1)) * (frameSize - 1))
        const a = data[f0 * frameSize + si]
        const b = data[(f0 + 1) * frameSize + si]
        this.morphScratch[vi++] = i / (POINTS - 1)
        this.morphScratch[vi++] = a + (b - a) * t
        this.morphScratch[vi++] = morph
      }
      gl.bindVertexArray(this.morphVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.morphVbo)
      gl.bufferData(gl.ARRAY_BUFFER, this.morphScratch, gl.DYNAMIC_DRAW)
      gl.uniform1f(this.uZ, morph)
      gl.uniform4f(this.uColor, 1.0, 0.72, 0.3, 1.0)
      gl.drawArrays(gl.LINE_STRIP, 0, POINTS)
    }
    gl.bindVertexArray(null)
  }
}
