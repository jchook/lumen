/**
 * Bloom as a post-process over the 2D canvas. The scene is downsampled to a quarter, the bright
 * parts are blurred twice (horizontal, vertical) in WebGL, and the result is layered over the game
 * with screen blending. The final pass splits red and green a little, growing toward the edges,
 * the way a worn tape or a cheap lens does. Everything stays drawn by the Canvas2D renderer.
 */
export interface Bloom {
  render(): void;
  resize(): void;
  ok: boolean;
}

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 o;
uniform sampler2D tex; uniform vec2 dir; uniform float threshold; uniform float gain; uniform float split;
const float w[5] = float[](0.227, 0.194, 0.121, 0.054, 0.016);
vec3 bright(vec2 q){ vec3 c = texture(tex, q).rgb; float l = dot(c, vec3(0.3, 0.59, 0.11)); return c * smoothstep(threshold, threshold + 0.25, l); }
vec3 blur(vec2 q){
  vec3 s = (threshold > 0.0 ? bright(q) : texture(tex, q).rgb) * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 d = dir * float(i);
    s += (threshold > 0.0 ? bright(q + d) : texture(tex, q + d).rgb) * w[i];
    s += (threshold > 0.0 ? bright(q - d) : texture(tex, q - d).rgb) * w[i];
  }
  return s;
}
void main(){
  if (split <= 0.0) { o = vec4(blur(uv) * gain, 1.0); return; }
  // Chromatic split: red pulled outward, green pulled inward, blue in place.
  vec2 off = (uv - 0.5) * split;
  float r = blur(uv + off).r;
  float g = blur(uv - off).g;
  float b = blur(uv).b;
  o = vec4(vec3(r, g, b) * gain, 1.0);
}`;

export function createBloom(source: HTMLCanvasElement, target: HTMLCanvasElement, scale = 0.25): Bloom {
  const gl = target.getContext("webgl2", { premultipliedAlpha: false, alpha: true });
  const dead: Bloom = { render() {}, resize() {}, ok: false };
  if (!gl) return dead;
  const small = document.createElement("canvas");
  const sctx = small.getContext("2d")!;
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
    return sh;
  };
  let prog: WebGLProgram;
  try {
    prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
  } catch {
    return dead;
  }
  gl.useProgram(prog);
  // Canvas rows run top-down, GL textures bottom-up; without this the whole glow layer renders
  // upside down and every bright body gets a blurry ghost at its mirrored height.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uDir = gl.getUniformLocation(prog, "dir");
  const uThr = gl.getUniformLocation(prog, "threshold");
  const uGain = gl.getUniformLocation(prog, "gain");
  const uSplit = gl.getUniformLocation(prog, "split");
  const makeTex = (): WebGLTexture => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const src = makeTex();
  const ping = makeTex();
  const fbo = gl.createFramebuffer();
  let w = 1;
  let h = 1;
  const resize = (): void => {
    w = Math.max(1, Math.floor(source.width * scale));
    h = Math.max(1, Math.floor(source.height * scale));
    small.width = w;
    small.height = h;
    target.width = w;
    target.height = h;
    gl.bindTexture(gl.TEXTURE_2D, ping);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  };
  resize();
  const render = (): void => {
    if (source.width * scale !== small.width || source.height * scale !== small.height) resize();
    sctx.drawImage(source, 0, 0, w, h);
    gl.viewport(0, 0, w, h);
    // Pass 1: bright-pass + horizontal blur, into ping.
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, small);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ping, 0);
    gl.uniform2f(uDir, 1.6 / w, 0);
    gl.uniform1f(uThr, 0.5);
    gl.uniform1f(uGain, 1.0);
    gl.uniform1f(uSplit, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Pass 2: vertical blur, to the screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, ping);
    gl.uniform2f(uDir, 0, 1.6 / h);
    gl.uniform1f(uThr, 0);
    gl.uniform1f(uGain, 1.15);
    gl.uniform1f(uSplit, 0.0035);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  return { render, resize, ok: true };
}
