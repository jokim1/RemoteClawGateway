import { extractGoogleDocsDocumentIdFromUrl, hasGoogleDocsDocumentUrl } from '../google-docs-url.js';

describe('google docs URL helpers', () => {
  test('extracts document id from canonical docs URL', () => {
    const url = 'https://docs.google.com/document/d/1wNDevnRe-SbUAj6eNUwb-RJFRenWnUSUS11iKfIr2Eo/edit?usp=sharing';
    expect(extractGoogleDocsDocumentIdFromUrl(url)).toBe('1wNDevnRe-SbUAj6eNUwb-RJFRenWnUSUS11iKfIr2Eo');
    expect(hasGoogleDocsDocumentUrl(url)).toBe(true);
  });

  test('extracts document id from /u/ path variant', () => {
    const url = 'https://docs.google.com/document/u/0/d/abc123_DEF-456/edit';
    expect(extractGoogleDocsDocumentIdFromUrl(url)).toBe('abc123_DEF-456');
  });

  test('does not match non-docs URLs', () => {
    expect(extractGoogleDocsDocumentIdFromUrl('https://example.com/document/d/abc')).toBeUndefined();
    expect(extractGoogleDocsDocumentIdFromUrl('https://docs.google.com/spreadsheets/d/abc')).toBeUndefined();
    expect(hasGoogleDocsDocumentUrl('hello world')).toBe(false);
  });
});
