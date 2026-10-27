/** Clipboard API requires a secure context; local HTTP IPs need the selection fallback. */
export async function copyText(value: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const previous = document.activeElement;
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy"))
      throw new Error("Select the value and copy it manually.");
  } finally {
    field.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}
