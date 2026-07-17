const { registerTool, toolsForScopes, scopeSatisfies, allTools } = require('./registry');
require('./tools'); // register the real tools (get_source_info, …)

describe('MCP registry — scope gating (the security-relevant logic)', () => {
  test('public tools are reachable by any authenticated token', () => {
    expect(scopeSatisfies([], 'public')).toBe(true);
    expect(scopeSatisfies(undefined, 'public')).toBe(true);
    expect(scopeSatisfies(['read'], 'public')).toBe(true);
  });

  test('non-public tools require the token to carry that exact scope', () => {
    expect(scopeSatisfies(['read'], 'read')).toBe(true);
    expect(scopeSatisfies(['read'], 'write')).toBe(false);
    expect(scopeSatisfies([], 'read')).toBe(false);
    expect(scopeSatisfies(undefined, 'read')).toBe(false);
  });

  test('get_source_info (public) is visible even to a zero-scope token', () => {
    expect(toolsForScopes([]).map((t) => t.name)).toContain('get_source_info');
    expect(toolsForScopes(['read']).map((t) => t.name)).toContain('get_source_info');
  });

  test('a write-scoped tool is invisible to a read-only token, visible to write', () => {
    registerTool({ name: 'unit_test_write_tool', title: 't', description: 'd', scope: 'write', handler: async () => ({ content: [] }) });
    expect(toolsForScopes(['read']).map((t) => t.name)).not.toContain('unit_test_write_tool');
    expect(toolsForScopes(['write']).map((t) => t.name)).toContain('unit_test_write_tool');
  });

  test('registerTool rejects missing fields and duplicate names', () => {
    expect(() => registerTool({ name: 'no_handler', scope: 'read' })).toThrow();
    expect(() => registerTool({ name: 'no_scope', handler: async () => ({}) })).toThrow(/scope/i);
    expect(() => registerTool({ name: 'get_source_info', scope: 'public', handler: async () => ({}) })).toThrow(/duplicate/i);
  });
});

describe('get_source_info handler', () => {
  test('is public + read-only and returns repo/license/version with no secrets', async () => {
    const tool = allTools().find((t) => t.name === 'get_source_info');
    expect(tool.scope).toBe('public');
    expect(tool.annotations.readOnlyHint).toBe(true);

    const res = await tool.handler({}, { user: { id: 'u1' }, scopes: ['read'] });
    const info = JSON.parse(res.content[0].text);
    expect(info.repository).toContain('github.com/jagduvi1/Cellarion');
    expect(info.license).toBe('AGPL-3.0');
    expect(typeof info.version).toBe('string');
    // Data minimisation: the tool must never surface secrets/config.
    expect(JSON.stringify(info)).not.toMatch(/secret|password|token|api[_-]?key|process\.env/i);
  });
});

describe('deprecation marker (docs/mcp-versioning.md)', () => {
  test('a deprecated tool stays registered but its description LEADS with the migration path', () => {
    registerTool({
      name: 'zz_test_deprecated', title: 'Old tool', scope: 'read',
      description: 'Does the old thing.',
      deprecated: 'use zz_new_tool instead; removed after v1.99',
      handler: async () => ({}),
    });
    const t = allTools().find((x) => x.name === 'zz_test_deprecated');
    expect(t.description).toBe('[DEPRECATED — use zz_new_tool instead; removed after v1.99] Does the old thing.');
    expect(t.deprecated).toBeTruthy();
  });

  test('an empty deprecation message is a programming error (the marker must carry a migration path)', () => {
    expect(() => registerTool({
      name: 'zz_test_deprecated_bad', scope: 'read', description: 'x',
      deprecated: '   ', handler: async () => ({}),
    })).toThrow(/migration message/i);
  });

  test('no live tool ships deprecated right now (drift guard — clean the marker after each sunset)', () => {
    const live = allTools().filter((t) => t.deprecated && !t.name.startsWith('zz_test_'));
    expect(live).toEqual([]);
  });
});
