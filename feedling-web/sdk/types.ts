export interface JarStatus {
  present: boolean;
  loggedIn?: boolean;
  count?: number;
  updatedAt?: number;
}

export interface PluginInfo {
  id: string;
  label: string;
  cookieDomains: string[];
  jar?: JarStatus;
}

/** One listable thing in a plugin — a note, a video, a transcript. */
export interface PluginItem {
  id: string;
  title: string;
  date?: string; // ISO
  meta?: Record<string, unknown>;
}

/** Returned by the app-authorization handshake. */
export interface ConnectRequest {
  requestId: string;
  approveUrl: string;
}

export type ConnectStatus =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "approved"; token: string };
