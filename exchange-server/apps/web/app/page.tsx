"use client";
import { Form, Input } from "./components/form";
import { useEffect, useState } from "react";
import { Brand, ConnectionDiagram, Icon } from "./components/ui";
import { auth } from "./components/auth-client";
import { AccountMenu } from "./components/account-menu";
import {
  ConnectionSetup,
  type ConnectionCredentials,
} from "./components/connection-credentials";

type Point = {
  id: string;
  name: string;
  createdAt: string;
  online: boolean;
  protected?: boolean;
};
export default function Page() {
  const { data: session, isPending } = auth.useSession();
  const [points, setPoints] = useState<Point[]>([]),
    [error, setError] = useState(""),
    [credentials, setCredentials] = useState<ConnectionCredentials | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [signup, setSignup] = useState(false),
    [serverAddress, setServerAddress] = useState("");
  const [loginErrorField, setLoginErrorField] = useState<string>();
  const [createError, setCreateError] = useState("");
  const [challenge, setChallenge] = useState(false);
  const [recovery, setRecovery] = useState(false);
  useEffect(() => {
    setServerAddress(
      process.env.NEXT_PUBLIC_EXCHANGE_WS_URL ?? window.location.origin,
    );
  }, []);
  async function load() {
    const response = await fetch("/api/points");
    if (!response.ok) throw new Error("Could not load your connections.");
    setPoints(await response.json());
  }
  useEffect(() => {
    if (!session) {
      setPoints([]);
      setCredentials(null);
      return;
    }
    void load().catch((e) => setError(e.message));
    const timer = setInterval(() => void load().catch(() => {}), 10000);
    return () => clearInterval(timer);
  }, [session]);
  async function login(form: FormData) {
    setLoginErrorField(undefined);
    setBusy(true);
    setError("");
    try {
      const email = String(form.get("email")),
        password = String(form.get("password"));
      const result = signup
        ? await auth.signUp.email({
            name: String(form.get("name")),
            email,
            password,
          })
        : await auth.signIn.email({ email, password });
      if (
        result.data &&
        "twoFactorRedirect" in result.data &&
        result.data.twoFactorRedirect
      )
        setChallenge(true);
      if (result.error) {
        const code = result.error.code ?? "";
        setLoginErrorField(
          code.includes("PASSWORD")
            ? "password"
            : code.includes("EMAIL") || code.includes("USER_ALREADY_EXISTS")
              ? "email"
              : undefined,
        );
        setError(
          result.error.message ?? "Unable to sign in. Please try again.",
        );
      }
    } catch {
      setError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function create(form: FormData) {
    setBusy(true);
    setCreateError("");
    try {
      const response = await fetch("/api/points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.get("name") }),
      });
      if (!response.ok) throw new Error("Could not create the connection.");
      const result = await response.json();
      setCredentials({
        serverUrl:
          process.env.NEXT_PUBLIC_EXCHANGE_WS_URL ?? window.location.origin,
        pointId: result.id,
        key: result.key,
        name: result.name,
      });
      await load();
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function rotate(id: string) {
    setError("");
    try {
      const response = await fetch("/api/points/" + id + "/key", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Could not rotate the connection key.");
      setCredentials({
        serverUrl:
          process.env.NEXT_PUBLIC_EXCHANGE_WS_URL ?? window.location.origin,
        pointId: id,
        key: (await response.json()).key,
        name: points.find((point) => point.id === id)?.name ?? "your workspace",
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(id: string) {
    setError("");
    try {
      const response = await fetch("/api/points/" + id, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete the connection.");
      await load();
      setCredentials(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const onlineCount = points.filter((point) => point.online).length;
  return (
    <main className={session ? "dashboard-shell" : "landing-shell"}>
      <header className="site-header">
        <Brand />
        <span className="header-divider" aria-hidden="true" />
        <span className="header-caption">Remote workspace</span>
        <nav aria-label="Main navigation">
          {session ? (
            <>
              <a href="#connections" className="nav-link active">
                Connections
              </a>
              <a href="#connection-guide" className="nav-link">
                Setup guide
              </a>
              <AccountMenu user={session.user} />
            </>
          ) : (
            <span className="header-access">
              <Icon name="shield" size={14} /> Private workspace access
            </span>
          )}
        </nav>
      </header>
      {isPending ? (
        <section className="loading-state" role="status">
          <span className="liquid-loader" aria-hidden="true" />
          Loading your workspace…
        </section>
      ) : !session ? (
        <div className="auth-layout">
          <section className="intro landing-intro">
            <span className="eyebrow">
              <span className="accent-dot" /> YOUR WORKSPACE, CONNECTED
            </span>
            <h1>
              Your workspace.
              <br />
              <span>Within reach.</span>
            </h1>
            <p className="hero-description">
              A direct line to your VS Code workspace.
              <br className="desktop-break" /> Pick up the conversation from any
              browser.
            </p>
            <ConnectionDiagram />
            <div className="hero-features">
              <span>
                <Icon name="terminal" size={15} /> Runs on your machine
              </span>
              <span>
                <Icon name="link" size={15} /> Connect from anywhere
              </span>
            </div>
          </section>
          <section className="card auth" aria-labelledby="auth-title">
            <div className="panel-label">
              <span>WORKSPACE ACCESS</span>
              <span>01 /</span>
            </div>
            <h2 id="auth-title">
              {challenge
                ? "Verify your identity"
                : signup
                  ? "Create your account"
                  : "Welcome back"}
            </h2>
            <p className="auth-description">
              {signup
                ? "Your workspace is one connection away."
                : "Sign in to connect to your workspace."}
            </p>
            <button
              className="google-button"
              onClick={async () => {
                setError("");
                try {
                  const result = await auth.signIn.social({
                    provider: "google",
                    callbackURL: "/",
                  });
                  if (result.error)
                    setError(
                      result.error.message ??
                        "Google sign-in is not configured.",
                    );
                } catch {
                  setError(
                    "Google sign-in is unavailable. Please try email instead.",
                  );
                }
              }}
            >
              <Icon name="google" size={19} /> Continue with Google
            </button>
            <div className="form-divider">
              <span>or continue with email</span>
            </div>

            {challenge ? (
              <Form
                error={error}
                errorField="code"
                action={async (form) => {
                  setBusy(true);
                  setError("");
                  try {
                    const code = String(form.get("code"));
                    const result = recovery
                      ? await auth.twoFactor.verifyBackupCode({ code })
                      : await auth.twoFactor.verifyTotp({ code });
                    if (result.error)
                      setError(result.error.message ?? "Verification failed.");
                    else {
                      setChallenge(false);
                      await auth.getSession();
                    }
                  } catch {
                    setError("Could not verify the code.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  {recovery ? "Recovery code" : "Authenticator code"}
                  <Input
                    name="code"
                    autoComplete="one-time-code"
                    inputMode={recovery ? "text" : "numeric"}
                    pattern={recovery ? undefined : "[0-9]{6}"}
                    required
                    autoFocus
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Verify
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setRecovery(!recovery)}
                >
                  {recovery ? "Use authenticator" : "Use a recovery code"}
                </button>
              </Form>
            ) : (
              <Form action={login} error={error} errorField={loginErrorField}>
                {signup && (
                  <label>
                    Full name
                    <Input
                      name="name"
                      placeholder="Your name"
                      required
                      autoComplete="name"
                      maxLength={100}
                    />
                  </label>
                )}
                <label>
                  Email address
                  <Input
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                  />
                </label>
                <label>
                  Password
                  <Input
                    name="password"
                    type="password"
                    placeholder={
                      signup ? "At least 8 characters" : "Enter your password"
                    }
                    required
                    minLength={signup ? 8 : undefined}
                    autoComplete={signup ? "new-password" : "current-password"}
                  />
                </label>
                <button className="primary auth-submit" disabled={busy}>
                  {busy
                    ? signup
                      ? "Creating account…"
                      : "Signing in…"
                    : signup
                      ? "Create account"
                      : "Sign in"}
                  <Icon name="arrow" size={17} />
                </button>
              </Form>
            )}
            <p className="auth-switch">
              {signup ? "Already have an account?" : "New to AI Browser?"}{" "}
              <button
                className="text-button"
                onClick={() => {
                  setChallenge(false);
                  setRecovery(false);
                  setSignup(!signup);
                  setError("");
                }}
              >
                {signup ? "Sign in" : "Create an account"}
              </button>
            </p>
            <div className="auth-footnote">
              <Icon name="shield" size={13} />
              <span>Your workspace. Your access.</span>
            </div>
          </section>
        </div>
      ) : (
        <>
          <section className="dashboard-intro" id="connections">
            <div>
              <span className="eyebrow">
                <span className="accent-dot" /> WORKSPACE CONTROL
              </span>
              <h1>
                Your connections<span className="heading-period">.</span>
              </h1>
              <p>
                A connection to your computer. A workspace wherever you are.
              </p>
            </div>
            <div className="connection-count">
              <span
                className={onlineCount ? "status-dot online" : "status-dot"}
              />
              {onlineCount} online<span className="count-divider">/</span>
              {points.length} total
            </div>
          </section>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card create-card">
            <div className="section-heading">
              <div className="section-icon">
                <Icon name="plus" />
              </div>
              <div>
                <h2>New connection</h2>
                <p>Give your computer a name to get started.</p>
              </div>
            </div>
            <Form action={create} error={createError} className="inline">
              <Input
                name="name"
                aria-label="Connection name"
                placeholder="e.g. Work MacBook"
                required
                maxLength={100}
              />
              <button className="primary" disabled={busy}>
                <Icon name="plus" size={16} />
                {busy ? "Creating…" : "Create connection"}
              </button>
            </Form>
          </section>
          {credentials && (
            <ConnectionSetup
              credentials={credentials}
              onDismiss={() => setCredentials(null)}
            />
          )}
          <div className="section-label">
            <span>YOUR WORKSPACES</span>
            <span>{String(points.length).padStart(2, "0")}</span>
          </div>
          <section className="points">
            {points.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <Icon name="terminal" size={26} />
                </div>
                <h2>Your first connection starts here</h2>
                <p>
                  Create a connection above, then link it to AI Browser in VS
                  Code.
                </p>
              </div>
            ) : (
              points.map((point) => (
                <article className="card point-card" key={point.id}>
                  <div className="point-top">
                    <span className="point-icon">
                      <Icon name="terminal" size={22} />
                    </span>
                    <div className="point-identity">
                      {" "}
                      <h2>
                        {point.name}
                        {point.protected && (
                          <span
                            className="point-protected"
                            title="Password protected"
                            aria-label="Password protected"
                          >
                            <Icon name="shield" size={13} />
                          </span>
                        )}
                      </h2>
                      <p className="point-date">
                        Created{" "}
                        {new Date(point.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                    <span
                      className={point.online ? "status is-online" : "status"}
                    >
                      <span
                        className={
                          point.online ? "status-dot online" : "status-dot"
                        }
                      />
                      {point.online ? "Online" : "Offline"}
                    </span>
                  </div>
                  <details className="connection-details">
                    <summary>Connection details</summary>
                    <p>Server address</p>
                    <code>{serverAddress}</code>
                    <p>Connection ID</p>
                    <code>{point.id}</code>
                    <p>
                      Use these values in Chat Settings → Server connection. To
                      get a new key, select Rotate key.
                    </p>
                  </details>
                  <a className="point-link" href={"/workspace/" + point.id}>
                    Open workspace
                    <Icon name="arrow" size={16} />
                  </a>
                  <div className="point-actions">
                    <button
                      className="text-button"
                      onClick={() => void rotate(point.id)}
                    >
                      <Icon name="key" size={14} />
                      Rotate key
                    </button>
                    <button
                      className="text-button danger-text"
                      onClick={() => void remove(point.id)}
                    >
                      Delete connection
                    </button>
                  </div>
                </article>
              ))
            )}
          </section>
          <section className="setup-guide" id="connection-guide">
            <div className="faq-heading">
              <span className="eyebrow">GET CONNECTED</span>
              <h2>Setup guide</h2>
              <p>Your workspace, in a few steps.</p>
            </div>
            <div className="faq-items">
              {[
                [
                  "How do I connect VS Code?",
                  "Create a connection above and copy its server address, connection ID, and key. In the AI Browser chat in VS Code, open Settings → Server connection, paste these values, and select Save & connect.",
                ],
                [
                  "Where can I find my connection key?",
                  "The key appears once when you create a connection. If you lose it, select Rotate key and replace it in VS Code. Rotating a key disconnects existing sessions.",
                ],
                [
                  "Why is my workspace offline?",
                  "Keep VS Code open with AI Browser running. Check the server address and connection settings. To connect from another device, use an address that device can reach; localhost always refers to the device you are using.",
                ],
                [
                  "How do I view my browser?",
                  "Open your workspace and select a browser tab from the browser panel. The tab runs on your computer, so it can access your local development sites.",
                ],
                [
                  "How do I protect a workspace with a password?",
                  "In VS Code, open Chat Settings → Server connection, set a Workspace password of at least 12 characters, and Save & connect. The website asks for it before opening your chat and browser. Use HTTPS when connecting from another device. The password cannot be recovered from the server.",
                ],
                [
                  "Can I secure my account with 2FA?",
                  "Open your account menu → Account settings. Enable two-factor authentication with an authenticator app and keep your recovery codes in a safe place. Google accounts use Google's sign-in security.",
                ],
              ].map(([question, answer]) => (
                <details key={question}>
                  <summary>
                    {question}
                    <Icon name="plus" size={15} />
                  </summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </section>
        </>
      )}
      <footer className="site-footer">
        <span>
          AI Browser<span className="footer-slash">/</span>Your workspace,
          everywhere.
        </span>
        <span className="footer-right">
          <span className="accent-dot" /> BUILT FOR YOUR WORKFLOW
        </span>
      </footer>
    </main>
  );
}
