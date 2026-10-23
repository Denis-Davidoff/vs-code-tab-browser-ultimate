import type { CSSProperties } from "react";

export type IconName =
  | "arrow"
  | "plus"
  | "terminal"
  | "globe"
  | "link"
  | "copy"
  | "key"
  | "logout"
  | "shield"
  | "send"
  | "stop"
  | "close"
  | "google";
const paths: Record<IconName, React.ReactNode> = {
  arrow: (
    <>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  link: (
    <>
      <path d="m10 13 4-4m-5 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="9" r="5" />
      <path d="m12 13 8 8m-3-3 3-3m-6 0 3-3" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4m6-4 4-4-4-4m-6 4h10" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  send: (
    <>
      <path d="m21 3-7 18-4-7-7-4L21 3ZM10 14 21 3" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  google: (
    <>
      <path d="M20 12h-8m8 0c.5 5-3 9-8 9a9 9 0 1 1 6-15" />
    </>
  ),
};
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
export function Brand() {
  return (
    <a href="/" className="brand" aria-label="AI Browser home">
      <img src="/ai-browser.png" width="38" height="38" alt="" />
      <span>AI Browser</span>
    </a>
  );
}
export function ConnectionDiagram() {
  return (
    <div
      className="connection-diagram"
      aria-label="Your VS Code workspace connects through AI Browser to your browser"
    >
      <div className="diagram-caption">
        <span>ONE WORKSPACE. ANYWHERE.</span>
        <span className="diagram-cross">+</span>
      </div>
      <div className="diagram-flow">
        <div className="diagram-node">
          <span className="node-icon">
            <Icon name="terminal" size={21} />
          </span>
          <strong>VS Code</strong>
          <span>Your computer</span>
        </div>
        <div className="diagram-wire">
          <span />
        </div>
        <div className="diagram-hub">
          <img src="/ai-browser.png" width="44" height="44" alt="AI Browser" />
        </div>
        <div className="diagram-wire">
          <span />
        </div>
        <div className="diagram-node">
          <span className="node-icon">
            <Icon name="globe" size={21} />
          </span>
          <strong>Browser</strong>
          <span>Wherever you are</span>
        </div>
      </div>
      <div className="diagram-bottom">
        <Icon name="shield" size={14} />
        <span>Your agent stays on your machine.</span>
      </div>
    </div>
  );
}
