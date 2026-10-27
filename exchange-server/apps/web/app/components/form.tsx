"use client";
import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type FormHTMLAttributes,
  type InputHTMLAttributes,
} from "react";
const Validation = createContext<{
  errors: Record<string, string>;
  clear: (name: string) => void;
}>({ errors: {}, clear: () => {} });
// Explicit submission preserves uncontrolled inputs when a caught API error occurs.
export function Form({
  action,
  error,
  errorField,
  children,
  ...props
}: Omit<FormHTMLAttributes<HTMLFormElement>, "action"> & {
  action: (data: FormData) => void | Promise<void>;
  error?: string;
  errorField?: string;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<string>();
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const visible = error && error !== dismissed ? error : "";
  return (
    <Validation.Provider
      value={{
        errors: {
          ...errors,
          ...(visible && errorField ? { [errorField]: visible } : {}),
        },
        clear: (name) => {
          setErrors((current) => {
            const next = { ...current };
            delete next[name];
            return next;
          });
          if (name === errorField) setDismissed(error);
        },
      }}
    >
      <form
        {...props}
        noValidate
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          const form = event.currentTarget;
          const next: Record<string, string> = {};
          let first: HTMLInputElement | undefined;
          for (const field of Array.from(form.elements)) {
            if (!(field instanceof HTMLInputElement) || field.disabled)
              continue;
            const blank =
              field.required &&
              field.type !== "password" &&
              !field.value.trim();
            if (blank || !field.validity.valid) {
              next[field.name] = blank
                ? "Please fill out this field."
                : field.validity.patternMismatch
                  ? "Enter a 6-digit authenticator code."
                  : field.validity.tooShort
                    ? `Use at least ${field.minLength} characters.`
                    : field.validationMessage;
              first ??= field;
            }
          }
          setErrors(next);
          if (first) {
            first.focus();
            return;
          }
          submitting.current = true;
          setPending(true);
          setDismissed(undefined);
          try {
            await action(new FormData(form));
          } finally {
            submitting.current = false;
            setPending(false);
          }
        }}
      >
        {pending && <span className="liquid-loader" role="status" aria-label="Submitting…" />}
        {children}
        {visible && !errorField && (
          <p className="error" role="alert">
            {visible}
          </p>
        )}
      </form>
    </Validation.Provider>
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const { errors, clear } = useContext(Validation);
  const error = errors[props.name ?? ""];
  return (
    <span className="form-field">
      <input
        {...props}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [props["aria-describedby"], error ? id : ""]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onChange={(event) => {
          clear(props.name ?? "");
          props.onChange?.(event);
        }}
      />
      {error && (
        <span id={id} className="field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
