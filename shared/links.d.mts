/** True only for an absolute, credential-free HTTP(S) URL without control characters. */
export function validLinkHref(value: unknown): value is string

/** Trims and normalizes an HTTP(S) URL, adding https:// to a bare domain. */
export function normalizeLinkHref(value: string): string | null
