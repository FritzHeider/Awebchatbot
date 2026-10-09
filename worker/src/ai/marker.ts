/**
 * Streams text through while removing a control marker (e.g. "[[HANDOFF]]") that may be split
 * across several deltas. Text that could be the start of the marker is held back until it is
 * either completed (and removed) or proven not to be the marker.
 */
export class MarkerFilter {
  private pending = '';
  found = false;

  constructor(private readonly marker: string) {}

  push(delta: string): string {
    this.pending += delta;
    let idx: number;
    while ((idx = this.pending.indexOf(this.marker)) !== -1) {
      this.found = true;
      this.pending = this.pending.slice(0, idx) + this.pending.slice(idx + this.marker.length);
    }
    const hold = this.partialSuffixLength(this.pending);
    const out = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return out;
  }

  flush(): string {
    const out = this.pending;
    this.pending = '';
    return out;
  }

  private partialSuffixLength(text: string): number {
    const max = Math.min(text.length, this.marker.length - 1);
    for (let len = max; len > 0; len--) {
      if (this.marker.startsWith(text.slice(text.length - len))) return len;
    }
    return 0;
  }
}

export const HANDOFF_MARKER = '[[HANDOFF]]';
