// Live link: other programs PUT layer bytes to a small relay (web/live-relay.ts); the page hears about
// them over server-sent events and replaces the matching open layer in memory. The viewer's own edits
// go back the same way, so those programs can read them.
import type { UsdSession } from './session.ts';

export class LiveLink {
  /** Marks this viewer's pushes, so they are not applied again when the relay echoes them. */
  readonly id = Math.random().toString(36).slice(2);
  /** Milliseconds between the last edit and publishing the edit target. */
  publishDelay = 100;
  private base = '';
  private source: EventSource | null = null;
  private readonly pending = new Map<string, boolean>(); // name -> may create an overlay; the latest push per name
  private pulling: Promise<void> | null = null;
  private applying = false;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private publishing = Promise.resolve();
  private warned = false;
  private readonly session: UsdSession;

  constructor(session: UsdSession) {
    this.session = session;
    // The relay replays its layers to each new subscriber, so subscribe once per open stage.
    session.addEventListener('stageopen', () => this.open());
    session.addEventListener('stageclose', () => this.close());
    session.addEventListener('primschange', () => this.schedulePublish());
  }

  get connected(): boolean {
    return this.source !== null;
  }

  /** `baseUrl` is the relay's live endpoint: events come from `<base>events`, layers live at `<base>layers/<name>`. */
  connect(baseUrl: string): void {
    this.base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.open();
  }

  disconnect(): void {
    this.base = '';
    this.close();
  }

  /** Resolves when nothing is being fetched, applied or published. */
  idle(): Promise<void> {
    return Promise.all([this.pulling, this.publishing]).then(() => undefined);
  }

  private open(): void {
    this.close();
    if (!this.base || !this.session.stage) return;
    this.source = new EventSource(`${this.base}events`);
    this.source.onopen = () => {
      this.warned = false;
      this.session.report('info', `Live link: connected to ${this.base}`);
    };
    this.source.onerror = () => {
      if (!this.warned) this.session.report('warn', `Live link: ${this.base} is not answering (retrying)`);
      this.warned = true;
    };
    this.source.addEventListener('layer', (event) => {
      const { name, origin, replay } = JSON.parse((event as MessageEvent<string>).data);
      if (origin === this.id) return; // our own push coming back
      this.pending.set(name, !replay); // replays from an earlier session must not add overlays to this stage
      this.pull();
    });
  }

  private close(): void {
    this.source?.close();
    this.source = null;
    this.pending.clear();
    clearTimeout(this.publishTimer);
  }

  /** Fetches and applies pushed layers one at a time; a burst on one name collapses to its latest push. */
  private pull(): Promise<void> {
    return (this.pulling ??= (async () => {
      try {
        while (this.pending.size) {
          const [name, create] = this.pending.entries().next().value!;
          this.pending.delete(name);
          const response = await fetch(`${this.base}layers/${encodeURI(name)}`);
          if (!response.ok) {
            this.session.report('warn', `Live link: ${name}: HTTP ${response.status}`);
            continue;
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          this.applying = true; // the edit this produces must not be published back
          try {
            await this.session.usd.importLayer(name, bytes, undefined, create);
            this.session.emit('livechange', { name });
          } catch (error: any) {
            // A replay for a layer this stage does not have is normal.
            this.session.report(create ? 'warn' : 'info', `Live link: ${name}: ${error.message}`);
          } finally {
            this.applying = false;
          }
        }
      } catch (error: any) {
        this.session.report('warn', `Live link: ${error.message}`);
      } finally {
        this.pulling = null;
      }
    })());
  }

  /** The viewer's own edits: the edit target goes to the relay a moment after the last one. */
  private schedulePublish(): void {
    if (!this.source || this.applying) return;
    clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => (this.publishing = this.publishing.then(() => this.publish())), this.publishDelay);
  }

  private async publish(): Promise<void> {
    try {
      // ponytail: only the edit target is mirrored, once per edit or drag end (primschange); session-layer
      // hiding and Clear edits across several layers are not. Hook UsdSession.edit() for drag-follow.
      const target = (await this.session.usd.layers()).find((layer) => layer.editTarget);
      if (!target || target.session || !this.source) return;
      const format = target.format === 'usdc' ? 'usdc' : 'usda';
      const bytes = await this.session.usd.exportLayer(target.identifier, format);
      if (!bytes) return;
      const response = await fetch(`${this.base}layers/${encodeURI(target.displayName)}`, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': format === 'usdc' ? 'application/usdc' : 'text/usda', 'X-Live-Origin': this.id },
      });
      if (!response.ok) this.session.report('warn', `Live link: could not publish ${target.displayName} (HTTP ${response.status})`);
    } catch (error: any) {
      this.session.report('warn', `Live link: ${error.message}`);
    }
  }
}
