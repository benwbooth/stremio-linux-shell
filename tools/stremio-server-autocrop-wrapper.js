#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const originalServerPath =
  process.env.STREMIO_ORIGINAL_SERVER_PATH || "/app/libexec/stremio/server.js";
const runtimeDir =
  process.env.XDG_RUNTIME_DIR ||
  (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "/tmp");
const eventLogPath =
  process.env.STREMIO_AUTOCROP_LOG ||
  path.join(runtimeDir, "stremio", "stremio-autocrop-events.log");
const injectionVersion = "2026-06-26.6";

function log(message) {
  console.log(`[stremio-autocrop] ${message}`);
}

function logEvent(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  log(message);
  try {
    fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
    fs.appendFileSync(eventLogPath, line);
  } catch (error) {
    log(`failed to write event log: ${error.message || error}`);
  }
}

function injectionScript() {
  const injectionVersionJson = JSON.stringify(injectionVersion);

  return `
<script>
(() => {
  const injectionVersion = ${injectionVersionJson};
  if (window.__stremioAutocropVersion === injectionVersion) return;
  window.__stremioAutocropInstalled = true;
  window.__stremioAutocropVersion = injectionVersion;

  const logUi = (event, detail) => {
    const params = new URLSearchParams({
      event,
      detail: detail || "",
      ts: String(Date.now()),
    });
    fetch("/stremio-autocrop-log?" + params.toString(), {
      cache: "no-store",
    }).catch(() => {});
  };

  const toast = (message) => {
    let node = document.getElementById("stremio-autocrop-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "stremio-autocrop-toast";
      node.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "padding:10px 12px",
        "border-radius:8px",
        "background:rgba(0,0,0,.82)",
        "color:#fff",
        "font:13px sans-serif",
        "pointer-events:none",
        "transition:opacity .2s ease",
      ].join(";");
      document.documentElement.appendChild(node);
    }

    node.textContent = message;
    node.style.opacity = "1";
    clearTimeout(window.__stremioAutocropToastTimer);
    window.__stremioAutocropToastTimer = setTimeout(() => {
      node.style.opacity = "0";
    }, 1800);
  };

  const installStyle = () => {
    let style = document.getElementById("stremio-autocrop-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "stremio-autocrop-style";
      (document.head || document.documentElement).appendChild(style);
    }
    style.dataset.version = injectionVersion;
    style.textContent = [
      "#stremio-autocrop-zone{position:fixed;top:6px;right:80px;z-index:2147483647;width:118px;height:54px;display:flex;align-items:center;justify-content:flex-end;pointer-events:none;}",
      "#stremio-autocrop-button{opacity:0;transform:translateY(-6px);transition:opacity .16s ease,transform .16s ease,background .16s ease,border-color .16s ease;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border:1px solid rgba(255,255,255,.28);border-radius:999px;background:rgba(8,10,14,.78);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);font:700 12px/1 sans-serif;letter-spacing:.02em;cursor:pointer;user-select:none;pointer-events:auto;}",
      "#stremio-autocrop-button:hover,#stremio-autocrop-button:focus-visible,#stremio-autocrop-button.stremio-autocrop-busy{opacity:1;transform:translateY(0);}",
      "#stremio-autocrop-button:hover{background:rgba(30,36,45,.88);border-color:rgba(255,255,255,.45);}",
      "#stremio-autocrop-button:active{transform:translateY(1px);}",
      "#stremio-autocrop-button.stremio-autocrop-busy{background:rgba(24,92,72,.88);}",
      "#stremio-autocrop-button .stremio-autocrop-glyph{position:relative;width:15px;height:15px;display:inline-block;flex:0 0 auto;}",
      "#stremio-autocrop-button .stremio-autocrop-glyph:before,#stremio-autocrop-button .stremio-autocrop-glyph:after{content:'';position:absolute;width:9px;height:9px;border:2px solid currentColor;}",
      "#stremio-autocrop-button .stremio-autocrop-glyph:before{left:0;top:0;border-right:0;border-bottom:0;}",
      "#stremio-autocrop-button .stremio-autocrop-glyph:after{right:0;bottom:0;border-left:0;border-top:0;}",
    ].join("\\n");
  };

  const setButtonLabel = (label, busy) => {
    const button = document.getElementById("stremio-autocrop-button");
    if (!button) return;

    const text = button.querySelector(".stremio-autocrop-label");
    if (text) text.textContent = label;
    button.classList.toggle("stremio-autocrop-busy", !!busy);
    clearTimeout(window.__stremioAutocropButtonTimer);

    if (busy) {
      window.__stremioAutocropButtonTimer = setTimeout(() => {
        setButtonLabel("Crop", false);
      }, 2200);
    }
  };

  const ensureButton = () => {
    installStyle();

    let zone = document.getElementById("stremio-autocrop-zone");
    if (!zone) {
      zone = document.createElement("div");
      zone.id = "stremio-autocrop-zone";
      (document.body || document.documentElement).appendChild(zone);
    }

    let button = document.getElementById("stremio-autocrop-button");
    if (!button) {
      button = document.createElement("button");
      button.id = "stremio-autocrop-button";
      button.type = "button";
      button.title = "Toggle mpv autocrop";
      button.setAttribute("aria-label", "Toggle mpv autocrop");
      button.innerHTML = '<span class="stremio-autocrop-glyph" aria-hidden="true"></span><span class="stremio-autocrop-label">Crop</span>';
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }, true);
    }

    if (button.parentElement !== zone) {
      zone.appendChild(button);
    }

    return button;
  };

  const installIpcLogger = () => {
    if (window.__stremioAutocropIpcLoggerInstalled) return;
    if (!window.ipc || typeof window.ipc.addEventListener !== "function") return;

    window.__stremioAutocropIpcLoggerInstalled = true;
    window.ipc.addEventListener("message", (event) => {
      let payload = event && event.data;
      let detail = "";

      try {
        const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
        const args = parsed && parsed.args;
        if (Array.isArray(args) && args[0] === "mpv-prop-change") {
          const prop = args[1] || {};
          detail = String(prop.name || "") + "=" + JSON.stringify(prop.data).slice(0, 120);
          logUi("mpv-prop", detail);
          return;
        }
      } catch (_) {}

      detail = String(payload || "").slice(0, 160);
      if (detail.includes("mpv")) logUi("ipc-message", detail);
    });
  };

  const postIpc = (method, data, notify) => {
    if (!window.ipc || typeof window.ipc.postMessage !== "function") {
      if (notify) {
        toast("Autocrop: IPC bridge not ready");
        setButtonLabel("No IPC", true);
        logUi("ipc-missing", method);
      }
      return false;
    }

    installIpcLogger();

    try {
      window.ipc.postMessage(JSON.stringify({
        id: Date.now(),
        type: 6,
        args: [method, data],
      }));
      if (notify) {
        const detail = method + ":" + JSON.stringify(data).slice(0, 140);
        logUi("ipc-send", detail);
      }
      return true;
    } catch (error) {
      if (notify) {
        const message = error && error.message ? error.message : String(error);
        toast("Autocrop: IPC send failed");
        setButtonLabel("IPC error", true);
        logUi("ipc-error", message.slice(0, 120));
      }
      return false;
    }
  };

  const toggle = () => {
    const ipcReady = !!(window.ipc && typeof window.ipc.postMessage === "function");
    logUi("click", (ipcReady ? "ipc=ready" : "ipc=missing") + " version=" + injectionVersion);
    setButtonLabel("Crop...", true);
    toast("Autocrop: button clicked");
    installIpcLogger();
    postIpc("toggle-crop", null, true);
  };

  window.stremioAutocropToggle = toggle;
  ensureButton();
  logUi("loaded", "version=" + injectionVersion);
  window.addEventListener("DOMContentLoaded", ensureButton, { once: true });
  setInterval(ensureButton, 2000);
})();
</script>`;
}

const injection = injectionScript();
const marker = "window.__stremioAutocropInstalled";

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }

  return undefined;
}

function deleteHeader(headers, name) {
  if (!headers) return;
  const lowerName = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) delete headers[key];
  }
}

function deleteResponseHeader(res, headers, name) {
  deleteHeader(headers, name);
  if (typeof res.removeHeader === "function") {
    res.removeHeader(name);
  }
}

function getWriteHeadHeaders(args) {
  if (typeof args[1] === "string") {
    args[2] = args[2] || {};
    return args[2];
  }

  args[1] = args[1] || {};
  return args[1];
}

function isHtmlResponse(statusCode, headers) {
  const contentType = String(getHeader(headers, "content-type") || "").toLowerCase();
  return statusCode >= 200 && statusCode < 300 && contentType.includes("text/html");
}

function shouldInspectRequest(req) {
  return req.method === "GET" && String(req.url || "").startsWith("/proxy/");
}

function injectHtml(html) {
  if (html.includes(marker)) return html;
  if (html.includes("</head>")) return html.replace("</head>", `${injection}</head>`);
  if (html.includes("</body>")) return html.replace("</body>", `${injection}</body>`);
  return `${html}${injection}`;
}

function wrapResponse(req, res) {
  if (!shouldInspectRequest(req)) return res;

  const originalWriteHead = res.writeHead;
  const originalWrite = res.write;
  const originalEnd = res.end;
  const chunks = [];
  let capture = false;
  let wroteHead = false;
  let writeHeadArgs = null;

  res.writeHead = function writeHead(statusCode, ...args) {
    wroteHead = true;
    writeHeadArgs = [statusCode, ...args];
    const headers = getWriteHeadHeaders(writeHeadArgs);

    if (isHtmlResponse(statusCode, headers)) {
      capture = true;
      headers["cache-control"] = "no-store, no-cache, must-revalidate, max-age=0";
      headers.pragma = "no-cache";
      headers.expires = "0";
      deleteResponseHeader(res, headers, "content-length");
      deleteResponseHeader(res, headers, "etag");
      deleteResponseHeader(res, headers, "accept-ranges");
      deleteResponseHeader(res, headers, "content-security-policy");
      deleteResponseHeader(res, headers, "content-security-policy-report-only");
      return res;
    }

    return originalWriteHead.apply(res, writeHeadArgs);
  };

  res.write = function write(chunk, encoding, callback) {
    if (!capture) return originalWrite.apply(res, arguments);
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }
    if (typeof encoding === "function") process.nextTick(encoding);
    if (typeof callback === "function") process.nextTick(callback);
    return true;
  };

  res.end = function end(chunk, encoding, callback) {
    if (!capture) return originalEnd.apply(res, arguments);
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }

    const body = injectHtml(Buffer.concat(chunks).toString("utf8"));

    if (!wroteHead) {
      writeHeadArgs = [200, { "content-type": "text/html; charset=utf-8" }];
    }
    originalWriteHead.apply(res, writeHeadArgs);

    if (typeof encoding === "function") callback = encoding;
    return originalEnd.call(res, Buffer.from(body, "utf8"), callback);
  };

  return res;
}

function handleAutocropLog(req, res) {
  if (!String(req.url || "").startsWith("/stremio-autocrop-log")) {
    return false;
  }

  logEvent(`ui ${req.url}`);
  res.writeHead(204, {
    "cache-control": "no-store",
  });
  res.end();
  return true;
}

function wrapListener(listener) {
  return function autocropListener(req, res) {
    if (handleAutocropLog(req, res)) return;
    return listener.call(this, req, wrapResponse(req, res));
  };
}

function patchCreateServer(module) {
  const originalCreateServer = module.createServer;

  module.createServer = function createServer(...args) {
    const listenerIndex =
      typeof args[0] === "function" ? 0 : typeof args[1] === "function" ? 1 : -1;

    if (listenerIndex >= 0) {
      args[listenerIndex] = wrapListener(args[listenerIndex]);
    }

    return originalCreateServer.apply(this, args);
  };
}

log(`event log at ${eventLogPath}`);
patchCreateServer(http);
patchCreateServer(https);
log(`loading original server from ${originalServerPath}`);
require(originalServerPath);
