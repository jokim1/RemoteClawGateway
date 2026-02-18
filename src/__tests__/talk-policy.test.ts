import { evaluateToolAvailability } from '../talk-policy';

describe('talk policy availability reasons', () => {
  test('marks uninstalled tools as blocked_not_installed', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_add_tab', description: 'tab tool', builtin: true }],
      {
        executionMode: 'openclaw',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'auto',
      },
      {
        isInstalled: () => false,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_not_installed');
  });

  test('marks tools blocked_tool_mode when tool approval is off', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_create', description: 'docs', builtin: true }],
      {
        executionMode: 'openclaw',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'off',
      },
      {
        isInstalled: () => true,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_tool_mode');
  });
});
