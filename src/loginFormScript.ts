/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * **This file is MPL-2.0, not MIT**, and it is the only one in the repository
 * that is. It carries Firefox's password-manager heuristics, ported, and MPL is
 * file-level copyleft: the file stays under MPL with its notice, while the rest
 * of the extension — which only imports it — stays MIT ("a Larger Work", MPL
 * §3.3). Whatever is added to this file is MPL too, so it holds only what has
 * to run in the page beside the ported state; the extension-side logic lives in
 * MIT files (`loginMessages.ts`, `loginWatcher.ts`). See THIRD-PARTY-NOTICES.md.
 *
 * Source: mozilla-firefox/firefox @ 4b5e436b8bc908fe7feb7341209140771397dda1 —
 * toolkit/components/passwordmgr/{LoginManagerChild, LoginHelper,
 * LoginManager.shared, shared/NewPasswordModel}.sys.mjs and
 * toolkit/modules/FormLikeFactory.sys.mjs.
 *
 * Modified: class statics flattened into functions; logging, site recipes,
 * telemetry, the Fathom model and password generation removed; Gecko-only APIs
 * replaced by DOM equivalents (each marked PORT); form attributes read through
 * `getAttribute` and form controls through the prototype getter, because a
 * control named `id` or `elements` shadows those properties on the form
 * (`[LegacyOverrideBuiltIns]`); `captureOnSubmit` also reports the field it
 * captured; `formHasModifiedFields` no longer accepts `value !== defaultValue`
 * as a modification (see there). Added around the port, for this extension:
 * the report to the extension, the submit triggers, the outcome watch, the
 * fill, and an uninstall for when the session that installed it goes.
 *
 * Why Firefox and not the extension most people would think of: Bitwarden,
 * KeePassXC-Browser and Proton Pass are GPL, which this MIT project cannot take
 * code from. Their *behaviour* was studied (when to offer a save, how to fill),
 * and none of their code is here.
 */

/** The isolated world the script runs in. The page's own scripts cannot see into it. */
export const loginsWorld = 'aiBrowserLogins';

/** The CDP binding it reports through. Exists only in {@link loginsWorld}. */
export const loginsBinding = 'aiBrowserLogins';

/**
 * The page-side script, for `Page.addScriptToEvaluateOnNewDocument` with
 * `worldName: loginsWorld`.
 *
 * `String.raw`, unlike the template literals in `elementPicker.ts`: this
 * script is mostly regular expressions, and in a plain template literal `\b`
 * is a backspace character and `\s` is the letter s — every pattern would be
 * silently different from the one written. Raw text keeps each backslash; the
 * one interpolation is the binding name. A backtick still cannot appear in it.
 *
 * What it does, end to end:
 *
 * - **reports** which login fields the frame shows (`fields`), whenever that
 *   changes;
 * - **captures** credentials leaving the page — on `submit`, on a trusted
 *   click on a sign-in button, on Enter in a login field, and when the form
 *   is removed from the DOM after one of those (the SPA case, Firefox's "form
 *   removal" capture). **Never on navigation alone**: leaving a page with a
 *   password typed and not submitted is not a sign-in, and capturing on
 *   `pagehide` turned "clicked Home" into "signed in" and offered the typo as
 *   an update. Firefox's guards then decide whether a capture is real — the
 *   user interacted since the last one, the same values are never reported
 *   twice — and one of ours on top: **the password, and the username, must
 *   hold the value the user last typed into that very field**. Firefox counts
 *   modification per form, so one keystroke in the username let a password
 *   set by script — the page's, or an assistant's — pass as the user's;
 * - **watches the outcome** of a capture: the field going away — and no
 *   sign-in field coming back for a moment — is a sign-in that worked;
 *   anything else, including a field that is merely disabled while the
 *   request runs or emptied after it, is not evidence of success;
 * - **reports once the document has settled** (`settled: true`), so the
 *   extension can judge a new page by what it shows after loading rather than
 *   by its first, possibly empty, frame;
 * - **fills** a username and password when the extension asks, and **reads**
 *   the current values for "save the login on this page".
 *
 * **One isolated world per name is shared by every CDP session**, measured in
 * Chrome 153: a session that attaches after another left finds the first one's
 * script still in that world. So an install takes over from whatever was there
 * (`__aiBrowserLoginsRegistry`), and its API is published under its own
 * `owner` — never a shared name a later install could not replace, and never
 * one an earlier session's late uninstall could reach. The first version
 * checked "already installed" and returned, which left a re-attached tab with
 * the departed session's script, stopped, and nothing capturing until the
 * page navigated.
 */
export function loginsApiName(owner: string): string {
	return `__aiBrowserLogins_${owner}`;
}

export function loginFormSource(owner: string): string {
	return String.raw`(() => {
'use strict';
const OWNER = ${JSON.stringify(owner)};
const notify = globalThis[${JSON.stringify(loginsBinding)}];
if (typeof notify !== 'function') { return; }
const registry = Array.isArray(globalThis.__aiBrowserLoginsRegistry)
  ? globalThis.__aiBrowserLoginsRegistry : (globalThis.__aiBrowserLoginsRegistry = []);
for (const off of registry.splice(0)) { try { off(); } catch (e) { /* already gone */ } }
// A build before the registry published one fixed name; it is stopped the same way.
try { globalThis.__aiBrowserLogins?.uninstall?.(); } catch (e) { /* already gone */ }
let stopped = false;
const send = (message) => {
  if (stopped) return;
  try { notify(JSON.stringify(message)); } catch (e) { /* the session is gone */ }
};
const teardown = [];
const listen = (target, type, handler, options) => {
  target.addEventListener(type, handler, options);
  teardown.push(() => target.removeEventListener(type, handler, options));
};

// ---- PORT shims for Gecko chrome-only APIs ----
const typeWasPassword = new WeakSet(); // Gecko: element.hasBeenTypePassword
const hasBeenTypePassword = el => el instanceof HTMLInputElement &&
  (el.type === 'password' ? (typeWasPassword.add(el), true) : typeWasPassword.has(el));
const NO_AUTOCOMPLETE_TYPES = ['checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button', 'hidden'];
function getAutocompleteInfo(el) { // Gecko: HTMLInputElement.getAutocompleteInfo()
  if (NO_AUTOCOMPLETE_TYPES.includes(el.type)) return null;
  const t = (el.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/);
  if (t.length > 1 && t[t.length - 1] === 'webauthn') t.pop();
  return { fieldName: t[t.length - 1] || '' };
}
let lastUserGestureTimeStamp = 0; // Gecko: document.lastUserGestureTimeStamp
for (const type of ['keydown', 'pointerdown', 'touchend']) {
  listen(globalThis, type, e => { if (e.isTrusted) lastUserGestureTimeStamp = e.timeStamp; }, true);
}
const formElementsGetter = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get;
const attr = (el, name) => (el.getAttribute && el.getAttribute(name)) || '';
const state = { // LoginFormState, one per document
  fillsByRootElement: new WeakMap(),
  lastSubmittedValuesByRootElement: new WeakMap(),
  fieldModificationsByRootElement: new WeakMap(),
  formlessModifiedPasswordFields: new WeakSet(),
  mockUsernameOnlyField: null,
  captureLoginTimeStamp: 0,
  // PORT: Firefox snapshots a form at fetch success so a removed field can still be read;
  // here every modified root keeps the controls it had when the user last typed into it.
  snapshots: new Map(),
  // Not upstream: the value each field held after the user's last trusted
  // input into it. A capture uses a field only if it still holds that value.
  trustedValues: new WeakMap(),
  // Not upstream: roots the user acted to submit — Enter in a field, a click on
  // a button. A form removed from the page counts as submitted only then.
  intent: new WeakSet(),
};
const trusted = el => el instanceof HTMLInputElement && state.trustedValues.get(el) === el.value;

// ---- NewPasswordModel.sys.mjs ----
const loginRegex =
  /login|log in|log on|log-on|Войти|sign in|sigin|sign\/in|sign-in|sign on|sign-on|ورود|登录|Přihlásit se|Přihlaste|Авторизоваться|Авторизация|entrar|ログイン|로그인|inloggen|Συνδέσου|accedi|ログオン|Giriş Yap|登入|connecter|connectez-vous|Connexion|Вход/i;
const loginFormAttrRegex = /login|log in|log on|log-on|sign in|sigin|sign\/in|sign-in|sign on|sign-on/i;

// ---- LoginManager.shared.sys.mjs (class Logic) ----
function inputTypeIsCompatibleWithUsername(input) {
  const fieldType = input.getAttribute('type')?.toLowerCase() || input.type;
  return ['text', 'email', 'url', 'tel', 'number', 'search'].includes(fieldType) || fieldType?.includes('user');
}
function elementAttrsMatchRegex(element, regex) { // PORT: attributes, not properties
  if (regex.test(attr(element, 'id')) || regex.test(attr(element, 'name')) || regex.test(attr(element, 'class')) ||
      regex.test(attr(element, 'aria-label'))) {
    return true;
  }
  const placeholder = element.getAttribute('placeholder');
  return !!placeholder && regex.test(placeholder);
}
function hasLabelMatchingRegex(element, regex) {
  return regex.test(element.labels?.[0]?.textContent ?? '');
}
function isUsernameFieldType(element, { ignoreConnect = false } = {}) {
  if (!(element instanceof HTMLInputElement)) return false; // PORT: HTMLInputElement.isInstance
  // If the element isn't connected then it isn't visible to the user so
  // shouldn't be considered. It must have been connected in the past.
  if (!element.isConnected && !ignoreConnect) return false;
  if (hasBeenTypePassword(element)) return false; // PORT
  if (!inputTypeIsCompatibleWithUsername(element)) return false;
  const acFieldName = getAutocompleteInfo(element)?.fieldName ?? ''; // PORT
  return acFieldName == 'username' || acFieldName == 'webauthn' ||
    // Bug 1540154: Some sites use tel/email on their username fields.
    acFieldName == 'email' || acFieldName == 'tel' || acFieldName == 'tel-national' ||
    acFieldName == 'off' || acFieldName == 'on' || acFieldName == '';
}
function isPasswordFieldType(element, { ignoreConnect = false } = {}) {
  if (!(element instanceof HTMLInputElement)) return false; // PORT
  if (!element.isConnected && !ignoreConnect) return false;
  if (!hasBeenTypePassword(element)) return false; // PORT
  // Ensure the element is of a type that could have autocomplete. If not, even if it
  // used to be a type=password, we can't treat it as a password input now
  return !!getAutocompleteInfo(element); // PORT
}

// ---- LoginHelper.sys.mjs ----
function isInferredLoginForm(formElement) {
  if (elementAttrsMatchRegex(formElement, loginRegex)) return true;
  const buttons = Array.from(formElement.querySelectorAll('button[type=submit]'));
  // Limit to form with only one submit button to avoid false positives.
  return buttons.length == 1 && loginFormAttrRegex.test(buttons[0].textContent);
}
function isInferredUsernameField(element) {
  const expr = /username/i;
  const ac = getAutocompleteInfo(element)?.fieldName; // PORT
  if (ac && (ac == 'username' || ac == 'webauthn')) return true;
  return elementAttrsMatchRegex(element, expr) || hasLabelMatchingRegex(element, expr);
}
function isInferredNonUsernameField(element) {
  const expr = /\b(search|code|add)\b/i;
  return elementAttrsMatchRegex(element, expr) || hasLabelMatchingRegex(element, expr);
}
function isInferredEmailField(element) {
  const expr = /email|邮箱/i;
  if (element.type == 'email') return true;
  const ac = getAutocompleteInfo(element)?.fieldName; // PORT
  if (ac && ac == 'email') return true;
  return elementAttrsMatchRegex(element, expr) || hasLabelMatchingRegex(element, expr);
}

// ---- FormLikeFactory.sys.mjs ----
function closestFormIgnoringShadowRoots(aField) {
  let form = aField.closest('form');
  let current = aField;
  while (!form) {
    const shadowRoot = current.getRootNode();
    if (!(shadowRoot instanceof ShadowRoot)) break; // PORT: ShadowRoot.isInstance
    const host = shadowRoot.host;
    form = host.closest('form');
    current = host;
  }
  return form;
}
function findRootForField(aField, { ignoreForm = false } = {}) {
  if (!ignoreForm) {
    let form = aField.form || closestFormIgnoringShadowRoots(aField);
    if (form) {
      // If a <form> appears inside another form, use the outermost <form> element.
      let parent = form;
      while ((parent = parent.parentNode)) {
        if (parent instanceof HTMLFormElement) form = parent; // PORT
      }
      return form;
    }
  }
  return aField.ownerDocument.documentElement;
}
function formLikeFor(root) { // createFromForm / createFromDocumentRoot
  if (root instanceof HTMLFormElement) { // PORT: gatherFormElements' nested-<form> merge omitted
    return { elements: [...formElementsGetter.call(root)], rootElement: root };
  }
  // Exclude elements inside the rootElement that are already in a <form> as
  // they will be handled by their own FormLike. PORT: computed once, not lazily.
  return { elements: [...root.querySelectorAll('input, select, textarea')].filter(el => !el.form), rootElement: root };
}
const createFromField = aField => formLikeFor(findRootForField(aField));

// ---- LoginManagerChild.sys.mjs (class LoginFormState) ----
function isProbablyAUsernameLoginForm(formElement, inputElement) {
  if (isInferredUsernameField(inputElement) || isInferredLoginForm(formElement)) {
    // This is where we collect hints that indicate this is not a username login form.
    return !isInferredNonUsernameField(inputElement);
  }
  return false;
}
function getUsernameFieldFromUsernameOnlyForm(form) {
  let candidate = null;
  for (const element of form.elements) {
    // if there is a password field in the form, this is NOT a username-only form.
    if (hasBeenTypePassword(element)) return null; // PORT
    // Ignore input fields whose type are not username compatiable, ex, hidden.
    if (!isUsernameFieldType(element)) continue;
    // If there are more than two input fields whose type is username
    // compatiable, this is NOT a username-only form.
    if (candidate) return null;
    candidate = element;
  }
  return candidate && isProbablyAUsernameLoginForm(form.rootElement, candidate) ? candidate : null;
}
function getPasswordFields(form, { minPasswordLength = 0, ignoreConnect = false } = {}) {
  const pwFields = [];
  for (let i = 0; i < form.elements.length; i++) {
    const element = form.elements[i];
    if (!(element instanceof HTMLInputElement) || !hasBeenTypePassword(element) || // PORT
        (!element.isConnected && !ignoreConnect)) {
      continue;
    }
    // XXX: Bug 780449 tracks our handling of emoji and multi-code-point characters in
    // password fields.
    if (minPasswordLength && element.value.trim().length < minPasswordLength) {
      continue; // Ignore empty or too-short passwords fields
    }
    pwFields[pwFields.length] = { index: i, element };
  }
  // If too few or too many fields, bail out.
  if (!pwFields.length || pwFields.length > 5) return null;
  return pwFields;
}
function getFormFields(form, isSubmission, { ignoreConnect = false } = {}) {
  let usernameField = null, newPasswordField = null, oldPasswordField = null;
  const emptyResult = { usernameField: null, newPasswordField: null, oldPasswordField: null };
  const minSubmitPasswordLength = 2;
  const pwFields = getPasswordFields(form, {
    minPasswordLength: isSubmission ? minSubmitPasswordLength : 0, ignoreConnect });
  // Check whether this is a username-only form when the form doesn't have a password field.
  if (!pwFields) return { ...emptyResult, usernameField: getUsernameFieldFromUsernameOnlyForm(form) };
  // Searching backwards from the first password field until we find a field
  // that looks like a "username" field. If no "username" field is found,
  // consider an email-like field a username field, if any.
  // If neither a username-like or an email-like field exists, assume the
  // first text field before the password field is the username.
  for (let i = pwFields[0].index - 1; i >= 0; i--) {
    const element = form.elements[i];
    if (!isUsernameFieldType(element, { ignoreConnect })) continue;
    if (!usernameField) usernameField = element;
    if (isInferredUsernameField(element)) {
      usernameField = element; // An username field is found, we are done.
      break;
    } else if (isInferredEmailField(element)) {
      usernameField = element; // email-like: keep it, but continue to search for "username"
    }
  }
  // If we're not submitting a form (it's a page load), there are no password field values
  // for us to use for identifying fields. So, just assume the first password field.
  if (!isSubmission || pwFields.length == 1) {
    return { ...emptyResult, usernameField, newPasswordField: pwFields[0].element };
  }
  // Try to figure out what is in the form based on the password values.
  const pw1 = pwFields[0].element.value;
  const pw2 = pwFields[1] ? pwFields[1].element.value : null;
  const pw3 = pwFields[2] ? pwFields[2].element.value : null;
  if (pwFields.length == 3) {
    // Look for two identical passwords, that's the new password
    if (pw1 == pw2 && pw2 == pw3) {
      newPasswordField = pwFields[0].element; // All 3 the same? Weird! Treat as if 1 pw field.
    } else if (pw1 == pw2) {
      newPasswordField = pwFields[0].element; oldPasswordField = pwFields[2].element;
    } else if (pw2 == pw3) {
      oldPasswordField = pwFields[0].element; newPasswordField = pwFields[2].element;
    } else if (pw1 == pw3) { // A bit odd, but could make sense with the right page layout.
      newPasswordField = pwFields[0].element; oldPasswordField = pwFields[1].element;
    } else {
      return emptyResult; // We can't tell which of the 3 passwords should be saved.
    }
  } else if (pw1 == pw2) {
    newPasswordField = pwFields[0].element; // pwFields.length == 2. Treat as if 1 pw field
  } else {
    oldPasswordField = pwFields[0].element; // Just assume that the 2nd password is the new password
    newPasswordField = pwFields[1].element;
  }
  return { ...emptyResult, usernameField, newPasswordField, oldPasswordField };
}
function compareAndUpdatePreviouslySentValues(formLikeRoot, usernameValue, passwordValue) {
  const last = state.lastSubmittedValuesByRootElement.get(formLikeRoot);
  if (last && last.username == usernameValue && last.password == passwordValue) return true;
  // Save the last submitted values so we don't prompt twice for the same values using
  // different capture methods e.g. a form submit event and upon navigation.
  state.lastSubmittedValuesByRootElement.set(formLikeRoot, { username: usernameValue, password: passwordValue });
  return false;
}
function formHasModifiedFields(form) { // signon.userInputRequiredToCapture.enabled = true
  const userHasInteracted = state.captureLoginTimeStamp != lastUserGestureTimeStamp; // PORT
  // Skip if user didn't interact with the page since last call or ever
  if (!userHasInteracted) return false;
  // PORT: upstream also counts a form as modified when some field's .value
  // differs from its .defaultValue. Dropped: a page, or an assistant using
  // browser_fill, sets .value from script, and one trusted click anywhere then
  // made its values look like the user's — staging an "Update password?" with
  // a password the user never typed. Only a trusted input event counts.
  return !!state.fieldModificationsByRootElement.get(form.rootElement);
}
function doesEventClearPrevFieldValue({ target, data, inputType }) {
  return !target.value || (data && data == target.value && inputType !== 'insertReplacementText');
}
function onInput(aEvent) { // observer.handleInput, capture phase
  if (!aEvent.isTrusted) return;
  const field = aEvent.composedPath()[0]; // PORT: aEvent.composedTarget
  const isPasswordType = isPasswordFieldType(field);
  if (!isPasswordType && !isUsernameFieldType(field)) return;
  state.trustedValues.set(field, field.value); // PORT: see trusted()
  const formLike = createFromField(field);
  const formLikeRoot = formLike.rootElement;
  const alreadyModified = state.fieldModificationsByRootElement.get(formLikeRoot);
  const { login: filledLogin, userTriggered: fillWasUserTriggered } = state.fillsByRootElement.get(formLikeRoot) || {};
  // don't flag as user-modified if the form was autofilled and doesn't appear to have changed
  const isAutofillInput = filledLogin && !fillWasUserTriggered;
  if (!alreadyModified && isAutofillInput) {
    if (isPasswordType && filledLogin.password == field.value) return;
    if (!isPasswordType && filledLogin.usernameField && filledLogin.username == field.value) return;
  }
  state.fieldModificationsByRootElement.set(formLikeRoot, true);
  state.snapshots.set(formLikeRoot, formLike.elements); // PORT
  // Keep track of the modified formless password field to trigger form submission when it is removed from DOM.
  if (!(formLikeRoot instanceof HTMLFormElement)) state.formlessModifiedPasswordFields.add(field);
  // When the password field value is cleared or entirely replaced we don't treat it as an autofilled form any more.
  if (isPasswordType && doesEventClearPrevFieldValue(aEvent) && filledLogin && filledLogin.password !== field.value) {
    state.fillsByRootElement.delete(formLikeRoot);
  }
}
function captureOnSubmit(form, { ignoreConnect = false } = {}) { // _maybeSendFormInteractionMessage(+Continue)
  let { usernameField, newPasswordField, oldPasswordField } = getFormFields(form, true, { ignoreConnect });
  if (newPasswordField == null) { // Need at least 1 valid password field to do anything.
    if (usernameField && trusted(usernameField)) { // username-only form. Record the username field but not sending prompt.
      // PORT: only a username the user typed — a script filling step one must
      // not choose the account the password of step two is saved under.
      state.mockUsernameOnlyField = { name: usernameField.name, value: usernameField.value };
    }
    return null;
  }
  // PORT: a password the user did not type is not theirs to save, whatever
  // else in the form they touched.
  if (!trusted(newPasswordField) || (oldPasswordField && !trusted(oldPasswordField))) return null;
  if (usernameField && !trusted(usernameField)) usernameField = null;
  const fullyMungedPattern = /^\*+$|^•+$|^\.+$/;
  if (newPasswordField.value.match(fullyMungedPattern)) return null;
  // When the username field is empty, check whether we have found it previously from a username-only form
  if (!usernameField && state.mockUsernameOnlyField) usernameField = state.mockUsernameOnlyField;
  if (usernameField?.value.match(/\.{3,}|\*{3,}|•{3,}/)) usernameField = null; // looks munged
  if (!formHasModifiedFields(form)) return null; // submitting values that are not changed by the user
  if (compareAndUpdatePreviouslySentValues(form.rootElement, usernameField?.value, newPasswordField.value)) {
    return null; // already submitted with the same username and password
  }
  state.captureLoginTimeStamp = lastUserGestureTimeStamp; // PORT
  return { usernameField, newPasswordField, oldPasswordField };
}

// ==== Everything below is this extension's, around the port ====

const acOf = el => getAutocompleteInfo(el)?.fieldName ?? '';

/** Drawn on the page at all: connected, laid out, not hidden, not transparent. Says nothing about usable. */
function isRendered(el) {
  if (!el.isConnected || el.getClientRects().length === 0) return false;
  if (getComputedStyle(el).visibility === 'hidden') return false;
  let opacity = 1;
  for (let node = el; node && node.nodeType === Node.ELEMENT_NODE && opacity >= 0.1; node = node.parentNode) {
    const value = parseFloat(getComputedStyle(node).opacity);
    if (!Number.isNaN(value)) opacity *= value;
  }
  return opacity >= 0.1;
}

/**
 * On screen and usable, for filling: the test is Browserpass's, minus its
 * viewport clause, so a form below the fold counts. A disabled field is not
 * usable — but it is still *there*, which is why the outcome watch asks
 * isRendered instead: a form disables its inputs while the request runs, and
 * reading that as "the form went away" called every wrong password a success.
 */
function isVisible(el) {
  return !el.disabled && isShown(el);
}

/** Rendered at the size of a real field: a one-pixel honeypot is drawn, and is not a form. */
function isShown(el) {
  return el.offsetWidth >= 30 && el.offsetHeight >= 10 && isRendered(el);
}

/**
 * A password field is on screen — any password field, new-password ones
 * included. A sign-up or reset form the server rejected and drew again is all
 * new-password fields, and leaving those out read that rejection as a success.
 * The same rule as the extension's for a new document.
 */
function passwordFieldShown() {
  for (const el of document.querySelectorAll('input')) {
    if (isPasswordFieldType(el) && isShown(el)) return true;
  }
  return false;
}

/**
 * The outermost form around a form. Not findRootForField(form): a control named
 * "form" shadows that property on the form element itself.
 */
function outermostForm(form) {
  let root = form;
  for (let parent = form.parentNode; parent; parent = parent.parentNode) {
    if (parent instanceof HTMLFormElement) root = parent;
  }
  return root;
}

/** Every root in the document: each outermost form, and the document itself for formless fields. */
function roots() {
  const list = [...document.forms].filter(form => outermostForm(form) === form).slice(0, 50);
  if (document.documentElement) list.push(document.documentElement);
  return list;
}

// ---- what the frame shows ----
let lastReport = '';
function report() {
  let login = false, password = false, newPassword = false, usernameOnly = false;
  for (const el of document.querySelectorAll('input')) {
    if (el.type === 'password') typeWasPassword.add(el);
    // Shown, not usable: this report is what the page displays, and a sign-in
    // form disabled while a request runs is still a sign-in form on screen.
    if (!isPasswordFieldType(el) || !isShown(el)) continue;
    password = true;
    if (acOf(el) === 'new-password') newPassword = true; else login = true;
  }
  if (!password) {
    for (const root of roots()) {
      const username = getUsernameFieldFromUsernameOnlyForm(formLikeFor(root));
      if (username && isVisible(username)) { usernameOnly = true; break; }
    }
  }
  const message = { type: 'fields', login, password, newPassword, usernameOnly, settled: false };
  const key = JSON.stringify(message);
  if (key !== lastReport) { lastReport = key; send(message); }
  return message;
}
let scheduled = 0;
const schedule = () => {
  if (stopped || scheduled) return;
  scheduled = setTimeout(() => { scheduled = 0; try { report(); } catch (e) { /* a page mid-teardown */ } }, 300);
};
/**
 * One report after the document has loaded and had time to draw, sent whether
 * or not anything changed. The first report goes out 300 ms after the document
 * starts, before a slow page has drawn its form at all — judging a navigation
 * by that one called a re-rendered sign-in form "no form, so it worked".
 */
let settledTimer = 0;
const reportSettled = () => {
  clearTimeout(settledTimer);
  settledTimer = setTimeout(() => {
    try { const message = report(); send({ ...message, settled: true }); } catch (e) { /* a page mid-teardown */ }
  }, 1500);
};

// ---- capturing ----
let watchGeneration = 0;
/**
 * What became of a submission, judged in the page.
 *
 * Only one thing is evidence that a sign-in worked: the field leaves the page
 * (removed, hidden, collapsed) and no password field takes its place for
 * 1.5 s. A form that re-renders itself with an error message replaces the
 * field with a new one, which the confirmation catches. Everything else —
 * the field disabled while the request runs, emptied after it, still there
 * after 12 s — ends as "remained", and remained is never an offer. A missed
 * offer costs the user one later sign-in; a wrong one costs their password.
 */
function watchOutcome(field, removed) {
  const generation = ++watchGeneration;
  const started = Date.now();
  let goneSince = removed ? Date.now() : 0;
  const tick = () => {
    if (stopped || generation !== watchGeneration) return;
    if (goneSince) {
      if (passwordFieldShown()) { send({ type: 'outcome', result: 'remained' }); return; }
      if (Date.now() - goneSince >= 1500) { send({ type: 'outcome', result: 'gone' }); return; }
    } else if (!field.isConnected || !isRendered(field)) {
      goneSince = Date.now();
    } else if (Date.now() - started > 12000) {
      send({ type: 'outcome', result: 'remained' }); return;
    }
    setTimeout(tick, 250);
  };
  setTimeout(tick, removed ? 0 : 250);
}
let lastUsernameSent = '';
function describe(form, fields, ignoreConnect) {
  const { usernameField, newPasswordField, oldPasswordField } = fields;
  const username = usernameField?.value ?? '';
  if (oldPasswordField) {
    return { kind: 'change', username, password: oldPasswordField.value, newPassword: newPasswordField.value };
  }
  const count = getPasswordFields(form, { minPasswordLength: 2, ignoreConnect })?.length ?? 0;
  if (count >= 2 || acOf(newPasswordField) === 'new-password') {
    return { kind: 'signup', username, password: '', newPassword: newPasswordField.value };
  }
  return { kind: 'login', username, password: newPasswordField.value, newPassword: '' };
}
function capture(form, options = {}) {
  const fields = captureOnSubmit(form, options);
  if (!fields) {
    // The first step of a two-step sign-in. Remembered only when the user
    // typed it: a page calling requestSubmit() on a field it filled itself
    // must not choose which account the next password is saved under.
    const remembered = state.mockUsernameOnlyField?.value;
    if (remembered && remembered !== lastUsernameSent && state.fieldModificationsByRootElement.get(form.rootElement)) {
      lastUsernameSent = remembered;
      send({ type: 'submit', kind: 'username', username: remembered, password: '', newPassword: '' });
    }
    return;
  }
  send({ type: 'submit', ...describe(form, fields, options.ignoreConnect) });
  watchOutcome(fields.newPasswordField, !!options.ignoreConnect);
}
/** A form the user acted to submit, now gone from the page: Firefox's form-removal capture. */
function captureRemoved() {
  for (const [root, elements] of [...state.snapshots]) {
    if (!state.intent.has(root)) continue;
    const passwords = elements.filter(el => hasBeenTypePassword(el));
    if (!passwords.length || !passwords.some(el => !el.isConnected)) continue;
    state.snapshots.delete(root);
    state.intent.delete(root);
    capture({ elements, rootElement: root }, { ignoreConnect: true });
  }
}

const submitWords = /log ?in|log ?on|sign ?in|sign ?on|submit|continue|next|verify|change|save|update|reset|войти|вход|далее|продолжить|сохранить|изменить|anmelden|weiter|connexion|entrar|acceder/i;
const labelOf = el => [el.textContent, attr(el, 'value'), attr(el, 'aria-label'), attr(el, 'title'),
  attr(el, 'id'), attr(el, 'name')].join(' ').slice(0, 300);

listen(globalThis, 'input', e => { try { onInput(e); } catch (err) { /* never break the page's typing */ } }, true);
listen(globalThis, 'submit', e => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  const root = outermostForm(form);
  state.intent.add(root);
  capture(formLikeFor(root));
}, true);
listen(globalThis, 'click', e => {
  if (!e.isTrusted) return;
  const target = e.composedPath()[0];
  const button = target instanceof Element
    ? target.closest('button, input[type=submit], input[type=button], input[type=image], [role=button], a') : null;
  if (!button) return;
  const submits = button.type === 'submit' || submitWords.test(labelOf(button));
  // A link is not a way to submit unless it says so: following "Home" with a
  // password typed is leaving, not signing in.
  if (button.localName === 'a' && !submits) return;
  const form = button.form || closestFormIgnoringShadowRoots(button);
  const root = form ? outermostForm(form) : document.documentElement;
  state.intent.add(root);
  if (submits) capture(formLikeFor(root));
}, true);
listen(globalThis, 'keydown', e => {
  if (!e.isTrusted || e.key !== 'Enter') return;
  const field = e.composedPath()[0];
  if (!isPasswordFieldType(field) && !isUsernameFieldType(field)) return;
  const formLike = createFromField(field);
  state.intent.add(formLike.rootElement);
  capture(formLike);
}, true);

const observer = new MutationObserver(records => {
  let removals = false;
  for (const record of records) {
    if (record.type === 'attributes' && record.attributeName === 'type' && record.oldValue?.toLowerCase() === 'password') {
      typeWasPassword.add(record.target);
    }
    if (record.removedNodes.length) removals = true;
  }
  if (removals && state.snapshots.size) captureRemoved();
  schedule();
});
observer.observe(document, {
  subtree: true, childList: true, attributes: true, attributeOldValue: true,
  attributeFilter: ['type', 'class', 'style', 'hidden', 'disabled'],
});
for (const type of ['DOMContentLoaded', 'load', 'pageshow', 'focusin']) listen(globalThis, type, schedule, true);
listen(globalThis, 'load', reportSettled, true);
listen(globalThis, 'pageshow', reportSettled, true);
if (document.readyState === 'complete') reportSettled();
schedule();

// ---- filling and reading, for the extension ----
function deepActiveElement() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
/** The login form to act on: the one with focus, then a form that looks like a login, then any. */
function target() {
  const active = deepActiveElement();
  const candidates = [];
  for (const root of roots()) {
    const form = formLikeFor(root);
    const passwords = form.elements.filter(el => isPasswordFieldType(el) && isVisible(el));
    let username = null;
    if (passwords.length) {
      username = getFormFields(form, false).usernameField;
    } else {
      username = getUsernameFieldFromUsernameOnlyForm(form);
      if (!username || !isVisible(username)) continue;
    }
    const current = passwords.find(el => acOf(el) === 'current-password')
      || passwords.find(el => acOf(el) !== 'new-password') || null;
    const score = (form.elements.includes(active) ? 8 : 0) + (current ? 4 : 0)
      + (root instanceof HTMLFormElement && isInferredLoginForm(root) ? 2 : 0) + (root instanceof HTMLFormElement ? 1 : 0);
    candidates.push({ form, username: username && isVisible(username) ? username : null,
      password: current, newPasswordOnly: passwords.length > 0 && !current, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
/**
 * Writes a value the way typing would be seen. The setter is this world's own
 * prototype setter: React's per-instance override lives on the page world's
 * wrapper, so its tracker keeps the old value and the input event counts as a
 * change. The value attribute is never set — that would put the password in
 * outerHTML, which an MCP tool hands to an assistant.
 */
function setValue(el, value) {
  el.focus({ preventScroll: true });
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
  nativeValue.call(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
/**
 * The extension names the origins it means. An execution context id is reused
 * after a cross-site navigation — the new document's worlds start numbering
 * again — so a call aimed at site A's frame can arrive in site B's. It asks
 * self.origin, the document's security origin, and not location.origin, which
 * is only the URL's, and the two disagree in both directions. A frame sandboxed
 * without allow-same-origin sits at the site's own address with an opaque
 * origin, so the URL would have handed it the site's password; an about:blank
 * or srcdoc frame has the page's origin and a URL whose origin is "null", so
 * the URL refused every fill there. This world's globals are its own, so the
 * page cannot redefine either.
 */
const here = origins => Array.isArray(origins) && origins.includes(self.origin);
function fill(username, password, onlyEmpty, origins) {
  if (!here(origins)) return { username: false, password: false, reason: 'noFields' };
  const found = target();
  if (!found) return { username: false, password: false, reason: 'noFields' };
  // A sign-up or change form: a saved password belongs in none of its fields.
  if (found.newPasswordOnly) return { username: false, password: false, reason: 'newPasswordOnly' };
  const passwordField = found.password;
  const usernameField = found.username;
  if (onlyEmpty && ((usernameField && usernameField.value) || (passwordField && passwordField.value)
      || (passwordField && passwordField.type !== 'password'))) {
    return { username: false, password: false, reason: 'notEmpty' };
  }
  for (const [field, value] of [[usernameField, username], [passwordField, password]]) {
    if (field && value && field.maxLength > 0 && value.length > field.maxLength) {
      return { username: false, password: false, reason: 'tooLong' };
    }
  }
  state.fillsByRootElement.set(found.form.rootElement,
    { login: { username, password, usernameField }, userTriggered: !onlyEmpty });
  let filledUsername = false, filledPassword = false;
  if (usernameField && username) {
    if (usernameField.value !== username) setValue(usernameField, username);
    filledUsername = true;
  }
  if (passwordField && password) {
    if (passwordField.value !== password) setValue(passwordField, password);
    filledPassword = true;
  }
  return { username: filledUsername, password: filledPassword };
}
function read(origins) {
  if (!here(origins)) return undefined;
  const found = target();
  if (!found) return undefined;
  const fields = getFormFields(found.form, true);
  if (!fields.newPasswordField) return undefined;
  return describe(found.form, fields, false);
}
/**
 * Everything this script attached, removed: its session is going, and a dead
 * binding should not keep a MutationObserver busy. A departed session's late
 * call names its own owner and leaves a newer install alone.
 */
function uninstall(who) {
  if (who !== undefined && who !== OWNER) return;
  stopped = true;
  observer.disconnect();
  clearTimeout(scheduled);
  clearTimeout(settledTimer);
  watchGeneration++;
  for (const off of teardown.splice(0)) off();
}
Object.defineProperty(globalThis, '__aiBrowserLogins_' + OWNER, { value: Object.freeze({ fill, read, uninstall }), configurable: true });
registry.push(() => uninstall());
})();`;
}
