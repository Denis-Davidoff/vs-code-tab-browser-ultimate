"use client";
import { use, useEffect, useRef, useState, type CSSProperties } from "react";
import { Brand, Icon } from "../../components/ui";
import { WorkspaceGate } from "../../components/workspace-gate";
import { RemoteBrowser } from "./remote-browser";

export default function Workspace({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const frame = useRef<HTMLIFrameElement>(null),
    screens = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false),
    [online, setOnline] = useState(false),
    [page, setPage] = useState<"chat" | "browser">("chat");
  const [split, setSplit] = useState(50),
    [resizing, setResizing] = useState(false);
  const [wide, setWide] = useState(false);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const media = matchMedia("(min-width: 761px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  function toggleWidth() {
    const next = !wide;
    setWide(next);
    try {
      localStorage.setItem("ai-browser:workspace-wide", String(next));
    } catch {
      /* Keep the preference for this session. */
    }
  }
  const drag = useRef<{ pointerId: number; start: number } | undefined>(
    undefined,
  );
  function resize(value: number, persist = false) {
    const next = Math.max(25, Math.min(75, value));
    setSplit(next);
    if (persist)
      try {
        localStorage.setItem("ai-browser:workspace-split", String(next));
      } catch {
        /* Storage may be unavailable. */
      }
  }
  function splitAt(clientX: number): number {
    const bounds = screens.current!.getBoundingClientRect();
    return ((clientX - bounds.left - 9) / (bounds.width - 18)) * 100;
  }
  useEffect(() => {
    try {
      setWide(localStorage.getItem("ai-browser:workspace-wide") === "true");
      const saved = localStorage.getItem("ai-browser:workspace-split");
      if (saved !== null && Number.isFinite(Number(saved)))
        resize(Number(saved));
    } catch {
      /* Use equal panels. */
    }
  }, []);
  function showPage(next: "chat" | "browser") {
    setPage(next);
    const rail = screens.current;
    if (rail)
      rail.scrollTo({
        left: next === "chat" ? 0 : rail.clientWidth,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      if (event.data?.type === "ai-browser-connection") {
        setConnected(event.data.connected === true);
        setOnline(event.data.online === true);
      }
      if (
        event.data?.type === "ai-browser-swipe" &&
        event.data.page === "browser" &&
        matchMedia("(max-width: 760px)").matches
      )
        showPage("browser");
    };
    window.addEventListener("message", receive);
    frame.current?.contentWindow?.postMessage(
      { type: "ai-browser-request-connection" },
      location.origin,
    );
    return () => window.removeEventListener("message", receive);
  }, []);
  const server = process.env.NEXT_PUBLIC_EXCHANGE_WS_URL;
  const src = `/remote-chat/index.html?point=${encodeURIComponent(id)}${server ? "&server=" + encodeURIComponent(server) : ""}`;
  return (
    <WorkspaceGate key={id} pointId={id}>
      <main className={`workspace-shell${wide ? " workspace-wide" : ""}`}>
        <header className="site-header workspace-header">
          <Brand />
          <span className="header-divider" aria-hidden="true" />
          <span className="header-caption">
            <span
              className={
                !connected || !online ? "liquid-loader" : online ? "status-dot online" : "status-dot"
              }
            />
            {connected
              ? online
                ? "Workspace online"
                : "Workspace offline"
              : "Connecting…"}
          </span>
          <button
            type="button"
            className="workspace-width-toggle"
            onClick={toggleWidth}
            aria-pressed={wide}
            aria-label="Use full screen width"
            title={wide ? "Restore centered width" : "Use full screen width"}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path
                d={
                  wide
                    ? "M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5"
                    : "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"
                }
              />
            </svg>
            <span>{wide ? "Centered" : "Full width"}</span>
          </button>
          <a href="/" className="workspace-back">
            <Icon name="arrow" size={14} />
            All connections
          </a>
        </header>
        <nav className="mobile-workspace-tabs" aria-label="Workspace screens">
          <button
            aria-current={page === "chat" ? "page" : undefined}
            onClick={() => showPage("chat")}
          >
            <Icon name="terminal" size={15} />
            Chat
          </button>
          <button
            aria-current={page === "browser" ? "page" : undefined}
            onClick={() => showPage("browser")}
          >
            <Icon name="globe" size={15} />
            Browser
          </button>
          <span>Swipe to switch</span>
        </nav>
        <div
          ref={screens}
          className={`workspace workspace-screens${resizing ? " is-resizing" : ""}`}
          style={
            {
              "--browser-share": `${split}fr`,
              "--chat-share": `${100 - split}fr`,
            } as CSSProperties
          }
          onScroll={(event) => {
            const rail = event.currentTarget;
            if (matchMedia("(max-width: 760px)").matches)
              setPage(
                rail.scrollLeft < rail.clientWidth / 2 ? "chat" : "browser",
              );
          }}
        >
          <RemoteBrowser
            pointId={id}
            active={desktop || page === "browser"}
            onShowChat={() => showPage("chat")}
          />
          <div
            className="workspace-divider"
            role="separator"
            aria-label="Resize browser and chat"
            aria-orientation="vertical"
            aria-valuemin={25}
            aria-valuemax={75}
            aria-valuenow={Math.round(split)}
            aria-valuetext={`Browser ${Math.round(split)}%, chat ${Math.round(100 - split)}%`}
            tabIndex={0}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              event.preventDefault();
              drag.current = { pointerId: event.pointerId, start: split };
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }}
            onPointerMove={(event) => {
              if (drag.current?.pointerId === event.pointerId)
                resize(splitAt(event.clientX));
            }}
            onPointerUp={(event) => {
              if (drag.current?.pointerId !== event.pointerId) return;
              resize(splitAt(event.clientX), true);
              drag.current = undefined;
              setResizing(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              if (drag.current) resize(drag.current.start);
              drag.current = undefined;
              setResizing(false);
            }}
            onLostPointerCapture={() => {
              drag.current = undefined;
              setResizing(false);
            }}
            onDoubleClick={() => resize(50, true)}
            onKeyDown={(event) => {
              const value =
                event.key === "ArrowLeft"
                  ? split - (event.shiftKey ? 10 : 2)
                  : event.key === "ArrowRight"
                    ? split + (event.shiftKey ? 10 : 2)
                    : event.key === "Home"
                      ? 25
                      : event.key === "End"
                        ? 75
                        : undefined;
              if (value !== undefined) {
                event.preventDefault();
                resize(value, true);
              }
            }}
          />
          <section
            className="card chat shared-chat-panel"
            aria-label="Chat screen"
          >
            <iframe
              ref={frame}
              onLoad={() =>
                frame.current?.contentWindow?.postMessage(
                  { type: "ai-browser-request-connection" },
                  location.origin,
                )
              }
              title="AI Browser chat"
              src={src}
              className="shared-chat-frame"
              allow="clipboard-write"
            />
          </section>
        </div>
      </main>
    </WorkspaceGate>
  );
}
