"use client";
import { Form, Input } from "./form";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { auth } from "./auth-client";
import { Icon } from "./ui";

export function AccountMenu({
  user,
}: {
  user: { name: string; email: string; twoFactorEnabled?: boolean | null };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ qr: string; codes: string[] } | null>(
    null,
  );
  useEffect(() => {
    const modal = dialog.current;
    const clear = () => {
      setSetup(null);
      setError("");
      setNotice("");
    };
    modal?.addEventListener("close", clear);
    return () => modal?.removeEventListener("close", clear);
  }, []);
  async function run(field: string, action: () => Promise<void>) {
    setErrorField(field);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <details className="account-menu">
        <summary aria-label="Account menu" title="Account">
          <span className="avatar">
            {user.name.slice(0, 1).toUpperCase() || "U"}
          </span>
        </summary>
        <div className="account-popover">
          <strong>{user.name}</strong>
          <small>{user.email}</small>
          <button onClick={() => dialog.current?.showModal()}>
            <Icon name="shield" size={16} />
            Account settings
          </button>
          <button onClick={() => void auth.signOut()}>
            <Icon name="logout" size={16} />
            Sign out
          </button>
        </div>
      </details>
      <dialog
        ref={dialog}
        className="account-dialog"
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="account-dialog-heading">
          <div>
            <span className="eyebrow">YOUR ACCOUNT</span>
            <h2>Account settings</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close settings"
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
        <p className="account-email">{user.email}</p>

        {notice && <p role="status">{notice}</p>}
        <Form
          error={errorField === "name" ? error : ""}
          errorField="name"
          action={(form) =>
            run("name", async () => {
              const result = await auth.updateUser({
                name: String(form.get("name")),
              });
              if (result.error) throw new Error(result.error.message);
              setNotice("Profile saved.");
            })
          }
        >
          <label>
            Display name
            <Input
              name="name"
              defaultValue={user.name}
              required
              maxLength={100}
            />
          </label>
          <button disabled={busy}>Save profile</button>
        </Form>
        <section className="account-security">
          <div className="security-heading">
            <Icon name="shield" />
            <h3>Two-factor authentication</h3>
            <span
              className={user.twoFactorEnabled ? "status is-online" : "status"}
            >
              {user.twoFactorEnabled ? "Enabled" : "Optional"}
            </span>
          </div>
          <p>
            Add a code from your authenticator app to email and password
            sign-in. Google sign-in uses your Google account security.
          </p>
          {setup ? (
            <>
              <img
                className="totp-qr"
                src={setup.qr}
                alt="Scan with your authenticator app"
              />
              <p>
                Scan this QR code, then save your recovery codes. Each code can
                be used once.
              </p>
              <div className="recovery-codes">
                {setup.codes.map((code) => (
                  <code key={code}>{code}</code>
                ))}
              </div>
              <button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob(
                      [
                        "AI Browser recovery codes\n\n" +
                          setup.codes.join("\n"),
                      ],
                      { type: "text/plain" },
                    ),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "ai-browser-recovery-codes.txt";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Download recovery codes
              </button>
              <Form
                error={errorField === "code" ? error : ""}
                errorField="code"
                action={(form) =>
                  run("code", async () => {
                    const result = await auth.twoFactor.verifyTotp({
                      code: String(form.get("code")),
                    });
                    if (result.error) throw new Error(result.error.message);
                    setSetup(null);
                    await auth.getSession();
                    setNotice("Two-factor authentication enabled.");
                  })
                }
              >
                <label>
                  Authenticator code
                  <Input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    required
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Verify and enable
                </button>
              </Form>
            </>
          ) : (
            <Form
              error={errorField === "password" ? error : ""}
              errorField="password"
              action={(form) =>
                run("password", async () => {
                  const password = String(form.get("password"));
                  if (user.twoFactorEnabled) {
                    const result = await auth.twoFactor.disable({ password });
                    if (result.error) throw new Error(result.error.message);
                    await auth.getSession();
                    setNotice("Two-factor authentication disabled.");
                  } else {
                    const result = await auth.twoFactor.enable({
                      password,
                      method: "totp",
                    });
                    if (result.error) throw new Error(result.error.message);
                    if (!result.data || result.data.method !== "totp")
                      throw new Error("Could not start setup.");
                    setSetup({
                      qr: await QRCode.toDataURL(result.data.totpURI, {
                        width: 220,
                        margin: 2,
                      }),
                      codes: result.data.backupCodes,
                    });
                  }
                })
              }
            >
              <label>
                Account password
                <Input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <button disabled={busy}>
                {user.twoFactorEnabled ? "Disable 2FA" : "Set up authenticator"}
              </button>
            </Form>
          )}
        </section>
      </dialog>
    </>
  );
}
