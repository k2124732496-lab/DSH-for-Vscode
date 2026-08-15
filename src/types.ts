/** Server lifecycle states. */
export type ServerState = "stopped" | "starting" | "running" | "stopping" | "crashed";

/** How a discovered dsh binary is spawned. */
export type DshKind = "node" | "cmd" | "direct";

/** A resolved, spawnable dsh executable. */
export interface DshLocation {
  kind: DshKind;
  /** Absolute path to the executable, a .js bin, or a .cmd shim. */
  path: string;
}

/** Public snapshot of the managed (or attached) DSH web server. */
export interface ServerSnapshot {
  state: ServerState;
  /** Base URL, e.g. http://127.0.0.1:34821 — set once running/attached. */
  url?: string;
  port?: number;
  /** true when this extension spawned the process (and therefore owns its lifecycle). */
  owned: boolean;
  pid?: number;
  /** Human-readable failure detail for the crashed state. */
  error?: string;
}
