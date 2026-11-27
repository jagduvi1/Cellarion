// utils/importPhotoLinks — the photo links of the file in hand stay in the
// browser; rows carry references, and only links on an allowed photo store
// (the twin of backend config/importPhotoSources) get one.
import { describe, it, expect } from 'vitest';
import { isImportPhotoLink, startPhotoLinks, photoRefFor, photoLinkFor } from './importPhotoLinks';

const LINK = 'https://firebasestorage.googleapis.com/v0/b/ma-cave-a-vins-app.appspot.com/o/wines%2Fu%2Fp1?alt=media&token=t';

describe('isImportPhotoLink', () => {
  it('accepts the app\'s photo store and nothing else', () => {
    expect(isImportPhotoLink(LINK)).toBe(true);
    expect(isImportPhotoLink(`  ${LINK}  `)).toBe(true);
    expect(isImportPhotoLink('https://firebasestorage.googleapis.com/v0/b/other-app.appspot.com/o/x')).toBe(false);
    expect(isImportPhotoLink('http://firebasestorage.googleapis.com/v0/b/ma-cave-a-vins-app.appspot.com/o/x')).toBe(false);
    expect(isImportPhotoLink('https://firebasestorage.googleapis.com:8443/v0/b/ma-cave-a-vins-app.appspot.com/o/x')).toBe(false);
    expect(isImportPhotoLink('file:///Users/me/photo.jpg')).toBe(false);
    expect(isImportPhotoLink('photo.jpg')).toBe(false);
    expect(isImportPhotoLink(undefined)).toBe(false);
  });
});

describe('photo references', () => {
  it('gives the same link the same reference, and resolves it back', () => {
    startPhotoLinks();
    const ref = photoRefFor(LINK);
    expect(ref).toMatch(/^photo-/);
    expect(ref).not.toContain('token');
    expect(photoRefFor(` ${LINK} `)).toBe(ref);
    expect(photoLinkFor(ref)).toBe(LINK);
  });

  it('gives no reference to a link no photo store would serve', () => {
    startPhotoLinks();
    expect(photoRefFor('https://example.com/photo.jpg')).toBeUndefined();
  });

  it('forgets the references of the file before when a new file is read', () => {
    startPhotoLinks();
    const ref = photoRefFor(LINK);
    startPhotoLinks();
    expect(photoLinkFor(ref)).toBeUndefined();
    expect(photoRefFor(LINK)).not.toBe(ref);
  });
});
