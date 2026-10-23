"use client";
import { useState } from "react";
import { Icon } from "./ui";
import { copyText } from "../lib/clipboard";

export interface ConnectionCredentials {
  serverUrl: string;
  pointId: string;
  key: string;
  name: string;
}
export function ConnectionSetup({
  credentials,
  onDismiss,
}: {
  credentials: ConnectionCredentials;
  onDismiss: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  async function copy(value: string, label: string) {
    try {
      await copyText(value);
      setFeedback(`${label} copied.`);
    } catch {
      setFeedback("Select the value and copy it manually.");
    }
  }
  return (
    <section className="card secret" aria-labelledby="connection-setup-title">
      <div className="section-heading">
        <div className="section-icon">
          <Icon name="key" />
        </div>
        <div>
          <h2 id="connection-setup-title">Connect {credentials.name}</h2>
          <p>
            In VS Code, open Chat Settings → Server connection and paste these
            values.
          </p>
        </div>
      </div>
      <div className="connection-credentials">
        {[
          { label: "Server address", value: credentials.serverUrl },
          { label: "Connection ID", value: credentials.pointId },
          { label: "Connection key", value: credentials.key },
        ].map((field) => (
          <div className="credential-field" key={field.label}>
            <label>
              <span>{field.label}</span>
              <input
                aria-label={field.label}
                readOnly
                value={field.value}
                onFocus={(event) => event.target.select()}
                spellCheck={false}
              />
            </label>
            <button
              aria-label={`Copy ${field.label.toLowerCase()}`}
              title={`Copy ${field.label.toLowerCase()}`}
              onClick={() => void copy(field.value, field.label)}
            >
              <Icon name="copy" size={15} />
            </button>
          </div>
        ))}
      </div>
      <p className="note">
        The key is shown only now. Save it before dismissing this panel.
      </p>
      <div className="button-row">
        <button
          onClick={() =>
            void copy(
              JSON.stringify(
                {
                  serverUrl: credentials.serverUrl,
                  connectionId: credentials.pointId,
                  key: credentials.key,
                },
                null,
                2,
              ),
              "Connection details",
            )
          }
        >
          <Icon name="copy" size={15} />
          Copy all details
        </button>
        <button className="ghost-button" onClick={onDismiss}>
          <Icon name="close" size={15} />
          Dismiss
        </button>
        <span className="copy-feedback" role="status">
          {feedback}
        </span>
      </div>
    </section>
  );
}
