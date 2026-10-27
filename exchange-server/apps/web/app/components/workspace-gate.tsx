"use client";
import { exchangeViewerId } from "../../../../../src/core/exchangeViewer";
import { Form, Input } from "./form";
import { useEffect, useState, type ReactNode } from "react";
import {
  exchangeCipher,
  type ExchangeCipher,
  type ExchangeEncryption,
} from "../../../../../src/core/exchangeCrypto";
import { Brand, Icon } from "./ui";
export function WorkspaceGate({
  pointId,
  children,
}: {
  pointId: string;
  children: ReactNode;
}) {
  const [descriptor, setDescriptor] = useState<ExchangeEncryption | null>(null),
    [paused, setPaused] = useState(false),
    [loaded, setLoaded] = useState(false),
    [unlocked, setUnlocked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function store(cipher?: ExchangeCipher) {
    const host = window as Window & {
      aiBrowserWorkspaceKeys?: Map<string, ExchangeCipher | undefined>;
    };
    host.aiBrowserWorkspaceKeys ??= new Map();
    host.aiBrowserWorkspaceKeys.set(pointId, cipher);
    setUnlocked(true);
  }
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/points/" + encodeURIComponent(pointId))
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "Sign in to open your workspace."
              : "Workspace not found.",
          );
        return response.json();
      })
      .then(async (data) => {
        const capabilities = await fetch("/api/security/capabilities", {
          cache: "no-store",
        });
        if (!capabilities.ok)
          throw new Error("Could not verify workspace access.");
        if ((await capabilities.json()).plugins.includes("sessions")) {
          const access = await fetch(
            `/api/plugins/viewers/access/${encodeURIComponent(pointId)}?viewerId=${encodeURIComponent(exchangeViewerId(pointId))}`,
            { cache: "no-store" },
          );
          if (!access.ok) throw new Error("Could not verify viewer access.");
          if ((await access.json()).blocked) {
            if (!cancelled) {
              setPaused(true);
              setLoaded(true);
            }
            return;
          }
        }
        if (cancelled) return;
        setDescriptor(data.encryption);
        setLoaded(true);
        if (!data.encryption) store();
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      const host = window as Window & {
        aiBrowserWorkspaceKeys?: Map<string, ExchangeCipher | undefined>;
      };
      host.aiBrowserWorkspaceKeys?.delete(pointId);
    };
  }, [pointId]);
  if (unlocked) return children;
  return (
    <main className="landing-shell">
      <header className="site-header">
        <Brand />
        <a href="/">All connections</a>
      </header>
      <section className="card workspace-unlock">
        <Icon name="shield" size={28} />
        <h1>
          {paused
            ? "Viewer disconnected"
            : loaded
              ? "Unlock workspace"
              : "Opening workspace…"}
        </h1>
        <p>
          {paused
            ? "This viewer was disconnected. Reconnect explicitly to open this workspace again."
            : loaded
              ? "Enter the workspace password set in VS Code. It stays in this browser tab."
              : ""}
        </p>
        {paused && (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const response = await fetch(
                  `/api/plugins/viewers/access/${encodeURIComponent(pointId)}/resume`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      viewerId: exchangeViewerId(pointId),
                    }),
                  },
                );
                if (!response.ok)
                  throw new Error("Could not reconnect. Please sign in again.");
                window.location.reload();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Reconnect to workspace
          </button>
        )}
        {error && (!loaded || paused) && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {loaded && descriptor && (
          <Form
            error={error}
            errorField="password"
            action={async (form) => {
              setBusy(true);
              setError("");
              try {
                store(
                  await exchangeCipher(
                    String(form.get("password")),
                    pointId,
                    descriptor,
                  ),
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Workspace password
              <Input
                type="password"
                name="password"
                autoComplete="off"
                required
                autoFocus
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? "Unlocking…" : "Unlock workspace"}
            </button>
          </Form>
        )}
      </section>
    </main>
  );
}
