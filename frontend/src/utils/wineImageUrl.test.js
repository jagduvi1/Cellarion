import { getWineImageUrl } from './wineImageUrl';
import { API_URL } from '../api/apiConstants';

describe('getWineImageUrl', () => {
  test('returns null for missing image', () => {
    expect(getWineImageUrl(null)).toBeNull();
    expect(getWineImageUrl(undefined)).toBeNull();
    expect(getWineImageUrl('')).toBeNull();
  });

  test('passes full external URLs through unchanged', () => {
    expect(getWineImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(getWineImageUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
  });

  test('passes data URLs through unchanged', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    expect(getWineImageUrl(dataUrl)).toBe(dataUrl);
  });

  test('prefixes internal API paths with API_URL', () => {
    expect(getWineImageUrl('/api/uploads/processed/a.png')).toBe(`${API_URL}/api/uploads/processed/a.png`);
  });

  test('treats plain filenames as uploads', () => {
    expect(getWineImageUrl('abc.png')).toBe(`${API_URL}/api/uploads/abc.png`);
  });
});
