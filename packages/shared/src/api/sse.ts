/**
 * Lightweight Server-Sent Events (SSE) client for React Native & Web.
 *
 * Uses XMLHttpRequest with `withCredentials = true` so the native cookie jar
 * replays session cookies (matching `client.ts`), and parses `data:` frames
 * incrementally from `onprogress` without external dependencies.
 */

export interface SseSubscription {
  close: () => void;
}

export function subscribeSSE(
  url: string,
  onData: (raw: string) => void,
  onError?: (err: unknown) => void,
): SseSubscription {
  let closed = false;
  let xhr: XMLHttpRequest | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const connect = () => {
    if (closed) return;
    if (typeof XMLHttpRequest === "undefined") return;

    const req = new XMLHttpRequest();
    xhr = req;
    let seen = 0;
    let buffer = "";

    req.open("GET", url, true);
    req.withCredentials = true;
    req.setRequestHeader("Accept", "text/event-stream");
    req.setRequestHeader("Cache-Control", "no-cache");

    req.onprogress = () => {
      if (closed) return;
      const chunk = req.responseText.slice(seen);
      seen = req.responseText.length;
      if (!chunk) return;

      buffer += chunk.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length > 0) {
          failures = 0;
          onData(dataLines.join("\n"));
        }
        boundary = buffer.indexOf("\n\n");
      }
    };

    const scheduleReconnect = (err?: unknown) => {
      if (closed) return;
      if (err) onError?.(err);
      const delay = Math.min(2000 * 2 ** failures, 30_000);
      failures += 1;
      retryTimer = setTimeout(connect, delay);
    };

    req.onerror = () => scheduleReconnect(new Error("SSE connection error"));
    req.onload = () => scheduleReconnect();
    req.send();
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (xhr) {
        xhr.onprogress = null;
        xhr.onerror = null;
        xhr.onload = null;
        xhr.abort();
        xhr = null;
      }
    },
  };
}
