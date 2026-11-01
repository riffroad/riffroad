import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { firstAtOrAfter, lastAtOrBefore, type Chart, type Techniques } from '../chart';
import { missText, type GameView, type ViewItem } from '../game/view';
import {
  Arrivals,
  FRETS,
  LANE,
  TOP_Y,
  anchorZone,
  approach,
  focusZone,
  framing,
  laneCenter,
  placeNote,
  stringY,
  timeZ,
  zoneLeft,
  zoneRight,
  type Zone,
} from '../layout';
import { bendGlyph, glyph, LabelPool, type TextStyle } from './labels';
import { BOARD_PATTERNS, floorMaterial, glowMaterial, Layer, sharedUniforms, woodMaterial } from './materials';
import { Particles } from './particles';
import { phraseLabels } from '../sections';
import { Scenery, type SceneryId } from './scenery';
import { Stage, type Mood } from './stage';
import { GUITARS, type Guitar, type InlayShape } from '../guitars';
import type { Band } from '../band';

/** String colours, low E first (same as engine-rt/dsp/src/fretboard.rs). */
export const STRING_HEX = ['#e82a2e', '#f4d02c', '#258cef', '#f58b1f', '#35c74b', '#a44ee8'];
const STRING_COLORS = STRING_HEX.map((h) => new THREE.Color(h));

export interface HighwaySettings {
  invertStrings: boolean;
  /** World units per second: how fast notes come. */
  speed: number;
  /** Seconds of music shown ahead of the strike line. */
  lookahead: number;
}

export const DEFAULT_HIGHWAY: HighwaySettings = { invertStrings: false, speed: 12, lookahead: 3 };

/** Luminance of a string's colour at rest, under the bloom's threshold (0.62): a string glows
 * only when it plays or is about to. The yellow A string, the brightest colour, would otherwise
 * glow all the time. */
const REST_LUMA = 0.5;
export const restOf = (c: { r: number; g: number; b: number }): number => Math.min(1, REST_LUMA / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));

/** The input's own noise (dBFS), followed under the guitar: down at once to a quieter frame, up
 * at most `NOISE_RISE` dB a second (a note held does not become the floor). */
const NOISE_RISE = 3;
export const followNoise = (floorDb: number, db: number, dt: number): number => (db < floorDb ? db : floorDb + Math.min(db - floorDb, NOISE_RISE * dt));

/** How much the strings ring (0..1) for a frame at `db` over the input's noise at `floorDb`: from
 * 10 dB above it, fully 30 dB higher. A hiss or a hum never shakes a string. */
export const ringOver = (db: number, floorDb: number): number => Math.min(1, Math.max(0, (db - floorDb - 10) / 30));

/** Camera for a five-fret zone (zoom 1), relative to the strike line under the zone centre: low
 * behind the neck, the highway running toward the horizon. */
const CAMERA = { fov: 48, height: 4.6, distance: 7.5, lookY: -0.6, lookZ: -14 };
/** The view rolls a little as the hand goes up the neck (radians per fret past the 5th). */
const ROLL = 0.0022;
/** Seconds ahead the neck shows where the fingers go. */
const GUIDE = 1.8;
/** Brightness of the notes to come by rank (0: the next one), on the highway and on the neck. */
const RANK_GLOW = [1, 0.78, 0.6];
const GUIDE_GLOW = [1.6, 0.55, 0.28];
/** The venue behind the highway while a song plays, against the menus. */
const PLAYING_DIM = 0.5;
/** Seconds a note keeps moving past the strike line before it vanishes. */
const PAST = 0.4;
/** Master mode: notes start fading this long before the strike line (s)… */
const MASTER_FADE = 1.5;
/** …and are gone this long before it. */
const MASTER_GONE = 0.3;
const GEM = { w: 0.84, h: 0.19, d: 0.34 };
const RADII = [0.034, 0.03, 0.026, 0.022, 0.019, 0.016];
const WHITE = new THREE.Color(1, 1, 1);
const GREY = new THREE.Color(0.11, 0.12, 0.15);
const RED = new THREE.Color(0.9, 0.04, 0.04);
const FRAME = new THREE.Color(0.55, 0.75, 1.0);
const ZONE = new THREE.Color(0.025, 0.06, 0.13);
const ZONE_EDGE = new THREE.Color(0.2, 0.45, 0.95);
const BEAT = new THREE.Color(0.3, 0.34, 0.45);
const PHRASE_LINE = new THREE.Color(0.45, 0.6, 1.0);
const SHAPE = new THREE.Color(0.22, 0.28, 0.5);
const ZONE_NUMBER = new THREE.Color('#ffb547');
/** Fret numbers at the foot of the stems, in their string's colour made lighter. */
const LABEL_COLORS = STRING_COLORS.map((c) => c.clone().lerp(WHITE, 0.3));

const FRET_NUMBER: TextStyle = { size: 80, color: '#ffffff', stroke: 'rgba(0,0,0,0.9)' };
const GEM_FRET: TextStyle = { size: 72, color: '#ffffff', stroke: 'rgba(0,0,0,0.9)' };
const LANE_FRET: TextStyle = { size: 80, weight: 800, color: '#ffffff', stroke: 'rgba(0,0,0,0.9)' };
const LANE_NUMBER: TextStyle = { size: 96, weight: 700, color: '#ffffff', stroke: 'rgba(0,0,0,0.7)' };
const FINGER: TextStyle = { size: 72, weight: 800, color: '#0b1020', badge: 'rgba(255,255,255,0.95)' };
/** Frets with a pearl dot on the fingerboard (two at 12 and 24). */
const INLAYS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
const CHORD_NAME: TextStyle = { size: 80, color: '#ffffff', stroke: 'rgba(4,8,24,0.95)' };
const TECHNIQUE: TextStyle = { size: 64, color: '#ffe7a0', stroke: 'rgba(0,0,0,0.9)' };
const PHRASE_NAME: TextStyle = { size: 64, weight: 600, color: '#a9c1ff', stroke: 'rgba(0,0,0,0.85)' };
/** Why a note was missed, by kind: timing in amber, pitch in blue, a wrong chord in red. */
const MISS_TIMING: TextStyle = { size: 72, weight: 800, color: '#ffd166', stroke: 'rgba(0,0,0,0.9)' };
const MISS_PITCH: TextStyle = { size: 72, weight: 800, color: '#8fd3ff', stroke: 'rgba(0,0,0,0.9)' };
const MISS_CHORD: TextStyle = { size: 72, weight: 800, color: '#ff8a8a', stroke: 'rgba(0,0,0,0.9)' };
/** How long a miss's reason stays above the strings, seconds. */
const CALLOUT_LIFE = 1.1;

interface AnchorSpan {
  start: number;
  end: number;
  zone: Zone;
}

interface StringLine {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  base: THREE.Color;
  pulse: number;
  miss: number;
  held: number;
  /** The next note is on this string: it lights up as the note comes (smoothed). */
  light: number;
  /** Out of a song: how much this string was the last one heard (it rings with the guitar). */
  ring: number;
  /** Its brightness at rest: its colour held under the bloom's threshold (see `restOf`). */
  rest: number;
}

interface Point {
  x: number;
  y: number;
  string: number;
}

/** Why a note was missed, floating up above where it met the strings. */
interface Callout {
  text: string;
  style: TextStyle;
  x: number;
  born: number;
}

type Layers = Record<'zones' | 'shapes' | 'beats' | 'edges' | 'marks' | 'tails' | 'stems' | 'frames' | 'gems' | 'bars' | 'guides', Layer>;

const DEFAULT_SPAN: AnchorSpan = { start: -Infinity, end: Infinity, zone: { lo: 1, hi: 5 } };
/** Streaks that light up the venue. */
const MILESTONES = [10, 25, 50, 75, 100, 150, 200, 300];

function techniqueText(t: Techniques | undefined, fret: number): string | null {
  if (!t) return null;
  const parts: string[] = [];
  if (t.hammerOn) parts.push('H');
  if (t.pullOff) parts.push('P');
  if (t.tap) parts.push('T');
  if (t.slideTo !== undefined && t.slideTo !== fret) parts.push(t.slideTo > fret ? '/' : '\\');
  if (t.vibrato) parts.push('~');
  if (t.palmMute) parts.push('PM');
  if (t.mute) parts.push('✕');
  if (t.harmonic) parts.push('◇');
  if (t.pinchHarmonic) parts.push('PH');
  if (t.tremolo) parts.push('≈');
  if (t.accent) parts.push('>');
  return parts.length ? parts.join(' ') : null;
}

function backdrop(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 512;
  const g = canvas.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#020309');
  grad.addColorStop(0.42, '#0a1230');
  grad.addColorStop(0.6, '#0e1a3e');
  grad.addColorStop(1, '#03050b');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The note highway: the neck seen from the front with its six coloured
 * strings at the bottom of the screen, notes coming from the distance at their string's height
 * with a stem down to their fret lane, chords in frames with their name, glowing sustains, and a
 * camera that follows the fretting hand.
 */
export class Highway {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 400);
  private readonly composer: EffectComposer;
  private readonly shared = sharedUniforms();
  private readonly layers: Layers;
  private readonly labels: LabelPool;
  private readonly particles = new Particles(5000);
  private readonly strings: StringLine[] = [];
  private readonly fretNumbers: THREE.Sprite[] = [];
  private readonly upcoming: number[] = [];
  private callouts: Callout[] = [];
  private readonly nextFret = new Map<number, { string: number; ahead: number }>();
  private readonly cam = { x: 2.5, scale: 1 };
  /** Strings of the next note, 0..1 this frame (see `guide`). */
  private readonly lit = [0, 0, 0, 0, 0, 0];
  private readonly arrivals = new Arrivals();
  /** Rank of the item being drawn among the notes to come (0: the next one), null once played. */
  private rank: number | null = null;
  private dim = 1;
  /** How much the camera breathes: 1 in the menus, 0 during a song. */
  private breath = 1;
  /** A career gig's crowd (0..1), which then drives the venue instead of the streak. */
  private crowd: number | null = null;
  private readonly size = new THREE.Vector2();
  private settings: HighwaySettings;
  /** Master mode: phrase iterations whose notes fade out before the strike line. */
  private master: ReadonlySet<number> | null = null;
  /** Visibility of the item being drawn (master mode), 0..1. */
  private vis = 1;
  private chart: Chart | null = null;
  private phraseText: string[] = [];
  private spans: AnchorSpan[] = [DEFAULT_SPAN];
  private zoneNow: Zone = DEFAULT_SPAN.zone;
  private wall = 0;
  /** Out of a song: the guitar's level, the strings last heard ringing with it. */
  private ringLevel = 0;
  /** The input's noise under the guitar (dBFS), see `followNoise`. */
  private noiseDb = -54;
  private readonly stage: Stage;
  private readonly scenery: Scenery;
  private readonly mood: Mood = { pulse: 0, energy: 0.25, danger: 0, flash: 0 };
  /** The guitar's parts, repainted by `setGuitar`. */
  private readonly neck = {
    wood: woodMaterial(),
    frets: new THREE.MeshBasicMaterial(),
    nut: new THREE.MeshBasicMaterial(),
    inlay: new THREE.MeshBasicMaterial(),
    inlays: new THREE.Group(),
    posts: null as THREE.ShaderMaterial | null,
    shape: null as InlayShape | null,
  };
  private lastStreak = 0;
  private fireworks = { until: 0, next: 0, intensity: 0 };

  constructor(
    private readonly container: HTMLElement,
    settings: HighwaySettings = DEFAULT_HIGHWAY,
  ) {
    this.settings = { ...settings };
    this.renderer = new THREE.WebGLRenderer({ powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    container.appendChild(this.renderer.domElement);
    this.scene.background = backdrop();
    this.scene.add(this.camera);
    this.stage = new Stage(this.camera);
    this.scenery = new Scenery(this.scene, (x, y, z, color, big) => {
      this.particles.burst(x, y, z, color, big ? 70 : 45, big ? 10 : 7, big ? 0.18 : 0.14, big ? 1.4 : 1.2);
      this.particles.flash(x, y, z, color, big ? 3.5 : 2.4, 0.3);
    });

    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.65, 0.45, 0.62));
    this.composer.addPass(new OutputPass());

    const box = new THREE.BoxGeometry(1, 1, 1);
    const flat = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const s = this.shared;
    this.layers = {
      zones: new Layer(flat, glowMaterial(s, { additive: true }), 64, 1),
      shapes: new Layer(flat, glowMaterial(s, { additive: true, soft: 0.5 }), 128, 1),
      beats: new Layer(flat, glowMaterial(s, { additive: true }), 256, 2),
      edges: new Layer(flat, glowMaterial(s, { additive: true }), 256, 2),
      marks: new Layer(flat, glowMaterial(s, { additive: true, soft: 1 }), 1024, 2),
      tails: new Layer(box, glowMaterial(s, { additive: true, edge: 0.5 }), 1024, 3),
      stems: new Layer(box, glowMaterial(s, { additive: true }), 1024, 3),
      frames: new Layer(box, glowMaterial(s, { additive: true, edge: 0.3 }), 1024, 4),
      gems: new Layer(new RoundedBoxGeometry(GEM.w, GEM.h, GEM.d, 4, 0.07), glowMaterial(s, { shade: 1, edge: 0.15, gloss: 1 }), 1024, 5),
      bars: new Layer(box, glowMaterial(s, { shade: 1, edge: 0.5 }), 256, 5),
      guides: new Layer(new RoundedBoxGeometry(0.72, 0.13, 0.2, 3, 0.05), glowMaterial(s, { additive: true, edge: 0.6 }), 64, 6),
    };
    for (const layer of Object.values(this.layers)) this.scene.add(layer.mesh);
    this.labels = new LabelPool(this.scene, 240);
    this.scene.add(this.particles.points);
    this.buildNeck(box);
    this.setGuitar(GUITARS[0]);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** Out of a song (menus, free play): the note the guitar just played rings on the string it
   * was most likely played on, in `tuning`, with a spark at its fret. */
  heard(midi: number, tuning: readonly number[]): void {
    const { string, fret } = placeNote(midi, tuning);
    this.strings.forEach((line, s) => (line.ring = s === string ? 1 : 0.15 * line.ring));
    const line = this.strings[string];
    if (!line) return;
    line.pulse = 1;
    const x = fret === 0 ? 0.25 : laneCenter(fret);
    const y = stringY(string, this.settings.invertStrings);
    this.particles.burst(x, y, 0.1, line.base, 14, 4.5, 0.08, 0.5);
    this.particles.flash(x, y, 0.15, line.base, 0.7, 0.2);
  }

  /** Out of a song: a strum without one pitch (a chord) shakes every string. */
  strummed(): void {
    for (const line of this.strings) {
      line.ring = 0.6;
      line.pulse = Math.max(line.pulse, 0.55);
    }
  }

  /** Out of a song: the guitar's level this frame (its loudest sample), the strings last heard
   * vibrating with it as long as they ring. */
  listen(peak: number, dt: number): void {
    const db = 20 * Math.log10(Math.max(peak, 1e-6));
    this.noiseDb = followNoise(this.noiseDb, db, dt);
    this.ringLevel = Math.max(ringOver(db, this.noiseDb), this.ringLevel * Math.exp(-dt / 0.12));
  }

  /** Fireworks over the neck and a burst of light: the end of a great song. */
  celebrate(intensity: number): void {
    this.fireworks = { until: this.wall + 2 + intensity, next: this.wall, intensity };
    this.mood.flash = 1;
  }

  /**
   * The place behind the highway: a set (its crowd `fill`ed from 0 to more than full, its sign
   * reading `sign`), or 'concert', the abstract stage of the backdrop alone.
   */
  setScenery(id: SceneryId, fill = 1, sign?: string): void {
    const sky = this.scenery.set(id, fill, sign);
    this.stage.setLook(sky?.crowd ?? 1, sky?.lights ?? 8);
  }

  /** The guitar played: its fingerboard, frets, inlays and nut (the strings keep their colours). */
  setGuitar(g: Guitar): void {
    const n = this.neck;
    const u = n.wood.uniforms;
    u.uA.value.set(g.board[0]);
    u.uB.value.set(g.board[1]);
    u.uPaint.value.set(g.paint ?? g.board[1]);
    u.uPattern.value = BOARD_PATTERNS.indexOf(g.pattern);
    n.frets.color.set(g.frets);
    n.nut.color.set(g.nut);
    n.inlay.color.set(g.inlay).multiplyScalar(g.glow ? 2.2 : 1);
    n.posts?.uniforms.uTint.value.set(g.posts);
    if (n.shape !== g.inlays) {
      n.shape = g.inlays;
      for (const child of n.inlays.children) (child as THREE.Mesh).geometry.dispose();
      n.inlays.clear();
      const geometry = inlayGeometry(g.inlays);
      if (geometry) {
        for (const f of INLAYS) {
          // The octaves: two dots, or one larger inlay.
          const double = f % 12 === 0 && g.inlays === 'dots';
          for (const z of double ? [-0.2, 0.3] : [0.05]) {
            const inlay = new THREE.Mesh(f % 12 === 0 && !double ? geometry.clone().scale(1.2, 1, 1.2) : geometry, n.inlay);
            inlay.position.set(laneCenter(f), 0.0055, z);
            n.inlays.add(inlay);
          }
        }
      }
    }
  }

  /** The band whose banner hangs in the sets, null for none. */
  setBand(band: Band | null): void {
    this.scenery.setBand(band);
  }

  setCrowd(value: number | null): void {
    this.crowd = value;
  }

  configure(settings: Partial<HighwaySettings>): void {
    Object.assign(this.settings, settings);
  }

  /**
   * Master mode: notes of these phrase iterations, played at the top level, show up
   * as usual far away then fade out on their way to the strike line; null: every note stays.
   */
  setMaster(iterations: ReadonlySet<number> | null): void {
    this.master = iterations;
  }

  setChart(chart: Chart | null): void {
    this.chart = chart;
    this.phraseText = chart ? phraseLabels(chart) : [];
    this.spans =
      chart && chart.anchors.length
        ? chart.anchors.map((a, i) => ({
            start: i === 0 ? -Infinity : a.time,
            end: chart.anchors[i + 1]?.time ?? Infinity,
            zone: anchorZone(a),
          }))
        : [DEFAULT_SPAN];
    const target = framing(this.spans[0].zone, this.camera.aspect);
    this.cam.x = target.x;
    this.cam.scale = target.scale;
  }

  /** Draws the highway at song time `now`; `dt` is the wall-clock time since the last frame. */
  render(now: number, view: GameView | null, dt: number): void {
    this.wall += dt;
    const far = this.settings.speed * this.settings.lookahead;
    this.shared.uFadeNear.value = far * 0.7;
    this.shared.uFadeFar.value = far * 1.02;
    const layers = Object.values(this.layers);
    for (const layer of layers) layer.begin();
    this.labels.begin();
    this.upcoming.length = 0;
    this.nextFret.clear();
    this.lit.fill(0);
    this.arrivals.reset();
    if (this.chart) {
      this.drawZones(now);
      this.drawShapes(now);
      this.drawBeats(now);
      this.drawLaneNumbers(now);
      this.drawPhrases(now);
      if (view) {
        this.drawItems(now, view);
        this.applyEffects(view);
      }
      this.drawCallouts();
    }
    for (const layer of layers) layer.end();
    this.labels.end();
    this.updateCamera(now, dt);
    this.updateMood(now, view, dt);
    this.launchFireworks();
    this.updateStrings(dt);
    this.updateFretNumbers();
    this.particles.update(dt, this.renderer.getDrawingBufferSize(this.size).y / (2 * Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2))));
    this.composer.render(dt);
  }

  private buildNeck(box: THREE.BoxGeometry): void {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FRETS, 220).rotateX(-Math.PI / 2), floorMaterial(this.shared));
    floor.position.set(FRETS / 2, -0.01, -106);
    floor.renderOrder = -1;
    this.scene.add(floor);

    const height = TOP_Y + 0.22;
    this.neck.posts = glowMaterial(this.shared, { additive: true });
    const wires = new Layer(box, this.neck.posts, 32, 2);
    wires.begin();
    for (let f = 0; f <= FRETS; f++) {
      wires.add(f * LANE, height / 2, -0.03, f === 0 ? 0.09 : 0.03, height, 0.03, WHITE, f === 0 ? 0.8 : 0.3);
    }
    wires.end();
    this.scene.add(wires.mesh);

    // The fingerboard under the strings, frets, the nut, inlays: painted by the guitar played.
    const board = new THREE.Mesh(new THREE.BoxGeometry(FRETS + 0.25, 0.04, 1.0), this.neck.wood);
    board.position.set(FRETS / 2 - 0.125, -0.016, 0.05);
    this.scene.add(board);
    for (let f = 1; f <= FRETS; f++) {
      const fret = new THREE.Mesh(box, this.neck.frets);
      fret.scale.set(0.045, 0.016, 1.0);
      fret.position.set(f * LANE, 0.012, 0.05);
      this.scene.add(fret);
    }
    // The headstock past the nut, seen when the hand plays low on the neck.
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.25), this.neck.wood);
    head.position.set(-0.86, -0.03, 0.05);
    this.scene.add(head);
    const nut = new THREE.Mesh(box, this.neck.nut);
    nut.scale.set(0.11, 0.035, 1.0);
    nut.position.set(0, 0.018, 0.05);
    this.scene.add(nut);
    this.scene.add(this.neck.inlays);

    const strike = new THREE.Mesh(box, glowMaterial(this.shared, { additive: true, tint: [0.3, 0.38, 0.55] }));
    strike.scale.set(FRETS, 0.01, 0.06);
    strike.position.set(FRETS / 2, 0.006, 0);
    this.scene.add(strike);

    STRING_COLORS.forEach((base, s) => {
      const geometry = new THREE.CylinderGeometry(RADII[s], RADII[s], FRETS, 10, 1, true).rotateZ(Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({ color: base.clone() });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(FRETS / 2, stringY(s, this.settings.invertStrings), 0);
      this.scene.add(mesh);
      material.color.multiplyScalar(restOf(base));
      this.strings.push({ mesh, material, base, pulse: 0, miss: 0, held: 0, light: 0, ring: 0, rest: restOf(base) });
    });

    for (let f = 1; f <= FRETS; f++) {
      const g = glyph(String(f), FRET_NUMBER);
      const material = new THREE.SpriteMaterial({ map: g.texture, transparent: true, depthTest: false, depthWrite: false });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(laneCenter(f), -0.1, 0.8);
      sprite.renderOrder = 30;
      sprite.userData.aspect = g.aspect;
      this.scene.add(sprite);
      this.fretNumbers.push(sprite);
    }
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.stage.resize(this.camera);
  }

  private zoneAt(t: number): Zone {
    return this.spans[Math.max(0, lastAtOrBefore(this.spans, t, (s) => s.start))].zone;
  }

  private labelFade(z: number): number {
    const far = this.settings.speed * this.settings.lookahead;
    const d = -z;
    return (1 - THREE.MathUtils.smoothstep(d, far * 0.55, far * 0.9)) * this.vis;
  }

  private drawZones(now: number): void {
    const { speed, lookahead } = this.settings;
    const t1 = now + lookahead + 0.2;
    for (let i = Math.max(0, lastAtOrBefore(this.spans, now - 0.5, (s) => s.start)); i < this.spans.length; i++) {
      const span = this.spans[i];
      if (span.start > t1) break;
      const a = Math.max(span.start, now - 0.5);
      const b = Math.min(span.end, t1);
      if (b <= a) continue;
      const za = timeZ(a, now, speed);
      const zb = timeZ(b, now, speed);
      const x0 = zoneLeft(span.zone);
      const x1 = zoneRight(span.zone);
      const zc = (za + zb) / 2;
      // The hand's frets: dark tiles ruled by their fret wires; the rest of the floor stays dim.
      this.layers.zones.add((x0 + x1) / 2, 0.002, zc, x1 - x0, 1, za - zb, ZONE, 1.6);
      this.layers.edges.add(x0, 0.004, zc, 0.05, 1, za - zb, ZONE_EDGE, 0.6);
      this.layers.edges.add(x1, 0.004, zc, 0.05, 1, za - zb, ZONE_EDGE, 0.6);
      for (let f = span.zone.lo; f < span.zone.hi; f++) this.layers.edges.add(f * LANE, 0.004, zc, 0.025, 1, za - zb, ZONE_EDGE, 0.3);
    }
  }

  /** Long hand shapes (held chords, arpeggios) as a faint band over the frets they hold. */
  private drawShapes(now: number): void {
    const chart = this.chart!;
    const { speed, lookahead } = this.settings;
    const t1 = now + lookahead;
    for (const hs of chart.handShapes) {
      if (hs.end < now || hs.start > t1 || hs.end - hs.start < 0.6) continue;
      const frets = chart.chordTemplates[hs.template]?.frets.filter((f) => f > 0) ?? [];
      if (!frets.length) continue;
      const x0 = (Math.min(...frets) - 1) * LANE;
      const x1 = Math.max(...frets) * LANE;
      const za = timeZ(Math.max(hs.start, now), now, speed);
      const zb = timeZ(Math.min(hs.end, t1), now, speed);
      this.layers.shapes.add((x0 + x1) / 2, 0.006, (za + zb) / 2, x1 - x0, 1, za - zb, SHAPE, 0.45);
    }
  }

  private drawBeats(now: number): void {
    const beats = this.chart!.beats;
    const { speed, lookahead } = this.settings;
    for (let i = firstAtOrAfter(beats, now - 0.3, (b) => b.time); i < beats.length && beats[i].time <= now + lookahead; i++) {
      const bar = beats[i].bar !== undefined;
      const z = timeZ(beats[i].time, now, speed);
      const zone = this.zoneAt(beats[i].time);
      this.layers.beats.add(FRETS / 2, 0.003, z, FRETS, 1, bar ? 0.06 : 0.03, BEAT, bar ? 0.45 : 0.18);
      this.layers.beats.add((zoneLeft(zone) + zoneRight(zone)) / 2, 0.004, z, zoneRight(zone) - zoneLeft(zone), 1, bar ? 0.07 : 0.035, BEAT, bar ? 1.4 : 0.7);
    }
  }

  /** Fret numbers on the highway, halfway out: the hand's frets in orange, the inlay ones dim. */
  private drawLaneNumbers(now: number): void {
    const t = now + this.settings.lookahead * 0.42;
    const zone = this.zoneAt(t);
    const z = timeZ(t, now, this.settings.speed);
    for (let f = 1; f <= FRETS; f++) {
      const inZone = f >= zone.lo && f <= zone.hi;
      if (!inZone && !INLAYS.includes(f)) continue;
      const h = inZone ? 0.62 : 0.48;
      this.labels.add(glyph(String(f), LANE_NUMBER), laneCenter(f), h / 2, z, h, inZone ? 0.9 : 0.28, inZone ? ZONE_NUMBER : WHITE);
    }
  }

  private drawPhrases(now: number): void {
    const { speed, lookahead } = this.settings;
    for (const [i, p] of this.chart!.phrases.entries()) {
      if (p.start < now - 0.3 || p.start > now + lookahead || p.name.startsWith('rest')) continue;
      const z = timeZ(p.start, now, speed);
      this.layers.beats.add(FRETS / 2, 0.004, z, FRETS, 1, 0.12, PHRASE_LINE, 0.9);
      this.labels.add(glyph(this.phraseText[i], PHRASE_NAME), zoneLeft(this.zoneAt(p.start)) - 0.8, 0.3, z, 0.34, this.labelFade(z));
    }
  }

  private drawItems(now: number, view: GameView): void {
    const { speed, lookahead } = this.settings;
    const items = view.items;
    const first = view.firstVisible(now - PAST);
    let prev: ViewItem | undefined = items[first - 1];
    for (let i = first; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      if (it.time > now + lookahead) break;
      const target = it.target;
      const repeat =
        target.kind === 'chord' &&
        prev?.target.kind === 'chord' &&
        prev.target.template === target.template &&
        it.time - prev.time < 2;
      prev = it;
      this.rank = this.arrivals.next(it.time, it.status === 'pending', it.time - now);
      if (it.time + it.sustain < now - PAST) continue;
      const z = timeZ(it.time, now, speed);
      this.vis = this.masterFade(it, it.time - now);
      if (target.kind === 'note') this.drawNote(it, target.string, target.fret, z, it.time - now, now);
      else this.drawChord(it, target.template, z, it.time - now, now, repeat);
    }
    this.vis = 1;
    this.rank = null;
  }

  /** Master mode: 1 far away, fading from 1.5 s before the strike line, gone 0.3 s before it. */
  private masterFade(it: ViewItem, ahead: number): number {
    if (!this.master?.has(it.iteration) || it.level < this.chart!.arrangement.maxDifficulty) return 1;
    return THREE.MathUtils.smoothstep(ahead, MASTER_GONE, MASTER_FADE);
  }

  /** Brightness of a note: flares as it reaches the strike line, fades once past it. */
  private glow(it: ViewItem, ahead: number): number {
    const fade = (ahead < 0 ? Math.max(0, 1 + ahead / PAST) : 1) * this.vis;
    // The next note brightest, the ones after it dimmer.
    const rank = RANK_GLOW[Math.min(this.rank ?? 0, RANK_GLOW.length - 1)];
    return it.status === 'pending' ? fade * rank * (1 + 0.8 * Math.exp(-Math.abs(ahead) / 0.1)) : fade * 0.8;
  }

  /**
   * Where the fingers go, on the neck: a light on the string at the fret of the next notes,
   * bright for the next one and dimmer for the two after, each growing as it comes; the string
   * of the next note lights up (an open string only lights up). `finger`: shown on the next chord.
   */
  private guide(string: number, fret: number, ahead: number, finger = -1): void {
    const rank = this.rank;
    if (rank === null || rank >= GUIDE_GLOW.length || ahead > GUIDE) return;
    const come = 1 - THREE.MathUtils.smoothstep(ahead, 0, GUIDE);
    if (rank === 0) this.lit[string] = Math.max(this.lit[string], 0.35 + 0.65 * come);
    if (fret <= 0) return;
    const x = laneCenter(fret);
    const y = stringY(string, this.settings.invertStrings);
    this.layers.guides.add(x, y, 0.02, 1, 1, 1, STRING_COLORS[string], GUIDE_GLOW[rank] * (0.35 + 0.65 * come) * this.vis);
    if (rank === 0 && finger > 0) this.labels.add(glyph(String(finger), FINGER), x, y + 0.16, 0.06, 0.16, (0.4 + 0.6 * come) * this.vis);
  }

  /** Remembers frets coming soon: the camera keeps them in view, the fret numbers light up. */
  private track(fret: number, string: number, ahead: number): void {
    if (ahead < 0 || fret <= 0) return;
    if (ahead < 1.6) this.upcoming.push(fret);
    const current = this.nextFret.get(fret);
    if (ahead < 0.7 && (!current || ahead < current.ahead)) this.nextFret.set(fret, { string, ahead });
  }

  private drawNote(it: ViewItem, string: number, fret: number, z: number, ahead: number, now: number): void {
    const L = this.layers;
    const y = stringY(string, this.settings.invertStrings);
    const techniques = this.chart!.notes[it.event]?.techniques;
    const missed = it.status === 'missed';
    const color = missed ? GREY : STRING_COLORS[string];
    const zone = this.zoneAt(it.time);
    const x = fret > 0 ? laneCenter(fret) : (zoneLeft(zone) + zoneRight(zone)) / 2;
    const open = zoneRight(zone) - zoneLeft(zone) - 0.1;
    this.track(fret, string, ahead);
    this.guide(string, fret, ahead);
    if (it.status !== 'hit' && ahead > -PAST) {
      const k = this.glow(it, ahead);
      if (fret > 0) {
        L.gems.add(x, y, z, 1, 1, 1, color, 1.3 * k);
        L.stems.add(x, y / 2, z, 0.045, y, 0.045, color, 0.6 * k);
        L.marks.add(x, 0.012, z, 0.95, 1, 0.3, color, 0.55 * k);
        // The fret at the foot of the stem, on the lane.
        const label = missed ? WHITE : LABEL_COLORS[string];
        this.labels.add(glyph(String(fret), LANE_FRET), x, 0.15, z + 0.12, 0.3, this.labelFade(z) * (missed ? 0.35 : 1), label);
      } else {
        L.bars.add(x, y, z, open, 0.12, 0.14, color, 1.2 * k);
        L.marks.add(x, 0.012, z, open, 1, 0.26, color, 0.3 * k);
      }
      const tech = techniqueText(techniques, fret);
      if (tech) this.labels.add(glyph(tech, TECHNIQUE), x, y + 0.27, z, 0.2, this.labelFade(z));
      if (techniques?.bend) this.labels.add(bendGlyph(techniques.bend), x + 0.15, y + 0.42, z, 0.36, this.labelFade(z));
    }
    if (it.sustain > 0.08) {
      this.drawTail(it, string, x, y, fret > 0 ? 0.22 : open * 0.9, color, now, fret, techniques?.slideTo);
    }
  }

  private drawChord(it: ViewItem, template: number, z: number, ahead: number, now: number, repeat: boolean): void {
    const tpl = this.chart!.chordTemplates[template];
    if (!tpl) return;
    const L = this.layers;
    const inv = this.settings.invertStrings;
    const zone = this.zoneAt(it.time);
    const fretted = tpl.frets.filter((f) => f > 0);
    let lo = fretted.length ? Math.min(...fretted) : zone.lo;
    let hi = fretted.length ? Math.max(...fretted) : zone.hi;
    if (tpl.frets.some((f) => f === 0)) lo = Math.min(lo, zone.lo);
    if (hi === lo) {
      hi = Math.min(FRETS, hi + 1);
      lo = hi - 1;
    }
    const x0 = (lo - 1) * LANE;
    const x1 = hi * LANE;
    const cx = (x0 + x1) / 2;
    const w = x1 - x0;
    const top = TOP_Y + 0.16;
    const missed = it.status === 'missed';
    tpl.frets.forEach((f, s) => {
      this.track(f, s, ahead);
      if (f >= 0) this.guide(s, f, ahead, tpl.fingers[s] ?? -1);
    });
    if (it.status !== 'hit' && ahead > -PAST) {
      const k = this.glow(it, ahead);
      const fc = missed ? GREY : FRAME;
      // A light box over the chord's frets only: thin posts and top, a faint pane.
      const t = 0.03;
      L.frames.add(x0, top / 2, z, t, top, t, fc, 0.8 * k);
      L.frames.add(x1, top / 2, z, t, top, t, fc, 0.8 * k);
      L.frames.add(cx, top, z, w + t, t, t, fc, 0.8 * k);
      L.frames.add(cx, top / 2, z, w, top, 0.01, fc, 0.07 * k);
      L.marks.add(cx, 0.012, z, w, 1, 0.34, fc, (repeat ? 0.15 : 0.3) * k);
      if (!repeat) {
        tpl.frets.forEach((f, s) => {
          if (f < 0) return;
          const y = stringY(s, inv);
          const c = missed ? GREY : STRING_COLORS[s];
          if (f === 0) {
            L.bars.add(cx, y, z, w - 0.12, 0.1, 0.12, c, 1.1 * k);
            return;
          }
          L.gems.add(laneCenter(f), y, z, 1, 1, 1, c, 1.3 * k);
          // Chords show which finger goes where; single notes show their fret.
          const finger = tpl.fingers[s] ?? -1;
          const label = finger > 0 ? glyph(String(finger), FINGER) : glyph(String(f), GEM_FRET);
          this.labels.add(label, laneCenter(f), y, z + GEM.d * 0.5 + 0.02, finger > 0 ? 0.2 : 0.26, this.labelFade(z) * (missed ? 0.35 : 1));
        });
        if (tpl.name) {
          const name = glyph(tpl.name, CHORD_NAME);
          this.labels.add(name, x0 + (name.aspect * 0.3) / 2, top + 0.24, z, 0.3, this.labelFade(z));
        }
      }
    }
    if (it.sustain > 0.08) {
      tpl.frets.forEach((f, s) => {
        if (f < 0) return;
        const color = missed ? GREY : STRING_COLORS[s];
        this.drawTail(it, s, f > 0 ? laneCenter(f) : cx, stringY(s, inv), f > 0 ? 0.2 : w * 0.85, color, now, f);
      });
    }
  }

  /** Sustain ribbon from the note (or the strike line, once hit) to the end of the note. */
  private drawTail(
    it: ViewItem,
    string: number,
    x: number,
    y: number,
    width: number,
    color: THREE.Color,
    now: number,
    fret: number,
    slideTo?: number,
  ): void {
    const { speed } = this.settings;
    const end = it.time + it.sustain;
    const from = it.status === 'hit' ? Math.max(it.time, now) : it.time;
    if (end <= from) return;
    const held = it.status === 'hit' && now >= it.time;
    const open = fret === 0 ? 0.35 : 1;
    // A held note shows its sustain even in master mode: the player found it.
    const k = open * (it.status === 'missed' ? 0.3 * this.vis : held ? 1.7 + 0.3 * Math.sin(this.wall * 30) : 0.8 * this.vis);
    const z0 = timeZ(from, now, speed);
    const z1 = timeZ(end, now, speed);
    let head = x;
    if (slideTo !== undefined && slideTo > 0 && slideTo !== fret && fret > 0) {
      const xs = laneCenter(fret);
      const xe = laneCenter(slideTo);
      head = xs + (xe - xs) * ((from - it.time) / it.sustain);
      const dx = xe - head;
      const dz = z1 - z0;
      this.layers.tails.add((head + xe) / 2, y, (z0 + z1) / 2, width, 0.06, Math.hypot(dx, dz), color, k, Math.atan2(dx, dz));
    } else {
      this.layers.tails.add(x, y, (z0 + z1) / 2, width, fret === 0 ? 0.03 : 0.06, z0 - z1, color, k);
    }
    if (held) {
      this.strings[string].held = 1;
      if (Math.random() < 0.5) this.particles.burst(head, y, 0.05, color, 1, 1.8, 0.07, 0.35);
    }
  }

  private applyEffects(view: GameView): void {
    for (const e of view.drainEffects()) {
      if (e.kind !== 'hit') this.callout(e.item);
      if (e.kind === 'late') continue;
      for (const p of this.points(e.item)) {
        const line = this.strings[p.string];
        if (e.kind === 'miss') {
          line.miss = 1;
          this.mood.danger = 1;
          continue;
        }
        line.pulse = 1;
        const c = STRING_COLORS[p.string];
        this.particles.burst(p.x, p.y, 0.1, c, e.item.perfect ? 28 : 16, 5.5, 0.09, 0.6);
        this.particles.flash(p.x, p.y, 0.15, c, e.item.perfect ? 1.2 : 0.8, 0.22);
      }
    }
  }

  /** Says above the strings why `it` was missed (nothing when it was not played). */
  private callout(it: ViewItem): void {
    const text = missText(it.reason);
    const points = this.points(it);
    if (!text || !points.length) return;
    const kind = it.reason?.kind;
    const style = kind === 'timing' ? MISS_TIMING : kind === 'pitch' ? MISS_PITCH : MISS_CHORD;
    const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    // A late note replaces what its miss said.
    this.callouts = this.callouts.filter((c) => Math.abs(c.x - x) > 0.01 || this.wall - c.born > 0.6);
    this.callouts.push({ text, style, x, born: this.wall });
  }

  private drawCallouts(): void {
    this.callouts = this.callouts.filter((c) => this.wall - c.born < CALLOUT_LIFE);
    for (const c of this.callouts) {
      const age = (this.wall - c.born) / CALLOUT_LIFE;
      const fade = age < 0.6 ? 1 : 1 - (age - 0.6) / 0.4;
      const pop = Math.min(1, age * 8);
      // Above the strings, clear of their glow.
      this.labels.add(glyph(c.text, c.style), c.x, TOP_Y + 0.45 + 0.3 * age, 0.25, 0.42 * (0.7 + 0.3 * pop), fade);
    }
  }

  /** Where a note or each note of a chord meets its string at the strike line. */
  private points(it: ViewItem): Point[] {
    const inv = this.settings.invertStrings;
    const zone = this.zoneAt(it.time);
    const xOf = (fret: number) => (fret > 0 ? laneCenter(fret) : (zoneLeft(zone) + zoneRight(zone)) / 2);
    if (it.target.kind === 'note') {
      const { string, fret } = it.target;
      return [{ x: xOf(fret), y: stringY(string, inv), string }];
    }
    const frets = this.chart?.chordTemplates[it.target.template]?.frets ?? [];
    return frets.flatMap((f, s) => (f < 0 ? [] : [{ x: xOf(f), y: stringY(s, inv), string: s }]));
  }

  private updateCamera(now: number, dt: number): void {
    const zone = this.chart ? focusZone(this.zoneAt(now + 0.45), this.upcoming) : DEFAULT_SPAN.zone;
    this.zoneNow = this.chart ? this.zoneAt(now) : DEFAULT_SPAN.zone;
    const target = framing(zone, this.camera.aspect);
    this.cam.x = approach(this.cam.x, target.x, dt, 0.35);
    this.cam.scale = approach(this.cam.scale, target.scale, dt, 0.5);
    const k = this.cam.scale;
    // In the menus the camera breathes: a slow, uneven drift, gone once a song plays.
    this.breath = approach(this.breath, this.chart ? 0 : 1, dt, 0.8);
    const t = this.wall;
    const b = this.breath;
    const bx = b * (Math.sin(t * 0.13) * 0.32 + Math.sin(t * 0.29 + 1.3) * 0.12);
    const by = b * (Math.sin(t * 0.17 + 0.4) * 0.14 + Math.sin(t * 0.41) * 0.05);
    this.camera.position.set(this.cam.x + bx, CAMERA.height * k + by, CAMERA.distance * k + b * Math.sin(t * 0.11) * 0.25);
    this.camera.lookAt(this.cam.x + bx * 0.4, CAMERA.lookY * k + by * 0.3, CAMERA.lookZ * k);
    this.camera.rotateZ(-ROLL * (this.cam.x - 5) + b * Math.sin(t * 0.09) * 0.006);
  }

  private launchFireworks(): void {
    const fw = this.fireworks;
    while (this.wall < fw.until && this.wall >= fw.next) {
      const zone = this.zoneNow;
      const x = zone.lo - 3 + Math.random() * (zone.hi - zone.lo + 6);
      const y = 1.8 + Math.random() * 2.2;
      const z = -2 - Math.random() * 6;
      const color = STRING_COLORS[Math.floor(Math.random() * STRING_COLORS.length)];
      this.particles.burst(x, y, z, color, Math.round(25 + 45 * fw.intensity), 7, 0.13, 1.2);
      this.particles.flash(x, y, z, color, 2.2, 0.3);
      this.mood.flash = Math.max(this.mood.flash, 0.5);
      fw.next += 0.25 / Math.max(fw.intensity, 0.3);
    }
  }

  /** The venue follows the music (beats) and the player (streak, misses, milestones). */
  private updateMood(now: number, view: GameView | null, dt: number): void {
    const beats = this.chart?.beats ?? [];
    const i = lastAtOrBefore(beats, now, (b) => b.time);
    if (i >= 0) {
      this.mood.pulse = Math.exp(-(now - beats[i].time) / 0.16) * (beats[i].bar !== undefined ? 1 : 0.6);
    } else {
      this.mood.pulse = 0.4 * Math.exp(-(this.wall % 0.7) / 0.2);
    }
    const streak = view?.score.streak ?? 0;
    if (MILESTONES.some((m) => this.lastStreak < m && streak >= m)) this.mood.flash = 1;
    this.lastStreak = streak;
    const energy = this.crowd !== null ? 0.1 + 0.9 * this.crowd : this.chart ? 0.2 + 0.8 * Math.min(1, streak / 30) : 0.35;
    this.mood.energy = approach(this.mood.energy, energy, dt, 0.8);
    this.mood.danger *= Math.exp(-dt / 0.35);
    this.mood.flash *= Math.exp(-dt / 0.45);
    this.dim = approach(this.dim, this.chart ? PLAYING_DIM : 1, dt, 0.6);
    this.stage.update(this.wall, this.mood, this.dim);
    this.scenery.update(dt, this.mood, this.dim);
    this.neck.wood.uniforms.uTime.value = this.wall;
    this.neck.wood.uniforms.uPulse.value = this.mood.pulse;
  }

  private updateStrings(dt: number): void {
    const inv = this.settings.invertStrings;
    // While a note comes, its string lights up and the others step back.
    const focus = Math.max(...this.lit);
    this.strings.forEach((line, s) => {
      line.pulse *= Math.exp(-dt / 0.2);
      line.miss *= Math.exp(-dt / 0.25);
      line.light = approach(line.light, this.lit[s], dt, 0.06);
      const ring = this.chart ? 0 : line.ring * this.ringLevel;
      const back = 1 - 0.5 * focus * (1 - line.light);
      line.material.color
        .copy(line.base)
        .multiplyScalar((line.rest + 2.4 * line.pulse + 0.5 * line.held + 0.45 * line.light + 1.2 * ring) * back)
        .lerp(RED, 0.5 * line.miss);
      line.mesh.position.y = stringY(s, inv) + 0.025 * Math.max(line.pulse, 0.7 * ring) * Math.sin(this.wall * 90 + s);
      const thick = 1 + 1.4 * line.pulse + 0.3 * line.held + 0.3 * line.light + 0.6 * ring;
      line.mesh.scale.set(1, thick, thick);
      line.held = 0;
    });
  }

  /** Fret numbers under the neck: the hand's zone in orange, the next frets in their string colour. */
  private updateFretNumbers(): void {
    const zone = this.zoneNow;
    this.fretNumbers.forEach((sprite, i) => {
      const f = i + 1;
      const m = sprite.material;
      const inZone = f >= zone.lo && f <= zone.hi;
      let h = inZone ? 0.36 : 0.26;
      let o = inZone ? 1 : 0.35;
      m.color.copy(inZone ? ZONE_NUMBER : WHITE);
      const next = this.nextFret.get(f);
      if (next) {
        const k = 1 - next.ahead / 0.7;
        h += 0.14 * k;
        o = Math.max(o, 0.6 + 0.4 * k);
        m.color.copy(STRING_COLORS[next.string]).multiplyScalar(1.2).lerp(WHITE, 0.35 * (1 - k));
      }
      m.opacity = o;
      sprite.scale.set(h * (sprite.userData.aspect as number), h, 1);
    });
  }
}

/** An inlay lying on the fingerboard, the size of a fret's width; null: none. */
function inlayGeometry(shape: InlayShape): THREE.BufferGeometry | null {
  if (shape === 'none') return null;
  if (shape === 'dots') return new THREE.CircleGeometry(0.1, 28).rotateX(-Math.PI / 2);
  if (shape === 'blocks') return new THREE.PlaneGeometry(0.56, 0.5).rotateX(-Math.PI / 2);
  const outline = new THREE.Shape();
  if (shape === 'diamonds') {
    outline.moveTo(0, 0.24);
    outline.lineTo(0.17, 0);
    outline.lineTo(0, -0.24);
    outline.lineTo(-0.17, 0);
  } else if (shape === 'sharks') {
    outline.moveTo(-0.28, 0.27);
    outline.lineTo(0.28, 0.27);
    outline.lineTo(0.28, -0.29);
  } else {
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.08 : 0.2;
      const a = Math.PI / 2 + (i * Math.PI) / 5;
      if (i === 0) outline.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else outline.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  outline.closePath();
  return new THREE.ShapeGeometry(outline).rotateX(-Math.PI / 2);
}
