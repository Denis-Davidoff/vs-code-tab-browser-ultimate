"use client";
import { useEffect, useState } from "react";
import { auth } from "../components/auth-client";
import { AccountMenu } from "../components/account-menu";
import "./security.css";

type Event = {
  id: string;
  created_at: string;
  event: string;
  user_id: string | null;
  point_id: string | null;
  ip: string | null;
  user_agent: string | null;
  outcome: string;
  reason: string | null;
};
type Connection = {
  id: string;
  user_id: string;
  point_id: string;
  kind: string;
  ip: string | null;
  user_agent: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: string;
  end_reason: string | null;
};
type Login = {
  id: string;
  created_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
};
type Viewer = {
  id: string;
  pointId: string;
  kind: string;
  ip: string | null;
  userAgent: string | null;
  startedAt: string;
  authSessionId: string;
  viewerId?: string;
};
type Commercial = {
  paymentsEnabled: boolean;
  subscription: {
    plan: string;
    period_end: string;
    included_bytes: string;
    used_bytes: string;
    extra_bytes: string;
  };
  plans: Record<string, { name: string; devices: number }>;
};
async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Sign in to view security activity."
        : response.status === 403
          ? "You do not have access to this journal."
          : "Could not load security information. Please retry.",
    );
  return response.json();
}
const date = (value: string) => new Date(value).toLocaleString();
const duration = (ms: string) => {
  const seconds = Math.floor(Number(ms) / 1000);
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
};
const gb = (value: string) => `${(Number(value) / 1e9).toFixed(2)} GB`;
export default function SecurityPage() {
  const { data: session, isPending } = auth.useSession();
  const [events, setEvents] = useState<Event[]>([]),
    [connections, setConnections] = useState<Connection[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]),
    [admin, setAdmin] = useState(false),
    [global, setGlobal] = useState(false);
  const [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [logins, setLogins] = useState<Login[]>([]),
    [commercial, setCommercial] = useState<Commercial | null>(null);
  const [alerts, setAlerts] = useState<Array<{ ip: string; attempts: number }>>(
      [],
    ),
    [confirm, setConfirm] = useState<string | null>(null);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const capabilities = await api("/api/security/capabilities");
      setPlugins(capabilities.plugins);
      setAdmin(capabilities.admin);
      const suffix = global ? "?admin=true" : "";
      const [journal, history, warnings] = await Promise.all([
        api("/api/security/events" + suffix),
        api("/api/security/connections" + suffix),
        api("/api/security/alerts" + suffix),
      ]);
      setEvents(journal.items);
      setNext(journal.next);
      setConnections(history);
      setAlerts(warnings.repeatedFailures);
      if (capabilities.plugins.includes("sessions")) {
        const access = await api("/api/plugins/sessions");
        setLogins(access.items);
        const grouped = new Map<string, Viewer>();
        for (const c of access.connections as Viewer[])
          grouped.set(
            `${c.authSessionId}:${c.pointId}:${c.viewerId ?? "legacy"}`,
            c,
          );
        setViewers([...grouped.values()]);
      }
      if (capabilities.plugins.includes("commercial"))
        setCommercial(await api("/api/plugins/commercial"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (session) void load();
  }, [session?.user.id, global]);
  async function revoke(id: string) {
    if (confirm !== id) {
      setConfirm(id);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/api/plugins/sessions/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
      });
      setConfirm(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="dashboard-shell security-page">
      <header className="site-header">
        <a href="/">AI Browser</a>
        <nav>
          <a className="nav-link" href="/">
            Connections
          </a>
          {session && <AccountMenu user={session.user} />}
        </nav>
      </header>
      <section className="dashboard-intro">
        <div>
          <span className="eyebrow">ACCOUNT SECURITY</span>
          <h1>Access activity</h1>
          <p>
            Sign-ins, workspace connections and browser viewing activity.
            Content, passwords and keys are never recorded here.
          </p>
        </div>
      </section>
      {isPending ? (
        <p role="status">Loading…</p>
      ) : !session ? (
        <p>
          <a href="/">Sign in</a> to view your activity.
        </p>
      ) : (
        <>
          <div className="security-actions">
            <button onClick={() => void load()} disabled={busy}>
              Refresh
            </button>
            {admin && (
              <label>
                <input
                  type="checkbox"
                  checked={global}
                  onChange={(e) => setGlobal(e.target.checked)}
                />{" "}
                Server-wide journal
              </label>
            )}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {alerts.length > 0 && (
            <section className="card">
              <h2>Repeated access failures</h2>
              <p>
                Five or more denied requests in the last 15 minutes. These are
                signals to investigate, not proof of an attack.
              </p>
              <ul>
                {alerts.map((a, i) => (
                  <li key={i}>
                    {a.ip ?? "Unknown address"}: {a.attempts} failures
                  </li>
                ))}
              </ul>
            </section>
          )}
          {events.some((e) => e.event === "auth.new_ip") && (
            <p className="notice is-info">
              A sign-in from a previously unseen IP appears in the journal.
              Mobile networks and VPNs can also change your address.
            </p>
          )}
          {commercial && (
            <section className="card">
              <h2>
                {commercial.plans[commercial.subscription.plan]?.name} plan
              </h2>
              <p>
                Up to {commercial.plans[commercial.subscription.plan]?.devices}{" "}
                computers online. Unlimited workspaces per computer.
              </p>
              <p>
                {gb(commercial.subscription.used_bytes)} of{" "}
                {gb(commercial.subscription.included_bytes)} used ·{" "}
                {gb(commercial.subscription.extra_bytes)} additional traffic
                remaining.
              </p>
              <p>
                Period ends {date(commercial.subscription.period_end)}. Payments
                are not enabled.
              </p>
            </section>
          )}
          {plugins.includes("sessions") && (
            <section className="card">
              <h2>Signed-in devices</h2>
              <p>
                Ending a sign-in disconnects its chat and browser viewers and
                requires signing in again.
              </p>
              <button disabled={busy} onClick={() => void revoke("others")}>
                {confirm === "others"
                  ? "Confirm: end all other sign-ins"
                  : "End all other sign-ins"}
              </button>
              <div className="security-table">
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Address</th>
                      <th>Signed in</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logins.map((s) => (
                      <tr key={s.id}>
                        <td>
                          {s.user_agent ?? "Unknown device"}
                          {s.current && " · This sign-in"}
                        </td>
                        <td>{s.ip_address ?? "Unknown"}</td>
                        <td>{date(s.created_at)}</td>
                        <td>
                          {!s.current && (
                            <button
                              disabled={busy}
                              onClick={() => void revoke(s.id)}
                            >
                              {confirm === s.id
                                ? "Confirm disconnect"
                                : "Disconnect"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {plugins.includes("sessions") && (
            <section className="card">
              <h2>Active viewers</h2>
              <button
                disabled={busy || !viewers.length}
                onClick={async () => {
                  if (confirm !== "all-viewers") {
                    setConfirm("all-viewers");
                    return;
                  }
                  setBusy(true);
                  setError("");
                  try {
                    await api("/api/plugins/viewers/disconnect-all", {
                      method: "POST",
                    });
                    setConfirm(null);
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {confirm === "all-viewers"
                  ? "Confirm: disconnect all viewers"
                  : "Disconnect all viewers"}
              </button>
              <p>
                Disconnect a workspace viewer without signing its device out.
                Both chat and browser channels close; reconnecting requires an
                explicit action.
              </p>
              <div className="security-table">
                <table>
                  <thead>
                    <tr>
                      <th>Workspace</th>
                      <th>Device / address</th>
                      <th>Connected</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewers.map((v) => (
                      <tr key={v.id}>
                        <td>{v.pointId}</td>
                        <td>
                          {v.ip ?? "Unknown"}
                          <small>{v.userAgent}</small>
                        </td>
                        <td>{date(v.startedAt)}</td>
                        <td>
                          <button
                            disabled={busy}
                            onClick={async () => {
                              if (confirm !== v.id) {
                                setConfirm(v.id);
                                return;
                              }
                              setBusy(true);
                              setError("");
                              try {
                                await api(
                                  `/api/plugins/viewers/${v.id}/disconnect`,
                                  { method: "POST" },
                                );
                                setConfirm(null);
                                await load();
                              } catch (e) {
                                setError((e as Error).message);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            {confirm === v.id
                              ? "Confirm disconnect"
                              : "Disconnect viewer"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!viewers.length && <p>No active viewers.</p>}
            </section>
          )}
          <section className="card">
            <h2>Connection history</h2>
            <p>
              Chat and media use separate connections. Live durations are
              calculated at refresh; crash durations are approximate.
            </p>
            <div className="security-table">
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Workspace</th>
                    <th>Channel</th>
                    <th>Address / device</th>
                    <th>Duration</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.map((c) => (
                    <tr key={c.id}>
                      <td>{date(c.started_at)}</td>
                      <td>
                        <code>{c.point_id}</code>
                      </td>
                      <td>{c.kind}</td>
                      <td>
                        {c.ip ?? "Unknown"}
                        <small>{c.user_agent}</small>
                      </td>
                      <td>{duration(c.duration_ms)}</td>
                      <td>{c.ended_at ? c.end_reason : "Connected"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!connections.length && <p>No connections recorded yet.</p>}
          </section>
          <section className="card">
            <h2>Security journal</h2>
            <div className="security-table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    {global && <th>Account</th>}
                    <th>Address</th>
                    <th>Workspace</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td>{date(e.created_at)}</td>
                      <td>
                        {e.event}
                        <small>{e.user_agent}</small>
                      </td>
                      {global && <td>{e.user_id ?? "Anonymous"}</td>}
                      <td>{e.ip ?? "Unknown"}</td>
                      <td>{e.point_id ?? "—"}</td>
                      <td>
                        {e.outcome}
                        <small>{e.reason}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!events.length && <p>No events recorded yet.</p>}
            {next && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const page = await api(
                      `/api/security/events?before=${encodeURIComponent(next)}${global ? "&admin=true" : ""}`,
                    );
                    setEvents((old) => [...old, ...page.items]);
                    setNext(page.next);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Load older events
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
