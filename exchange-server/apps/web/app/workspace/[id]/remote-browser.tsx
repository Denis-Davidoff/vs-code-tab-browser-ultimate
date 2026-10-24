"use client";
import { workspaceExchangeSocket } from "../../../../../../src/core/exchangeCrypto";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { createPreviewVideo, supportsPreviewVideo } from "../../components/preview-video";
import { createPreviewScrollQueue } from "../../components/preview-scroll";
import { Icon } from "../../components/ui";
import {
  clampPreviewZoom,
  previewPoint,
  previewZoomScroll,
} from "../../components/preview-zoom";

type Tab = { id: string; title: string; url: string; kind?: "chrome" | "vscode" };
type Frame = { tabId: string; data: string; width: number; height: number };
const keys = new Set([
  "Backspace",
  "Tab",
  "Enter",
  "Escape",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
export function RemoteBrowser({
  pointId,
  active,
  onShowChat,
}: {
  pointId: string;
  active: boolean;
  onShowChat: () => void;
}) {
  const socket = useRef<WebSocket | null>(null),
    image = useRef<HTMLCanvasElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null);
  const videoDecoder = useRef<ReturnType<typeof createPreviewVideo> | null>(null);
  const videoSupported = useRef(false), relayVideo = useRef(false), videoFailed = useRef(false);
  const [streamCodec, setStreamCodec] = useState("");
  function watchBrowser() {
    const ws = socket.current;
    if (!ready.current || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "browser.watch", active: activeRef.current && !document.hidden,
      ...(videoSupported.current && relayVideo.current ? { video: "h264" } : {}) }));
  }
  const selectedRef = useRef<string | null>(null),
    activeRef = useRef(active),
    ready = useRef(false);
  const [connecting, setConnecting] = useState(true);
  const [online, setOnline] = useState(false),
    [tabs, setTabs] = useState<Tab[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null),
    [error, setError] = useState(""),
    [address, setAddress] = useState(""),
    [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitView, setFitView] = useState(false);
  const fitRef = useRef(false);
  const zoomRef = useRef(1);
  const commands = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const commandDone = useRef(new Map<string, (ok: boolean) => void>());
  const scrollQueue = useRef<ReturnType<
    typeof createPreviewScrollQueue
  > | null>(null);
  if (!scrollQueue.current)
    scrollQueue.current = createPreviewScrollQueue((value, done) => {
      if (!selectedRef.current) return false;
      return !!command(
        "input",
        { tabId: selectedRef.current, input: value },
        done,
      );
    });
  const frameRef = useRef<Frame | null>(null),
    lastUrl = useRef("");
  const editingAddress = useRef(false);
  // True once the viewer has typed into the field since it last showed the page's address.
  const addressDirty = useRef(false);
  const touch = useRef<{
      x: number;
      y: number;
      left: number;
      top: number;
      panned: boolean;
      lastX: number;
      lastY: number;
    } | null>(null),
    ignoreClickUntil = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const node = viewport.current,
      content = stage.current;
    const next = clampPreviewZoom(value);
    if (next !== zoomRef.current) scrollQueue.current?.reset();
    if (!node || !content) {
      zoomRef.current = next;
      setZoom(next);
      return;
    }
    const previous = zoomRef.current,
      rect = node.getBoundingClientRect();
    const x =
      clientX === undefined ? node.clientWidth / 2 : clientX - rect.left;
    const y =
      clientY === undefined ? node.clientHeight / 2 : clientY - rect.top;
    const left = previewZoomScroll(node.scrollLeft, x, previous, next),
      top = previewZoomScroll(node.scrollTop, y, previous, next);
    zoomRef.current = next;
    content.style.width = `${next * 100}%`;
    content.style.height = `${next * 100}%`;
    node.scrollLeft = next === 1 ? 0 : left;
    node.scrollTop = next === 1 ? 0 : top;
    setZoom(next);
  }
  useEffect(() => {
    changeZoom(1);
    scrollQueue.current?.reset();
    pointers.current.clear();
    pinch.current = null;
    touch.current = null;
  }, [selected]);
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || !frameRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointers.current.size === 1)
      touch.current = {
        x: event.clientX,
        y: event.clientY,
        left: event.currentTarget.scrollLeft,
        top: event.currentTarget.scrollTop,
        panned: false,
        lastX: event.clientX,
        lastY: event.clientY,
      };
    if (pointers.current.size === 2) {
      scrollQueue.current?.reset();
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
      touch.current = null;
      ignoreClickUntil.current = Date.now() + 700;
    }
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse") hover(event.clientX, event.clientY);
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()],
        distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current && distance)
        changeZoom(
          (zoomRef.current * distance) / pinch.current,
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
        );
      pinch.current = distance;
      ignoreClickUntil.current = Date.now() + 700;
      return;
    }
    const start = touch.current;
    if (start && zoomRef.current === 1) {
      const dx = start.x - event.clientX,
        dy = start.y - event.clientY;
      // Keep the existing horizontal swipe to return to chat on a phone.
      const chatSwipe =
        !start.panned &&
        dx < 0 &&
        Math.abs(dx) > Math.abs(dy) * 1.5 &&
        matchMedia("(max-width: 760px)").matches;
      if (!chatSwipe && (start.panned || Math.hypot(dx, dy) > 6)) {
        const p = point(start.x, start.y),
          img = image.current;
        if (p && img) {
          const rect = img.getBoundingClientRect(),
            size = frameRef.current;
          if (size) {
            const scale = Math.min(
              rect.width / size.width,
              rect.height / size.height,
            );
            const dy = start.lastY - event.clientY;
            const rest = dy - scrollPreview(event.currentTarget, dy);
            if (start.lastX !== event.clientX || rest)
              scrollQueue.current?.enqueue(
                p.x,
                p.y,
                (start.lastX - event.clientX) / scale,
                rest / scale,
              );
          }
        }
        start.panned = true;
        ignoreClickUntil.current = Date.now() + 700;
      }
      start.lastX = event.clientX;
      start.lastY = event.clientY;
    }
    if (start && zoomRef.current > 1) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6)
        start.panned = true;
      event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
      event.currentTarget.scrollTop = start.top + start.y - event.clientY;
      if (start.panned) ignoreClickUntil.current = Date.now() + 700;
    }
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pinch.current !== null) {
      pinch.current = null;
      touch.current = null;
      ignoreClickUntil.current = Date.now() + 700;
      return;
    }
    const start = touch.current;
    touch.current = null;
    if (!start || start.panned) return;
    const dx = start.x - event.clientX,
      dy = start.y - event.clientY;
    if (Math.hypot(dx, dy) < 12) return;
    ignoreClickUntil.current = Date.now() + 700;
    if (
      Math.abs(dx) > 70 &&
      Math.abs(dx) > Math.abs(dy) &&
      dx < 0 &&
      matchMedia("(max-width: 760px)").matches
    ) {
      onShowChat();
      return;
    }
  }

  function command(
    action: string,
    extra: Record<string, unknown> = {},
    done?: (ok: boolean) => void,
  ) {
    const ws = socket.current;
    if (!ready.current || ws?.readyState !== WebSocket.OPEN) {
      setError("Connect your VS Code workspace to use the browser.");
      return;
    }
    if (commands.current.size >= 32) {
      setError("Wait for pending browser actions.");
      return;
    }
    setError("");
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      commands.current.delete(id);
      commandDone.current.delete(id);
      done?.(false);
      setPending(false);
      setError("Browser action timed out. Check the page before trying again.");
    }, 16000);
    commands.current.set(id, timer);
    if (done) commandDone.current.set(id, done);
    ws.send(JSON.stringify({ type: "browser.command", id, action, ...extra }));
    return id;
  }
  /** Pointer moves for the page's hover and the pickers' highlight: at most one in flight, ~8 a second. */
  const lastMove = useRef(0);
  function hover(clientX: number, clientY: number) {
    const now = Date.now();
    if (now - lastMove.current < 120 || commands.current.size > 2) return;
    const ws = socket.current;
    if (!ready.current || ws?.readyState !== WebSocket.OPEN) return;
    const p = point(clientX, clientY);
    if (!p || !frameRef.current || !selectedRef.current) return;
    lastMove.current = now;
    input({ action: "move", ...p });
  }
  /** Lays the remote page out at this preview's size, so it fills it with no bars. */
  function sendFit() {
    const box = viewport.current;
    if (!fitRef.current || !box) return;
    const clamp = (n: number) => Math.max(200, Math.min(4096, Math.round(n)));
    input({ action: "fit", width: clamp(box.clientWidth), height: clamp(box.clientHeight) });
  }
  function toggleFit() {
    const next = !fitRef.current;
    fitRef.current = next;
    setFitView(next);
    if (next) sendFit();
    else input({ action: "unfit" });
  }
  useEffect(() => {
    const box = viewport.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(sendFit, 300);
    });
    observer.observe(box);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, []);
  /** Scrolls the preview box itself by up to `dy`; answers how much it moved. */
  function scrollPreview(box: HTMLElement, dy: number): number {
    const before = box.scrollTop,
      max = Math.max(0, box.scrollHeight - box.clientHeight),
      next = Math.max(0, Math.min(max, before + dy));
    box.scrollTop = next;
    return next - before;
  }
  function input(value: Record<string, unknown>) {
    if (selectedRef.current)
      command("input", { tabId: selectedRef.current, input: value });
  }
  function point(clientX: number, clientY: number) {
    const img = image.current;
    if (!img || !frameRef.current) return;
    return previewPoint(
      clientX,
      clientY,
      img.getBoundingClientRect(),
      img.width,
      img.height,
    );
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !selectedRef.current ||
      !frameRef.current ||
      event.nativeEvent.isComposing
    )
      return;
    if (
      (event.ctrlKey || event.metaKey) &&
      ["+", "=", "-", "0"].includes(event.key)
    ) {
      event.preventDefault();
      changeZoom(
        event.key === "0"
          ? 1
          : zoomRef.current * (event.key === "-" ? 1 / 1.2 : 1.2),
      );
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      ["r", "l", "t", "w"].includes(event.key.toLowerCase())
    )
      return;
    const modifiers =
      (event.altKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.metaKey ? 4 : 0) |
      (event.shiftKey ? 8 : 0);
    if (
      keys.has(event.key) ||
      ((event.ctrlKey || event.metaKey) &&
        ["a", "c", "v", "x", "z", "y"].includes(event.key.toLowerCase()))
    ) {
      if (event.key.toLowerCase() === "v") return;
      event.preventDefault();
      input({
        action: "key",
        key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
        modifiers,
      });
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      input({ action: "text", text: event.key });
    }
  }
  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      scrollQueue.current?.reset();
      videoDecoder.current?.reset();
    }
    watchBrowser();
  }, [active]);
  useEffect(() => {
    let stopped = false, accessDenied = false;
    videoFailed.current = false; videoSupported.current = false; relayVideo.current = false;
    videoDecoder.current = createPreviewVideo(() => image.current, value => {
      if (value.tabId !== selectedRef.current || !activeRef.current || document.hidden) return;
      frameRef.current = value; setFrame(value);
      setStreamCodec("codec" in value ? "H.264" : "JPEG");
    }, () => { videoFailed.current = true; videoSupported.current = false; watchBrowser(); });
    void supportsPreviewVideo().then(supported => {
      if (!stopped) { videoSupported.current = supported && !videoFailed.current; watchBrowser(); }
    });
    let handshake: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const clearCommands = () => {
      scrollQueue.current?.reset();
      commandDone.current.clear();
      for (const timer of commands.current.values()) clearTimeout(timer);
      commands.current.clear();
      setPending(false);
    };
    function connect() {
      if (stopped) return;
      clearTimeout(retry);
      clearTimeout(handshake);
      setConnecting(true);
      setError("");
      const base =
        process.env.NEXT_PUBLIC_EXCHANGE_WS_URL ??
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
      const ws = (socket.current = workspaceExchangeSocket(
        base + "/ws/stream-browser",
        pointId,
      ));
      handshake = setTimeout(() => { if (ws === socket.current) ws.close(); }, 10000);
      ws.onopen = () => {
        if (ws !== socket.current || stopped) return;
        ws.send(JSON.stringify({ type: "auth", version: 1, pointId }));
      };
      ws.onmessage = (event) => {
        if (ws !== socket.current || stopped) return;
        try {
          const value = JSON.parse(event.data);
          if (value.type === "ready") {
            clearTimeout(handshake);
            setConnecting(false);
            ready.current = true;
            relayVideo.current = Array.isArray(value.features) && value.features.includes("h264");
            setError("");
            setOnline(value.online);
            watchBrowser();
          } else if (value.type === "browser.presence") {
            setError("");
            setOnline(value.online);
            if (!value.online) {
              setFrame(null);
              videoDecoder.current?.reset();
              frameRef.current = null;
              setTabs([]);
              selectedRef.current = null;
              setSelected(null);
              clearCommands();
            }
          } else if (value.type === "browser.viewers") {
            setViewerCount(Number.isSafeInteger(value.count) && value.count >= 0 ? value.count : 0);
          } else if (value.type === "browser.state") {
            setTabs(value.tabs);
            if (value.error) setError(value.error);
            const changedTab = selectedRef.current !== value.selected;
            if (changedTab) {
              // The extension puts the previous tab back; fitting is chosen per tab.
              fitRef.current = false;
              setFitView(false);
              setFrame(null);
              videoDecoder.current?.reset();
              frameRef.current = null;
            }
            selectedRef.current = value.selected;
            setSelected(value.selected);
            const tab = value.tabs.find((t: Tab) => t.id === value.selected);
            if (tab && (changedTab || tab.url !== lastUrl.current)) {
              lastUrl.current = tab.url;
              // Polling must not replace a URL while the viewer is typing it;
              // onBlur shows the latest one if it moved on meanwhile.
              if (changedTab || !editingAddress.current) {
                addressDirty.current = false;
                setAddress(tab.url);
              }
            }
          } else if (value.type === "browser.frame" || value.type === "browser.video") {
            if (
              value.tabId !== selectedRef.current ||
              !activeRef.current ||
              document.hidden
            )
              return;
            if (value.type === "browser.video") { if (videoSupported.current) videoDecoder.current?.video(value); }
            else void videoDecoder.current?.jpeg(value);
          } else if (value.type === "browser.result") {
            const timer = commands.current.get(value.id);
            if (timer) {
              clearTimeout(timer);
              commands.current.delete(value.id);
            }
            const done = commandDone.current.get(value.id);
            commandDone.current.delete(value.id);
            done?.(value.ok === true);
            setPending(false);
            if (!value.ok) setError(value.error ?? "Browser action failed");
          } else if (value.type === "browser.error") setError(value.error);
        } catch {
          setError("Invalid browser response.");
        }
      };
      ws.onclose = (event) => {
        if (ws !== socket.current || stopped) return;
        clearTimeout(handshake);
        accessDenied = event.code === 4001 || event.code === 1008;
        setConnecting(!accessDenied);
        ready.current = false;
        setViewerCount(0);
        setOnline(false);
        setFrame(null);
        videoDecoder.current?.reset();
        frameRef.current = null;
        clearCommands();
        if (event.code === 4001 || event.code === 1008)
          setError(
            "Browser access expired. Sign in again or check your connection.",
          );
        else retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => {
        if (ws === socket.current && !stopped)
          ws.close();
      };
    }
    const resume = () => {
      if (document.hidden || stopped || accessDenied || socket.current?.readyState === WebSocket.CONNECTING) return;
      const previous = socket.current;
      socket.current = null;
      previous?.close();
      ready.current = false;
      setOnline(false);
      setViewerCount(0);
      clearCommands();
      connect();
    };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    const visibility = () => {
      if (document.hidden) {
        scrollQueue.current?.reset();
        videoDecoder.current?.reset();
      }
      if (!document.hidden) { resume(); return; }
      const ws = socket.current;
      if (ws) watchBrowser();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", resume);
    window.addEventListener("pageshow", pageShow);
    connect();
    return () => {
      stopped = true;
      ready.current = false;
      clearTimeout(retry);
      clearTimeout(handshake);
      clearCommands();
      socket.current?.close();
      videoDecoder.current?.dispose(); videoDecoder.current = null;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", pageShow);
    };
  }, [pointId]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!frameRef.current) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        changeZoom(
          zoomRef.current * Math.exp(-event.deltaY * 0.01),
          event.clientX,
          event.clientY,
        );
        return;
      }
      if (zoomRef.current > 1) return;
      const p = point(event.clientX, event.clientY);
      if (!p || !frameRef.current) return;
      event.preventDefault();
      const scale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? node.clientHeight
            : 1;
      // At full width the preview can be taller than its box: show the rest of it
      // first, then scroll the page itself.
      const deltaY = event.deltaY * scale - scrollPreview(node, event.deltaY * scale);
      if (!event.deltaX && !deltaY) return;
      scrollQueue.current?.enqueue(p.x, p.y, event.deltaX * scale, deltaY);
    };
    let gestureZoom = 1;
    const gestureStart = (event: Event) => {
      if (!frameRef.current) return;
      event.preventDefault();
      gestureZoom = zoomRef.current;
      ignoreClickUntil.current = Date.now() + 700;
    };
    const gestureChange = (event: Event) => {
      if (!frameRef.current) return;
      ignoreClickUntil.current = Date.now() + 700;
      event.preventDefault();
      if (pointers.current.size >= 2) return;
      const gesture = event as Event & {
        scale?: number;
        clientX?: number;
        clientY?: number;
      };
      if (gesture.scale)
        changeZoom(
          gestureZoom * gesture.scale,
          gesture.clientX,
          gesture.clientY,
        );
    };
    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("gesturestart", gestureStart, { passive: false });
    node.addEventListener("gesturechange", gestureChange, { passive: false });
    const gestureEnd = () => {
      ignoreClickUntil.current = Date.now() + 700;
    };
    node.addEventListener("gestureend", gestureEnd);
    return () => {
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("gesturestart", gestureStart);
      node.removeEventListener("gesturechange", gestureChange);
      node.removeEventListener("gestureend", gestureEnd);
    };
  }, []);
  return (
    <aside
      className="card preview-panel remote-browser-panel"
      aria-label="Browser screen"
    >
      <div className="remote-browser-controls">
        {frame && <span className="remote-stream-codec" title="Current preview codec">{streamCodec}</span>}
        <span className="remote-viewer-count" title="Active viewers of the selected tab" aria-label={`${selected ? viewerCount : 0} active viewers`}>
          <Icon name="eye" size={14} /> {selected ? viewerCount : 0}
        </span>
        <span
          className={`remote-browser-icon${online ? " online" : ""}`}
          title={online ? pending ? "Waiting for browser…" : "Browser connected" : "Waiting for browser connection…"}
          role="img"
          aria-label={online ? pending ? "Waiting for browser…" : "Browser connected" : "Waiting for browser connection…"}
        >
          {!online || pending ? <span className="liquid-loader" aria-hidden="true" /> : <Icon name="globe" size={15} />}
        </span>
        <select
          aria-label="Remote browser tab"
          value={selected ?? ""}
          disabled={!online || pending}
          onChange={(event) => {
            setPending(true);
            setError("");
            setFrame(null);
            videoDecoder.current?.reset();
            frameRef.current = null;
            command("select", { tabId: event.target.value });
          }}
        >
          <option value="" disabled>
            Select a tab
          </option>
          {tabs.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {tab.kind === "chrome" ? "Chrome · " : "VS Code · "}
              {tab.title || tab.url}
            </option>
          ))}
        </select>
        <button
          type="button"
          title="Close selected browser tab in VS Code"
          aria-label="Close selected browser tab in VS Code"
          disabled={!selected}
          onClick={() => {
            scrollQueue.current?.reset();
            input({ action: "close" });
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <form
        className="remote-browser-address"
        onSubmit={(event) => {
          event.preventDefault();
          const url = address.trim();
          if (!url) return;
          editingAddress.current = false;
          addressDirty.current = false;
          input({
            action: "navigate",
            url: /^https?:\/\//i.test(url) ? url : "https://" + url,
          });
        }}
      >
        <button
          type="button"
          title="Back"
          aria-label="Back"
          disabled={!selected}
          onClick={() => input({ action: "back" })}
        >
          ←
        </button>
        <button
          type="button"
          title="Forward"
          aria-label="Forward"
          disabled={!selected}
          onClick={() => input({ action: "forward" })}
        >
          →
        </button>
        <button
          type="button"
          title="Reload"
          aria-label="Reload"
          disabled={!selected}
          onClick={() => input({ action: "reload" })}
        >
          ↻
        </button>
        <input
          aria-label="Remote page address"
          placeholder="https://… or http://localhost:…"
          value={address}
          disabled={!selected}
          onFocus={() => { editingAddress.current = true; }}
          onBlur={() => {
            editingAddress.current = false;
            // The page may have moved on while the field was focused; an
            // untouched field follows it, a draft the viewer typed stays.
            if (!addressDirty.current) setAddress(lastUrl.current);
          }}
          onChange={(event) => {
            // Typing after Enter, with focus never having left the field, is editing too.
            editingAddress.current = true;
            addressDirty.current = true;
            setAddress(event.target.value);
          }}
        />
        <button type="submit" disabled={!selected || !address.trim()} aria-label="Go to address" title="Go to address">
          →
        </button>
        <div
          className="remote-browser-zoom"
          role="group"
          aria-label="Preview zoom"
        >
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={!frame || zoom <= 1}
            onClick={() => changeZoom(zoomRef.current / 1.2)}
          >
            −
          </button>
          <button
            type="button"
            className="remote-browser-zoom-value"
            aria-label="Reset preview zoom"
            title="Full width · pinch or Ctrl/⌘ + wheel to zoom"
            disabled={!frame}
            onClick={() => changeZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={!frame || zoom >= 4}
            onClick={() => changeZoom(zoomRef.current * 1.2)}
          >
            +
          </button>
          <button
            type="button"
            className={fitView ? "remote-browser-fit active" : "remote-browser-fit"}
            aria-pressed={fitView}
            aria-label="Fit page to my view"
            title={fitView ? "Page is laid out at this view's size · click to restore its size in VS Code" : "Fit to my view: lay the page out at this view's size (changes the tab in VS Code while you watch)"}
            disabled={!selected}
            onClick={toggleFit}
          >
            ⤢
          </button>
        </div>
      </form>
      <div className="remote-browser-content">
        {error && (
          <div className="remote-browser-error" role="status">
            {error}
            <button
              type="button"
              aria-label="Dismiss browser error"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
        <div
          ref={viewport}
          className="remote-browser-viewport"
          tabIndex={frame ? 0 : -1}
          role="group"
          aria-label="Remote page. Click to interact; type to enter text."
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={(event) => {
            pointers.current.delete(event.pointerId);
            pinch.current = null;
            touch.current = null;
            ignoreClickUntil.current = Date.now() + 700;
          }}
          onKeyDown={keyboard}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text/plain");
            if (text) {
              event.preventDefault();
              input({ action: "text", text: text.slice(0, 4000) });
            }
          }}
          onClick={(event) => {
            if (Date.now() < ignoreClickUntil.current) return;
            const p = point(event.clientX, event.clientY);
            if (frame && p) {
              event.currentTarget.focus();
              input({
                action: "click",
                ...p,
                button: "left",
                count: event.detail === 2 ? 2 : 1,
              });
            }
          }}
          onContextMenu={(event) => {
            const p = point(event.clientX, event.clientY);
            if (frame && p) {
              event.preventDefault();
              input({ action: "click", ...p, button: "right", count: 1 });
            }
          }}
        >
          <>
            <div
              hidden={!frame}
              ref={stage}
              className="remote-browser-stage"
              style={{ width: `${zoom * 100}%` }}
            >
              <canvas
                ref={image}
                role="img"
                aria-label="Live view of the selected VS Code browser tab"
              />
            </div>
          </>
          {!frame && (
            <div className="preview-placeholder">
              <div className="preview-symbol">
                {selected || connecting ? <span className="liquid-loader" style={{ "--liquid-size": "36px" } as React.CSSProperties} aria-hidden="true" /> : <Icon name="globe" size={26} />}
              </div>
              <h3>
                {connecting ? "Connecting…" : selected
                  ? "Connecting to your tab…"
                  : "Your browser, remotely"}
              </h3>
              <p>
                {connecting ? "Reconnecting to the remote browser…" : online
                  ? "Select an open VS Code browser tab to view and control it here."
                  : "The extension browser channel is offline. Install the updated extension, reload VS Code and reconnect its server connection."}
              </p>
            </div>
          )}
        </div>
      </div>
      <form
        className="remote-browser-text"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) {
            input({ action: "text", text });
            setText("");
            viewport.current?.focus();
          }
        }}
      >
        <input
          aria-label="Text to type into the remote page"
          placeholder="Type into the focused page field…"
          disabled={!frame}
          value={text}
          maxLength={4000}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          disabled={!frame || !text}
          title="Type text into page"
          aria-label="Type text into page"
        >
          <Icon name="send" size={14} />
        </button>
      </form>
      <div className="preview-footer">
        <Icon name="terminal" size={13} />
        <span>Live view · input runs on your computer</span>
      </div>
    </aside>
  );
}
