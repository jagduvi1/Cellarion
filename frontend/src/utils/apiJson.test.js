import { apiJson } from './apiJson';

// Minimal stand-in for a fetch Response with just the bits apiJson uses.
const makeRes = (ok, status, jsonImpl) => ({
  ok,
  status,
  json: jsonImpl ?? (async () => ({})),
});

describe('apiJson', () => {
  test('returns the parsed body on a 2xx response', async () => {
    const res = makeRes(true, 200, async () => ({ post: { _id: 'abc' } }));
    await expect(apiJson(res)).resolves.toEqual({ post: { _id: 'abc' } });
  });

  test('accepts a Promise<Response>, not just a Response', async () => {
    const res = makeRes(true, 201, async () => ({ ok: 1 }));
    await expect(apiJson(Promise.resolve(res))).resolves.toEqual({ ok: 1 });
  });

  test('throws on a non-2xx response, using body.error as the message', async () => {
    const res = makeRes(false, 400, async () => ({ error: 'Bad input' }));
    await expect(apiJson(res)).rejects.toThrow('Bad input');
  });

  test('falls back to body.message, then to a status-code message', async () => {
    const withMessage = makeRes(false, 403, async () => ({ message: 'Forbidden' }));
    await expect(apiJson(withMessage)).rejects.toThrow('Forbidden');

    const noBodyText = makeRes(false, 500, async () => ({}));
    await expect(apiJson(noBodyText)).rejects.toThrow('Request failed (500)');
  });

  test('attaches status and body to the thrown error', async () => {
    const res = makeRes(false, 409, async () => ({ error: 'Conflict' }));
    await expect(apiJson(res)).rejects.toMatchObject({
      message: 'Conflict',
      status: 409,
      body: { error: 'Conflict' },
    });
  });

  test('treats an empty/invalid JSON body as null on success', async () => {
    const res = makeRes(true, 204, async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    await expect(apiJson(res)).resolves.toBeNull();
  });

  test('still throws on a non-2xx with an unparseable body', async () => {
    const res = makeRes(false, 502, async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    await expect(apiJson(res)).rejects.toThrow('Request failed (502)');
  });
});
