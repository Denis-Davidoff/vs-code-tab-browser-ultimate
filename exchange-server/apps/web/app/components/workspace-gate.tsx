"use client";
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
      .then((data) => {
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
        <h1>{loaded ? "Unlock workspace" : "Opening workspace…"}</h1>
        <p>
          {loaded
            ? "Enter the workspace password set in VS Code. It stays in this browser tab."
            : ""}
        </p>
        {error && !loaded && (
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
