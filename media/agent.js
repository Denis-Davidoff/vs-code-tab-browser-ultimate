"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // shared/protocol.ts
  var defaultPreferredAttributes = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
  var agentChannel = "__tabBrowserAgent";
  function isAgentMessage(value) {
    return typeof value === "object" && value !== null && agentChannel in value && value[agentChannel] === true && typeof value.kind === "string";
  }
  function packAgentMessage(message) {
    return { [agentChannel]: true, ...message };
  }

  // page-src/consoleCapture.ts
  var maxEntries = 1e3;
  var maxEntryLength = 4e3;
  var maxDepth = 4;
  var patchedLevels = ["log", "info", "warn", "error", "debug", "trace"];
  var entries = [];
  var dropped = 0;
  var installed = false;
  function installConsoleCapture() {
    if (installed) {
      return;
    }
    installed = true;
    for (const level of patchedLevels) {
      const original = console[level];
      if (typeof original !== "function") {
        continue;
      }
      const forward = original;
      console[level] = function(...args) {
        record(level, formatArguments(args));
        return forward.apply(this, args);
      };
    }
    const originalClear = console.clear;
    if (typeof originalClear === "function") {
      console.clear = function(...args) {
        entries.length = 0;
        dropped = 0;
        return originalClear.apply(this, args);
      };
    }
    window.addEventListener("error", (event) => {
      const target = event.target;
      if (target && target !== window && target.tagName) {
        const url = target.src || target.href;
        record("error", `Failed to load ${target.tagName.toLowerCase()}${url ? `: ${url}` : ""}`);
        return;
      }
      const error = event.error;
      record(
        "error",
        event.message || String(error != null ? error : "Script error"),
        error instanceof Error ? error.stack : void 0
      );
    }, true);
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      record(
        "error",
        `Unhandled rejection: ${reason instanceof Error ? `${reason.name}: ${reason.message}` : formatValue(reason, 0)}`,
        reason instanceof Error ? reason.stack : void 0
      );
    });
  }
  function record(level, text, stack) {
    entries.push({
      level,
      time: Date.now(),
      text: text.length > maxEntryLength ? `${text.slice(0, maxEntryLength)}\u2026 (truncated)` : text,
      stack
    });
    while (entries.length > maxEntries) {
      entries.shift();
      dropped++;
    }
  }
  function consoleSnapshot() {
    return { entries: entries.slice(), dropped };
  }
  function formatArguments(args) {
    if (!args.length) {
      return "";
    }
    const parts = [];
    let rest = args.slice(1);
    if (typeof args[0] === "string" && /%[sdifoOjc%]/.test(args[0])) {
      let consumed = 0;
      const formatted = args[0].replace(/%([sdifoOjc%])/g, (match, kind) => {
        if (kind === "%") {
          return "%";
        }
        if (consumed >= rest.length) {
          return match;
        }
        const value = rest[consumed++];
        switch (kind) {
          case "c":
            return "";
          case "s":
            return typeof value === "string" ? value : formatValue(value, 1);
          case "d":
          case "i":
            return String(typeof value === "bigint" ? value : Math.trunc(Number(value)));
          case "f":
            return String(Number(value));
          default:
            return formatValue(value, 1);
        }
      });
      parts.push(formatted);
      rest = rest.slice(consumed);
    } else {
      parts.push(formatValue(args[0], 0));
    }
    for (const value of rest) {
      parts.push(formatValue(value, 0));
    }
    return parts.join(" ");
  }
  function formatValue(value, depth, seen = /* @__PURE__ */ new Set()) {
    if (typeof value === "string") {
      return depth === 0 ? value : JSON.stringify(value);
    }
    if (value === null) {
      return "null";
    }
    if (value === void 0) {
      return "undefined";
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "bigint") {
      return `${value}n`;
    }
    if (typeof value === "symbol") {
      return value.toString();
    }
    if (typeof value === "function") {
      return `[Function: ${value.name || "anonymous"}]`;
    }
    if (value instanceof Error) {
      return value.stack || `${value.name}: ${value.message}`;
    }
    if (typeof Node !== "undefined" && value instanceof Node) {
      return formatNode(value);
    }
    const object = value;
    if (seen.has(object)) {
      return "[Circular]";
    }
    if (depth >= maxDepth) {
      return Array.isArray(value) ? "[Array]" : "[Object]";
    }
    seen.add(object);
    try {
      if (Array.isArray(value)) {
        const items2 = value.slice(0, 100).map((item) => formatValue(item, depth + 1, seen));
        if (value.length > 100) {
          items2.push(`\u2026 ${value.length - 100} more`);
        }
        return `[${items2.join(", ")}]`;
      }
      if (value instanceof Map) {
        const items2 = Array.from(value.entries()).slice(0, 50).map(([key, item]) => `${formatValue(key, depth + 1, seen)} => ${formatValue(item, depth + 1, seen)}`);
        return `Map(${value.size}) {${items2.join(", ")}}`;
      }
      if (value instanceof Set) {
        const items2 = Array.from(value.values()).slice(0, 50).map((item) => formatValue(item, depth + 1, seen));
        return `Set(${value.size}) {${items2.join(", ")}}`;
      }
      const name = object.constructor && object.constructor.name !== "Object" ? `${object.constructor.name} ` : "";
      const keys = Object.keys(object).slice(0, 50);
      const items = keys.map((key) => `${key}: ${formatValue(object[key], depth + 1, seen)}`);
      if (Object.keys(object).length > keys.length) {
        items.push("\u2026");
      }
      return `${name}{${items.join(", ")}}`;
    } catch {
      return "[Unserializable]";
    } finally {
      seen.delete(object);
    }
  }
  function formatNode(node) {
    var _a, _b;
    if (node instanceof Element) {
      const html = (_a = node.outerHTML) != null ? _a : "";
      return html.length > 200 ? `${html.slice(0, 200)}\u2026` : html;
    }
    return `${node.nodeName}(${((_b = node.nodeValue) != null ? _b : "").slice(0, 80)})`;
  }

  // page-src/pageIcon.ts
  var wantedSize = 32;
  var iconRelations = /(^|\s)(shortcut\s+icon|icon|apple-touch-icon(-precomposed)?|mask-icon)(\s|$)/i;
  function findIconHref() {
    var _a;
    const links = Array.prototype.slice.call(
      document.querySelectorAll("link[rel][href]")
    );
    let best;
    for (const link of links) {
      if (!iconRelations.test((_a = link.getAttribute("rel")) != null ? _a : "")) {
        continue;
      }
      const href = link.href;
      if (!href) {
        continue;
      }
      const score = scoreIcon(link, href);
      if (!best || score > best.score) {
        best = { href, score };
      }
    }
    return best == null ? void 0 : best.href;
  }
  function scoreIcon(link, href) {
    var _a, _b;
    const type = ((_a = link.getAttribute("type")) != null ? _a : "").toLowerCase();
    const extension = extensionOf(href);
    if (type.includes("svg") || extension === "svg") {
      return 100;
    }
    let score = extension === "ico" || type.includes("icon") ? 40 : 60;
    if (/apple-touch-icon/i.test((_b = link.getAttribute("rel")) != null ? _b : "")) {
      score -= 30;
    }
    const size = largestSize(link.getAttribute("sizes"));
    if (size) {
      score += Math.max(0, 20 - Math.abs(size - wantedSize) / 8);
    }
    return score;
  }
  function largestSize(sizes) {
    if (!sizes || /any/i.test(sizes)) {
      return void 0;
    }
    let largest;
    for (const part of sizes.split(/\s+/)) {
      const width = parseInt(part.split(/x/i)[0], 10);
      if (!isNaN(width) && (largest === void 0 || width > largest)) {
        largest = width;
      }
    }
    return largest;
  }
  function extensionOf(href) {
    var _a;
    try {
      const pathname = new URL(href, location.href).pathname;
      return ((_a = pathname.split(".").pop()) != null ? _a : "").toLowerCase();
    } catch {
      return "";
    }
  }

  // page-src/elementContext.ts
  var limits = {
    outerHtml: 4e3,
    matchedRules: 80,
    inheritedRules: 60,
    ancestors: 16,
    declarations: 2e3,
    variables: 40
  };
  var inheritedProperties = /* @__PURE__ */ new Set([
    "azimuth",
    "border-collapse",
    "border-spacing",
    "caption-side",
    "caret-color",
    "color",
    "cursor",
    "direction",
    "empty-cells",
    "font",
    "font-family",
    "font-feature-settings",
    "font-kerning",
    "font-optical-sizing",
    "font-size",
    "font-size-adjust",
    "font-stretch",
    "font-style",
    "font-synthesis",
    "font-variant",
    "font-variant-caps",
    "font-variant-east-asian",
    "font-variant-ligatures",
    "font-variant-numeric",
    "font-variation-settings",
    "font-weight",
    "hyphens",
    "letter-spacing",
    "line-break",
    "line-height",
    "list-style",
    "list-style-image",
    "list-style-position",
    "list-style-type",
    "orphans",
    "overflow-wrap",
    "pointer-events",
    "quotes",
    "tab-size",
    "text-align",
    "text-align-last",
    "text-indent",
    "text-justify",
    "text-rendering",
    "text-shadow",
    "text-transform",
    "text-underline-position",
    "text-wrap",
    "visibility",
    "white-space",
    "widows",
    "word-break",
    "word-spacing",
    "writing-mode",
    "-webkit-font-smoothing",
    "-webkit-text-size-adjust",
    "accent-color",
    "color-scheme",
    "user-select"
  ]);
  var alwaysResolved = [
    "align-items",
    "align-self",
    "appearance",
    "background-color",
    "background-image",
    "border-radius",
    "bottom",
    "box-shadow",
    "box-sizing",
    "color",
    "cursor",
    "direction",
    "display",
    "flex-basis",
    "flex-direction",
    "flex-grow",
    "flex-shrink",
    "flex-wrap",
    "float",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "gap",
    "grid-auto-flow",
    "grid-template-columns",
    "grid-template-rows",
    "height",
    "justify-content",
    "left",
    "letter-spacing",
    "line-height",
    "list-style",
    "margin",
    "max-height",
    "max-width",
    "min-height",
    "min-width",
    "object-fit",
    "opacity",
    "order",
    "outline",
    "overflow-x",
    "overflow-y",
    "padding",
    "pointer-events",
    "position",
    "right",
    "tab-size",
    "text-align",
    "text-decoration",
    "text-indent",
    "text-overflow",
    "text-transform",
    "top",
    "transform",
    "transition",
    "user-select",
    "vertical-align",
    "visibility",
    "white-space",
    "width",
    "word-break",
    "writing-mode",
    "z-index"
  ];
  var shorthands = {
    "background": [
      "background-attachment",
      "background-clip",
      "background-color",
      "background-image",
      "background-origin",
      "background-position",
      "background-repeat",
      "background-size"
    ],
    "border": ["border-color", "border-style", "border-width"],
    "border-block": ["border-block-color", "border-block-style", "border-block-width"],
    "border-bottom": ["border-bottom-color", "border-bottom-style", "border-bottom-width"],
    "border-color": ["border-bottom-color", "border-left-color", "border-right-color", "border-top-color"],
    "border-inline": ["border-inline-color", "border-inline-style", "border-inline-width"],
    "border-left": ["border-left-color", "border-left-style", "border-left-width"],
    "border-radius": [
      "border-bottom-left-radius",
      "border-bottom-right-radius",
      "border-top-left-radius",
      "border-top-right-radius"
    ],
    "border-right": ["border-right-color", "border-right-style", "border-right-width"],
    "border-style": ["border-bottom-style", "border-left-style", "border-right-style", "border-top-style"],
    "border-top": ["border-top-color", "border-top-style", "border-top-width"],
    "border-width": ["border-bottom-width", "border-left-width", "border-right-width", "border-top-width"],
    "flex": ["flex-basis", "flex-grow", "flex-shrink"],
    "flex-flow": ["flex-direction", "flex-wrap"],
    "font": [
      "font-family",
      "font-size",
      "font-stretch",
      "font-style",
      "font-variant",
      "font-weight",
      "line-height"
    ],
    "gap": ["column-gap", "row-gap"],
    "grid-area": ["grid-column-end", "grid-column-start", "grid-row-end", "grid-row-start"],
    "inset": ["bottom", "left", "right", "top"],
    "list-style": ["list-style-image", "list-style-position", "list-style-type"],
    "margin": ["margin-bottom", "margin-left", "margin-right", "margin-top"],
    "outline": ["outline-color", "outline-style", "outline-width"],
    "overflow": ["overflow-x", "overflow-y"],
    "padding": ["padding-bottom", "padding-left", "padding-right", "padding-top"],
    "place-items": ["align-items", "justify-items"],
    "text-decoration": ["text-decoration-color", "text-decoration-line", "text-decoration-style"],
    "transition": [
      "transition-delay",
      "transition-duration",
      "transition-property",
      "transition-timing-function"
    ]
  };
  var flexAndGridProperties = /* @__PURE__ */ new Set([
    "align-items",
    "align-self",
    "flex-basis",
    "flex-direction",
    "flex-grow",
    "flex-shrink",
    "flex-wrap",
    "gap",
    "grid-auto-flow",
    "grid-template-columns",
    "grid-template-rows",
    "justify-content",
    "order"
  ]);
  var positionedProperties = /* @__PURE__ */ new Set(["bottom", "left", "right", "top", "z-index"]);
  var statePseudo = new RegExp(
    "::?(?:hover|focus|focus-within|focus-visible|active|visited|link|any-link|target|target-within|placeholder-shown|autofill|checked|indeterminate|default|disabled|enabled|read-only|read-write|required|optional|valid|invalid|in-range|out-of-range|user-valid|user-invalid|open|popover-open|modal|fullscreen|before|after|first-line|first-letter|placeholder|selection|backdrop|marker|file-selector-button|details-content|-webkit-[\\w-]+|-moz-[\\w-]+)\\b(?!\\()",
    "g"
  );
  function describeNode(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const classes = Array.prototype.slice.call(element.classList).map((name) => `.${name}`).join("");
    return `${tag}${id}${classes}`;
  }
  function htmlPath(element) {
    const path = [];
    for (let node = element; node; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) {
        break;
      }
      path.unshift(describeNode(node));
    }
    return path.length ? path : [describeNode(element)];
  }
  function elementRect(element) {
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }
  function outerHtml(element) {
    var _a;
    const html = (_a = element.outerHTML) != null ? _a : "";
    if (html.length <= limits.outerHtml) {
      return html;
    }
    const tag = element.tagName.toLowerCase();
    const openTagEnd = html.indexOf(">");
    const openTag = openTagEnd === -1 ? `<${tag}>` : html.slice(0, openTagEnd + 1);
    const children = element.children.length;
    return `${openTag}
  <!-- ${children} child element${children === 1 ? "" : "s"} omitted -->
</${tag}>`;
  }
  function collectStyles(element) {
    try {
      return buildSnapshot(element);
    } catch {
      return void 0;
    }
  }
  function buildSnapshot(element) {
    let unreadableStyleSheets = 0;
    let counted = false;
    const sheets = Array.prototype.slice.call(document.styleSheets);
    const visit = (visitor) => {
      for (const sheet of sheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          if (!counted) {
            unreadableStyleSheets++;
          }
          continue;
        }
        walkRules(rules, [], visitor);
      }
      counted = true;
    };
    const matched = [];
    const declared = /* @__PURE__ */ new Set();
    const declaredOrder = [];
    const inlineStyle = element.style;
    if (inlineStyle == null ? void 0 : inlineStyle.length) {
      matched.push({ selector: "element.style", declarations: declarationText(inlineStyle) });
      collectDeclared(inlineStyle, declared, declaredOrder);
    }
    visit((rule, conditions) => {
      if (matched.length >= limits.matchedRules || !matchesElement(element, rule.selectorText)) {
        return;
      }
      const declarations = declarationText(rule.style);
      if (!declarations) {
        return;
      }
      matched.push({
        selector: rule.selectorText,
        declarations,
        conditions: conditions.length ? conditions.slice() : void 0
      });
      collectDeclared(rule.style, declared, declaredOrder);
    });
    const inherited = [];
    const ancestors = [];
    for (let node = element.parentElement; node && ancestors.length < limits.ancestors; node = node.parentElement) {
      ancestors.push(node);
    }
    for (const ancestor of ancestors) {
      const from = describeNode(ancestor);
      const ancestorInline = ancestor.style;
      const inlineInherited = (ancestorInline == null ? void 0 : ancestorInline.length) ? declarationsOf(ancestorInline, (property) => inheritedProperties.has(property)) : "";
      if (inlineInherited) {
        inherited.push({ selector: "element.style", declarations: inlineInherited, from });
      }
    }
    visit((rule, conditions) => {
      if (inherited.length >= limits.inheritedRules) {
        return;
      }
      const declarations = declarationsOf(rule.style, (property) => inheritedProperties.has(property));
      if (!declarations) {
        return;
      }
      for (const ancestor of ancestors) {
        if (matchesElement(ancestor, rule.selectorText)) {
          inherited.push({
            selector: rule.selectorText,
            declarations,
            conditions: conditions.length ? conditions.slice() : void 0,
            from: describeNode(ancestor)
          });
          return;
        }
      }
    });
    const computed = getComputedStyle(element);
    return {
      matched,
      inherited,
      resolved: resolveValues(element, computed, declared, declaredOrder),
      variables: resolveVariables(computed, [...matched, ...inherited]),
      unreadableStyleSheets
    };
  }
  function walkRules(rules, conditions, visit) {
    for (const rule of Array.prototype.slice.call(rules)) {
      const styleRule = rule;
      if (typeof styleRule.selectorText === "string" && styleRule.style) {
        visit(styleRule, conditions);
        continue;
      }
      const group = rule;
      if (!group.cssRules) {
        continue;
      }
      const condition = groupCondition(rule);
      if (condition === void 0) {
        continue;
      }
      walkRules(group.cssRules, condition ? [...conditions, condition] : conditions, visit);
    }
  }
  function groupCondition(rule) {
    var _a;
    const media = rule.media;
    if (media) {
      const text = media.mediaText;
      if (!text || text === "all") {
        return "";
      }
      try {
        return matchMedia(text).matches ? `@media ${text}` : void 0;
      } catch {
        return `@media ${text}`;
      }
    }
    const conditionText = rule.conditionText;
    if (typeof conditionText === "string") {
      const isSupports = /^@supports/i.test((_a = rule.cssText) != null ? _a : "");
      if (isSupports) {
        try {
          return CSS.supports(conditionText) ? `@supports ${conditionText}` : void 0;
        } catch {
          return `@supports ${conditionText}`;
        }
      }
      return `@container ${conditionText}`;
    }
    const name = rule.name;
    if (typeof name === "string") {
      return name ? `@layer ${name}` : "";
    }
    return void 0;
  }
  function matchesElement(element, selectorText) {
    for (const part of splitSelectorList(selectorText)) {
      const testable = part.replace(statePseudo, "").trim();
      if (!testable || testable.indexOf("&") !== -1) {
        continue;
      }
      try {
        if (element.matches(testable)) {
          return true;
        }
      } catch {
      }
    }
    return false;
  }
  function splitSelectorList(selectorText) {
    const parts = [];
    let depth = 0;
    let quote;
    let start = 0;
    for (let i = 0; i < selectorText.length; i++) {
      const char = selectorText[i];
      if (quote) {
        if (char === "\\") {
          i++;
        } else if (char === quote) {
          quote = void 0;
        }
        continue;
      }
      switch (char) {
        case '"':
        case "'":
          quote = char;
          break;
        case "(":
        case "[":
          depth++;
          break;
        case ")":
        case "]":
          depth--;
          break;
        case ",":
          if (depth === 0) {
            parts.push(selectorText.slice(start, i));
            start = i + 1;
          }
          break;
      }
    }
    parts.push(selectorText.slice(start));
    return parts;
  }
  function declarationText(style) {
    var _a;
    const text = ((_a = style.cssText) != null ? _a : "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
    return text.length > limits.declarations ? `${text.slice(0, limits.declarations)}\u2026` : text;
  }
  function declaredNames(cssText) {
    const names = [];
    let depth = 0;
    let quote;
    let start = 0;
    const take = (end) => {
      const colon = cssText.indexOf(":", start);
      if (colon !== -1 && colon < end) {
        const name = cssText.slice(start, colon).trim();
        if (name) {
          names.push(name);
        }
      }
      start = end + 1;
    };
    for (let i = 0; i < cssText.length; i++) {
      const char = cssText[i];
      if (quote) {
        if (char === "\\") {
          i++;
        } else if (char === quote) {
          quote = void 0;
        }
        continue;
      }
      switch (char) {
        case '"':
        case "'":
          quote = char;
          break;
        case "(":
          depth++;
          break;
        case ")":
          depth--;
          break;
        case ";":
          if (depth === 0) {
            take(i);
          }
          break;
      }
    }
    take(cssText.length);
    return names;
  }
  function declarationsOf(style, filter) {
    const parts = [];
    for (let i = 0; i < style.length; i++) {
      const property = style.item(i);
      if (filter && !filter(property)) {
        continue;
      }
      const value = style.getPropertyValue(property);
      if (!value) {
        continue;
      }
      const priority = style.getPropertyPriority(property);
      parts.push(`${property}: ${value}${priority ? ` !${priority}` : ""}`);
    }
    const text = parts.join("; ");
    return text.length > limits.declarations ? `${text.slice(0, limits.declarations)}\u2026` : text;
  }
  function collectDeclared(style, declared, order) {
    var _a;
    const add = (property) => {
      var _a2, _b;
      declared.add(property);
      for (const longhand of (_a2 = shorthands[property]) != null ? _a2 : []) {
        declared.add(longhand);
        for (const nested of (_b = shorthands[longhand]) != null ? _b : []) {
          declared.add(nested);
        }
      }
    };
    for (let i = 0; i < style.length; i++) {
      add(style.item(i));
    }
    for (const property of declaredNames((_a = style.cssText) != null ? _a : "")) {
      if (order.indexOf(property) === -1) {
        order.push(property);
      }
      add(property);
    }
  }
  function resolveValues(element, computed, declared, declaredOrder) {
    const resolved = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (property, fromUserAgent) => {
      if (seen.has(property) || property.startsWith("--")) {
        return;
      }
      const value = computed.getPropertyValue(property);
      if (!value) {
        return;
      }
      seen.add(property);
      resolved.push(fromUserAgent ? { property, value, fromUserAgent } : { property, value });
    };
    for (const property of declaredOrder) {
      push(property);
    }
    const wanted = alwaysResolved.filter((property) => !seen.has(property) && isRelevant(property, element, computed));
    const untouched = untouchedValues(element, wanted);
    for (const property of wanted) {
      const value = computed.getPropertyValue(property);
      const isDefault = !declared.has(property) && !!value && untouched.get(property) === value;
      push(property, isDefault || void 0);
    }
    return resolved;
  }
  function isRelevant(property, element, computed) {
    if (flexAndGridProperties.has(property)) {
      const parent = element.parentElement;
      const displays = computed.getPropertyValue("display") + (parent ? ` ${getComputedStyle(parent).getPropertyValue("display")}` : "");
      return /flex|grid/.test(displays);
    }
    if (positionedProperties.has(property)) {
      return computed.getPropertyValue("position") !== "static";
    }
    return true;
  }
  function untouchedValues(element, properties) {
    const values = /* @__PURE__ */ new Map();
    if (!properties.length || !document.body) {
      return values;
    }
    const host = document.createElement("div");
    host.setAttribute("data-tab-browser", "probe");
    host.style.cssText = "all: initial; position: absolute; left: -99999px; top: 0;width: 0; height: 0; overflow: hidden; contain: strict;";
    let probe;
    try {
      probe = document.createElement(element.tagName.toLowerCase());
      host.appendChild(probe);
      document.body.appendChild(host);
      const computed = getComputedStyle(probe);
      for (const property of properties) {
        values.set(property, computed.getPropertyValue(property));
      }
    } catch {
    } finally {
      host.remove();
    }
    return values;
  }
  function resolveVariables(computed, rules) {
    var _a;
    const names = /* @__PURE__ */ new Set();
    const pattern = /var\(\s*(--[\w-]+)/g;
    for (const rule of rules) {
      for (const declaration of rule.declarations.split(";")) {
        const property = (_a = declaration.split(":")[0]) == null ? void 0 : _a.trim();
        if (property == null ? void 0 : property.startsWith("--")) {
          names.add(property);
        }
      }
      pattern.lastIndex = 0;
      for (let match = pattern.exec(rule.declarations); match; match = pattern.exec(rule.declarations)) {
        names.add(match[1]);
      }
    }
    const variables = [];
    for (const name of names) {
      if (variables.length >= limits.variables) {
        break;
      }
      const value = computed.getPropertyValue(name).trim();
      if (value) {
        variables.push({ property: name, value });
      }
    }
    return variables;
  }

  // page-src/selectors.ts
  function escapeIdentifier(value) {
    return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/[^\w-]/g, (ch) => `\\${ch}`);
  }
  function escapeAttributeValue(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function isPlainIdentifier(value) {
    return /^[A-Za-z_][\w-]*$/.test(value);
  }
  function looksGenerated(value) {
    return value.length > 40 || /\d{5,}/.test(value) || /(^|[-_])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,}$/i.test(value);
  }
  function isUnique(root, selector) {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }
  function stableClasses(element) {
    const result = [];
    for (const className of Array.prototype.slice.call(element.classList)) {
      if (isPlainIdentifier(className) && !looksGenerated(className)) {
        result.push(className);
      }
      if (result.length === 3) {
        break;
      }
    }
    return result;
  }
  function stepSelector(element, preferredAttributes) {
    const tag = element.tagName.toLowerCase();
    for (const attribute of preferredAttributes) {
      const value = element.getAttribute(attribute);
      if (value) {
        const selector = `[${attribute}="${escapeAttributeValue(value)}"]`;
        if (isUnique(document, selector)) {
          return selector;
        }
        if (isUnique(document, tag + selector)) {
          return tag + selector;
        }
      }
    }
    const id = element.getAttribute("id");
    if (id && isPlainIdentifier(id) && !looksGenerated(id) && isUnique(document, `#${escapeIdentifier(id)}`)) {
      return `#${escapeIdentifier(id)}`;
    }
    const parent = element.parentElement;
    if (!parent) {
      return tag;
    }
    const sameTag = Array.prototype.slice.call(parent.children).filter((child) => child.tagName === element.tagName);
    if (sameTag.length === 1) {
      return tag;
    }
    const classes = stableClasses(element);
    if (classes.length) {
      const withClasses = tag + classes.map((name) => `.${escapeIdentifier(name)}`).join("");
      const matching = sameTag.filter((child) => classes.every((name) => child.classList.contains(name)));
      if (matching.length === 1) {
        return withClasses;
      }
    }
    return `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
  }
  function cssPath(element, preferredAttributes) {
    const parts = [];
    let node = element;
    while (node) {
      const step = stepSelector(node, preferredAttributes);
      parts.unshift(step);
      if (step.startsWith("#") || step.includes("[")) {
        break;
      }
      if (isUnique(document, parts.join(" > "))) {
        break;
      }
      node = node.parentElement;
    }
    return parts.join(" > ");
  }
  function xPath(element) {
    var _a, _b;
    const parts = [];
    let node = element;
    while (node) {
      const tag = node.tagName.toLowerCase();
      const id = node.getAttribute("id");
      if (id && !looksGenerated(id) && isUnique(document, `[id="${escapeAttributeValue(id)}"]`)) {
        parts.unshift(`*[@id="${id}"]`);
        return `//${parts.join("/")}`;
      }
      let index = 1;
      let siblings = 0;
      let sibling = (_b = (_a = node.parentElement) == null ? void 0 : _a.firstElementChild) != null ? _b : null;
      for (; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.tagName !== node.tagName) {
          continue;
        }
        siblings++;
        if (sibling === node) {
          index = siblings;
        }
      }
      parts.unshift(siblings > 1 ? `${tag}[${index}]` : tag);
      node = node.parentElement;
    }
    return `/${parts.join("/")}`;
  }
  function describeElement(element, preferredAttributes, documentUrl) {
    var _a, _b;
    const attributes = {};
    for (const name of ["id", "name", "type", "role", "href", "aria-label", ...preferredAttributes]) {
      const value = element.getAttribute(name);
      if (value !== null) {
        attributes[name] = value;
      }
    }
    const text = (_b = (_a = element.innerText) != null ? _a : element.textContent) != null ? _b : "";
    const trimmed = text.replace(/\s+/g, " ").trim();
    return {
      selector: cssPath(element, preferredAttributes),
      xpath: xPath(element),
      tagName: element.tagName.toLowerCase(),
      id: element.id || void 0,
      classes: Array.prototype.slice.call(element.classList),
      attributes,
      text: trimmed ? trimmed.slice(0, 120) : void 0,
      framePath: [],
      documentUrl,
      descriptor: describeNode(element),
      htmlPath: htmlPath(element),
      outerHtml: outerHtml(element),
      rect: elementRect(element),
      styles: collectStyles(element)
    };
  }

  // page-src/picker.ts
  var overlayAttribute = "data-tab-browser";
  var blockedEvents = [
    "mousedown",
    "mouseup",
    "pointerdown",
    "pointerup",
    "dblclick",
    "auxclick",
    "contextmenu",
    "submit",
    "touchstart",
    "touchend",
    "dragstart"
  ];
  var ElementPicker = class {
    constructor(_host) {
      this._host = _host;
      __publicField(this, "_active", false);
      __publicField(this, "_preferredAttributes", defaultPreferredAttributes);
      __publicField(this, "_hovered");
      __publicField(this, "_lastPointer");
      __publicField(this, "_overlayRoot");
      __publicField(this, "_outline");
      __publicField(this, "_label");
      __publicField(this, "_cursorStyle");
      __publicField(this, "_pendingFrame", 0);
      __publicField(this, "_reportedSelector");
      __publicField(this, "_onMouseMove", (event) => {
        this._lastPointer = { x: event.clientX, y: event.clientY };
        this._scheduleUpdate();
      });
      __publicField(this, "_onMouseOut", (event) => {
        if (!event.relatedTarget) {
          this._hovered = void 0;
          this._reportedSelector = void 0;
          this._hideOverlay();
        }
      });
      __publicField(this, "_onViewportChange", () => {
        if (this._lastPointer) {
          this._scheduleUpdate();
        }
      });
      __publicField(this, "_onClick", (event) => {
        var _a;
        event.preventDefault();
        event.stopImmediatePropagation();
        const element = (_a = this._hovered) != null ? _a : document.elementFromPoint(event.clientX, event.clientY);
        if (!element || element === document.documentElement) {
          return;
        }
        this._host.onPick(describeElement(element, this._preferredAttributes, this._host.documentUrl()));
      });
      __publicField(this, "_onKeyDown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.disable();
          this._host.onCancel();
        }
      });
      __publicField(this, "_blockEvent", (event) => {
        if (this._isOwnOverlay(event.target)) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      });
    }
    get active() {
      return this._active;
    }
    get preferredAttributes() {
      return this._preferredAttributes;
    }
    enable(attributes) {
      var _a;
      if (attributes == null ? void 0 : attributes.length) {
        this._preferredAttributes = attributes;
      }
      if (this._active) {
        return;
      }
      this._active = true;
      this._reportedSelector = void 0;
      window.addEventListener("mousemove", this._onMouseMove, true);
      window.addEventListener("mouseout", this._onMouseOut, true);
      window.addEventListener("click", this._onClick, true);
      window.addEventListener("keydown", this._onKeyDown, true);
      window.addEventListener("scroll", this._onViewportChange, true);
      window.addEventListener("resize", this._onViewportChange, true);
      for (const type of blockedEvents) {
        window.addEventListener(type, this._blockEvent, true);
      }
      this._cursorStyle = document.createElement("style");
      this._cursorStyle.setAttribute(overlayAttribute, "cursor");
      this._cursorStyle.textContent = "*, *::before, *::after { cursor: crosshair !important; }";
      ((_a = document.head) != null ? _a : document.documentElement).appendChild(this._cursorStyle);
    }
    disable() {
      var _a, _b;
      if (!this._active) {
        return;
      }
      this._active = false;
      this._hovered = void 0;
      this._lastPointer = void 0;
      this._reportedSelector = void 0;
      window.removeEventListener("mousemove", this._onMouseMove, true);
      window.removeEventListener("mouseout", this._onMouseOut, true);
      window.removeEventListener("click", this._onClick, true);
      window.removeEventListener("keydown", this._onKeyDown, true);
      window.removeEventListener("scroll", this._onViewportChange, true);
      window.removeEventListener("resize", this._onViewportChange, true);
      for (const type of blockedEvents) {
        window.removeEventListener(type, this._blockEvent, true);
      }
      if (this._pendingFrame) {
        cancelAnimationFrame(this._pendingFrame);
        this._pendingFrame = 0;
      }
      (_a = this._cursorStyle) == null ? void 0 : _a.remove();
      this._cursorStyle = void 0;
      (_b = this._overlayRoot) == null ? void 0 : _b.remove();
      this._overlayRoot = this._outline = this._label = void 0;
    }
    _scheduleUpdate() {
      if (this._pendingFrame) {
        return;
      }
      this._pendingFrame = requestAnimationFrame(() => {
        this._pendingFrame = 0;
        this._updateHighlight();
      });
    }
    _updateHighlight() {
      if (!this._active || !this._lastPointer) {
        return;
      }
      const element = document.elementFromPoint(this._lastPointer.x, this._lastPointer.y);
      if (!element || element === document.documentElement) {
        this._hovered = void 0;
        this._reportedSelector = void 0;
        this._hideOverlay();
        return;
      }
      this._hovered = element;
      const selector = cssPath(element, this._preferredAttributes);
      this._showOverlay(element, selector);
      if (selector !== this._reportedSelector) {
        this._reportedSelector = selector;
        this._host.onHover(selector);
      }
    }
    // -- overlay -------------------------------------------------------------------------------
    _isOwnOverlay(target) {
      return !!this._overlayRoot && target instanceof Node && this._overlayRoot.contains(target);
    }
    _ensureOverlay() {
      var _a;
      if ((_a = this._overlayRoot) == null ? void 0 : _a.isConnected) {
        return;
      }
      this._overlayRoot = document.createElement("div");
      this._overlayRoot.setAttribute(overlayAttribute, "picker");
      this._overlayRoot.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
      this._outline = document.createElement("div");
      this._outline.style.cssText = "position: fixed; pointer-events: none; box-sizing: border-box;border: 2px solid #4daafc; background: rgba(77, 170, 252, 0.14); border-radius: 2px;";
      this._label = document.createElement("div");
      this._label.style.cssText = "position: fixed; pointer-events: none; max-width: 90vw; box-sizing: border-box;padding: 3px 6px; border-radius: 3px; background: #1f1f1f; color: #ffffff;font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;white-space: nowrap; overflow: hidden; text-overflow: ellipsis;box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);";
      this._overlayRoot.appendChild(this._outline);
      this._overlayRoot.appendChild(this._label);
      document.documentElement.appendChild(this._overlayRoot);
    }
    _hideOverlay() {
      if (this._overlayRoot) {
        this._overlayRoot.style.display = "none";
      }
    }
    _showOverlay(element, selector) {
      this._ensureOverlay();
      if (!this._overlayRoot || !this._outline || !this._label) {
        return;
      }
      this._overlayRoot.style.display = "";
      const rect = element.getBoundingClientRect();
      this._outline.style.left = `${rect.left}px`;
      this._outline.style.top = `${rect.top}px`;
      this._outline.style.width = `${rect.width}px`;
      this._outline.style.height = `${rect.height}px`;
      this._label.textContent = `${selector}  \xB7  ${Math.round(rect.width)}\xD7${Math.round(rect.height)}`;
      const labelHeight = 20;
      const above = rect.top - labelHeight - 4;
      this._label.style.left = `${Math.max(2, Math.min(rect.left, window.innerWidth - 24))}px`;
      this._label.style.top = `${above >= 0 ? above : Math.min(rect.bottom + 4, window.innerHeight - labelHeight - 2)}px`;
    }
  };

  // page-src/agent.ts
  if (!window.__tabBrowserInstalled) {
    window.__tabBrowserInstalled = true;
    install();
  }
  function install() {
    var _a, _b;
    installConsoleCapture();
    const realOrigin = (_b = (_a = window.__tabBrowserConfig) == null ? void 0 : _a.realOrigin) != null ? _b : location.origin;
    function send(event) {
      var _a2;
      try {
        (_a2 = window.parent) == null ? void 0 : _a2.postMessage(packAgentMessage(event), "*");
      } catch {
      }
    }
    function childFrames() {
      return Array.prototype.slice.call(document.querySelectorAll("iframe, frame"));
    }
    function post(target, message) {
      try {
        target == null ? void 0 : target.postMessage(packAgentMessage(message), "*");
      } catch {
      }
    }
    function broadcast(message) {
      for (const frame of childFrames()) {
        post(frame.contentWindow, message);
      }
    }
    function findFrameElement(source) {
      if (!source) {
        return void 0;
      }
      for (const frame of childFrames()) {
        if (frame.contentWindow === source) {
          return frame;
        }
      }
      return void 0;
    }
    function onRealServer(rawUrl) {
      try {
        const current = new URL(rawUrl, location.href);
        if (current.origin !== location.origin) {
          return current.toString();
        }
        const real = new URL(realOrigin);
        current.protocol = real.protocol;
        current.host = real.host;
        return current.toString();
      } catch {
        return rawUrl;
      }
    }
    function documentUrlOnRealServer() {
      return onRealServer(location.href);
    }
    let reportedIcon;
    function reportIcon() {
      const href = findIconHref();
      if (!href || href === reportedIcon) {
        return;
      }
      reportedIcon = href;
      send({ kind: "icon", href: onRealServer(href) });
    }
    function watchIcon() {
      var _a2;
      let scheduled = 0;
      const observer = new MutationObserver(() => {
        if (scheduled) {
          return;
        }
        scheduled = setTimeout(() => {
          scheduled = 0;
          reportIcon();
        }, 200);
      });
      observer.observe((_a2 = document.head) != null ? _a2 : document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href", "rel", "sizes", "type"]
      });
    }
    const picker = new ElementPicker({
      onHover: (selector) => send({ kind: "hover", selector, framePath: [] }),
      onPick: (element) => send({ kind: "pick", element }),
      onCancel: () => {
        broadcast({ kind: "disablePicker" });
        send({ kind: "cancel" });
      },
      documentUrl: documentUrlOnRealServer
    });
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!isAgentMessage(message)) {
        return;
      }
      switch (message.kind) {
        case "enablePicker":
        case "disablePicker": {
          if (event.source && event.source !== window && event.source !== window.parent) {
            return;
          }
          if (message.kind === "enablePicker") {
            picker.enable(message.preferAttributes);
          } else {
            picker.disable();
          }
          broadcast(message);
          return;
        }
        case "collectConsole": {
          if (event.source && event.source !== window && event.source !== window.parent) {
            return;
          }
          const snapshot = consoleSnapshot();
          send({
            kind: "console",
            requestId: message.requestId,
            entries: snapshot.entries,
            dropped: snapshot.dropped,
            documentUrl: documentUrlOnRealServer()
          });
          return;
        }
      }
      const frame = findFrameElement(event.source);
      if (!frame) {
        return;
      }
      switch (message.kind) {
        case "ready":
          if (picker.active) {
            post(frame.contentWindow, { kind: "enablePicker", preferAttributes: picker.preferredAttributes });
          }
          return;
        case "icon":
          return;
        case "pageError":
        case "console":
          send(message);
          return;
        case "cancel":
          picker.disable();
          broadcast({ kind: "disablePicker" });
          send(message);
          return;
        case "hover":
          send({
            kind: "hover",
            selector: message.selector,
            framePath: [cssPath(frame, picker.preferredAttributes), ...message.framePath]
          });
          return;
        case "pick":
          send({
            kind: "pick",
            element: {
              ...message.element,
              framePath: [cssPath(frame, picker.preferredAttributes), ...message.element.framePath]
            }
          });
          return;
      }
    });
    let reportedErrors = 0;
    window.addEventListener("error", (event) => {
      var _a2;
      if (reportedErrors >= 10) {
        return;
      }
      const target = event.target;
      const message = target && target !== window && target.tagName ? `Failed to load ${target.tagName.toLowerCase()}${target.src || target.href ? `: ${target.src || target.href}` : ""}` : event.message || String((_a2 = event.error) != null ? _a2 : "Script error");
      if (!message) {
        return;
      }
      reportedErrors++;
      send({ kind: "pageError", message: message.slice(0, 300) });
    }, true);
    send({ kind: "ready", documentUrl: documentUrlOnRealServer() });
    reportIcon();
    watchIcon();
    window.addEventListener("pagehide", () => picker.disable());
  }
})();
//# sourceMappingURL=agent.js.map
