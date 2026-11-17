(() => {
  "use strict";

  const script = document.currentScript;
  const parentOrigin = script && script.getAttribute("data-parent-origin");
  const allowedHosts = (script && script.getAttribute("data-allowed-hosts") || "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!parentOrigin || parentOrigin === "null" || window.parent === window) return;
  let parsedParent;
  try {
    parsedParent = new URL(parentOrigin);
  } catch {
    return;
  }
  if ((parsedParent.protocol !== "https:" && parsedParent.protocol !== "http:")
    || parsedParent.origin !== parentOrigin
    || !allowedHosts.includes(location.hostname.toLowerCase())) return;

  const protocol = "spotcheck-dom";
  const version = 2;
  const selectorLimit = 1200;
  const pinLimit = 500;
  const candidateLimit = 12;
  let nonce = "";
  let inspectionMode = "off";
  let pins = [];
  let hoverTarget = null;
  let containerSelector = "";
  let currentCandidates = [];
  let lastHoverSignature = "";
  let frame = 0;
  let resizeObserver = null;
  let mutationObserver = null;
  let inspectedListeners = false;
  const outline = document.createElement("div");
  outline.setAttribute("aria-hidden", "true");
  Object.assign(outline.style, {
    all: "initial",
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    boxSizing: "border-box",
    border: "2px solid #f59e0b",
    background: "rgba(245, 158, 11, .08)",
    display: "none",
  });
  (document.documentElement || document).appendChild(outline);

  const send = (type, payload) => {
    if (!nonce) return;
    window.parent.postMessage({
      protocol,
      version,
      nonce,
      type,
      ...payload,
    }, parentOrigin);
  };
  const validEnvelope = (message) => message && typeof message === "object"
    && !Array.isArray(message)
    && message.protocol === protocol && message.version === version
    && typeof message.nonce === "string" && message.nonce.length >= 16 && message.nonce.length <= 128;
  const uniqueSelector = (element) => {
    if (!(element instanceof Element) || !element.isConnected) return "";
    if (element.id) {
      const byId = `#${CSS.escape(element.id)}`;
      try {
        if (document.querySelectorAll(byId).length === 1) return byId;
      } catch {
        return "";
      }
    }
    const parts = [];
    let node = element;
    while (node && node !== document.documentElement && parts.length < 20) {
      let part = node.localName;
      if (!part || !/^[a-z][a-z0-9-]*$/i.test(part)) return "";
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const selector = parts.join(" > ");
      try {
        if (selector.length > selectorLimit) return "";
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch {
        return "";
      }
      node = parent;
    }
    return "";
  };
  const isEligibleElement = (element) => element instanceof Element
    && element !== document.body
    && element !== document.documentElement
    && !outline.contains(element)
    && element.isConnected
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden";
  const candidateLabel = (element) => `${element.localName}${element.id ? `#${element.id}` : ""}`.slice(0, 160);
  const makeCandidate = (element) => {
    if (!isEligibleElement(element)) return null;
    const selector = uniqueSelector(element);
    if (!selector) return null;
    const rect = element.getBoundingClientRect();
    return {
      element,
      selector,
      label: candidateLabel(element),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  };
  const getCandidates = (target, mode) => {
    const element = target instanceof Element ? target : target && target.parentElement;
    if (!element || mode === "free" || mode === "off") return [];
    if (mode === "element") {
      const candidate = makeCandidate(element);
      return candidate ? [candidate] : [];
    }
    const candidates = [];
    const seen = new Set();
    let node = element;
    while (node && node !== document.body && node !== document.documentElement && candidates.length < candidateLimit) {
      const candidate = makeCandidate(node);
      if (candidate && candidate.rect.width >= 24 && candidate.rect.height >= 16 && !seen.has(candidate.selector)) {
        seen.add(candidate.selector);
        candidates.push(candidate);
      }
      node = node.parentElement;
    }
    return candidates;
  };
  const activeCandidate = (candidates, mode) => {
    if (mode === "container" && candidates.some((candidate) => candidate.selector === containerSelector)) {
      return candidates.find((candidate) => candidate.selector === containerSelector);
    }
    const first = candidates[0] || null;
    containerSelector = mode === "container" && first ? first.selector : "";
    return first;
  };
  const displayOutline = (element) => {
    if (!element || !element.isConnected) {
      outline.style.display = "none";
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(outline.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      display: "block",
    });
  };
  const move = (event) => {
    if (inspectionMode !== "element" && inspectionMode !== "container") return;
    const candidates = getCandidates(event.target, inspectionMode);
    const selected = activeCandidate(candidates, inspectionMode);
    if (!selected) {
      currentCandidates = [];
      hoverTarget = null;
      lastHoverSignature = "";
      outline.style.display = "none";
      send("hover", { mode: inspectionMode, candidates: [], selectedSelector: "" });
      return;
    }
    currentCandidates = candidates;
    hoverTarget = selected.element;
    displayOutline(hoverTarget);
    const selectedSelector = selected.selector;
    const signature = `${inspectionMode}:${selectedSelector}:${candidates.map((candidate) => candidate.selector).join("|")}`;
    if (signature !== lastHoverSignature) {
      lastHoverSignature = signature;
      send("hover", {
        mode: inspectionMode,
        candidates: candidates.map(({ selector, label, rect }) => ({ selector, label, rect })),
        selectedSelector,
      });
    }
  };
  const select = (event) => {
    if (inspectionMode === "off") return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    if (inspectionMode === "free") {
      send("point", {
        href: location.href,
        pointX: event.clientX,
        pointY: event.clientY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      });
      return;
    }
    const candidates = getCandidates(event.target, inspectionMode);
    const candidate = activeCandidate(candidates, inspectionMode) || (hoverTarget ? makeCandidate(hoverTarget) : null);
    if (!candidate) return;
    const { element, selector } = candidate;
    const rect = element.getBoundingClientRect();
    send("selected", {
      mode: inspectionMode,
      href: location.href,
      anchor: {
        selector,
        offsetX: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(rect.width, 1))),
        offsetY: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(rect.height, 1))),
      },
      pointX: event.clientX,
      pointY: event.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    });
  };
  const schedulePositions = () => {
    if (!nonce || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      const positions = [];
      const missing = [];
      for (const pin of pins) {
        let matches = [];
        try {
          matches = document.querySelectorAll(pin.selector);
        } catch {
          missing.push(pin.id);
          continue;
        }
        if (matches.length !== 1) {
          missing.push(pin.id);
          continue;
        }
        const rect = matches[0].getBoundingClientRect();
        if (!rect.width || !rect.height) {
          missing.push(pin.id);
          continue;
        }
        positions.push({
          id: pin.id,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
      }
      send("positions", {
        positions,
        missing,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      });
    });
  };
  const onScroll = () => {
    if (inspectionMode === "element" || inspectionMode === "container") displayOutline(hoverTarget);
    schedulePositions();
  };
  const onResize = () => {
    if (inspectionMode === "element" || inspectionMode === "container") displayOutline(hoverTarget);
    schedulePositions();
  };
  const onMutation = (records) => {
    if (records.every((record) => record.target === outline)) return;
    refreshResizeTargets();
    if (hoverTarget && !hoverTarget.isConnected) {
      hoverTarget = null;
      outline.style.display = "none";
    } else {
      displayOutline(hoverTarget);
    }
    schedulePositions();
  };
  const onRouteChange = () => send("route", { href: location.href });
  const installInspectListeners = () => {
    if (inspectedListeners) return;
    inspectedListeners = true;
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", select, true);
  };
  const removeInspectListeners = () => {
    if (!inspectedListeners) return;
    inspectedListeners = false;
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("click", select, true);
    hoverTarget = null;
    outline.style.display = "none";
  };
  const setInspectionMode = (mode) => {
    inspectionMode = mode;
    if (mode !== "off") installInspectListeners();
    else {
      removeInspectListeners();
    }
    if (mode === "free" || mode === "off") {
      currentCandidates = [];
      containerSelector = "";
      lastHoverSignature = "";
      outline.style.display = "none";
    } else {
      lastHoverSignature = "";
    }
  };

  const refreshResizeTargets = () => {
    if (!resizeObserver) return;
    resizeObserver.disconnect();
    for (const pin of pins) {
      try {
        const targets = document.querySelectorAll(pin.selector);
        if (targets.length === 1) resizeObserver.observe(targets[0]);
      } catch {
        // Invalid selectors are reported as missing by the next position pass.
      }
    }
  };
  const onMessage = (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin || !validEnvelope(event.data)) return;
    const message = event.data;
    if (message.type === "start") {
      nonce = message.nonce;
      send("ready", { parentOrigin, href: location.href });
      schedulePositions();
      return;
    }
    if (!nonce || message.nonce !== nonce) return;
    if (message.type === "inspection"
      && (message.mode === "off" || message.mode === "element" || message.mode === "container" || message.mode === "free")) {
      setInspectionMode(message.mode);
    } else if (message.type === "candidate" && inspectionMode === "container"
      && typeof message.selector === "string" && message.selector.length <= selectorLimit
      && currentCandidates.some((candidate) => candidate.selector === message.selector)) {
      containerSelector = message.selector;
      const selected = currentCandidates.find((candidate) => candidate.selector === containerSelector);
      hoverTarget = selected ? selected.element : null;
      displayOutline(hoverTarget);
    } else if (message.type === "anchors" && Array.isArray(message.pins) && message.pins.length <= pinLimit) {
      const next = [];
      for (const pin of message.pins) {
        if (!pin || typeof pin !== "object"
          || typeof pin.id !== "string" || pin.id.length < 1 || pin.id.length > 200
          || typeof pin.selector !== "string" || !pin.selector.trim() || pin.selector.length > selectorLimit
          || !Number.isFinite(pin.offsetX) || pin.offsetX < 0 || pin.offsetX > 1
          || !Number.isFinite(pin.offsetY) || pin.offsetY < 0 || pin.offsetY > 1) return;
        next.push({ id: pin.id, selector: pin.selector, offsetX: pin.offsetX, offsetY: pin.offsetY });
      }
      pins = next;
      refreshResizeTargets();
      schedulePositions();
    }
  };
  window.addEventListener("message", onMessage);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    onRouteChange();
    schedulePositions();
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    onRouteChange();
    schedulePositions();
    return result;
  };
  window.addEventListener("popstate", onRouteChange);
  window.addEventListener("hashchange", onRouteChange);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  resizeObserver = new ResizeObserver(schedulePositions);
  mutationObserver = new MutationObserver(onMutation);
  if (document.documentElement) mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  window.addEventListener("pagehide", () => {
    removeInspectListeners();
    window.removeEventListener("popstate", onRouteChange);
    window.removeEventListener("hashchange", onRouteChange);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("message", onMessage);
    if (resizeObserver) resizeObserver.disconnect();
    if (mutationObserver) mutationObserver.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    outline.remove();
  }, { once: true });
})();
