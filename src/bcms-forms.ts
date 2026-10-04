// @bettercms-ai/convert forms-helper v2
// Written by @bettercms-ai/convert; a re-run rewrites it, so do not edit it.
// Resolves a BetterCMS form by NAME at build, for the environment that is building this site: the id
// from bcms-content.json (written into the tree before the build) and the endpoint from BCMS_API_URL.
// The source names no host and no id, so every BetterCMS environment builds its own wiring.
// A form it cannot resolve renders unwired (no action, no method, no id) with one warning line, and
// the build goes on. Form NAMES are the contract between environments: rename a form on every one.
import { existsSync, readFileSync } from "node:fs";

type SnapshotForm = { id: string; name: string; projectId?: string | null; ignoredAt?: string | null };
type Snapshot = { projectId: string | null; forms: SnapshotForm[] };
type Wiring = { id: string; action: string };

let snapshot: Snapshot | null | undefined;
const resolved = new Map<string, Wiring | undefined>();

const env = (key: string): string | undefined => process.env[key] || process.env[`PUBLIC_${key}`] || undefined;

const isForm = (value: unknown): value is SnapshotForm =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { name?: unknown }).name === "string";

function readSnapshot(): Snapshot | null {
  for (const file of ["bcms-content.json", "bcms-content/forms.json"]) {
    if (!existsSync(file)) continue;
    try {
      const data: unknown = JSON.parse(readFileSync(file, "utf8"));
      const record = (Array.isArray(data) ? { forms: data } : (data ?? {})) as { forms?: unknown; projectId?: unknown };
      const forms: unknown[] = Array.isArray(record.forms) ? record.forms : [];
      if (!forms.every(isForm)) throw new Error("a form entry has no id or name");
      return { projectId: typeof record.projectId === "string" ? record.projectId : null, forms };
    } catch (error) {
      // Read once per build, so this is the one line however many forms the site has.
      console.warn(`[bcms-forms] FORMS_SNAPSHOT_UNREADABLE: ${file} could not be read (${error instanceof Error ? error.message : String(error)}); every form renders unwired.`);
      return null;
    }
  }
  return null;
}

function unwired(code: string, name: string, why: string): undefined {
  console.warn(`[bcms-forms] ${code}: form "${name}" renders unwired; ${why}.`);
  return undefined;
}

function resolve(name: string): Wiring | undefined {
  if (snapshot === undefined) snapshot = readSnapshot();
  // No snapshot (a local dev build), or one it could not read: the form renders unwired, as before.
  if (snapshot === null) return undefined;
  const project = env("BCMS_PROJECT_ID") ?? snapshot.projectId;
  // The forms the conversion brief names from: this project's own, ignored ones left out.
  const own = snapshot.forms.filter((f) => !f.ignoredAt && (!project || f.projectId === project));
  const hits = own.filter((f) => f.name === name);
  const form = hits.length === 1 ? hits[0] : undefined;
  if (!form && hits.length > 1) {
    return unwired("BCMS_FORM_NAME_AMBIGUOUS", name, `${hits.length} forms in this project share that name; rename one in the Forms tab`);
  }
  if (!form) {
    return unwired(
      "BCMS_FORM_NOT_FOUND",
      name,
      own.length === 0
        ? "this project has no forms yet; the release of this build derives them"
        : "no form in this project has that name; a name is shared by every environment, so rename the form on each one",
    );
  }
  const api = env("BCMS_API_URL");
  if (!api) return unwired("BCMS_FORM_API_URL_MISSING", name, "BCMS_API_URL is not set, so it has nowhere to post");
  return { id: form.id, action: `${api.replace(/\/$/, "")}/api/v1/forms/public/${form.id}/submissions` };
}

/** Resolved once per name, so a form's three attributes print one warning, not three. */
function wiring(name: string): Wiring | undefined {
  if (!resolved.has(name)) resolved.set(name, resolve(name));
  return resolved.get(name);
}

export const bcmsFormId = (name: string): string | undefined => wiring(name)?.id;

export const bcmsFormAction = (name: string): string | undefined => wiring(name)?.action;

/** "post" only for a form that resolved: an unwired form keeps no method, like its action and id. */
export const bcmsFormMethod = (name: string): "post" | undefined => (wiring(name) ? "post" : undefined);
