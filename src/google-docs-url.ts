const GOOGLE_DOCS_URL_RE = /^https?:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/i;

export function extractGoogleDocsDocumentIdFromUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(GOOGLE_DOCS_URL_RE);
  return match?.[1];
}

export function hasGoogleDocsDocumentUrl(value: string): boolean {
  return Boolean(extractGoogleDocsDocumentIdFromUrl(value));
}
