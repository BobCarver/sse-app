/// <reference lib="dom" />
import { qrcode } from "@libs/qrcode";
import type { AdminOverview } from "../src/adminTypes.ts";
import { renderJudges, renderOverview, type ViewState } from "./adminView.ts";

const OPEN_KEY = "admin-open";
const POLL_MS = 3000;

/**
 * A phone number as WhatsApp wants it: international format, digits only (no
 * "+", spaces, dashes, brackets or leading "00"). Returns "" if what was typed
 * cannot be a full international number, so the caller falls back to letting
 * the person pick a contact.
 */
export function whatsappNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^00/, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : "";
}

/** The link someone can open to act as a device, plus how to hand it over. */
export function shareLinks(
  link: string,
  name: string,
  email?: string,
  phone?: string,
): { mailto: string; sms: string; whatsapp: string } {
  const text = `Your link for ${name}. Open it on your device: ${link}`;
  const number = whatsappNumber(phone ?? "");
  return {
    mailto: `mailto:${encodeURIComponent(email ?? "")}?subject=${
      encodeURIComponent(`Your link: ${name}`)
    }&body=${encodeURIComponent(text)}`,
    sms: `sms:${number ? `+${number}` : ""}?&body=${encodeURIComponent(text)}`,
    // wa.me opens WhatsApp with the message ready to send; without a number it
    // opens the contact chooser.
    whatsapp: `https://wa.me/${number}?text=${encodeURIComponent(text)}`,
  };
}

/** QR code for `text` as inline SVG (without the XML prolog, which does not belong in HTML). */
export function qrSvg(text: string): string {
  return qrcode(text, { output: "svg" }).replace(/^[\s\S]*?(?=<svg)/, "");
}

function readOpen(): Map<string, boolean> {
  try {
    return new Map(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
  } catch {
    return new Map();
  }
}

export function startAdminPage(doc: Document = document): void {
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  const login = $<HTMLFormElement>("login");
  const loginDialog = $<HTMLDialogElement>("loginDialog");
  const app = $("app");
  const tree = $("tree");
  const judges = $("judges");
  const toastEl = $("toast");
  const dialog = $<HTMLDialogElement>("linkDialog");

  const open = readOpen();
  const state: ViewState = {
    isOpen: (key, dflt) => open.get(key) ?? dflt,
    now: Date.now(),
  };
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const toast = (text: string, bad = false) => {
    toastEl.textContent = text;
    toastEl.className = bad ? "bad" : "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.textContent = "", 6000);
  };

  /** Every admin call: same-origin cookie plus the header that proves it is this page. */
  async function api(
    method: string,
    path: string,
    body?: BodyInit | null,
    json = false,
  ): Promise<Response> {
    const headers: Record<string, string> = { "x-admin-request": "1" };
    if (json) headers["content-type"] = "application/json";
    const res = await fetch(path, {
      method,
      headers,
      body,
      credentials: "same-origin",
    });
    if (res.status === 401) showLogin();
    return res;
  }

  function showLogin(): void {
    clearTimeout(timer);
    app.hidden = true;
    if (!loginDialog.open) loginDialog.showModal();
    ($("token") as HTMLInputElement).focus();
  }

  function showApp(): void {
    loginDialog.close();
    app.hidden = false;
    void refresh();
  }

  async function refresh(): Promise<void> {
    clearTimeout(timer);
    try {
      const res = await api("GET", "/admin/overview");
      if (res.ok) {
        const text = await res.text();
        if (text !== last) {
          last = text;
          const o = JSON.parse(text) as AdminOverview;
          state.now = Date.now();
          tree.innerHTML = renderOverview(o, state);
          judges.innerHTML = renderJudges(o);
        }
        $("conn").textContent = "";
      } else if (res.status !== 401) {
        $("conn").textContent = `server error (${res.status})`;
      }
    } catch {
      $("conn").textContent = "server unreachable";
    }
    if (!app.hidden) timer = setTimeout(refresh, POLL_MS);
  }

  // --- sign in / out --------------------------------------------------------
  // The sign-in popup cannot be dismissed (Esc) without a valid token.
  loginDialog.addEventListener("cancel", (e) => e.preventDefault());
  login.onsubmit = async (e) => {
    e.preventDefault();
    const input = $("token") as HTMLInputElement;
    const res = await fetch("/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: input.value }),
      credentials: "same-origin",
    });
    input.value = "";
    if (res.ok) {
      $("loginError").textContent = "";
      showApp();
    } else {
      $("loginError").textContent = res.status === 401
        ? "Wrong token."
        : "Could not sign in.";
    }
  };
  $("logout").onclick = async () => {
    await api("POST", "/admin/logout");
    last = "";
    showLogin();
  };

  // --- tabs -----------------------------------------------------------------
  for (const tab of ["festival", "judges"] as const) {
    $(`tab-${tab}`).onclick = () => {
      $("tree").hidden = tab !== "festival";
      $("judges").hidden = tab !== "judges";
      $("tab-festival").setAttribute(
        "aria-selected",
        String(tab === "festival"),
      );
      $("tab-judges").setAttribute("aria-selected", String(tab === "judges"));
    };
  }

  // Remember which triangles are open (toggle does not bubble, so capture it).
  app.addEventListener("toggle", (e) => {
    const el = e.target as HTMLDetailsElement;
    if (el.dataset?.key) {
      open.set(el.dataset.key, el.open);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
      } catch { /* private mode: not remembered */ }
    }
  }, true);

  // --- links ----------------------------------------------------------------
  /** Who the open dialog is for, so the share buttons can follow the phone field. */
  let shareTarget: { link: string; name: string; email?: string } | undefined;

  function updateShare(): void {
    if (!shareTarget) return;
    const phone = ($("phone") as HTMLInputElement).value;
    const share = shareLinks(
      shareTarget.link,
      shareTarget.name,
      shareTarget.email,
      phone,
    );
    ($("mailto") as HTMLAnchorElement).href = share.mailto;
    ($("sms") as HTMLAnchorElement).href = share.sms;
    ($("whatsapp") as HTMLAnchorElement).href = share.whatsapp;
    $("phoneHint").textContent = !phone.trim()
      ? "Add a number (with country code) to send straight to one person."
      : whatsappNumber(phone)
      ? ""
      : "Use the full international number, for example +44 7700 900123.";
  }
  $("phone").oninput = updateShare;

  async function newLink(
    clientId: string,
    name: string,
    email: string,
  ): Promise<void> {
    const res = await api(
      "POST",
      "/admin/credentials",
      JSON.stringify({ client_id: clientId, label: `${name} (admin page)` }),
      true,
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return toast(
        body.error ?? `Could not create a link (${res.status})`,
        true,
      );
    }
    shareTarget = { link: body.link, name, email: email || undefined };
    ($("phone") as HTMLInputElement).value = "";
    updateShare();
    $("linkTitle").textContent = `Link for ${name}`;
    ($("linkText") as HTMLInputElement).value = body.link;
    $("qr").innerHTML = qrSvg(body.link);
    $("linkNote").textContent = email
      ? `Email goes to ${email}.`
      : "No email on file: your mail app will ask for the address.";
    dialog.showModal();
    last = ""; // show the new link in the list
    void refresh();
  }

  async function copy(): Promise<void> {
    const input = $("linkText") as HTMLInputElement;
    try {
      // Clipboard API only exists on https/localhost; select-and-copy elsewhere.
      if (navigator.clipboard) await navigator.clipboard.writeText(input.value);
      else throw new Error("no clipboard api");
    } catch {
      input.select();
      doc.execCommand("copy");
    }
    toast("Link copied");
  }
  $("copy").onclick = copy;
  $("closeDialog").onclick = () => {
    dialog.close();
    ($("linkText") as HTMLInputElement).value = ""; // shown once
    $("qr").innerHTML = "";
    shareTarget = undefined;
    ($("phone") as HTMLInputElement).value = ""; // phone numbers are not kept
  };

  // --- actions --------------------------------------------------------------
  async function act(
    method: string,
    path: string,
    label: string,
  ): Promise<void> {
    const res = await api(method, path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toast(`${label}: ${body.error ?? res.status}`, true);
    const missing = body.missing_audio?.length
      ? ` (${body.missing_audio.length} audio file(s) missing)`
      : "";
    toast(`${label}: ok${missing}`);
    last = "";
    void refresh();
  }

  async function upload(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    const { competition, competitor, kind } = input.dataset;
    const path = `/admin/audio/${competition}/${competitor}/${kind}`;
    let res = await api("PUT", path, file);
    if (res.status === 409) {
      if (
        !confirm(
          "Uploads are closed for this session. Replace the audio anyway?",
        )
      ) {
        input.value = "";
        return;
      }
      res = await api("PUT", `${path}?force=1`, file);
    }
    const body = await res.json().catch(() => ({}));
    input.value = "";
    if (!res.ok) {
      return toast(`Upload failed: ${body.error ?? res.status}`, true);
    }
    toast(`Uploaded ${kind} audio`);
    last = "";
    void refresh();
  }

  app.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!el || el.tagName === "INPUT") return;
    const { action, id, client, name, email } = el.dataset;
    if (action === "new-link") void newLink(client!, name!, email ?? "");
    else if (action === "revoke") {
      if (confirm("Revoke this link? The device is locked out immediately.")) {
        void act("DELETE", `/admin/credentials/${id}`, "Revoke");
      }
    } else if (action === "start") {
      void act("POST", `/sessions/${id}/start`, "Start");
    } else if (action === "skip") {
      void act("POST", `/admin/sessions/${id}/skip`, "Skip");
    } else if (action === "abort") {
      if (confirm("Abort this session now?")) {
        void act("POST", `/admin/sessions/${id}/abort`, "Abort");
      }
    }
    // Buttons inside a <summary> must not also toggle the section.
    if (el.closest("summary")) e.preventDefault();
  });
  app.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset?.action === "upload") void upload(t);
  });

  // Start: signed in already (cookie) or show the form.
  fetch("/admin/me", { credentials: "same-origin" })
    .then((r) => r.ok ? showApp() : showLogin())
    .catch(showLogin);
}
