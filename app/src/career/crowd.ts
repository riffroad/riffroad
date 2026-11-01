/**
 * The crowd at a gig, 0 (leaving) to 1 (on fire). It follows how well the last notes went,
 * slowly: a bad passage cools the room, a good one warms it back. A crowd left cold too long
 * boos the band off the stage.
 */

/** Notes the crowd remembers (moving average). */
const WINDOW = 16;
/** Recent accuracy at which the room is empty of goodwill, and at which it is on fire. */
const FLOOR = 0.55;
// Near-perfect playing sets a room on fire: at 95 % it is already on fire for good players only.
const CEIL = 0.98;
/** How fast the room follows (s). */
const TAU = 2;
/** Below this, for that long, the band is booed off. */
export const BOO = 0.08;
export const BOO_AFTER = 20;

export class Crowd {
  value: number;
  private recent: number;
  private low = 0;

  /** `patience`: seconds of a cold room before the band is booed off. */
  constructor(
    start = 0.5,
    private readonly patience = BOO_AFTER,
  ) {
    this.value = start;
    this.recent = FLOOR + start * (CEIL - FLOOR);
  }

  /** Where the crowd is heading: the recent accuracy, from FLOOR (0) to CEIL (1). */
  get target(): number {
    return Math.min(1, Math.max(0, (this.recent - FLOOR) / (CEIL - FLOOR)));
  }

  /** A note played (hit) or missed. */
  note(hit: boolean): void {
    this.recent += ((hit ? 1 : 0) - this.recent) / WINDOW;
  }

  /** `dt` seconds of the show; true once the crowd has had enough. */
  update(dt: number): boolean {
    const target = this.target;
    this.value = target + (this.value - target) * Math.exp(-Math.max(dt, 0) / TAU);
    this.low = this.value < BOO ? this.low + dt : 0;
    return this.low >= this.patience;
  }

  /** A gap in the show (retuning between songs): the room cools by `amount`, then has to be won
   * back. */
  cool(amount: number): void {
    this.value = Math.max(0, this.value - amount);
    this.recent = Math.max(0, this.recent - amount * (CEIL - FLOOR));
  }
}
