import displayableImage from './displayableImage';

test('passes own upload paths, inline images and http(s) links', () => {
  expect(displayableImage('/api/uploads/abc-123.png')).toBe('/api/uploads/abc-123.png');
  expect(displayableImage('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(displayableImage(' https://cdn.example.com/a.png ')).toBe('https://cdn.example.com/a.png');
});

test('refuses shapes that would carry the viewer somewhere else', () => {
  for (const bad of ['//attacker.example/a.png', 'javascript:alert(1)', '/api/uploads/../../x', '/etc/passwd', 'data:text/html;base64,PA==', 'label.png', '', null, undefined, {}]) {
    expect(displayableImage(bad)).toBeNull();
  }
});
