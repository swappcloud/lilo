/** Save streaming captions outside the render path, at a bounded cadence. */
export class CaptionPersistence {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly write: () => void) {}

  schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), 250);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
  }
}
